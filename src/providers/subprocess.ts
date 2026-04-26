/**
 * Subscription provider runner — wraps the official Claude Code (`claude -p`)
 * and Codex (`codex exec`) CLIs as subprocesses.
 *
 * Why subprocess and not direct API:
 *   - Anthropic and OpenAI both prohibit using OAuth tokens from consumer
 *     subscriptions in third-party tools (HARNESS-PLAN.md decision 4 revision)
 *   - But they explicitly permit invoking the official CLI as a subprocess —
 *     it's the official client doing the work, not a token-extracting
 *     impersonator
 *
 * Trade-offs (vs API path):
 *   - Higher per-call overhead (CLI spawn + their own system prompt loaded each time)
 *   - No tools (those CLIs do their own internal tooling)
 *   - No prompt caching benefits
 *   - Limited streaming (we get text chunks but no per-token usage data)
 *   - Cost recorded as $0 (it's drawn from your subscription quota)
 *
 * Use this lane for: ad-hoc questions, daily chat, anything where you want
 * to use Max/Pro instead of paying API tokens.
 *
 * Use the API lane for: agent loops, programmatic tool calling, anywhere
 * you need structured outputs or prompt caching.
 */
import { spawn } from 'node:child_process';
import type { Message, StreamEvent, SubscriptionProvider } from '../types.js';

export interface SubscriptionRunOptions {
  provider: SubscriptionProvider;
  modelId: string;
  messages: Message[];
  system?: string;
  cwd?: string;
  /** Resume an existing CLI session, if known. Provider-specific format. */
  resumeSessionId?: string;
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // 4MB cap on captured output

export async function* runSubscription(
  opts: SubscriptionRunOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  const prompt = flattenMessagesToPrompt(opts.messages, opts.system);
  const { command, args } = buildCommand(opts.provider, opts.modelId, prompt, opts.resumeSessionId);

  const child = spawn(command, args, {
    cwd: opts.cwd ?? process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const decoder = new TextDecoder();
  let stderrBuf = '';
  let totalBytes = 0;
  let truncated = false;
  let assembled = '';

  // Capture stderr for error reporting
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderrBuf.length < MAX_OUTPUT_BYTES) {
      stderrBuf += chunk.toString();
    }
  });

  // Stream stdout
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      if (totalBytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        break;
      }
      const text = decoder.decode(chunk);
      const remaining = MAX_OUTPUT_BYTES - totalBytes;
      const safeText = text.length > remaining ? text.slice(0, remaining) : text;
      totalBytes += safeText.length;
      assembled += safeText;
      yield { type: 'text', delta: safeText };
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    yield { type: 'error', error: { name: 'SubscriptionStreamError', message: error.message } };
    throw error;
  }

  // Wait for process exit
  const exitCode = await new Promise<number>((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.on('exit', (code) => resolve(code ?? -1));
  });

  if (truncated) {
    yield {
      type: 'text',
      delta: `\n\n[harness] subprocess output truncated at ${MAX_OUTPUT_BYTES} bytes`,
    };
  }

  if (exitCode !== 0) {
    const message = (stderrBuf || `${command} exited with code ${exitCode}`).trim();
    const isCommandNotFound = stderrBuf.includes('ENOENT') || /command not found/i.test(stderrBuf);
    const friendlyMessage = isCommandNotFound
      ? `${command} is not installed or not on PATH. Install ${commandHelpHint(opts.provider)} and try again.`
      : message;

    yield { type: 'error', error: { name: 'SubscriptionExitError', message: friendlyMessage } };
    throw Object.assign(new Error(friendlyMessage), { name: 'SubscriptionExitError' });
  }

  // No structured usage data in text mode — record zeros + cost 0 (drawn from subscription)
  yield {
    type: 'usage',
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
  };

  // Note: caller is responsible for the final 'done' event with assembled text
  // (we don't construct ChatResult here because that needs the conversation_id
  // and other fields that live in stream())
  void assembled;
}

// ────────────────────────────────────────────────────────────────────
// Command construction
// ────────────────────────────────────────────────────────────────────

function buildCommand(
  provider: SubscriptionProvider,
  modelId: string,
  prompt: string,
  resumeSessionId?: string,
): { command: string; args: string[] } {
  switch (provider) {
    case 'claude-code': {
      // claude -p "<prompt>" --model <modelId> [--resume <session-id>]
      // Claude Code's --model accepts: sonnet | opus | haiku | <full-model-id>
      const args: string[] = ['-p', prompt];
      if (modelId && modelId !== 'default') {
        args.push('--model', modelId);
      }
      if (resumeSessionId) {
        args.push('--resume', resumeSessionId);
      }
      return { command: 'claude', args };
    }
    case 'codex': {
      // codex exec "<prompt>" [--model <modelId>]
      const args: string[] = ['exec', prompt];
      if (modelId && modelId !== 'default') {
        args.push('--model', modelId);
      }
      return { command: 'codex', args };
    }
  }
}

function commandHelpHint(provider: SubscriptionProvider): string {
  switch (provider) {
    case 'claude-code':
      return 'Claude Code (npm install -g @anthropic-ai/claude-code, then run `claude` once to authenticate)';
    case 'codex':
      return 'Codex CLI (https://developers.openai.com/codex/cli, then run `codex` once to authenticate)';
  }
}

// ────────────────────────────────────────────────────────────────────
// Message flattening
// ────────────────────────────────────────────────────────────────────

/**
 * Subscription CLIs take a single prompt string, not a conversation array.
 * For multi-turn use, the user should rely on the CLI's own session-resume
 * mechanism (claude --resume, codex's session features) rather than
 * re-sending history.
 *
 * For v0.4, we flatten as: optional system context + the LAST user message.
 * Earlier turns in the array are ignored (use the CLI's session machinery
 * for continuity).
 */
function flattenMessagesToPrompt(messages: Message[], system?: string): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    throw new Error('Subscription providers require at least one user message');
  }
  if (system) {
    return `[Context: ${system}]\n\n${lastUser.content}`;
  }
  return lastUser.content;
}

// ────────────────────────────────────────────────────────────────────
// Doctor helpers — check whether a binary is on PATH
// ────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function isClaudeCodeAvailable(): Promise<boolean> {
  try {
    await exec('claude', ['--version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export async function isCodexAvailable(): Promise<boolean> {
  try {
    await exec('codex', ['--version'], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
