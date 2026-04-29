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
import { runThreadCommand, type ThreadSubcommand } from './commands/thread.js';
import { runTracesCommand, type TracesSubcommand } from './commands/traces.js';
import { runSkillsCommand, type SkillsSubcommand } from './commands/skills.js';
import { runReplayCommand } from './commands/replay.js';
import { runCodifyCommand } from './commands/codify.js';
import { runReflectCommand } from './commands/reflect.js';
import { runRalphCommand } from './commands/ralph.js';
import { runEvolveCommand } from './commands/evolve.js';
import { runGainCommand } from './commands/gain.js';
import { runCompressMemoryCommand } from './commands/compress-memory.js';
import { runEvalThreeArmCommand } from './commands/eval-three-arm.js';
import {
  runFrqncyCommand,
  runFrqncyListCommand,
  runFrqncyValidateCommand,
  runFrqncyShowCommand,
} from './commands/frqncy.js';
import { runLearningAgentCommand, type LearningAgentSubcommand } from './commands/learning-agent.js';
import { runIdentityCommand, type IdentitySubcommand } from './commands/identity.js';
import { runPayCommand, type PaySubcommand } from './commands/pay.js';
import { hydrateApiKeysIntoEnv } from './auth/index.js';

const HELP = `
@frqncy-network/harness — plug-and-play LLM harness

Usage:
  frqncy-harness <command> [options]

Commands:
  chat <prompt>            One-shot completion. Streams to stdout.
                           Options: --model <m>, --system <s>, --resume <id>, --json
  repl                     Interactive REPL. Slash commands inside: /model, /new, /system, /tools, /yolo, /help, /exit
                           Options: --model <m>, --system <s>, --resume <id>
                                    --agent (enable tools + MCP + sandbox for a persistent agent conversation)
                                    --yolo, --max-steps <n>, --no-sandbox (only with --agent)
                                    --payments (install pay + discover_agents tools; only with --agent)
  agent <prompt>           Multi-step agent loop with tools (bash, file, web).
                           Creates a sandbox + external artifacts (progress.md, tasks.json, init.sh).
                           Options: --model <m>, --yolo, --max-steps <n>, --no-sandbox, --no-artifacts,
                                    --payments (install pay + discover_agents tools; needs wallet creds)
  doctor                   Health check (Node, API keys, trace dir, gtr, git)
  config <subcmd> [args]   list | get <path> | set <path> <value> | unset <path> | path
  costs [--period 7d]      Summarize spend over last period (e.g. 7d, 4w, 3m, all)
                           Options: --json, --thread <id>, --project <id>,
                                    --by-thread, --by-project
  traces <subcmd> [args]   list [--thread <id>] [--project <id>] [--since 7d] [--limit 20]
                           | show <conversation-id> | latest | path
                           Options: --json (on list / show / latest)
  mcp <subcmd> [args]      list | add <name> <command> [args...] | remove <name>
                           | enable <name> | disable <name> | path
                           | import-from-claude-desktop | test [<name>]
  auth <subcmd> [args]     status | set <provider> <key> | unset <provider> | path
                           (OAuth login is NOT available — Anthropic/OpenAI ToS forbids
                            consumer-subscription OAuth tokens in third-party tools)
  thread <subcmd> [args]   list | current | new <id> [--label '...'] [--project <id>]
                           | use <id> | none | rename <old> <new> | delete <id> | path
                           (Tags every conversation's trace + index with thread/project ids;
                            chat/repl/agent take --thread <id> to override the active thread)
  identity <subcmd> [args] register [--domain <d>] [--network base|base-sepolia] [--upload-to <path>] [--bind-smart-account] [--json]
                           | whoami | card [--out <path>] | serve [--port 3030]
                           | lookup <agentId> [--network base|base-sepolia] [--json]
                           (ERC-8004 trustless agent identity. Registers on-chain on Base and serves
                            /.well-known/agent-card.json + /.well-known/agent-registration.json. Requires
                            wallet credentials — set via 'auth set cdp-api-key-id …' or env vars.)
  pay <subcmd> [args]      test <url> [--max <atomic>] [--feedback-agent <id>] | balance | budget [show|set <usd>]
                           | discover | history [--last N] [--thread <id>] [--direction in|out] [--json]
                           (x402 micropayments. 'pay test' hits a 402'd URL and auto-pays under the cap.
                            'pay balance' reads native USDC on the agent's smart account + EOA.
                            'pay discover' queries the facilitator's registry of paid resources.
                            'pay history' tails the trace store for 'payment' records.)
  skills <subcmd> [args]   list | show <name> | path | match "<prompt>"
                           (Skills are markdown packs at ~/.frqncy-harness/skills/<name>/SKILL.md
                            with YAML frontmatter; auto-injected into chat/repl/agent system prompts
                            when the prompt matches the skill's keywords or description.)
  replay <conv-id>         Re-run a saved conversation against a (potentially different) model.
                           Options: --model <m>, --diff, --json, --thread <id>
                           (--diff prints a side-by-side comparison vs the original assistant reply.)
  codify <conv-id>         Take one failed conversation and generate a Vitest regression test
                           that would catch the failure if it recurred. The cornerstone
                           self-improvement primitive — operationalizes "watch the loop,
                           codify the failure" as a single command. Test starts as
                           describe.skip() so it doesn't break the suite when generated.
                           Options: --output <path>, --model <m>, --reason "<text>",
                                    --manifest <path>, --dry-run, --json
                           (See proposals/SELF-IMPROVING-HARNESS.md for the full design.)
  reflect                  Read N recent traces and generate a structured Markdown
                           proposal of the top recurring failure modes + a recommended
                           fix per mode (new hook / new skill / system-prompt amendment /
                           regression test). The cross-trace half of self-improvement;
                           pairs with codify (per-trace).
                           Options: --thread <id>, --project <id>, --last N, --since 7d,
                                    --output <path>, --model <m>, --include-success,
                                    --dry-run, --json
                           Default output: proposals/reflection-<YYYY-MM-DD>.md
  ralph "<prompt>"         Persistent outer loop. Re-invokes chat() against the same
                           prompt + thread until the completion-promise predicate
                           matches, max-iterations is hit, the cost cap fires, or
                           ~/.frqncy-harness/kill.flag appears.
                           Options: --until "<predicate>" (substring or /regex/),
                                    --max-iterations N (default 25), --thread <id>,
                                    --project <id>, --model <m>, --cwd <path>, --json
                           Default predicate: <promise>DONE</promise>
                           Kill switch: touch ~/.frqncy-harness/kill.flag
                           For tool work, use --model claude-sdk/* (the in-process SDK
                           lane does multi-step tool calling automatically). v0.8 ships
                           single-call iterations; full tools+MCP per iteration is v0.9.
  evolve                   Closes the self-improvement loop. Reads a reflection markdown
                           file (most recent in proposals/ by default), picks one
                           proposal, wraps ralph with the claude-sdk lane to implement
                           it, runs the pre-evolve gate (rubric-anchor + inoculation-
                           audit + voice-anchor), then runs \`npm test\` independently
                           to verify. With --auto-pr, also commits, pushes, and opens
                           a draft PR via \`gh pr create --draft\` with full provenance
                           metadata. Refuses on a dirty working tree unless --yes is
                           passed.
                           Options: --reflection <path>, --proposal N (default 1),
                                    --cwd <path>, --model <m>, --max-iterations N,
                                    --thread <id>, --yes, --skip-verify, --skip-gate,
                                    --auto-pr, --worktree, --keep-worktree, --json
                           Voice anchor: ~/.frqncy-harness/voice-anchor.md (optional;
                           when present, banned-phrase regex blocks off-brand prose
                           before the test gate runs).
                           --auto-pr: refuses on protected branches (main/master/develop/
                           production/release) unless --yes is also set. Always opens
                           DRAFT — never auto-merges. Requires \`gh\` CLI installed.
                           --worktree: runs all evolve operations inside an isolated gtr
                           worktree. Your main checkout is never touched. Pairs with
                           --auto-pr for fully sandboxed autonomy. Requires \`git gtr\`.
                           --keep-worktree: keep the worktree on disk after success
                           (default cleans up on success, keeps on failure for debug).
                           (See proposals/SELF-IMPROVING-HARNESS.md for the full design.)
  gain                     Cost decomposition by tool / model / lane / conversation
                           over a time window. Where \`costs\` shows total spend,
                           \`gain\` shows what the tokens went to.
                           Options: --period 7d, --top N (default 10),
                                    --thread <id>, --project <id>, --json
  compress-memory <target> Rewrite stable agent inputs (CLAUDE.md, AGENT.md, skill
                           READMEs) into compressed form, preserving the unchanged
                           original at <file>.original.md. Saves 40-60% on every
                           iteration forever. Idempotent (skips files where the
                           sidecar's hash matches what's already compressed).
                           Options: --model <m>, --dry-run, --force, --min-bytes N,
                                    --json
  frqncy "<prompt>"        Invoke FRQNCY OS — Orli's personal AI organization.
                           Loads persona system prompts from ./frqncy-os/ and
                           routes the prompt to one or more personas. Modes:
                             frqncy "<p>"                     → AUTO: FRQNCY routes,
                                                                invokes persona(s),
                                                                synthesizes if multi
                             frqncy --persona <name> "<p>"    → direct invocation
                             frqncy --council "<question>"    → all 7 in parallel
                             frqncy --no-route "<p>"          → FRQNCY responds in
                                                                own voice (v0.11)
                             frqncy --list                    → enumerate the org
                                                                (FRQNCY/Council/C-Suite/
                                                                Workers/Meta) with
                                                                models + flags
                             frqncy --validate                → check architectural
                                                                invariants (Council
                                                                completeness, evolves
                                                                rules, parent resolution,
                                                                inoculation coverage).
                                                                Exit non-zero on error.
                             frqncy --show <slug>             → drill into one persona
                                                                (frontmatter + full system
                                                                prompt, byte count,
                                                                inoculation status)
                           Personas: 1 FRQNCY + 7 Council + 6 C-Suite + 19 Workers + Learning Agent.
                           All traces tagged thread=frqncy-os/<persona>, project=frqncy-os —
                           queryable via reflect/codify/gain/costs.
                           Options: --persona <name>, --council, --no-route, --save, --list,
                                    --validate, --show <slug>, --persona-dir <path>,
                                    --model <m>, --json
                           --save: with --council, writes a structured deliberation
                           record to proposals/council-deliberations/<date>-<slug>.md
                           (the trace store already keeps the raw invocations).
  learning-agent <subcmd>  The Learning Agent — meta-tier sibling of FRQNCY.
                           Reads recent FRQNCY OS traces, identifies recurring
                           failure modes per persona, proposes prompt updates.
                             learning-agent run [--persona <name>] [--apply]
                             learning-agent list-pending
                             learning-agent help
                           Hard rules: NEVER touches Council personas (Council
                           prompts evolve only by Orli's hand). Default is
                           dry-run; --apply writes the proposal markdown.
                           Options: --persona <name>, --since 7d, --last 30,
                                    --apply, --model <m>, --json
  eval-three-arm <skill>   Run a three-arm eval against a fixture dataset:
                           (baseline / generic-modifier / full-skill) and reject
                           skills whose lift over the generic modifier is below the
                           threshold (default 5pp). Catches placebo improvements.
                           Options: --dataset <path>, --model <m>,
                                    --modifier "<text>", --lift-threshold N, --json

Global:
  --version, -v            Print version
  --help, -h               This help

Model strings (API path — pay per token, full feature support):
  anthropic/claude-sonnet-4-6
  anthropic/claude-opus-4-6
  anthropic/claude-haiku-4-5-20251001
  openai/gpt-5
  openai/gpt-5-mini
  google/gemini-2.5-pro
  google/gemini-2.5-flash
  openrouter/<provider>/<model>   (e.g. openrouter/nousresearch/hermes-4-405b)
  chutes/<provider>/<model>       (decentralized inference, set CHUTES_API_KEY; e.g. chutes/deepseek-ai/deepseek-r1)
  perplexity/sonar                (search-grounded; returns sources alongside text)
  perplexity/sonar-pro
  perplexity/sonar-reasoning      (DeepSeek R1 + Perplexity search)

Model strings (SDK path — programmatic agent loop; full tool/MCP/hook support, real per-token cost):
  claude-sdk/claude-sonnet-4-6    (uses @anthropic-ai/claude-agent-sdk; needs ANTHROPIC_API_KEY)
  claude-sdk/claude-opus-4-6
  claude-sdk/claude-haiku-4-5-20251001

Model strings (subscription path — uses your Max/Pro quota; no tools, limited streaming):
  claude-code/sonnet              (requires "claude" CLI installed; uses Claude Max)
  claude-code/opus
  claude-code/haiku
  codex/default                   (requires "codex" CLI installed; uses ChatGPT Pro)
  codex/gpt-5

Examples:
  frqncy-harness chat "summarize the harness.md doc"
  frqncy-harness chat "explain MCP" --model openai/gpt-5
  frqncy-harness chat "what is MCP" --model claude-code/sonnet     # uses Claude Max
  frqncy-harness chat "explain context graphs" --model codex/default # uses ChatGPT Pro
  frqncy-harness repl --model openrouter/nousresearch/hermes-4-405b
  frqncy-harness repl --agent --model openrouter/google/gemini-2.5-flash --yolo  # persistent agent chat
  frqncy-harness config set defaultModel claude-code/sonnet
  frqncy-harness config set costCap.softWarnUsd 10
  frqncy-harness costs --period 30d

Docs: https://github.com/0rli-E/frqncy-harness#readme
`;

const VERSION = '0.13.4-alpha.1';

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
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'repl': {
        const replMaxStepsStr = flagString(flags, 'max-steps');
        await runReplCommand({
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(flagString(flags, 'system') ? { system: flagString(flags, 'system')! } : {}),
          ...(flagString(flags, 'resume') ? { resume: flagString(flags, 'resume')! } : {}),
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
          agent: flagBool(flags, 'agent'),
          yolo: flagBool(flags, 'yolo'),
          ...(replMaxStepsStr ? { maxSteps: Number(replMaxStepsStr) } : {}),
          noSandbox: flagBool(flags, 'no-sandbox'),
          payments: flagBool(flags, 'payments'),
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
          payments: flagBool(flags, 'payments'),
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
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
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
          byThread: flagBool(flags, 'by-thread'),
          byProject: flagBool(flags, 'by-project'),
        });
        break;
      case 'traces': {
        const sub = positional[0] as TracesSubcommand | undefined;
        if (!sub) {
          throw new Error('Usage: frqncy-harness traces <list|show|latest|path> [args]');
        }
        await runTracesCommand(sub, positional.slice(1));
        break;
      }
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
      case 'thread': {
        const sub = positional[0] as ThreadSubcommand | undefined;
        if (!sub) {
          throw new Error(
            'Usage: frqncy-harness thread <list|current|new|use|none|rename|delete|path> [args]',
          );
        }
        await runThreadCommand(sub, positional.slice(1));
        break;
      }
      case 'skills': {
        const sub = positional[0] as SkillsSubcommand | undefined;
        if (!sub) {
          throw new Error('Usage: frqncy-harness skills <list|show|path|match> [args]');
        }
        await runSkillsCommand(sub, positional.slice(1));
        break;
      }
      case 'replay': {
        const id = positional[0];
        if (!id) throw new Error('Usage: frqncy-harness replay <conversation-id> [--model <m>] [--diff] [--json]');
        await runReplayCommand(id, {
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          diff: flagBool(flags, 'diff'),
          json: flagBool(flags, 'json'),
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
        });
        break;
      }
      case 'codify': {
        const id = positional[0];
        if (!id) {
          throw new Error(
            'Usage: frqncy-harness codify <conversation-id> [--output <path>] [--model <m>] [--reason "<text>"] [--manifest <path>] [--dry-run] [--json]',
          );
        }
        await runCodifyCommand(id, {
          ...(flagString(flags, 'output') ? { output: flagString(flags, 'output')! } : {}),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(flagString(flags, 'reason') ? { reason: flagString(flags, 'reason')! } : {}),
          ...(flagString(flags, 'manifest') ? { manifest: flagString(flags, 'manifest')! } : {}),
          dryRun: flagBool(flags, 'dry-run'),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'reflect': {
        const lastStr = flagString(flags, 'last');
        await runReflectCommand({
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
          ...(lastStr ? { last: Number(lastStr) } : {}),
          ...(flagString(flags, 'since') ? { since: flagString(flags, 'since')! } : {}),
          ...(flagString(flags, 'output') ? { output: flagString(flags, 'output')! } : {}),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          dryRun: flagBool(flags, 'dry-run'),
          json: flagBool(flags, 'json'),
          includeSuccess: flagBool(flags, 'include-success'),
        });
        break;
      }
      case 'ralph': {
        const ralphPrompt = positional.join(' ');
        if (!ralphPrompt.trim()) {
          throw new Error(
            'Usage: frqncy-harness ralph "<prompt>" [--until "<predicate>"] [--max-iterations N] [--thread <id>] [--model <m>] [--cwd <path>] [--json]',
          );
        }
        const maxIterStr = flagString(flags, 'max-iterations');
        await runRalphCommand(ralphPrompt, {
          ...(flagString(flags, 'until') ? { until: flagString(flags, 'until')! } : {}),
          ...(maxIterStr ? { maxIterations: Number(maxIterStr) } : {}),
          ...(flagString(flags, 'cwd') ? { cwd: flagString(flags, 'cwd')! } : {}),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'gain': {
        const topStr = flagString(flags, 'top');
        await runGainCommand({
          ...(flagString(flags, 'period') ? { period: flagString(flags, 'period')! } : {}),
          ...(topStr ? { top: Number(topStr) } : {}),
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          ...(flagString(flags, 'project') ? { projectId: flagString(flags, 'project')! } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'compress-memory': {
        const target = positional[0];
        if (!target) {
          throw new Error(
            'Usage: frqncy-harness compress-memory <target-dir-or-file> [--model <m>] [--dry-run] [--force] [--min-bytes N] [--json]',
          );
        }
        const minBytesStr = flagString(flags, 'min-bytes');
        await runCompressMemoryCommand(target, {
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          dryRun: flagBool(flags, 'dry-run'),
          force: flagBool(flags, 'force'),
          ...(minBytesStr ? { minBytes: Number(minBytesStr) } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'frqncy': {
        // --list is prompt-free: enumerates every persona in the org.
        if (flagBool(flags, 'list')) {
          await runFrqncyListCommand({
            ...(flagString(flags, 'persona-dir') ? { personaDir: flagString(flags, 'persona-dir')! } : {}),
            json: flagBool(flags, 'json'),
          });
          break;
        }
        // --validate is prompt-free: checks architectural invariants over the persona dir.
        if (flagBool(flags, 'validate')) {
          const result = await runFrqncyValidateCommand({
            ...(flagString(flags, 'persona-dir') ? { personaDir: flagString(flags, 'persona-dir')! } : {}),
            json: flagBool(flags, 'json'),
          });
          // Exit non-zero on any error so CI pipelines can gate on `frqncy --validate`.
          if (!result.ok) process.exitCode = 1;
          break;
        }
        // --show <slug> is prompt-free: render frontmatter + system prompt for one persona.
        const showSlug = flagString(flags, 'show');
        if (showSlug) {
          await runFrqncyShowCommand(showSlug, {
            ...(flagString(flags, 'persona-dir') ? { personaDir: flagString(flags, 'persona-dir')! } : {}),
            json: flagBool(flags, 'json'),
          });
          break;
        }
        const frqncyPrompt = positional.join(' ');
        if (!frqncyPrompt.trim()) {
          throw new Error(
            'Usage: frqncy-harness frqncy "<prompt>" [--persona <name>] [--council] [--no-route] [--save] [--model <m>] [--json]\n' +
              '       frqncy-harness frqncy --list [--json]\n' +
              '       frqncy-harness frqncy --validate [--json]\n' +
              '       frqncy-harness frqncy --show <slug> [--json]',
          );
        }
        await runFrqncyCommand(frqncyPrompt, {
          ...(flagString(flags, 'persona') ? { persona: flagString(flags, 'persona')! } : {}),
          council: flagBool(flags, 'council'),
          noRoute: flagBool(flags, 'no-route'),
          save: flagBool(flags, 'save'),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'learning-agent': {
        const sub = (positional[0] ?? 'help') as LearningAgentSubcommand;
        const lastStr = flagString(flags, 'last');
        await runLearningAgentCommand(sub, {
          ...(flagString(flags, 'persona') ? { persona: flagString(flags, 'persona')! } : {}),
          ...(flagString(flags, 'since') ? { since: flagString(flags, 'since')! } : {}),
          ...(lastStr ? { last: Number(lastStr) } : {}),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          apply: flagBool(flags, 'apply'),
          autoPr: flagBool(flags, 'auto-pr'),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'eval-three-arm': {
        const skill = positional[0];
        if (!skill) {
          throw new Error(
            'Usage: frqncy-harness eval-three-arm <skill-name> [--dataset <path>] [--model <m>] [--modifier "<text>"] [--lift-threshold N] [--json]',
          );
        }
        const liftStr = flagString(flags, 'lift-threshold');
        await runEvalThreeArmCommand(skill, {
          ...(flagString(flags, 'dataset') ? { dataset: flagString(flags, 'dataset')! } : {}),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(flagString(flags, 'modifier') ? { modifier: flagString(flags, 'modifier')! } : {}),
          ...(liftStr ? { liftThreshold: Number(liftStr) } : {}),
          json: flagBool(flags, 'json'),
        });
        break;
      }
      case 'identity': {
        const sub = positional[0] as IdentitySubcommand | undefined;
        if (!sub) {
          throw new Error(
            'Usage: frqncy-harness identity <register|whoami|card|serve|lookup> [args]',
          );
        }
        await runIdentityCommand(sub, positional.slice(1));
        break;
      }
      case 'pay': {
        const sub = positional[0] as PaySubcommand | undefined;
        if (!sub) {
          throw new Error('Usage: frqncy-harness pay <test|balance|budget|discover> [args]');
        }
        await runPayCommand(sub, positional.slice(1));
        break;
      }
      case 'evolve': {
        const proposalStr = flagString(flags, 'proposal');
        const evolveMaxIterStr = flagString(flags, 'max-iterations');
        await runEvolveCommand({
          ...(flagString(flags, 'reflection') ? { reflectionPath: flagString(flags, 'reflection')! } : {}),
          ...(proposalStr ? { proposal: Number(proposalStr) } : {}),
          ...(flagString(flags, 'cwd') ? { cwd: flagString(flags, 'cwd')! } : {}),
          ...(flagString(flags, 'model') ? { model: flagString(flags, 'model')! } : {}),
          ...(evolveMaxIterStr ? { maxIterations: Number(evolveMaxIterStr) } : {}),
          ...(flagString(flags, 'thread') ? { threadId: flagString(flags, 'thread')! } : {}),
          yes: flagBool(flags, 'yes'),
          skipVerify: flagBool(flags, 'skip-verify'),
          skipGate: flagBool(flags, 'skip-gate'),
          autoPr: flagBool(flags, 'auto-pr'),
          worktree: flagBool(flags, 'worktree'),
          keepWorktree: flagBool(flags, 'keep-worktree'),
          json: flagBool(flags, 'json'),
        });
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
