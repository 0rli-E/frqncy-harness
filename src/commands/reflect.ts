/**
 * `frqncy-harness reflect [--thread <tag>] [--project <tag>] [--last N] [--since 7d] [--output <path>] [--model <m>] [--dry-run] [--json] [--include-success]`
 *
 * The cross-trace half of the self-improvement loop. Where `codify` operates on
 * a single failed conversation, `reflect` reads the last N traces matching a
 * filter and asks an LLM to identify recurring failure modes and propose fixes.
 *
 * Output is a structured Markdown proposal written to disk
 * (default: `proposals/reflection-<YYYY-MM-DD>.md`). The proposal is never
 * auto-applied — it's a doc that you read, decide on, and either hand-implement
 * or feed into `harness codify` (for test fixes) or, eventually, `harness evolve`
 * (which proposes a PR against the harness/repo).
 *
 * Why this exists: codify gives you a permanent test from one failure;
 * reflect tells you which failure modes are recurring. Together they implement
 * Huntley's "watch the loop, codify the failure" discipline at two scales.
 *
 * See `proposals/SELF-IMPROVING-HARNESS.md` (in this repo) for the full design.
 *
 * Safety: every reflect invocation prepends an inoculation sentence to the LLM
 * system prompt naming reward-hacking as a known anti-pattern. Per the Anthropic
 * Nov 2025 reward-hacking paper (arXiv 2511.18397), this single-line mitigation
 * reduces misalignment generalization 75-90% even at 99% reward-hacking rates.
 * Do not remove without reading that paper.
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { chat as defaultChat } from '../chat.js';
import { loadConfig } from '../config.js';
import {
  IndexRecordSchema,
  TraceRecordSchema,
  type ChatInput,
  type ChatResult,
  type IndexRecord,
  type ModelString,
  type TraceRecord,
} from '../types.js';
import { DEFAULT_TRACE_DIR, getIndexFilePath } from '../trace.js';
import { extractFailureSignal, INOCULATION_SENTENCE } from './codify.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

const DEFAULT_LAST = 20;
const DEFAULT_SINCE = '7d';
const MAX_TRACE_BUDGET_CHARS = 80_000; // keeps the bundled context well under any provider's window

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface ReflectCommandOptions {
  /** Filter to one thread tag. */
  threadId?: string;
  /** Filter to one project tag. */
  projectId?: string;
  /** Most recent N traces (after thread/project/since filters). Default 20. */
  last?: number;
  /** Time window — `7d` / `4w` / `3m` / `1y` / `all`. Default `7d`. */
  since?: string;
  /** Output path for the proposal markdown. Default `proposals/reflection-<YYYY-MM-DD>.md`. */
  output?: string;
  /** Override the LLM. Defaults to config.defaultModel. */
  model?: string;
  /** Print the proposal to stdout, don't write. */
  dryRun?: boolean;
  /** Emit a JSON summary instead of human-readable status. */
  json?: boolean;
  /** Include status=completed traces in the analysis (by default reflect focuses on failures). */
  includeSuccess?: boolean;
  /** Test seam — override the trace store location. */
  traceDir?: string;
  /** Test seam — override the project root for output path resolution. */
  cwd?: string;
  /** Test seam — substitute a chat function (real chat by default). */
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
}

export interface ReflectResult {
  tracesAnalyzed: number;
  tracesFailed: number;
  outputPath: string;
  proposalMarkdown: string;
  written: boolean;
  filter: {
    threadId?: string;
    projectId?: string;
    last: number;
    since: string;
    includeSuccess: boolean;
  };
}

export interface TraceSummary {
  conversationId: string;
  startedAt: string;
  model: string;
  status: string;
  failureReason: string;
  isFailure: boolean;
  userPrompt: string;
  assistantResponse: string;
  errorMessage?: string;
  threadId?: string;
  projectId?: string;
}

// ────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────

export async function runReflectCommand(options: ReflectCommandOptions = {}): Promise<ReflectResult> {
  const config = await loadConfig();
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;
  const cwd = options.cwd ?? process.cwd();
  const chatFn = options.chatFn ?? defaultChat;

  const last = options.last ?? DEFAULT_LAST;
  const since = options.since ?? DEFAULT_SINCE;
  const includeSuccess = options.includeSuccess ?? false;

  // 1. Load + filter the index
  const allIndex = await loadIndex(traceDir);
  const sinceMs = parseSince(since);
  const cutoff = sinceMs === Number.POSITIVE_INFINITY ? 0 : Date.now() - sinceMs;

  let filtered = allIndex.filter((r) => {
    if (Date.parse(r.started_at) < cutoff) return false;
    if (options.threadId && r.thread_id !== options.threadId) return false;
    if (options.projectId && r.project_id !== options.projectId) return false;
    return true;
  });

  // Most-recent first, then take `last`
  filtered.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  filtered = filtered.slice(0, last);

  if (filtered.length === 0) {
    throw new Error(
      `no traces match the filter (thread=${options.threadId ?? '*'}, project=${options.projectId ?? '*'}, since=${since}, last=${last})`,
    );
  }

  // 2. Load each conversation file and build summaries
  const summaries: TraceSummary[] = [];
  for (const indexEntry of filtered) {
    try {
      const records = await loadConversationRecords(indexEntry, traceDir);
      const signal = extractFailureSignal(records, indexEntry);
      summaries.push(buildTraceSummary(indexEntry, records, signal));
    } catch {
      // skip traces whose conversation file is missing/corrupt
    }
  }

  // 3. Filter to failures unless --include-success
  const focused = includeSuccess ? summaries : summaries.filter((s) => s.isFailure);

  if (focused.length === 0) {
    throw new Error(
      `no failed traces in the ${summaries.length} matching window. ` +
        `Pass --include-success to reflect on successful runs as well.`,
    );
  }

  // 4. Build the reflection prompt
  const reflectionPrompt = buildReflectionPrompt({
    summaries: focused,
    totalScanned: summaries.length,
    filter: {
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      last,
      since,
      includeSuccess,
    },
  });

  const reflectModel = (options.model ?? config.defaultModel ?? 'anthropic/claude-sonnet-4-6') as ModelString;

  if (!options.json) {
    process.stdout.write(
      `${ANSI.bold}${ANSI.cyan}reflecting on ${focused.length} trace(s)${ANSI.reset}` +
        ` ${ANSI.dim}(of ${summaries.length} matching the filter)${ANSI.reset}\n` +
        `${ANSI.dim}filter: thread=${options.threadId ?? '*'} project=${options.projectId ?? '*'} since=${since} last=${last}${ANSI.reset}\n` +
        `${ANSI.dim}via=${reflectModel}${ANSI.reset}\n\n`,
    );
  }

  // 5. Call the LLM
  const result = await chatFn({
    model: reflectModel,
    messages: [{ role: 'user', content: reflectionPrompt }],
    system: REFLECT_SYSTEM_PROMPT,
    costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd },
  });

  const proposalMarkdown = result.text.trim();

  // 6. Resolve output path
  const today = new Date().toISOString().slice(0, 10);
  const defaultOutput = join(cwd, 'proposals', `reflection-${today}.md`);
  const outputPath = options.output ? resolveOutputPath(options.output, cwd) : defaultOutput;

  // 7. Write to disk (unless dry-run)
  let written = false;
  if (!options.dryRun) {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    const fullDoc = renderProposalDocument({
      proposalMarkdown,
      tracesAnalyzed: focused.length,
      tracesScanned: summaries.length,
      filter: {
        ...(options.threadId ? { threadId: options.threadId } : {}),
        ...(options.projectId ? { projectId: options.projectId } : {}),
        last,
        since,
        includeSuccess,
      },
      reflectModel,
      generatedAt: new Date().toISOString(),
      summaries: focused,
    });
    await fs.writeFile(outputPath, fullDoc, 'utf-8');
    written = true;
  }

  const summary: ReflectResult = {
    tracesAnalyzed: focused.length,
    tracesFailed: summaries.filter((s) => s.isFailure).length,
    outputPath,
    proposalMarkdown,
    written,
    filter: {
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      last,
      since,
      includeSuccess,
    },
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  if (options.dryRun) {
    process.stdout.write(
      `${ANSI.dim}── proposed reflection (dry-run, not written) ──${ANSI.reset}\n` +
        proposalMarkdown +
        `\n${ANSI.dim}── end ──${ANSI.reset}\n` +
        `${ANSI.dim}would write to: ${outputPath}${ANSI.reset}\n`,
    );
  } else {
    process.stdout.write(
      `${ANSI.green}wrote${ANSI.reset} ${outputPath}\n` +
        `${ANSI.dim}${focused.length} trace(s) analyzed, ${summary.tracesFailed} failure(s) in window of ${summaries.length} matching${ANSI.reset}\n` +
        `${ANSI.yellow}note:${ANSI.reset} read the proposal, then either hand-implement, ` +
        `${ANSI.dim}codify${ANSI.reset} a specific trace, or wait for ${ANSI.dim}evolve${ANSI.reset} (next sprint).\n`,
    );
  }

  return summary;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

export const REFLECT_SYSTEM_PROMPT = `You are a self-improvement analyst for an LLM agent harness. ${INOCULATION_SENTENCE}

Your job: given N trace summaries from recent agent runs (each summary contains the user prompt, the assistant response, and the failure reason if any), identify the 3 most recurring failure modes across the corpus and propose ONE concrete fix per mode.

For each fix, choose ONE of:
  (a) **new hook** — file path under hooks/, behavior, which lifecycle event(s) (pre-agent / post-tool-use / post-agent / etc.)
  (b) **new skill** — SKILL.md frontmatter (name + description + keywords) + the body the agent should be given when this skill matches
  (c) **system-prompt amendment** — the exact text to add to AGENT.md / CLAUDE.md, scoped to the failure pattern
  (d) **regression test** — point at one specific trace ID to feed into \`harness codify\`, plus the assertion to add when un-skipping

Format the output as Markdown using EXACTLY this structure:

## Recurring failure modes

### 1. <one-line name of the mode>

- **Frequency:** X of N traces
- **Pattern:** <one paragraph: what specifically goes wrong>
- **Example trace:** \`<conversation-id>\`
- **Recommended fix:** \`<a/b/c/d>\` — <details, multi-paragraph if needed; for (a)/(b)/(d) include the actual content to add>
- **Estimated complexity:** small | medium | large

### 2. ...

### 3. ...

## Synthesis

<one paragraph: which fix has the highest leverage to ship first, and why>

Output ONLY the Markdown proposal. No commentary, no greetings, no caveats.`;

interface BuildReflectionPromptArgs {
  summaries: TraceSummary[];
  totalScanned: number;
  filter: {
    threadId?: string;
    projectId?: string;
    last: number;
    since: string;
    includeSuccess: boolean;
  };
}

export function buildReflectionPrompt(args: BuildReflectionPromptArgs): string {
  const lines: string[] = [
    `# Reflect on the last ${args.summaries.length} agent run(s)`,
    ``,
    `## Filter applied`,
    ``,
    `- thread: ${args.filter.threadId ?? '*'}`,
    `- project: ${args.filter.projectId ?? '*'}`,
    `- since: ${args.filter.since}`,
    `- last: ${args.filter.last}`,
    `- includeSuccess: ${args.filter.includeSuccess}`,
    `- focused-on: ${args.summaries.length} trace(s) of ${args.totalScanned} matching the filter`,
    ``,
    `## Trace summaries`,
    ``,
  ];

  // Bundle traces with a budget so we don't blow the context window
  let used = 0;
  for (let i = 0; i < args.summaries.length; i++) {
    const t = args.summaries[i]!;
    const block = formatTraceSummaryBlock(t, i + 1);
    if (used + block.length > MAX_TRACE_BUDGET_CHARS) {
      lines.push(``, `_[truncated — remaining ${args.summaries.length - i} trace(s) omitted to stay within context budget]_`);
      break;
    }
    lines.push(block);
    used += block.length;
  }

  lines.push(
    ``,
    `## Your task`,
    ``,
    `Identify the 3 most recurring failure modes across the trace corpus above and propose ONE concrete fix per mode using the structure described in the system prompt. Output only the Markdown proposal.`,
  );

  return lines.join('\n');
}

function formatTraceSummaryBlock(t: TraceSummary, idx: number): string {
  const status = t.isFailure ? `FAILED — ${t.failureReason}` : `ok — ${t.status}`;
  const errLine = t.errorMessage ? `\n- error: ${t.errorMessage}` : '';
  return [
    ``,
    `### Trace ${idx}: \`${t.conversationId.slice(0, 8)}\``,
    ``,
    `- model: ${t.model}`,
    `- status: ${status}${errLine}`,
    ``,
    `**User prompt:**`,
    ``,
    truncate(t.userPrompt, 600),
    ``,
    `**Assistant response:**`,
    ``,
    truncate(t.assistantResponse, 1500),
    ``,
  ].join('\n');
}

export function buildTraceSummary(
  indexEntry: IndexRecord,
  records: TraceRecord[],
  signal: { isFailure: boolean; reason: string },
): TraceSummary {
  const userPrompt = extractFirstUserMessage(records);
  const assistantResponse = extractFinalAssistantText(records);
  const errorMessage = extractFirstErrorMessage(records);

  return {
    conversationId: indexEntry.conversation_id,
    startedAt: indexEntry.started_at,
    model: indexEntry.model,
    status: indexEntry.status,
    failureReason: signal.reason,
    isFailure: signal.isFailure,
    userPrompt,
    assistantResponse,
    ...(errorMessage ? { errorMessage } : {}),
    ...(indexEntry.thread_id ? { threadId: indexEntry.thread_id } : {}),
    ...(indexEntry.project_id ? { projectId: indexEntry.project_id } : {}),
  };
}

interface RenderDocArgs {
  proposalMarkdown: string;
  tracesAnalyzed: number;
  tracesScanned: number;
  filter: {
    threadId?: string;
    projectId?: string;
    last: number;
    since: string;
    includeSuccess: boolean;
  };
  reflectModel: string;
  generatedAt: string;
  summaries: TraceSummary[];
}

export function renderProposalDocument(args: RenderDocArgs): string {
  const traceList = args.summaries.map((s) => `- \`${s.conversationId}\` — ${s.failureReason || s.status}`).join('\n');
  return [
    `# Reflection — ${args.generatedAt.slice(0, 10)}`,
    ``,
    `> Generated by \`frqncy-harness reflect\`. Read, decide, then either hand-implement,`,
    `> feed a specific trace into \`harness codify\`, or wait for \`harness evolve\` (next sprint).`,
    ``,
    `## Run metadata`,
    ``,
    `- **Generated:** ${args.generatedAt}`,
    `- **Model:** \`${args.reflectModel}\``,
    `- **Filter:** thread=\`${args.filter.threadId ?? '*'}\` project=\`${args.filter.projectId ?? '*'}\` since=\`${args.filter.since}\` last=\`${args.filter.last}\` includeSuccess=\`${args.filter.includeSuccess}\``,
    `- **Traces analyzed:** ${args.tracesAnalyzed} of ${args.tracesScanned} matching the filter`,
    ``,
    `## Source traces`,
    ``,
    traceList,
    ``,
    `---`,
    ``,
    args.proposalMarkdown,
    ``,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

const SINCE_REGEX = /^(\d+)([dwmy])$/;

export function parseSince(since: string): number {
  if (since === 'all') return Number.POSITIVE_INFINITY;
  const match = since.match(SINCE_REGEX);
  if (!match) {
    throw new Error(`invalid --since "${since}" — expected like 7d, 4w, 3m, 1y, or all`);
  }
  const n = Number(match[1]);
  const unit = match[2]!;
  const day = 86_400_000;
  switch (unit) {
    case 'd':
      return n * day;
    case 'w':
      return n * 7 * day;
    case 'm':
      return n * 30 * day;
    case 'y':
      return n * 365 * day;
    default:
      throw new Error(`invalid time unit in --since "${since}"`);
  }
}

async function loadIndex(traceDir: string): Promise<IndexRecord[]> {
  const indexPath = getIndexFilePath(traceDir);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: IndexRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(IndexRecordSchema.parse(JSON.parse(trimmed)));
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function loadConversationRecords(indexEntry: IndexRecord, traceDir: string): Promise<TraceRecord[]> {
  const date = indexEntry.started_at.slice(0, 10);
  const path = join(traceDir, date, `${indexEntry.conversation_id}.jsonl`);
  const raw = await fs.readFile(path, 'utf-8');
  const out: TraceRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(TraceRecordSchema.parse(JSON.parse(trimmed)));
    } catch {
      // skip malformed
    }
  }
  return out;
}

function extractFirstUserMessage(records: TraceRecord[]): string {
  for (const r of records) {
    if (r.type === 'user' && typeof r.content === 'string') return r.content;
  }
  return '';
}

function extractFinalAssistantText(records: TraceRecord[]): string {
  const assistantRecords = records.filter((r) => r.type === 'assistant');
  if (assistantRecords.length === 0) return '';
  const last = assistantRecords[assistantRecords.length - 1]!;
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
}

function extractFirstErrorMessage(records: TraceRecord[]): string | undefined {
  for (const r of records) {
    if (r.type === 'error') {
      if (typeof r.content === 'object' && r.content !== null && 'message' in r.content) {
        const m = (r.content as { message?: unknown }).message;
        return typeof m === 'string' ? m : String(m ?? '');
      }
      if (typeof r.content === 'string') return r.content;
    }
  }
  return undefined;
}

function resolveOutputPath(p: string, cwd: string): string {
  if (p.startsWith('/')) return p;
  return join(cwd, p);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '\n[... truncated]';
}
