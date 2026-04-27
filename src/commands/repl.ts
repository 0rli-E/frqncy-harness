/**
 * `frqncy-harness repl` — interactive REPL with model swap.
 *
 * Plain readline implementation for v0.1; Ink-based TUI is a v0.2 polish.
 *
 * Slash commands inside the REPL:
 *   /model <model>      switch the model mid-conversation
 *   /new                start a fresh conversation
 *   /resume <id>        resume a past conversation by id
 *   /system <text>      set the system prompt for subsequent turns
 *   /help               list commands
 *   /exit, /quit, ^C    leave the REPL
 */
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { stream } from '../stream.js';
import { loadConfig } from '../config.js';
import { loadProjectInstructions } from '../instructions.js';
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
};

export interface ReplCommandOptions {
  model?: string;
  system?: string;
  resume?: string;
}

export async function runReplCommand(options: ReplCommandOptions): Promise<void> {
  const config = await loadConfig();
  let currentModel = (options.model ?? config.defaultModel) as ModelString;
  let currentSystem = options.system;
  let systemSource: string | undefined;
  let conversationId: string | undefined = options.resume;
  let messages: Message[] = [];

  // Auto-load AGENT.md / CLAUDE.md as initial system prompt when none provided
  // and we're not resuming a saved conversation.
  if (!currentSystem && !conversationId) {
    const loaded = await loadProjectInstructions(process.cwd());
    if (loaded) {
      currentSystem = loaded.content;
      systemSource = loaded.source;
    }
  }

  const rl = createInterface({ input, output });

  // Header
  output.write(
    `${ANSI.bold}${ANSI.cyan}@frqncy-network/harness REPL${ANSI.reset} ${ANSI.dim}(type /help for commands)${ANSI.reset}\n`,
  );
  output.write(`${ANSI.dim}model: ${currentModel}${ANSI.reset}\n`);
  if (currentSystem) {
    const label = systemSource ? `system (${systemSource})` : 'system';
    output.write(`${ANSI.dim}${label}: ${currentSystem.slice(0, 60)}${currentSystem.length > 60 ? '...' : ''}${ANSI.reset}\n`);
  }
  if (conversationId) {
    output.write(`${ANSI.dim}resuming: ${conversationId}${ANSI.reset}\n`);
  }
  output.write('\n');

  const prompt = () => `${ANSI.cyan}you ▸${ANSI.reset} `;

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
          rl.close();
          return;
        case 'help':
          output.write(
            `${ANSI.dim}/model <model>    switch model (e.g. /model openai/gpt-5)\n` +
              `/new              start a fresh conversation\n` +
              `/resume <id>      resume a past conversation\n` +
              `/system <text>    set system prompt\n` +
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
        default:
          output.write(`${ANSI.red}unknown command: /${cmd}${ANSI.reset} (try /help)\n\n`);
          continue;
      }
    }

    // Regular user message — append to history and call the model
    messages.push({ role: 'user', content: trimmed });
    output.write(`${ANSI.green}${currentModel.split('/').pop()} ▸${ANSI.reset} `);

    let assistantText = '';
    let usage: Usage | undefined;

    try {
      for await (const event of stream({
        model: currentModel,
        messages,
        ...(currentSystem ? { system: currentSystem } : {}),
        ...(conversationId ? { conversationId } : {}),
      })) {
        switch (event.type) {
          case 'text':
            output.write(event.delta);
            assistantText += event.delta;
            break;
          case 'usage':
            usage = event.usage;
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

  rl.close();
}
