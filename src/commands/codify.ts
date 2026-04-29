/**
 * `frqncy-harness codify <conv-id-or-prefix> [--output path] [--model m] [--dry-run] [--reason text] [--manifest path] [--json]`
 *
 * The cornerstone self-improvement primitive. Takes a single failed conversation
 * from the trace store and generates a Vitest regression test that would catch
 * the failure if it recurred.
 *
 * Why this exists: Geoffrey Huntley's "watch the loop, codify the failure"
 * discipline operationalized as a single command. Every observed failure
 * becomes a permanent test instead of tribal knowledge that decays.
 *
 * Lowest-risk self-improvement primitive: only generates tests, never changes
 * agent behavior. Highest leverage: every other self-improvement primitive
 * (`reflect`, `evolve`) depends on a growing regression set built from real traces.
 *
 * See `proposals/SELF-IMPROVING-HARNESS.md` (in this repo) for the full design.
 *
 * Safety: every codify invocation prepends an inoculation sentence to the LLM
 * prompt that explicitly names reward-hacking as a known anti-pattern. Per the
 * Anthropic Nov 2025 reward-hacking paper (arXiv 2511.18397), this single-line
 * mitigation reduces misalignment generalization 75-90% even at 99% reward-hacking
 * rates. Do not remove without reading that paper.
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

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

/**
 * The single sentence prepended to every codify LLM prompt. Per Anthropic Nov 2025
 * (arXiv 2511.18397): inoculation prompting reduces misalignment generalization 75-90%
 * even when reward-hacking rates exceed 99%. Counterintuitive and load-bearing.
 */
export const INOCULATION_SENTENCE =
  'Note: reward hacking — proposing fixes that pass surface checks but degrade ' +
  'the underlying behavior — is a known failure mode of self-improvement systems ' +
  'and is explicitly disallowed in this run.';

const DEFAULT_REGRESSION_DIR = 'test/regression';
const DEFAULT_MANIFEST_PATH = 'test/regression/MANIFEST.md';

const CODIFY_SYSTEM_PROMPT = `You are a regression-test author. ${INOCULATION_SENTENCE}

Your job: given a record of a single failed agent run (the prompt the agent received, the assistant's response that was wrong, optionally the system prompt and the failure reason), produce a Vitest regression test in TypeScript that would catch the failure if it recurred.

Output ONLY the test code, wrapped in a single \`\`\`typescript fenced block. Do not include any commentary, headings, or explanation outside the code block.

Test conventions for this repo:
- Use \`import { describe, it, expect } from 'vitest';\`
- Wrap in \`describe.skip(...)\` so the test does not run by default — operator un-skips when ready
- Top-of-file comment block with: REGRESSION marker, source conversation ID, captured date, failure mode summary
- Inside the test: declare const \`prompt\` (the original user prompt, possibly truncated), \`knownFailureResponse\` (the bad response, possibly truncated), and a clear assertion that captures the failure pattern (regex, .not.toContain, schema check, or a comment marking what assertion to add)
- Keep the test self-contained — no external imports beyond vitest. The point is documentation + a runnable scaffold; deeper integration is a follow-up.
- If the failure is ambiguous, leave the assertion as \`expect.todo(...)\` with a comment explaining what the human should add.`;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface CodifyCommandOptions {
  /** Where to write the test. Defaults to test/regression/<slug>.test.ts under cwd. */
  output?: string;
  /** Override the model used to generate the test. Defaults to config defaultModel. */
  model?: string;
  /** Print the proposed test instead of writing it. */
  dryRun?: boolean;
  /** Explicit failure reason — overrides automatic inference from the trace. */
  reason?: string;
  /** Where to write the MANIFEST.md entry. Defaults to test/regression/MANIFEST.md. */
  manifest?: string;
  /** Emit JSON summary on stdout instead of human-readable status. */
  json?: boolean;
  /** Test seam — override the trace store location. */
  traceDir?: string;
  /** Test seam — override the project root for output paths. */
  cwd?: string;
  /** Test seam — substitute a chat function (real chat by default). */
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
}

export interface CodifyResult {
  conversationId: string;
  slug: string;
  outputPath: string;
  manifestPath: string;
  failureReason: string;
  testCode: string;
  written: boolean;
}

export interface FailureSignal {
  isFailure: boolean;
  reason: string;
  errorRecords: TraceRecord[];
  status: string;
}

// ────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────

export async function runCodifyCommand(
  conversationIdOrPrefix: string,
  options: CodifyCommandOptions = {},
): Promise<CodifyResult> {
  const config = await loadConfig();
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;
  const cwd = options.cwd ?? process.cwd();
  const chatFn = options.chatFn ?? defaultChat;

  // 1. Find the conversation in INDEX.jsonl (by full id or shortest unique prefix)
  const indexEntry = await findConversation(conversationIdOrPrefix, traceDir);

  // 2. Load the JSONL records for that conversation
  const records = await loadConversationRecords(indexEntry, traceDir);

  // 3. Detect the failure signal
  const signal = extractFailureSignal(records, indexEntry, options.reason);
  if (!signal.isFailure) {
    throw new Error(
      `conversation ${indexEntry.conversation_id.slice(0, 8)} has no obvious failure ` +
        `(status=${indexEntry.status}, no error records). ` +
        `If you want to codify it anyway, pass --reason "what went wrong".`,
    );
  }

  // 4. Extract the prompt + response + system prompt from the trace
  const userPrompt = extractFirstUserMessage(records);
  const assistantResponse = extractFinalAssistantText(records);
  const systemPrompt = extractSystemPrompt(records);

  // 5. Build the codify prompt
  const codifyPrompt = buildCodifyPrompt({
    userPrompt,
    assistantResponse,
    failureReason: signal.reason,
    sourceConversationId: indexEntry.conversation_id,
    sourceModel: indexEntry.model,
    ...(systemPrompt ? { systemPrompt } : {}),
  });

  // 6. Resolve the codify model
  const codifyModel = (options.model ?? config.defaultModel ?? 'anthropic/claude-sonnet-4-6') as ModelString;

  if (!options.json) {
    process.stdout.write(
      `${ANSI.bold}${ANSI.cyan}codifying ${indexEntry.conversation_id.slice(0, 8)}${ANSI.reset}` +
        ` ${ANSI.dim}via=${codifyModel}${ANSI.reset}\n` +
        `${ANSI.dim}failure: ${signal.reason}${ANSI.reset}\n\n`,
    );
  }

  // 7. Call the LLM
  const result = await chatFn({
    model: codifyModel,
    messages: [{ role: 'user', content: codifyPrompt }],
    system: CODIFY_SYSTEM_PROMPT,
    costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd },
  });

  // 8. Extract the test code from the model's response
  const testCode = extractTestCode(result.text);
  if (!testCode) {
    throw new Error(
      'codify model did not produce a recognizable test code block. ' +
        `Got: ${result.text.slice(0, 200)}${result.text.length > 200 ? '...' : ''}`,
    );
  }

  // 9. Generate slug + output paths
  const slug = generateSlug(signal.reason, indexEntry.conversation_id);
  const outputPath = options.output
    ? resolveOutputPath(options.output, cwd)
    : join(cwd, DEFAULT_REGRESSION_DIR, `${slug}.test.ts`);
  const manifestPath = options.manifest
    ? resolveOutputPath(options.manifest, cwd)
    : join(cwd, DEFAULT_MANIFEST_PATH);

  // 10. Write to disk (unless dry-run)
  let written = false;
  if (!options.dryRun) {
    await fs.mkdir(dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, testCode + '\n', 'utf-8');

    await ensureManifest(manifestPath);
    const entry = formatManifestEntry({
      slug,
      conversationId: indexEntry.conversation_id,
      capturedAt: new Date().toISOString(),
      failureReason: signal.reason,
      sourceModel: indexEntry.model,
      outputPath,
      cwd,
    });
    await fs.appendFile(manifestPath, entry, 'utf-8');
    written = true;
  }

  const summary: CodifyResult = {
    conversationId: indexEntry.conversation_id,
    slug,
    outputPath,
    manifestPath,
    failureReason: signal.reason,
    testCode,
    written,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  if (options.dryRun) {
    process.stdout.write(
      `${ANSI.dim}── proposed test (dry-run, not written) ──${ANSI.reset}\n` +
        testCode +
        `\n${ANSI.dim}── end ──${ANSI.reset}\n` +
        `${ANSI.dim}would write to: ${outputPath}${ANSI.reset}\n`,
    );
  } else {
    process.stdout.write(
      `${ANSI.green}wrote${ANSI.reset} ${outputPath}\n` +
        `${ANSI.dim}manifest entry → ${manifestPath}${ANSI.reset}\n` +
        `${ANSI.yellow}note:${ANSI.reset} test starts as ${ANSI.dim}describe.skip()${ANSI.reset} — review,` +
        ` then un-skip when ready to gate against this regression.\n`,
    );
  }

  return summary;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

interface BuildCodifyPromptArgs {
  userPrompt: string;
  assistantResponse: string;
  systemPrompt?: string;
  failureReason: string;
  sourceConversationId: string;
  sourceModel: string;
}

export function buildCodifyPrompt(args: BuildCodifyPromptArgs): string {
  const sysSection = args.systemPrompt
    ? `\n## System prompt (truncated)\n\n${truncate(args.systemPrompt, 2000)}\n`
    : '';
  return [
    `# Codify a failed agent run as a regression test`,
    ``,
    `## Source`,
    `- Conversation ID: ${args.sourceConversationId}`,
    `- Model: ${args.sourceModel}`,
    `- Failure reason: ${args.failureReason}`,
    sysSection,
    `## User prompt the agent received`,
    ``,
    truncate(args.userPrompt, 4000),
    ``,
    `## Assistant response that was wrong`,
    ``,
    truncate(args.assistantResponse, 4000),
    ``,
    `## Your task`,
    ``,
    `Write a single Vitest regression test (TypeScript) that captures this failure mode. ` +
      `Output only the code, wrapped in a single \`\`\`typescript fenced block. ` +
      `Default to describe.skip() so the test does not break the suite when generated. ` +
      `If the assertion is ambiguous, leave it as expect.todo() with a comment.`,
  ].join('\n');
}

export function extractFailureSignal(
  records: TraceRecord[],
  indexEntry: IndexRecord,
  explicitReason?: string,
): FailureSignal {
  const errorRecords = records.filter((r) => r.type === 'error');
  const status = indexEntry.status;

  // Explicit --reason always wins
  if (explicitReason && explicitReason.trim().length > 0) {
    return { isFailure: true, reason: explicitReason.trim(), errorRecords, status };
  }

  if (status === 'aborted_cost_cap') {
    return { isFailure: true, reason: 'aborted: cost cap exceeded', errorRecords, status };
  }
  if (status === 'aborted_error') {
    const msg = extractErrorMessage(errorRecords[0]);
    return { isFailure: true, reason: `aborted: ${msg}`, errorRecords, status };
  }
  if (status === 'aborted_window_full') {
    return { isFailure: true, reason: 'aborted: context window full', errorRecords, status };
  }
  if (status === 'aborted_user') {
    return { isFailure: true, reason: 'aborted: user interrupted', errorRecords, status };
  }
  if (errorRecords.length > 0) {
    return { isFailure: true, reason: extractErrorMessage(errorRecords[0]), errorRecords, status };
  }

  return { isFailure: false, reason: '', errorRecords, status };
}

function extractErrorMessage(record: TraceRecord | undefined): string {
  if (!record) return 'unknown error';
  if (typeof record.content === 'object' && record.content !== null && 'message' in record.content) {
    return String((record.content as { message?: unknown }).message ?? 'unknown error');
  }
  if (typeof record.content === 'string') return record.content;
  return 'unknown error';
}

export function generateSlug(failureReason: string, conversationId: string): string {
  const reasonSlug = failureReason
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6)
    .join('-')
    .slice(0, 60);
  const idShort = conversationId.slice(0, 8);
  return reasonSlug ? `${reasonSlug}-${idShort}` : `regression-${idShort}`;
}

export function extractTestCode(modelResponse: string): string | null {
  // Prefer a typed fence: ```typescript or ```ts
  const tsMatch = modelResponse.match(/```(?:typescript|ts)\n([\s\S]*?)\n```/);
  if (tsMatch && tsMatch[1]) return tsMatch[1].trim();
  // Fall back to any fenced block
  const anyMatch = modelResponse.match(/```\n?([\s\S]*?)\n?```/);
  if (anyMatch && anyMatch[1]) return anyMatch[1].trim();
  return null;
}

interface ManifestEntryArgs {
  slug: string;
  conversationId: string;
  capturedAt: string;
  failureReason: string;
  sourceModel: string;
  outputPath: string;
  cwd?: string;
}

export function formatManifestEntry(args: ManifestEntryArgs): string {
  const cwdPrefix = args.cwd ? args.cwd + '/' : process.cwd() + '/';
  const relativePath = args.outputPath.startsWith(cwdPrefix)
    ? args.outputPath.slice(cwdPrefix.length)
    : args.outputPath;
  return [
    ``,
    `## ${args.slug}`,
    ``,
    `- **Source trace:** \`${args.conversationId}\``,
    `- **Captured:** ${args.capturedAt}`,
    `- **Source model:** \`${args.sourceModel}\``,
    `- **Failure:** ${args.failureReason}`,
    `- **Test:** \`${relativePath}\``,
    ``,
  ].join('\n');
}

async function ensureManifest(manifestPath: string): Promise<void> {
  await fs.mkdir(dirname(manifestPath), { recursive: true });
  try {
    await fs.access(manifestPath);
    return;
  } catch {
    // Doesn't exist; write the header
  }
  const header = [
    `# Regression manifest`,
    ``,
    `Tests in this directory are generated by \`frqncy-harness codify <trace-id>\`.`,
    ``,
    `Each entry below was extracted from a real failed agent run. Tests start as`,
    `\`describe.skip()\` so the suite stays green; un-skip when you've reviewed the`,
    `assertion and are ready to gate against the regression.`,
    ``,
    `Per \`proposals/SELF-IMPROVING-HARNESS.md\`: this is the cornerstone primitive of`,
    `the harness's self-improvement loop — every observed failure becomes a permanent`,
    `test, so the same class of failure cannot recur silently.`,
    ``,
    `---`,
  ].join('\n');
  await fs.writeFile(manifestPath, header, 'utf-8');
}

function resolveOutputPath(p: string, cwd: string): string {
  if (p.startsWith('/')) return p;
  return join(cwd, p);
}

// ────────────────────────────────────────────────────────────────────
// Trace loaders (parallel to replay.ts; intentionally local for now —
// could be hoisted to a shared module if a third command needs them.)
// ────────────────────────────────────────────────────────────────────

async function findConversation(idOrPrefix: string, traceDir: string): Promise<IndexRecord> {
  const indexPath = getIndexFilePath(traceDir);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`no traces yet — INDEX.jsonl missing at ${indexPath}`);
    }
    throw err;
  }

  const records: IndexRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(IndexRecordSchema.parse(JSON.parse(trimmed)));
    } catch {
      // skip malformed
    }
  }

  const matches = records.filter(
    (r) => r.conversation_id === idOrPrefix || r.conversation_id.startsWith(idOrPrefix),
  );
  if (matches.length === 0) {
    throw new Error(`no trace found for conversation id "${idOrPrefix}"`);
  }
  const exact = matches.find((r) => r.conversation_id === idOrPrefix);
  if (!exact && matches.length > 1) {
    const ids = matches.map((r) => r.conversation_id.slice(0, 8)).join(', ');
    throw new Error(`prefix "${idOrPrefix}" matched ${matches.length} conversations: ${ids}`);
  }
  return exact ?? matches[0]!;
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

function extractSystemPrompt(records: TraceRecord[]): string | undefined {
  for (const r of records) {
    if (r.type === 'system' && typeof r.content === 'string' && r.content.trim().length > 0) {
      return r.content;
    }
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '\n\n[... truncated]';
}
