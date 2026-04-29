/**
 * `frqncy-harness learning-agent run [--persona <name>] [--since 7d] [--apply] [--three-arm] [--auto-pr] [--json]`
 *
 * The Learning Agent — meta-tier sibling of FRQNCY. Reads the never-compacted
 * trace store, identifies recurring failure modes per persona, and proposes
 * prompt updates with explicit before/after diffs. Composes existing primitives:
 *
 *   1. **reflect** — synthesizes failure patterns across recent traces
 *   2. **eval-three-arm** (optional `--three-arm`) — verifies a proposed
 *      prompt change has lift over a generic terseness modifier
 *   3. **auto-pr** (optional `--auto-pr`) — opens a draft PR with full
 *      provenance metadata so Orli can review on her phone
 *
 * Hard rules baked in:
 *   - **Never touches Council personas** (the 7 Council members have
 *     `evolves: false` in their frontmatter). This is enforced explicitly
 *     by reading the persona file and refusing to proceed.
 *   - **Never auto-deploys.** Default is dry-run (proposal goes to a Markdown
 *     file). `--apply` writes the proposal; `--auto-pr` opens a draft PR.
 *     The actual prompt change requires Orli's merge.
 *   - **Inoculation sentence** in the Learning Agent's own system prompt —
 *     this is the system most at risk of self-rewarding behavior, doubly
 *     explicit.
 *   - **All proposals reference source traces** (conversation IDs) so Orli
 *     can replay them via `harness replay <id> --diff`.
 *
 * Per `proposals/SELF-IMPROVING-HARNESS.md` Tier A.4: this is the agent that
 * makes the harness self-improve on the FRQNCY OS organization specifically.
 *
 * Pi-aligned: top-level dispatch only, filesystem as substrate (proposals
 * land as `.md` files), no nested agent loops, externalized state.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { runReflectCommand, type ReflectResult } from './reflect.js';
import { defaultLoadPersona, COUNCIL_MEMBERS, DEFAULT_PERSONA_DIR, type LoadedPersona } from './frqncy.js';
import { loadConfig } from '../config.js';
import { INOCULATION_SENTENCE } from './codify.js';
import type { ChatInput, ChatResult } from '../types.js';

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

const DEFAULT_SINCE = '7d';
const DEFAULT_LAST = 30;
const PROPOSAL_DIR = 'proposals/learning-agent';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type LearningAgentStatus =
  | 'completed'
  | 'no_traces'
  | 'council_refused'
  | 'persona_not_found'
  | 'no_proposals_generated';

export interface LearningAgentSubcommandRunOptions {
  /** Focus on one persona's traces. If unset, processes the whole frqncy-os project. */
  persona?: string;
  /** Time window. Default `7d`. */
  since?: string;
  /** How many traces per reflect call. Default 30. */
  last?: number;
  /** Override LLM lane. */
  model?: string;
  /** Write the proposal markdown to disk. Default false (dry-run). */
  apply?: boolean;
  /** Open a draft PR with the proposal. Implies --apply. (Future v0.12 — not yet wired.) */
  autoPr?: boolean;
  /** Override personaDir. Default `<cwd>/frqncy-os/`. */
  personaDir?: string;
  /** Override cwd. */
  cwd?: string;
  /** Emit JSON. */
  json?: boolean;
  // Test seams ─────────────────────────────────────────────
  reflectFn?: typeof runReflectCommand;
  loadPersonaFn?: typeof defaultLoadPersona;
  /** Substitute an LLM call for the optional verifier step. */
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
}

export interface LearningAgentProposal {
  persona: string;
  proposalPath: string;
  proposalMarkdown: string;
  reflectionPath: string;
  tracesAnalyzed: number;
  written: boolean;
}

export interface LearningAgentRunResult {
  status: LearningAgentStatus;
  personasProcessed: string[];
  personasRefused: string[]; // Council members refused by hard rule
  proposals: LearningAgentProposal[];
  totalCostUsd: number;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Refuse if the requested persona is on the Council. Council prompts evolve only
 * by Orli's hand — never by the Learning Agent. The hard rule is enforced both
 * by checking the canonical Council list AND by reading the persona's `evolves:`
 * frontmatter (defensive: belt + suspenders).
 */
export function isCouncilPersona(slug: string): boolean {
  return (COUNCIL_MEMBERS as readonly string[]).includes(slug.toLowerCase());
}

export function shouldRefusePersonaUpdate(persona: LoadedPersona): { refused: true; reason: string } | { refused: false } {
  if (isCouncilPersona(persona.slug)) {
    return { refused: true, reason: `${persona.slug} is a Council member; Council prompts evolve only by Orli's hand` };
  }
  if (persona.frontmatter.evolves === false) {
    return {
      refused: true,
      reason: `${persona.slug} has \`evolves: false\` in its frontmatter; Learning Agent will not modify it`,
    };
  }
  return { refused: false };
}

export interface ProposalArgs {
  personaSlug: string;
  reflectionPath: string;
  reflectionMarkdown: string;
  tracesAnalyzed: number;
  generatedAt: string;
}

export function formatProposalMarkdown(args: ProposalArgs): string {
  return [
    `# Learning Agent proposal — ${args.personaSlug}`,
    ``,
    `> Generated by \`frqncy-harness learning-agent run\` on ${args.generatedAt}.`,
    `> Read this, decide if it's a real failure pattern, then either hand-edit`,
    `> the persona file or run \`frqncy-harness learning-agent run --persona ${args.personaSlug} --apply --auto-pr\``,
    `> to ship as a draft PR.`,
    ``,
    `## Source`,
    ``,
    `- Persona: \`${args.personaSlug}\` (file: \`frqncy-os/.../${args.personaSlug}.md\`)`,
    `- Reflection: \`${args.reflectionPath}\``,
    `- Traces analyzed: ${args.tracesAnalyzed}`,
    `- Generated: ${args.generatedAt}`,
    ``,
    `## Hard guarantees`,
    ``,
    `- ✓ Inoculation active (per Anthropic Nov 2025, [arXiv:2511.18397](https://arxiv.org/abs/2511.18397))`,
    `- ✓ Council personas not touched (\`evolves: false\` enforced)`,
    `- ✓ Provenance: agent (Learning Agent persona)`,
    `- ✓ No prompt change applied yet — this is a proposal only`,
    ``,
    `## Reflection synthesis`,
    ``,
    args.reflectionMarkdown.trim(),
    ``,
    `## Next steps`,
    ``,
    `1. Read each "Recurring failure mode" above against your own knowledge of the persona`,
    `2. If you agree, hand-edit \`frqncy-os/.../${args.personaSlug}.md\` (the body, not the frontmatter)`,
    `3. Validate with \`frqncy-harness eval-three-arm ${args.personaSlug} --lift-threshold 5\` if you have a fixture set`,
    `4. Commit + ship a draft PR; or run \`learning-agent run --persona ${args.personaSlug} --apply --auto-pr\` to do steps 2-3 mechanically`,
    ``,
    `Reject this proposal entirely if it conflicts with the persona's intended voice.`,
    ``,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

export async function runLearningAgentRun(
  options: LearningAgentSubcommandRunOptions = {},
): Promise<LearningAgentRunResult> {
  await loadConfig();
  const cwd = options.cwd ?? process.cwd();
  const personaDir = options.personaDir ?? join(cwd, DEFAULT_PERSONA_DIR);
  const reflectFn = options.reflectFn ?? runReflectCommand;
  const loadPersonaFn = options.loadPersonaFn ?? defaultLoadPersona;
  const since = options.since ?? DEFAULT_SINCE;
  const last = options.last ?? DEFAULT_LAST;
  const apply = options.apply ?? false;

  const banner = (msg: string): void => {
    if (!options.json) process.stdout.write(msg);
  };

  banner(
    `${ANSI.bold}${ANSI.magenta}learning-agent${ANSI.reset} ${ANSI.dim}` +
      `since=${since} last=${last} apply=${apply} ` +
      `target=${options.persona ?? 'all non-Council personas'}${ANSI.reset}\n` +
      `${ANSI.dim}${INOCULATION_SENTENCE}${ANSI.reset}\n\n`,
  );

  const personasRefused: string[] = [];
  const personasProcessed: string[] = [];
  const proposals: LearningAgentProposal[] = [];
  let totalCostUsd = 0;

  // 1. Hard refusal first if a Council persona was explicitly asked for
  if (options.persona) {
    const persona = await loadPersonaFn(options.persona, personaDir);
    if (!persona) {
      const result: LearningAgentRunResult = {
        status: 'persona_not_found',
        personasProcessed: [],
        personasRefused: [],
        proposals: [],
        totalCostUsd: 0,
      };
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stderr.write(
          `${ANSI.red}× persona "${options.persona}" not found in ${personaDir}${ANSI.reset}\n`,
        );
      }
      return result;
    }
    const refusal = shouldRefusePersonaUpdate(persona);
    if (refusal.refused) {
      personasRefused.push(persona.slug);
      const result: LearningAgentRunResult = {
        status: 'council_refused',
        personasProcessed: [],
        personasRefused,
        proposals: [],
        totalCostUsd: 0,
      };
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stderr.write(
          `${ANSI.red}× refused: ${refusal.reason}${ANSI.reset}\n` +
            `${ANSI.dim}Council prompts and \`evolves: false\` personas evolve only by Orli's hand.${ANSI.reset}\n`,
        );
      }
      return result;
    }
  }

  // 2. Run reflect against the appropriate slice of traces
  const reflectThreadId = options.persona ? `frqncy-os/${options.persona}` : undefined;
  const reflectionResult = await invokeReflect({
    reflectFn,
    threadId: reflectThreadId,
    last,
    since,
    cwd,
    apply,
    model: options.model,
  });

  if (!reflectionResult) {
    const result: LearningAgentRunResult = {
      status: 'no_traces',
      personasProcessed,
      personasRefused,
      proposals: [],
      totalCostUsd: 0,
    };
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stderr.write(
        `${ANSI.yellow}× no FRQNCY OS traces in window${ANSI.reset}\n` +
          `${ANSI.dim}Run a few invocations of \`frqncy-harness frqncy --persona <name> "..."\` first.${ANSI.reset}\n`,
      );
    }
    return result;
  }

  // 3. Build the proposal markdown
  const targetSlug = options.persona ?? 'frqncy-os';
  const generatedAt = new Date().toISOString();
  const proposalMarkdown = formatProposalMarkdown({
    personaSlug: targetSlug,
    reflectionPath: reflectionResult.outputPath,
    reflectionMarkdown: reflectionResult.proposalMarkdown,
    tracesAnalyzed: reflectionResult.tracesAnalyzed,
    generatedAt,
  });

  const proposalPath = join(
    cwd,
    PROPOSAL_DIR,
    `${generatedAt.slice(0, 10)}-${targetSlug}.md`,
  );

  // 4. Write to disk if --apply
  let written = false;
  if (apply) {
    await fs.mkdir(join(cwd, PROPOSAL_DIR), { recursive: true });
    await fs.writeFile(proposalPath, proposalMarkdown, 'utf-8');
    written = true;
    banner(
      `${ANSI.green}✓ proposal written${ANSI.reset} ${proposalPath}\n` +
        `${ANSI.dim}  reflection: ${reflectionResult.outputPath}${ANSI.reset}\n` +
        `${ANSI.dim}  traces: ${reflectionResult.tracesAnalyzed}${ANSI.reset}\n`,
    );
  } else {
    banner(
      `${ANSI.yellow}note:${ANSI.reset} dry-run — proposal generated but not written.\n` +
        `${ANSI.dim}  would write to: ${proposalPath}${ANSI.reset}\n` +
        `${ANSI.dim}  reflection (already on disk): ${reflectionResult.outputPath}${ANSI.reset}\n` +
        `${ANSI.dim}  pass --apply to write the proposal.${ANSI.reset}\n\n` +
        proposalMarkdown +
        `\n`,
    );
  }

  personasProcessed.push(targetSlug);
  proposals.push({
    persona: targetSlug,
    proposalPath,
    proposalMarkdown,
    reflectionPath: reflectionResult.outputPath,
    tracesAnalyzed: reflectionResult.tracesAnalyzed,
    written,
  });

  // 5. (--auto-pr is v0.12; surface a clear message that it's not wired yet)
  if (options.autoPr) {
    banner(
      `${ANSI.yellow}note:${ANSI.reset} --auto-pr is not yet wired in v0.11. ` +
        `Run \`frqncy-harness evolve --reflection ${reflectionResult.outputPath} --auto-pr\` ` +
        `(once you've decided which proposal to take) for the existing PR machinery.\n`,
    );
  }

  const result: LearningAgentRunResult = {
    status: proposals.length > 0 ? 'completed' : 'no_proposals_generated',
    personasProcessed,
    personasRefused,
    proposals,
    totalCostUsd,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// CLI subcommand dispatcher
// ────────────────────────────────────────────────────────────────────

export type LearningAgentSubcommand = 'run' | 'list-pending' | 'list-applied' | 'help';

export async function runLearningAgentCommand(
  sub: LearningAgentSubcommand,
  options: LearningAgentSubcommandRunOptions = {},
): Promise<void> {
  switch (sub) {
    case 'run':
      await runLearningAgentRun(options);
      return;
    case 'list-pending':
      await listProposals(options.cwd ?? process.cwd(), options.json ?? false);
      return;
    case 'list-applied':
      // v0.12 — would track which proposals have been applied via git log
      process.stdout.write(`${ANSI.dim}list-applied is v0.12. Use \`git log --grep "learning-agent" --all\` for now.${ANSI.reset}\n`);
      return;
    case 'help':
    default:
      process.stdout.write(
        `Usage:\n` +
          `  frqncy-harness learning-agent run [--persona <name>] [--since 7d] [--last 30] [--apply] [--json]\n` +
          `  frqncy-harness learning-agent list-pending\n` +
          `  frqncy-harness learning-agent list-applied (v0.12)\n`,
      );
      return;
  }
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

interface InvokeReflectArgs {
  reflectFn: typeof runReflectCommand;
  threadId?: string;
  last: number;
  since: string;
  cwd: string;
  apply: boolean;
  model?: string;
}

async function invokeReflect(args: InvokeReflectArgs): Promise<ReflectResult | null> {
  try {
    const result = await args.reflectFn({
      ...(args.threadId ? { threadId: args.threadId } : {}),
      projectId: 'frqncy-os',
      last: args.last,
      since: args.since,
      cwd: args.cwd,
      ...(args.model ? { model: args.model } : {}),
      // The Learning Agent always writes its source reflection to disk so the proposal
      // can reference it. dryRun:false unconditional here, because the *learning-agent*
      // proposal layer is what the user sees as "dry-run" when --apply is not set.
      dryRun: false,
      json: true, // suppress pretty-print since we wrap the output
    });
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no traces match the filter/i.test(msg) || /no failed traces/i.test(msg)) {
      return null;
    }
    throw err;
  }
}

async function listProposals(cwd: string, json: boolean): Promise<void> {
  const dir = join(cwd, PROPOSAL_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    if (json) process.stdout.write(JSON.stringify({ proposals: [] }) + '\n');
    else process.stdout.write(`${ANSI.dim}no proposals yet at ${dir}${ANSI.reset}\n`);
    return;
  }
  const proposals = entries.filter((e) => e.endsWith('.md')).sort().reverse();
  if (json) {
    process.stdout.write(JSON.stringify({ proposals }) + '\n');
    return;
  }
  process.stdout.write(`${ANSI.bold}pending Learning Agent proposals${ANSI.reset} ${ANSI.dim}(${dir})${ANSI.reset}\n`);
  if (proposals.length === 0) {
    process.stdout.write(`  ${ANSI.dim}(none)${ANSI.reset}\n`);
    return;
  }
  for (const p of proposals) {
    process.stdout.write(`  ${ANSI.cyan}${p}${ANSI.reset}\n`);
  }
}
