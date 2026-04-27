/**
 * `frqncy-harness replay <conversation-id> [--model <m>] [--diff] [--json]`
 *
 * Re-runs a saved conversation from the trace store. Replays the original
 * user/system messages against the same model — or a different one if
 * `--model` is given — and prints the new assistant text.
 *
 * With `--diff`, prints a side-by-side comparison of the new reply vs the
 * original assistant text from the trace.
 *
 * Why this exists: the trace store is a regression dataset by construction.
 * A trivial replay turns it into "did the new model do better, worse, or
 * the same on this prompt?" — which is the cheapest possible model eval.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { stream } from '../stream.js';
import { loadConfig } from '../config.js';
import {
  IndexRecordSchema,
  TraceRecordSchema,
  type IndexRecord,
  type TraceRecord,
  type Message,
  type ModelString,
  type Usage,
} from '../types.js';
import { DEFAULT_TRACE_DIR, getIndexFilePath } from '../trace.js';

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

export interface ReplayCommandOptions {
  model?: string;
  diff?: boolean;
  json?: boolean;
  threadId?: string;
  projectId?: string;
  /** Test seam — override the trace store location. */
  traceDir?: string;
}

export interface ReplaySummary {
  originalConversationId: string;
  originalModel: string;
  newConversationId: string;
  newModel: string;
  newText: string;
  originalText: string;
  newUsage?: Usage;
  similarity: number;
}

export async function runReplayCommand(
  conversationIdOrPrefix: string,
  options: ReplayCommandOptions,
): Promise<ReplaySummary> {
  const config = await loadConfig();
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;

  const indexEntry = await findConversation(conversationIdOrPrefix, traceDir);
  const records = await loadConversationRecords(indexEntry, traceDir);

  const messages = extractUserMessages(records);
  if (messages.length === 0) {
    throw new Error(`conversation ${indexEntry.conversation_id.slice(0, 8)} has no user messages to replay`);
  }
  const systemPrompt = extractSystemPrompt(records);
  const originalText = extractAssistantText(records);

  const replayModel = (options.model ?? indexEntry.model) as ModelString;

  if (!options.json) {
    process.stdout.write(
      `${ANSI.bold}${ANSI.cyan}replaying ${indexEntry.conversation_id.slice(0, 8)}${ANSI.reset}` +
        ` ${ANSI.dim}orig=${indexEntry.model} → new=${replayModel}${ANSI.reset}\n` +
        `${ANSI.dim}${messages.length} message(s), system=${systemPrompt ? 'yes' : 'no'}${ANSI.reset}\n\n`,
    );
  }

  let newText = '';
  let newUsage: Usage | undefined;
  let newConversationId = '';

  for await (const event of stream({
    model: replayModel,
    messages,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
    costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd },
  })) {
    switch (event.type) {
      case 'text':
        if (!options.json) process.stdout.write(event.delta);
        newText += event.delta;
        break;
      case 'usage':
        newUsage = event.usage;
        break;
      case 'done':
        newConversationId = event.result.conversationId;
        break;
      case 'error':
        // bubble — handled by CLI catch
        break;
    }
  }

  if (!options.json) process.stdout.write('\n');

  const similarity = jaccardSimilarity(originalText, newText);

  const summary: ReplaySummary = {
    originalConversationId: indexEntry.conversation_id,
    originalModel: indexEntry.model,
    newConversationId,
    newModel: replayModel,
    newText,
    originalText,
    similarity,
    ...(newUsage ? { newUsage } : {}),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  if (newUsage) {
    process.stderr.write(
      `\n${ANSI.dim}[usage] in=${newUsage.inputTokens} out=${newUsage.outputTokens}` +
        (newUsage.cachedInputTokens ? ` cached=${newUsage.cachedInputTokens}` : '') +
        (newUsage.costUsd !== undefined ? ` cost=$${newUsage.costUsd.toFixed(6)}` : '') +
        ` new-conv=${newConversationId.slice(0, 8)}${ANSI.reset}\n`,
    );
  }

  if (options.diff) {
    printDiff(originalText, newText, indexEntry.model, replayModel, similarity);
  } else {
    process.stdout.write(
      `\n${ANSI.dim}word-overlap with original (${indexEntry.model}): ${(similarity * 100).toFixed(1)}%${ANSI.reset}\n` +
        `${ANSI.dim}pass --diff to see the side-by-side.${ANSI.reset}\n`,
    );
  }

  return summary;
}

// ────────────────────────────────────────────────────────────────────
// Trace loading helpers
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

function extractSystemPrompt(records: TraceRecord[]): string | undefined {
  // The first 'system' record (or the first user record's system, if logged that way)
  for (const r of records) {
    if (r.type === 'system' && typeof r.content === 'string' && r.content.trim().length > 0) {
      return r.content;
    }
  }
  return undefined;
}

function extractUserMessages(records: TraceRecord[]): Message[] {
  // Replay only includes the user turns — we want the model's *fresh* take,
  // not a continuation of its prior reply. (For continuation, use --resume.)
  const out: Message[] = [];
  for (const r of records) {
    if (r.type === 'user' && typeof r.content === 'string') {
      out.push({ role: 'user', content: r.content });
    }
  }
  return out;
}

function extractAssistantText(records: TraceRecord[]): string {
  // Concatenate the final assistant message (or the only one). We pick the
  // last assistant record because that's the "answer" we're comparing against.
  const assistantRecords = records.filter((r) => r.type === 'assistant');
  if (assistantRecords.length === 0) return '';
  const last = assistantRecords[assistantRecords.length - 1]!;
  if (typeof last.content === 'string') return last.content;
  return JSON.stringify(last.content);
}

// ────────────────────────────────────────────────────────────────────
// Diff renderer + similarity
// ────────────────────────────────────────────────────────────────────

function printDiff(
  original: string,
  fresh: string,
  originalModel: string,
  newModel: string,
  similarity: number,
): void {
  const origLines = original.split('\n');
  const newLines = fresh.split('\n');
  const max = Math.max(origLines.length, newLines.length);
  const colWidth = Math.max(40, Math.floor((process.stdout.columns ?? 120) / 2) - 4);

  process.stdout.write(
    `\n${ANSI.bold}diff${ANSI.reset} ${ANSI.dim}(word-overlap: ${(similarity * 100).toFixed(1)}%)${ANSI.reset}\n` +
      `${ANSI.dim}${pad(`── original (${originalModel}) ──`, colWidth)}  ${pad(`── replay (${newModel}) ──`, colWidth)}${ANSI.reset}\n`,
  );

  for (let i = 0; i < max; i++) {
    const a = origLines[i] ?? '';
    const b = newLines[i] ?? '';
    const same = a === b;
    const ac = same ? ANSI.dim : ANSI.yellow;
    const bc = same ? ANSI.dim : ANSI.green;
    process.stdout.write(
      `${ac}${pad(truncate(a, colWidth), colWidth)}${ANSI.reset}  ${bc}${pad(truncate(b, colWidth), colWidth)}${ANSI.reset}\n`,
    );
  }
  process.stdout.write('\n');
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Lightweight Jaccard similarity over lowercased word tokens.
 * Not a serious eval — just a quick "did the model's answer drift?" signal.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
