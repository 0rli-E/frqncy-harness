/**
 * `frqncy-harness ralph "<prompt>" [--until "<predicate>"] [--max-iterations N] [--cwd <path>] [--model <m>] [--thread <id>]`
 *
 * The persistent outer loop. Re-invokes `chat()` against the same prompt + thread
 * until a completion-promise predicate matches, max-iterations is hit, the
 * cost cap fires, or `~/.frqncy-harness/kill.flag` appears.
 *
 * Why this exists: it's the missing primitive that turns the harness from "a
 * CLI you invoke" into "a process you can leave running." Pairs with `codify`
 * (per-trace test fountain) and `reflect` (cross-trace failure-mode synthesis)
 * to complete the self-improvement triad — ralph is the *generator* of traces
 * the other two consume.
 *
 * Architectural notes (per `proposals/SELF-IMPROVING-HARNESS.md` and
 * `../FRQNCY WEBSITE/HARNESS-ROADMAP.md` v2 Phase 1):
 *   - The loop lives OUTSIDE the LLM (Ralph Loop pattern; harness.md operations layer)
 *   - State belongs on disk — every iteration writes to the never-compacted JSONL trace,
 *     tagged with the same thread_id, so reflect/codify can read across iterations
 *   - The completion-promise is an EXTERNAL sentinel, not an internal LLM judgment —
 *     "I'm done" only counts when the predicate matches, never when the LLM says so
 *   - Kill switch via filesystem (touch ~/.frqncy-harness/kill.flag) — survives any
 *     in-process crash; other safe-to-leave-running primitives layer on top
 *
 * v0.8 limitations (lift in v0.9):
 *   - Each iteration is one `chat()` call. Tool work requires a tool-capable lane
 *     (claude-sdk/* recommended; claude-code/* and codex/* do their own tooling).
 *     For pure prose tasks, any lane works.
 *   - Predicate eval supports string-contains and /regex/ syntax. Shell-exec
 *     predicates (`!cmd`) are deferred — too easy to weaponize without more thought.
 *   - No MCP wiring per iteration (use the agent command for that today; ralph + MCP
 *     is the v0.9 work).
 *
 * Safety:
 *   - System prompt includes the inoculation sentence (Anthropic Nov 2025 paper,
 *     arXiv 2511.18397) — reduces misalignment generalization 75-90% even when
 *     reward-hacking rates exceed 99%.
 *   - Max-iterations is HARD; the loop will not exceed it. Default 25.
 *   - The cost cap is inherited from config ($5 soft / $25 hard by default) and
 *     accumulated across the entire ralph run — not reset per iteration.
 *   - `~/.frqncy-harness/kill.flag` is checked at the START of every iteration.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chat as defaultChat } from '../chat.js';
import { loadConfig } from '../config.js';
import { INOCULATION_SENTENCE } from './codify.js';
import type { ChatInput, ChatResult, ModelString } from '../types.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
};

const DEFAULT_MAX_ITERATIONS = 25;
const DEFAULT_UNTIL = '<promise>DONE</promise>';
const DEFAULT_KILL_FLAG_PATH = join(homedir(), '.frqncy-harness', 'kill.flag');

export const RALPH_SYSTEM_PROMPT = `You are working inside a Ralph loop — your output will be evaluated against a completion-promise predicate, and if unmet, you will be re-invoked with the same prompt up to a hard iteration cap. ${INOCULATION_SENTENCE}

Your job each iteration:
1. Read your previous progress if any was made (e.g., scratch files in the working directory, prior assistant outputs in the conversation thread). The trace store preserves everything across iterations.
2. Make concrete forward progress on the task.
3. When and ONLY when the task is genuinely complete, emit the completion-promise token EXACTLY as specified by the operator (it will be a literal string or a regex pattern). Emit nothing else after it on the same line.

If you cannot make forward progress (you are stuck, you need information you do not have, an external dependency is broken), say so explicitly and stop. Do not emit the completion-promise to escape a hard problem — the operator is watching, and a false promise wastes their merge budget.`;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type RalphStatus = 'completed' | 'exhausted' | 'killed' | 'cost_aborted';

export interface RalphCommandOptions {
  /** Completion predicate. Plain string (substring match) or /regex/ syntax. Default: <promise>DONE</promise> */
  until?: string;
  /** Hard cap on iterations. Default 25. */
  maxIterations?: number;
  /** Working directory the loop operates in. Defaults to process.cwd(). Currently informational — passed in the prompt; full file-tool integration lands in v0.9. */
  cwd?: string;
  /** LLM lane override. Defaults to config.defaultModel. */
  model?: string;
  /** Thread tag — all iterations share this so traces can be queried as one unit. Auto-generated if not given. */
  threadId?: string;
  /** Project tag — passed through to traces. */
  projectId?: string;
  /** Emit JSON summary instead of human-readable status. */
  json?: boolean;
  /** Test seam — substitute the chat function. */
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
  /** Test seam — override kill-flag location. */
  killFlagPath?: string;
}

export interface IterationRecord {
  iteration: number;
  conversationId: string;
  costUsd: number;
  finalText: string;
  predicateMatched: boolean;
}

export interface RalphResult {
  status: RalphStatus;
  iterations: IterationRecord[];
  threadId: string;
  totalCostUsd: number;
  finalText: string;
  /** True when status === 'completed'; convenience flag. */
  completed: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────

export async function runRalphCommand(prompt: string, options: RalphCommandOptions = {}): Promise<RalphResult> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required. Usage: frqncy-harness ralph "your task" --until "DONE"');
  }

  const config = await loadConfig();
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const until = options.until ?? DEFAULT_UNTIL;
  const cwd = options.cwd ?? process.cwd();
  const model = (options.model ?? config.defaultModel ?? 'anthropic/claude-sonnet-4-6') as ModelString;
  const threadId = options.threadId ?? `ralph-${randomUUID().slice(0, 8)}`;
  const chatFn = options.chatFn ?? defaultChat;
  const killFlagPath = options.killFlagPath ?? DEFAULT_KILL_FLAG_PATH;

  if (maxIterations < 1) {
    throw new Error('maxIterations must be at least 1');
  }

  const iterations: IterationRecord[] = [];
  const banner = (msg: string): void => {
    if (!options.json) process.stdout.write(msg);
  };

  banner(
    `${ANSI.bold}${ANSI.cyan}ralph loop starting${ANSI.reset}` +
      ` ${ANSI.dim}thread=${threadId} model=${model} max-iter=${maxIterations}${ANSI.reset}\n` +
      `${ANSI.dim}until: ${truncate(until, 80)}${ANSI.reset}\n` +
      `${ANSI.dim}cwd: ${cwd}${ANSI.reset}\n` +
      `${ANSI.dim}kill flag: ${killFlagPath} (touch to abort)${ANSI.reset}\n\n`,
  );

  for (let i = 1; i <= maxIterations; i++) {
    // Kill switch — checked at the START of every iteration so the loop halts
    // within at most one iteration of `touch ~/.frqncy-harness/kill.flag`.
    if (await fileExists(killFlagPath)) {
      banner(`${ANSI.yellow}× kill flag detected at ${killFlagPath} — halting${ANSI.reset}\n`);
      return finalize('killed', iterations, threadId);
    }

    const iterPrompt = i === 1 ? buildInitialPrompt(prompt, until, cwd) : buildContinuationPrompt(prompt, i, maxIterations, until);

    banner(`${ANSI.bold}iteration ${i}/${maxIterations}${ANSI.reset}\n`);

    let result: ChatResult;
    try {
      result = await chatFn({
        model,
        messages: [{ role: 'user', content: iterPrompt }],
        system: RALPH_SYSTEM_PROMPT,
        threadId,
        ...(options.projectId ? { projectId: options.projectId } : {}),
        costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Cost-cap abort is a recoverable terminal state, not a thrown error in normal operation,
      // but if a downstream provider throws on the cap we surface it cleanly.
      if (/cost.cap/i.test(message) || /\$\d+.*cap/i.test(message)) {
        banner(`${ANSI.red}× cost cap aborted the loop after iteration ${i - 1}${ANSI.reset}\n`);
        return finalize('cost_aborted', iterations, threadId);
      }
      throw err;
    }

    const matched = matchesCompletionPredicate(result.text, until);
    const iter: IterationRecord = {
      iteration: i,
      conversationId: result.conversationId,
      costUsd: result.usage.costUsd ?? 0,
      finalText: result.text,
      predicateMatched: matched,
    };
    iterations.push(iter);

    banner(
      `${ANSI.dim}  conv=${result.conversationId.slice(0, 8)} cost=$${(result.usage.costUsd ?? 0).toFixed(4)} matched=${matched}${ANSI.reset}\n`,
    );

    if (matched) {
      banner(`${ANSI.green}✓ completion-promise matched on iteration ${i}${ANSI.reset}\n`);
      return finalize('completed', iterations, threadId);
    }
  }

  banner(`${ANSI.yellow}× max-iterations reached (${maxIterations}) without matching the completion-promise${ANSI.reset}\n`);
  return finalize('exhausted', iterations, threadId);

  function finalize(status: RalphStatus, iters: IterationRecord[], thread: string): RalphResult {
    const totalCostUsd = iters.reduce((sum, it) => sum + it.costUsd, 0);
    const finalText = iters.length > 0 ? iters[iters.length - 1]!.finalText : '';
    const summary: RalphResult = {
      status,
      iterations: iters,
      threadId: thread,
      totalCostUsd,
      finalText,
      completed: status === 'completed',
    };
    if (options.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    } else {
      process.stdout.write(
        `\n${ANSI.bold}ralph summary${ANSI.reset}\n` +
          `${ANSI.dim}  status: ${status}${ANSI.reset}\n` +
          `${ANSI.dim}  iterations: ${iters.length}${ANSI.reset}\n` +
          `${ANSI.dim}  total cost: $${totalCostUsd.toFixed(4)}${ANSI.reset}\n` +
          `${ANSI.dim}  thread: ${thread}${ANSI.reset}\n`,
      );
    }
    return summary;
  }
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Match the assistant's final text against a completion-promise predicate.
 *
 * Predicate forms:
 *   - "/regex/flags"  — JS regex match (e.g., /\bdone\b/i). Bare slashes only at
 *                       both ends; no escape syntax for outer slashes.
 *   - any other       — case-sensitive substring contains check.
 */
export function matchesCompletionPredicate(text: string, predicate: string): boolean {
  if (!text) return false;
  const trimmed = predicate.trim();
  // /regex/flags form
  if (trimmed.length >= 2 && trimmed.startsWith('/')) {
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash > 0) {
      const pattern = trimmed.slice(1, lastSlash);
      const flags = trimmed.slice(lastSlash + 1);
      try {
        const re = new RegExp(pattern, flags);
        return re.test(text);
      } catch {
        // Malformed regex — fall through to substring match against the raw input
      }
    }
  }
  return text.includes(predicate);
}

export function buildInitialPrompt(userTask: string, until: string, cwd: string): string {
  return [
    `# Ralph loop — iteration 1`,
    ``,
    `**Working directory:** \`${cwd}\``,
    `**Completion predicate:** \`${until}\``,
    ``,
    `## Task`,
    ``,
    userTask,
    ``,
    `When the task is genuinely complete, emit the completion-promise predicate in your final message — exactly as specified above. Otherwise, make concrete forward progress and your output will be re-fed into a subsequent iteration.`,
  ].join('\n');
}

export function buildContinuationPrompt(userTask: string, iteration: number, maxIterations: number, until: string): string {
  return [
    `# Ralph loop — iteration ${iteration} of ${maxIterations}`,
    ``,
    `**Completion predicate:** \`${until}\``,
    ``,
    `## Original task`,
    ``,
    userTask,
    ``,
    `## Continue`,
    ``,
    `Your previous iterations are visible in the conversation thread (same thread_id). Read them, identify what's done and what's left, then make the next concrete forward step. If the task is now complete, emit the completion-promise predicate exactly. If you are stuck, say so explicitly — do not fabricate completion to escape a hard problem.`,
  ].join('\n');
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
