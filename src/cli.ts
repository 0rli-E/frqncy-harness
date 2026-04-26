#!/usr/bin/env node
/**
 * `frqncy-harness` CLI entry point.
 *
 * Subcommands:
 *   chat <prompt>            one-shot conversation
 *   repl                     interactive REPL
 *   doctor                   health check
 *   config <subcmd> [args]   manage config
 *   costs [--period 7d]      summarize spend
 *   --version                print version
 *   --help                   print this help
 */
import { ZodError } from 'zod';
import { runChatCommand } from './commands/chat.js';
import { runReplCommand } from './commands/repl.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runConfigCommand, type ConfigSubcommand } from './commands/config.js';
import { runCostsCommand } from './commands/costs.js';
import { runAgentCommand } from './commands/agent.js';
import { runMcpCommand, type McpSubcommand } from './commands/mcp.js';
import { runAuthCommand, type AuthSubcommand } from './commands/auth.js';
import { hydrateApiKeysIntoEnv } from './auth/index.js';

const HELP = `
@frqncy/harness — plug-and-play LLM harness

Usage:
  frqncy-harness <command> [options]

Commands:
  chat <prompt>            One-shot completion. Streams to stdout.
                           Options: --model <m>, --system <s>, --resume <id>, --json
  repl                     Interactive REPL. Slash commands inside: /model, /new, /system, /help, /exit
                           Options: --model <m>, --system <s>, --resume <id>
  agent <prompt>           Multi-step agent loop with tools (bash, file, web).
                           Creates a sandbox + external artifacts (progress.md, tasks.json, init.sh).
                           Options: --model <m>, --yolo, --max-steps <n>, --no-sandbox, --no-artifacts
  doctor                   Health check (Node, API keys, trace dir, gtr, git)
  config <subcmd> [args]   list | get <path> | set <path> <value> | unset <path> | path
  costs [--period 7d]      Summarize spend over last period (e.g. 7d, 4w, 3m, all)
                           Options: --json
  mcp <subcmd> [args]      list | add <name> <command> [args...] | remove <name>
                           | enable <name> | disable <name> | path
                           | import-from-claude-desktop | test [<name>]
  auth <subcmd> [args]     status | set <provider> <key> | unset <provider> | path
                           (login/logout for Claude Max OAuth in v0.3)

Global:
  --version, -v            Print version
  --help, -h               This help

Model strings:
  anthropic/claude-sonnet-4-6
  anthropic/claude-opus-4-6
  anthropic/claude-haiku-4-5-20251001
  openai/gpt-5
  openai/gpt-5-mini
  google/gemini-2.5-pro
  google/gemini-2.5-flash
  openrouter/<provider>/<model>   (e.g. openrouter/nousresearch/hermes-4-405b)

Examples:
  frqncy-harness chat "summarize the harness.md doc"
  frqncy-harness chat "explain MCP" --model openai/gpt-5
  frqncy-harness repl --model openrouter/nousresearch/hermes-4-405b
  frqncy-harness config set defaultModel anthropic/claude-sonnet-4-6
  frqncy-harness config set costCap.softWarnUsd 10
  frqncy-harness costs --period 30d

Docs: https://github.com/0xOrli/frqncy-harness#readme
`;

const VERSION = '0.3.0-alpha.1';

interface ParsedArgs {
  command?: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  let command: string | undefined;
  if (argv[0] && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
  }
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1);
      flags[key] = true;
      i++;
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { command: command ?? undefined, positional, flags };
}

function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, positional, flags } = parseArgs(argv);

  if (flagBool(flags, 'version') || flagBool(flags, 'v')) {
    process.stdout.write(VERSION + '\n');
    return;
  }
  if (flagBool(flags, 'help') || flagBool(flags, 'h') || command === 'help' || !command) {
    process.stdout.write(HELP);
    return;
  }

  // Hydrate stored API keys into env vars before any provider call (v0.2 auth)
  await hydrateApiKeysIntoEnv();

  try {
    switch (command) {
      case 'chat': {
        const prompt = positional.join(' ');
        await runChatCommand(prompt, {
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(flagString(flags, 'system') ? { system: flagString(flags, 'system')! } : {}),
          ...(flagString(flags, 'resume') ? { resume: flagString(flags, 'resume')! } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'repl': {
        await runReplCommand({
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(flagString(flags, 'system') ? { system: flagString(flags, 'system')! } : {}),
          ...(flagString(flags, 'resume') ? { resume: flagString(flags, 'resume')! } : {}),
        });
        break;
      }
      case 'agent': {
        const prompt = positional.join(' ');
        const maxStepsStr = flagString(flags, 'max-steps');
        await runAgentCommand(prompt, {
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          yolo: flagBool(flags, 'yolo'),
          ...(maxStepsStr ? { maxSteps: Number(maxStepsStr) } : {}),
          noSandbox: flagBool(flags, 'no-sandbox'),
          noArtifacts: flagBool(flags, 'no-artifacts'),
        });
        break;
      }
      case 'doctor':
        await runDoctorCommand();
        break;
      case 'config': {
        const sub = positional[0] as ConfigSubcommand | undefined;
        if (!sub) {
          throw new Error('Usage: frqncy-harness config <list|get|set|unset|path> [args]');
        }
        await runConfigCommand(sub, positional.slice(1));
        break;
      }
      case 'costs':
        await runCostsCommand({
          ...(flagString(flags, 'period') ? { period: flagString(flags, 'period')! } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      case 'mcp': {
        const sub = positional[0] as McpSubcommand | undefined;
        if (!sub) {
          throw new Error(
            'Usage: frqncy-harness mcp <list|add|remove|enable|disable|path|import-from-claude-desktop|test> [args]',
          );
        }
        await runMcpCommand(sub, positional.slice(1));
        break;
      }
      case 'auth': {
        const sub = positional[0] as AuthSubcommand | undefined;
        if (!sub) {
          throw new Error('Usage: frqncy-harness auth <status|set|unset|path|login|logout> [args]');
        }
        await runAuthCommand(sub, positional.slice(1));
        break;
      }
      default:
        process.stderr.write(`unknown command: ${command}\n${HELP}`);
        process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`\nerror: ${formatError(err)}\n`);
    process.exit(1);
  }
}

function formatError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues
      .map((i) => `  - ${i.path.length > 0 ? i.path.join('.') + ': ' : ''}${i.message}`)
      .join('\n');
    return `validation failed:\n${issues}`;
  }
  if (err instanceof Error) {
    // Walk the cause chain to find the most actionable underlying error.
    const root = findRootCause(err);
    const message = root.message;

    if (root.name === 'AI_LoadAPIKeyError' || /API[_ ]key/i.test(message)) {
      return `${message}\nhint: set the relevant API key env var (e.g. ANTHROPIC_API_KEY=sk-ant-...). Run 'frqncy-harness doctor' to see which keys are detected.`;
    }
    return message;
  }
  return String(err);
}

function findRootCause(err: Error): Error {
  let current = err;
  while (current.cause instanceof Error) {
    current = current.cause;
  }
  return current;
}

main().catch((err) => {
  process.stderr.write(`\nfatal: ${formatError(err)}\n`);
  process.exit(1);
});
