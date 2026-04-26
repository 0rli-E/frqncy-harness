/**
 * `frqncy-harness agent <prompt>` — multi-step agent loop.
 *
 * Implements the Anthropic external-artifacts pattern (decision 9):
 *   - Scaffolds init.sh + progress.md + tasks.json + baseline git commit in the sandbox
 *   - Runs stream() with bash + read + write + grep + glob + web_fetch tools
 *   - Surfaces tool calls live with formatting
 *   - TTY approval for state-changing tools (--yolo bypasses)
 *   - Writes the assistant's final message back to progress.md so the next session can resume
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { stream } from '../stream.js';
import { loadConfig } from '../config.js';
import { createSandbox, type Sandbox } from '../sandbox/index.js';
import { bashTool } from '../tools/bash.js';
import { readTool, writeTool, grepTool, globTool } from '../tools/file.js';
import { webFetchTool } from '../tools/web.js';
import { webSearchTool } from '../tools/web-search.js';
import { loadMcpConfig, getEnabledServers } from '../mcp/config.js';
import { connectMcpServers } from '../mcp/client.js';
import { flattenMcpToolset } from '../mcp/tool-adapter.js';
import type { ApprovalRequest } from '../approval.js';
import type { HarnessTool } from '../tools/index.js';
import type { ModelString } from '../types.js';

const exec = promisify(execFile);

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

export interface AgentCommandOptions {
  model?: string;
  yolo?: boolean;
  maxSteps?: number;
  noSandbox?: boolean;
  noArtifacts?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DEFAULT_TOOLS: HarnessTool<any, any>[] = [
  bashTool,
  readTool,
  writeTool,
  grepTool,
  globTool,
  webFetchTool,
  webSearchTool,
];

export async function runAgentCommand(prompt: string, options: AgentCommandOptions): Promise<void> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required. Usage: frqncy-harness agent "your task"');
  }

  const config = await loadConfig();
  const model = (options.model ?? config.defaultModel) as ModelString;
  const maxSteps = options.maxSteps ?? 20;

  // ── Sandbox ────────────────────────────────────────────────
  let sandbox: Sandbox | null = null;
  let sandboxPath: string;
  if (options.noSandbox) {
    sandboxPath = process.cwd();
    output.write(`${ANSI.yellow}! running with --no-sandbox in ${sandboxPath}${ANSI.reset}\n`);
  } else {
    sandbox = await createSandbox({
      cwd: process.cwd(),
      conversationId: cryptoRandomId(),
    });
    sandboxPath = sandbox.path;
    output.write(`${ANSI.dim}sandbox: ${sandbox.backend} @ ${sandbox.path}${ANSI.reset}\n`);
  }

  // ── External artifacts (decision 9) ────────────────────────
  if (!options.noArtifacts) {
    await scaffoldArtifacts(sandboxPath, prompt);
    output.write(`${ANSI.dim}artifacts: progress.md + tasks.json + .frqncy-harness/init.sh${ANSI.reset}\n`);
  }

  // ── MCP servers (decision D1) ──────────────────────────────
  const mcpConfig = await loadMcpConfig();
  const mcpServerEntries = getEnabledServers(mcpConfig);
  let mcpResult: Awaited<ReturnType<typeof connectMcpServers>> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mcpTools: HarnessTool<any, any>[] = [];
  if (mcpServerEntries.length > 0) {
    output.write(`${ANSI.dim}connecting to ${mcpServerEntries.length} MCP server(s)...${ANSI.reset}\n`);
    mcpResult = await connectMcpServers(mcpServerEntries);
    for (const s of mcpResult.servers) {
      output.write(`${ANSI.dim}  ${ANSI.green}✓${ANSI.dim} ${s.name} (${s.tools.length} tools)${ANSI.reset}\n`);
    }
    for (const e of mcpResult.errors) {
      output.write(`${ANSI.dim}  ${ANSI.red}✗${ANSI.dim} ${e.name}: ${e.error.message}${ANSI.reset}\n`);
    }
    mcpTools.push(...flattenMcpToolset(mcpResult.servers));
  }

  // ── System prompt: AGENT.md → CLAUDE.md → default ─────────
  const systemPrompt = await loadSystemPrompt(process.cwd(), prompt, sandboxPath);

  // ── Approval callback (TTY) ────────────────────────────────
  const rl = createInterface({ input, output });
  const approval = options.yolo
    ? undefined
    : async (req: ApprovalRequest): Promise<boolean> => {
        output.write('\n');
        output.write(
          `${ANSI.yellow}? approve ${ANSI.bold}${req.toolName}${ANSI.reset}${ANSI.yellow} ${ANSI.dim}${JSON.stringify(req.input).slice(0, 200)}${ANSI.reset}\n`,
        );
        const ans = await rl.question(`${ANSI.yellow}  [y/N/a=always]${ANSI.reset} `);
        const trimmed = ans.trim().toLowerCase();
        if (trimmed === 'a' || trimmed === 'always') {
          // ApprovalManager remembers per-conversation when callback returns true
          return true;
        }
        return trimmed === 'y' || trimmed === 'yes';
      };

  // ── Run the agent loop ─────────────────────────────────────
  output.write(`${ANSI.bold}${ANSI.cyan}@frqncy/harness agent${ANSI.reset} ${ANSI.dim}(model=${model}, maxSteps=${maxSteps})${ANSI.reset}\n`);
  output.write('\n');

  let aborted = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: HarnessTool<any, any>[] = [...DEFAULT_TOOLS, ...mcpTools];
  try {
    for await (const event of stream({
      model,
      messages: [{ role: 'user', content: prompt }],
      system: systemPrompt,
      tools: allTools,
      maxSteps,
      sandboxPath,
      ...(approval ? { approval } : {}),
      yolo: options.yolo === true,
      costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd },
      trifectaSeverity: 'warn',
    })) {
      switch (event.type) {
        case 'text':
          output.write(event.delta);
          break;
        case 'tool_call':
          output.write(`\n${ANSI.blue}→ ${event.toolName}${ANSI.reset} ${ANSI.dim}${truncate(JSON.stringify(event.input), 120)}${ANSI.reset}\n`);
          break;
        case 'tool_result':
          output.write(`${ANSI.green}← ${event.toolName}${ANSI.reset} ${ANSI.dim}${truncate(JSON.stringify(event.output), 120)}${ANSI.reset}\n`);
          break;
        case 'tool_error':
          output.write(`${ANSI.red}× ${event.toolName} ${event.error.message}${ANSI.reset}\n`);
          break;
        case 'step_finish':
          output.write(`${ANSI.dim}  step ${event.step} → ${event.finishReason}${ANSI.reset}\n`);
          break;
        case 'usage':
          output.write(
            `\n${ANSI.dim}[usage] in=${event.usage.inputTokens} out=${event.usage.outputTokens}` +
              (event.usage.cachedInputTokens ? ` cached=${event.usage.cachedInputTokens}` : '') +
              (event.usage.costUsd !== undefined ? ` cost=$${event.usage.costUsd.toFixed(6)}` : '') +
              `${ANSI.reset}\n`,
          );
          break;
        case 'cost_warn':
          output.write(`${ANSI.yellow}! ${event.message}${ANSI.reset}\n`);
          break;
        case 'cost_abort':
          output.write(`${ANSI.red}× ${event.message}${ANSI.reset}\n`);
          aborted = true;
          break;
        case 'trifecta_warn':
          output.write(`${ANSI.yellow}! ${event.message}${ANSI.reset}\n`);
          break;
        case 'done':
          output.write('\n');
          if (!options.noArtifacts) {
            await fs.appendFile(
              join(sandboxPath, 'progress.md'),
              `\n## Final reply (${new Date().toISOString()})\n\n${event.result.text}\n`,
              'utf-8',
            );
          }
          output.write(`${ANSI.dim}conversation: ${event.result.conversationId}${ANSI.reset}\n`);
          break;
        case 'error':
          // Already handled by the throw below
          break;
      }
    }
  } finally {
    rl.close();
    if (mcpResult) {
      await mcpResult.disconnectAll();
    }
    if (sandbox && !options.noArtifacts) {
      // Don't auto-cleanup the sandbox so the user can inspect what the agent did.
      // We surface the path instead.
      output.write(`\n${ANSI.dim}sandbox preserved at: ${sandbox.path}${ANSI.reset}\n`);
      output.write(`${ANSI.dim}to clean: rm -rf "${sandbox.path}"${ANSI.reset}\n`);
    } else if (sandbox) {
      await sandbox.cleanup();
    }
  }

  if (aborted) {
    process.exit(2);
  }
}

// ────────────────────────────────────────────────────────────────────
// External artifacts scaffolding
// ────────────────────────────────────────────────────────────────────

async function scaffoldArtifacts(sandboxPath: string, prompt: string): Promise<void> {
  const harnessDir = join(sandboxPath, '.frqncy-harness');
  await fs.mkdir(harnessDir, { recursive: true });

  // init.sh — sourced or run by the agent for env setup. Empty by default; user can edit.
  const initSh = `#!/usr/bin/env bash
# init.sh — sourced/run by the agent at the start of each session.
# Add env vars, source venvs, install deps, etc. Empty by default.
set -euo pipefail
echo "[init] frqncy-harness agent session starting in $(pwd)"
`;
  await fs.writeFile(join(harnessDir, 'init.sh'), initSh, { encoding: 'utf-8', mode: 0o755 });

  // progress.md — append-only log of every step + reasoning. Bridges sessions.
  const startedAt = new Date().toISOString();
  const progressMd = `# Agent progress

Started: ${startedAt}
Sandbox: ${sandboxPath}

## Original prompt

${prompt}

## Steps

`;
  await fs.writeFile(join(sandboxPath, 'progress.md'), progressMd, 'utf-8');

  // tasks.json — prompt decomposed into testable items. v0.2 ships an empty list;
  // the agent can populate it via the write tool. v0.3 adds an initializer agent.
  const tasksJson = {
    started_at: startedAt,
    original_prompt: prompt,
    tasks: [
      { id: 1, status: 'pending', description: 'Decompose the prompt into concrete steps' },
      { id: 2, status: 'pending', description: 'Execute each step using available tools' },
      { id: 3, status: 'pending', description: 'Verify the work and write a summary' },
    ],
  };
  await fs.writeFile(join(sandboxPath, 'tasks.json'), JSON.stringify(tasksJson, null, 2) + '\n', 'utf-8');

  // Baseline git commit if sandbox is a git worktree
  try {
    await exec('git', ['add', '-A'], { cwd: sandboxPath });
    await exec(
      'git',
      ['commit', '-m', '[frqncy-harness] baseline before agent run', '--allow-empty', '--no-verify'],
      { cwd: sandboxPath },
    );
  } catch {
    // not a git repo — fine
  }
}

// ────────────────────────────────────────────────────────────────────
// System prompt loader (decision D2)
// ────────────────────────────────────────────────────────────────────

async function loadSystemPrompt(originalCwd: string, prompt: string, sandboxPath: string): Promise<string> {
  const candidates = [
    join(originalCwd, 'AGENT.md'),
    join(originalCwd, 'CLAUDE.md'),
  ];
  let projectInstructions = '';
  for (const path of candidates) {
    try {
      const contents = await fs.readFile(path, 'utf-8');
      projectInstructions = contents;
      break;
    } catch {
      continue;
    }
  }

  const baseSystem =
    `You are an agent running inside the @frqncy/harness CLI. ` +
    `You have these tools available: bash, read, write, grep, glob, web_fetch. ` +
    `Your sandbox cwd is: ${sandboxPath}\n\n` +
    `Use external artifacts to track progress: append to progress.md as you work, ` +
    `and update tasks.json when you complete a discrete step. ` +
    `When the task is complete, write a final summary to progress.md and stop.`;

  if (projectInstructions) {
    return `${baseSystem}\n\n--- PROJECT INSTRUCTIONS (from AGENT.md or CLAUDE.md) ---\n\n${projectInstructions}`;
  }
  return baseSystem;
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function cryptoRandomId(): string {
  return randomUUID();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}
