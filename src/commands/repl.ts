/**
 * `frqncy-harness repl` — interactive REPL with model swap.
 *
 * Two modes:
 *   - default: text-only chat (low cost, no tool execution)
 *   - --agent: persistent agent conversation with tools (bash, file, web, MCP).
 *              Each turn runs a multi-step agent loop in a per-session sandbox.
 *              State persists across turns; you stay in one conversation.
 *
 * Slash commands inside the REPL:
 *   /model <model>      switch the model mid-conversation
 *   /new                start a fresh conversation
 *   /resume <id>        resume a past conversation by id
 *   /system <text>      set the system prompt for subsequent turns
 *   /tools on|off       toggle tool use for subsequent turns (agent mode only)
 *   /yolo on|off        toggle approval bypass (agent mode only)
 *   /help               list commands
 *   /exit, /quit, ^C    leave the REPL
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { randomUUID } from 'node:crypto';
import { stream } from '../stream.js';
import { loadConfig } from '../config.js';
import { loadProjectInstructions } from '../instructions.js';
import { loadSkills, matchSkills, formatSkillsForSystemPrompt, type LoadedSkill } from '../skills/index.js';
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
import type { Message, ModelString, Usage } from '../types.js';

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

export interface ReplCommandOptions {
  model?: string;
  system?: string;
  resume?: string;
  threadId?: string;
  projectId?: string;
  /** Enable tools (bash/file/web/MCP) and run a multi-step agent loop on each turn. */
  agent?: boolean;
  /** When true, skip per-tool approval prompts. Only meaningful with --agent. */
  yolo?: boolean;
  /** Cap on agent steps per user turn. Default 20. Only meaningful with --agent. */
  maxSteps?: number;
  /** Skip sandbox creation; agent operates in current cwd. Only meaningful with --agent. */
  noSandbox?: boolean;
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

export async function runReplCommand(options: ReplCommandOptions): Promise<void> {
  const config = await loadConfig();
  let currentModel = (options.model ?? config.defaultModel) as ModelString;
  let currentSystem = options.system;
  let systemSource: string | undefined;
  let conversationId: string | undefined = options.resume;
  let messages: Message[] = [];

  // Agent-mode toggles (mutable via slash commands)
  let toolsEnabled = options.agent === true;
  let yolo = options.yolo === true;
  const maxSteps = options.maxSteps ?? 20;

  // ── Sandbox + MCP setup (only if agent mode) ──────────────
  let sandbox: Sandbox | null = null;
  let sandboxPath: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mcpTools: HarnessTool<any, any>[] = [];
  let mcpResult: Awaited<ReturnType<typeof connectMcpServers>> | null = null;

  if (toolsEnabled) {
    if (options.noSandbox) {
      sandboxPath = process.cwd();
      output.write(`${ANSI.yellow}! running with --no-sandbox in ${sandboxPath}${ANSI.reset}\n`);
    } else {
      sandbox = await createSandbox({
        cwd: process.cwd(),
        conversationId: randomUUID(),
      });
      sandboxPath = sandbox.path;
      output.write(`${ANSI.dim}sandbox: ${sandbox.backend} @ ${sandbox.path}${ANSI.reset}\n`);
    }

    // MCP servers
    const mcpConfig = await loadMcpConfig();
    const mcpServerEntries = getEnabledServers(mcpConfig);
    if (mcpServerEntries.length > 0) {
      output.write(`${ANSI.dim}connecting to ${mcpServerEntries.length} MCP server(s)...${ANSI.reset}\n`);
      mcpResult = await connectMcpServers(mcpServerEntries);
      for (const s of mcpResult.servers) {
        output.write(`${ANSI.dim}  ${ANSI.green}✓${ANSI.dim} ${s.name} (${s.tools.length} tools)${ANSI.reset}\n`);
      }
      for (const e of mcpResult.errors) {
        output.write(`${ANSI.dim}  ${ANSI.red}✗${ANSI.dim} ${e.name}: ${e.error.message}${ANSI.reset}\n`);
      }
      mcpTools = flattenMcpToolset(mcpResult.servers);
    }
  }

  // Auto-load AGENT.md / CLAUDE.md as initial system prompt when none provided
  // and we're not resuming a saved conversation.
  if (!currentSystem && !conversationId) {
    const loaded = await loadProjectInstructions(process.cwd());
    if (loaded) {
      currentSystem = loaded.content;
      systemSource = loaded.source;
    }
  }

  // Skills are loaded once at REPL start; matched on each user turn so the
  // system prompt grows with the conversation's topic. Already-injected
  // skills are tracked so we don't re-inject the same body twice.
  const allSkills: LoadedSkill[] = await loadSkills();
  const injectedSkills = new Set<string>();
  // Pre-inject any "always" skills upfront.
  if (allSkills.length > 0) {
    const alwaysOn = allSkills.filter((s) => s.always);
    if (alwaysOn.length > 0) {
      const addendum = formatSkillsForSystemPrompt(alwaysOn);
      currentSystem = currentSystem ? `${currentSystem}\n\n${addendum}` : addendum;
      for (const s of alwaysOn) injectedSkills.add(s.name);
    }
  }

  const rl = createInterface({ input, output });

  // Approval callback (TTY) — only used when tools enabled and not yolo
  const approvalCallback = async (req: ApprovalRequest): Promise<boolean> => {
    output.write('\n');
    output.write(
      `${ANSI.yellow}? approve ${ANSI.bold}${req.toolName}${ANSI.reset}${ANSI.yellow} ${ANSI.dim}${truncate(JSON.stringify(req.input), 200)}${ANSI.reset}\n`,
    );
    const ans = await rl.question(`${ANSI.yellow}  [y/N/a=always]${ANSI.reset} `);
    const trimmed = ans.trim().toLowerCase();
    if (trimmed === 'a' || trimmed === 'always') return true;
    return trimmed === 'y' || trimmed === 'yes';
  };

  // Header
  const modeLabel = toolsEnabled ? 'agent REPL' : 'REPL';
  output.write(
    `${ANSI.bold}${ANSI.cyan}@frqncy-network/harness ${modeLabel}${ANSI.reset} ${ANSI.dim}(type /help for commands)${ANSI.reset}\n`,
  );
  output.write(`${ANSI.dim}model: ${currentModel}${ANSI.reset}\n`);
  if (toolsEnabled) {
    const toolCount = DEFAULT_TOOLS.length + mcpTools.length;
    output.write(`${ANSI.dim}tools: ${toolCount} enabled${yolo ? ' (yolo: on)' : ''}${ANSI.reset}\n`);
  }
  if (currentSystem) {
    const label = systemSource ? `system (${systemSource})` : 'system';
    output.write(`${ANSI.dim}${label}: ${currentSystem.slice(0, 60)}${currentSystem.length > 60 ? '...' : ''}${ANSI.reset}\n`);
  }
  if (conversationId) {
    output.write(`${ANSI.dim}resuming: ${conversationId}${ANSI.reset}\n`);
  }
  output.write('\n');

  const prompt = () => `${ANSI.cyan}you ▸${ANSI.reset} `;

  try {
    while (true) {
      let userInput: string;
      try {
        userInput = await rl.question(prompt());
      } catch {
        // user hit Ctrl+C or stdin closed
        break;
      }

      const trimmed = userInput.trim();
      if (!trimmed) continue;

      // Slash commands
      if (trimmed.startsWith('/')) {
        const [cmd, ...rest] = trimmed.slice(1).split(/\s+/);
        const arg = rest.join(' ');
        switch (cmd) {
          case 'exit':
          case 'quit':
          case 'q':
            return;
          case 'help':
            output.write(
              `${ANSI.dim}/model <model>    switch model (e.g. /model openai/gpt-5)\n` +
                `/new              start a fresh conversation\n` +
                `/resume <id>      resume a past conversation\n` +
                `/system <text>    set system prompt\n` +
                `/tools on|off     toggle tools for subsequent turns (agent mode only)\n` +
                `/yolo on|off      toggle approval bypass (agent mode only)\n` +
                `/help             this list\n` +
                `/exit             leave${ANSI.reset}\n\n`,
            );
            continue;
          case 'model':
            if (!arg) {
              output.write(`${ANSI.yellow}current model: ${currentModel}${ANSI.reset}\n\n`);
            } else {
              currentModel = arg as ModelString;
              output.write(`${ANSI.green}model → ${currentModel}${ANSI.reset}\n\n`);
            }
            continue;
          case 'new':
            messages = [];
            conversationId = undefined;
            output.write(`${ANSI.green}fresh conversation${ANSI.reset}\n\n`);
            continue;
          case 'resume':
            if (!arg) {
              output.write(`${ANSI.yellow}usage: /resume <conversation-id>${ANSI.reset}\n\n`);
            } else {
              conversationId = arg;
              messages = [];
              output.write(`${ANSI.green}resuming ${conversationId}${ANSI.reset}\n\n`);
            }
            continue;
          case 'system':
            currentSystem = arg || undefined;
            systemSource = undefined;
            output.write(`${ANSI.green}system prompt ${arg ? 'set' : 'cleared'}${ANSI.reset}\n\n`);
            continue;
          case 'tools':
            if (!sandboxPath && arg === 'on') {
              output.write(`${ANSI.yellow}cannot enable tools mid-session — restart with --agent to set up the sandbox${ANSI.reset}\n\n`);
              continue;
            }
            if (arg === 'on') {
              toolsEnabled = true;
              output.write(`${ANSI.green}tools enabled${ANSI.reset}\n\n`);
            } else if (arg === 'off') {
              toolsEnabled = false;
              output.write(`${ANSI.green}tools disabled${ANSI.reset}\n\n`);
            } else {
              output.write(`${ANSI.yellow}usage: /tools on|off (currently ${toolsEnabled ? 'on' : 'off'})${ANSI.reset}\n\n`);
            }
            continue;
          case 'yolo':
            if (arg === 'on') {
              yolo = true;
              output.write(`${ANSI.green}yolo on (approval bypassed)${ANSI.reset}\n\n`);
            } else if (arg === 'off') {
              yolo = false;
              output.write(`${ANSI.green}yolo off (approval required for state-changing tools)${ANSI.reset}\n\n`);
            } else {
              output.write(`${ANSI.yellow}usage: /yolo on|off (currently ${yolo ? 'on' : 'off'})${ANSI.reset}\n\n`);
            }
            continue;
          default:
            output.write(`${ANSI.red}unknown command: /${cmd}${ANSI.reset} (try /help)\n\n`);
            continue;
        }
      }

      // Regular user message — append to history and call the model
      messages.push({ role: 'user', content: trimmed });

      // Per-turn skill matching: if a new skill triggers on this user input,
      // append its body to the running system prompt for subsequent turns.
      if (allSkills.length > 0) {
        const newlyMatched = matchSkills(trimmed, allSkills).filter((s) => !injectedSkills.has(s.name));
        if (newlyMatched.length > 0) {
          const addendum = formatSkillsForSystemPrompt(newlyMatched);
          currentSystem = currentSystem ? `${currentSystem}\n\n${addendum}` : addendum;
          for (const s of newlyMatched) injectedSkills.add(s.name);
          output.write(
            `${ANSI.dim}[+ skill: ${newlyMatched.map((s) => s.name).join(', ')}]${ANSI.reset}\n`,
          );
        }
      }

      output.write(`${ANSI.green}${currentModel.split('/').pop()} ▸${ANSI.reset} `);

      let assistantText = '';
      let usage: Usage | undefined;

      // Build tools array (agent mode only)
      const turnTools = toolsEnabled ? [...DEFAULT_TOOLS, ...mcpTools] : undefined;

      try {
        for await (const event of stream({
          model: currentModel,
          messages,
          ...(currentSystem ? { system: currentSystem } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(options.threadId ? { threadId: options.threadId } : {}),
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(turnTools ? { tools: turnTools } : {}),
          ...(toolsEnabled ? { maxSteps } : {}),
          ...(toolsEnabled && sandboxPath ? { sandboxPath } : {}),
          ...(toolsEnabled && !yolo ? { approval: approvalCallback } : {}),
          ...(toolsEnabled ? { yolo } : {}),
          ...(toolsEnabled ? { costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd } } : {}),
          ...(toolsEnabled ? { trifectaSeverity: 'warn' as const } : {}),
        })) {
          switch (event.type) {
            case 'text':
              output.write(event.delta);
              assistantText += event.delta;
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
              if (toolsEnabled) {
                output.write(`${ANSI.dim}  step ${event.step} → ${event.finishReason}${ANSI.reset}\n`);
              }
              break;
            case 'usage':
              usage = event.usage;
              break;
            case 'cost_warn':
              output.write(`\n${ANSI.yellow}! ${event.message}${ANSI.reset}\n`);
              break;
            case 'cost_abort':
              output.write(`\n${ANSI.red}× ${event.message}${ANSI.reset}\n`);
              break;
            case 'trifecta_warn':
              output.write(`\n${ANSI.yellow}! ${event.message}${ANSI.reset}\n`);
              break;
            case 'done':
              conversationId = event.result.conversationId;
              break;
            case 'error':
              output.write(`\n${ANSI.red}[error] ${event.error.message}${ANSI.reset}\n`);
              break;
          }
        }
      } catch (err) {
        output.write(`\n${ANSI.red}[error] ${err instanceof Error ? err.message : String(err)}${ANSI.reset}\n`);
        messages.pop(); // don't keep failed turn in history
        output.write('\n');
        continue;
      }

      messages.push({ role: 'assistant', content: assistantText });

      output.write('\n');
      if (usage) {
        output.write(
          `${ANSI.dim}[usage] in=${usage.inputTokens} out=${usage.outputTokens}` +
            (usage.cachedInputTokens ? ` cached=${usage.cachedInputTokens}` : '') +
            (usage.costUsd !== undefined ? ` cost=$${usage.costUsd.toFixed(6)}` : '') +
            `${ANSI.reset}\n`,
        );
      }
      output.write('\n');
    }
  } finally {
    rl.close();
    if (mcpResult) {
      await mcpResult.disconnectAll();
    }
    if (sandbox) {
      output.write(`${ANSI.dim}sandbox preserved at: ${sandbox.path}${ANSI.reset}\n`);
      output.write(`${ANSI.dim}to clean: rm -rf "${sandbox.path}"${ANSI.reset}\n`);
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
