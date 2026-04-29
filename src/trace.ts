/**
 * Trace writer.
 *
 * Architectural principle (decisions 7 and 8 in HARNESS-PLAN.md):
 *   Trace data is sacred. Append-only. Never compacted. Never modified after write.
 *   The trace is the moat (per Phil Schmid: "the harness is the dataset").
 *
 * Layout on disk:
 *   ~/.frqncy-harness/traces/
 *     <YYYY-MM-DD>/
 *       <conversation-uuid>.jsonl    ← one file per conversation
 *     INDEX.jsonl                     ← one row per conversation, summary metadata
 *
 * The traces/ directory is itself a git repo. v0.0.1 doesn't auto-commit;
 * v0.1+ adds end-of-conversation auto-commit and the `frqncy-harness sync` command.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  TRACE_SCHEMA_VERSION,
  TraceRecordSchema,
  IndexRecordSchema,
  type TraceRecord,
  type IndexRecord,
  type ConversationStatus,
  type Message,
  type ModelString,
  type Usage,
} from './types.js';

export const DEFAULT_TRACE_DIR = join(homedir(), '.frqncy-harness', 'traces');

/**
 * Get the absolute path to the JSONL file for a given conversation.
 * Traces are date-partitioned by conversation start date.
 */
export function getTraceFilePath(
  conversationId: string,
  startedAt: Date,
  traceDir = DEFAULT_TRACE_DIR,
): string {
  const dateStr = startedAt.toISOString().slice(0, 10);
  return join(traceDir, dateStr, `${conversationId}.jsonl`);
}

/**
 * Get the absolute path to the INDEX.jsonl file.
 */
export function getIndexFilePath(traceDir = DEFAULT_TRACE_DIR): string {
  return join(traceDir, 'INDEX.jsonl');
}

/**
 * Append a single trace record to a conversation's JSONL file.
 * Validates against the Zod schema before writing — refuses to write malformed records.
 */
export async function appendTraceRecord(
  filePath: string,
  record: Omit<TraceRecord, 'schema_version'>,
): Promise<void> {
  const fullRecord: TraceRecord = {
    ...record,
    schema_version: TRACE_SCHEMA_VERSION,
  };

  // Validate before write — refuse to corrupt the trace
  TraceRecordSchema.parse(fullRecord);

  // Ensure parent directory exists
  const parentDir = filePath.slice(0, filePath.lastIndexOf('/'));
  await fs.mkdir(parentDir, { recursive: true });

  // Append, with trailing newline for JSONL convention
  await fs.appendFile(filePath, JSON.stringify(fullRecord) + '\n', 'utf-8');
}

/**
 * Append a single index record to INDEX.jsonl.
 * Each conversation contributes exactly one row at end-of-conversation
 * (or one row per status change in v0.2+).
 */
export async function appendIndexRecord(
  record: Omit<IndexRecord, 'schema_version'>,
  traceDir = DEFAULT_TRACE_DIR,
): Promise<void> {
  const fullRecord: IndexRecord = {
    ...record,
    schema_version: TRACE_SCHEMA_VERSION,
  };

  IndexRecordSchema.parse(fullRecord);

  const indexPath = getIndexFilePath(traceDir);
  await fs.mkdir(traceDir, { recursive: true });
  await fs.appendFile(indexPath, JSON.stringify(fullRecord) + '\n', 'utf-8');
}

// ────────────────────────────────────────────────────────────────────
// Read API — thread history loading (v0.14.0)
// ────────────────────────────────────────────────────────────────────

/**
 * Read INDEX.jsonl and return all records. Bad lines are silently skipped
 * (the trace store is the moat — never throw on read; the worst that can
 * happen is some history is missing, not that the harness crashes).
 */
export async function readIndex(traceDir = DEFAULT_TRACE_DIR): Promise<IndexRecord[]> {
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
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const parsed = IndexRecordSchema.safeParse(obj);
      if (parsed.success) out.push(parsed.data);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Read every record from a conversation's JSONL. Bad lines silently skipped.
 */
export async function readConversation(
  conversationId: string,
  startedAt: Date,
  traceDir = DEFAULT_TRACE_DIR,
): Promise<TraceRecord[]> {
  const path = getTraceFilePath(conversationId, startedAt, traceDir);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TraceRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const parsed = TraceRecordSchema.safeParse(obj);
      if (parsed.success) out.push(parsed.data);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

export interface LoadThreadHistoryOptions {
  /** Max conversations to look back. Default 10. Set 0 to disable. */
  maxConversations?: number;
  /**
   * Hard cap on total messages returned. Most-recent messages preferred when
   * trimming. Default 40 (≈20 turns including assistant + user pairs).
   */
  maxMessages?: number;
  /**
   * Hard cap on total bytes of message content (sum of message.content lengths
   * UTF-8 byte count). Most-recent messages preferred when trimming. Default 50_000
   * (≈12K tokens conservative). Set 0 to disable.
   */
  maxBytes?: number;
  /** Override the trace dir. */
  traceDir?: string;
  /**
   * Include records from conversations that ended in error (default false).
   * Aborted conversations rarely contain meaningful continuity.
   */
  includeAborted?: boolean;
}

export interface ThreadHistoryResult {
  /** Messages in chronological order, ready to prepend to a chat() messages[] array. */
  messages: Message[];
  /** Number of conversations the messages were drawn from. */
  conversationsRead: number;
  /** Number of messages dropped because of maxMessages or maxBytes caps. */
  messagesTrimmed: number;
  /** Total UTF-8 byte count of returned message content. */
  totalBytes: number;
}

/**
 * Load prior turns on a thread from the trace store, ready to prepend to a
 * chat() invocation as conversational context.
 *
 * Strategy:
 *   1. Read INDEX.jsonl, filter by thread_id, sort by started_at desc
 *   2. Take the most recent N conversations (default 10)
 *   3. For each, read the JSONL and extract user/assistant messages in step order
 *   4. Concatenate chronologically (oldest convo first, oldest step first inside each)
 *   5. Apply maxMessages and maxBytes caps from the END (most recent preferred)
 *
 * Pi-aligned: filesystem-as-substrate, lazy read on invoke, no daemon, no index
 * beyond what's already there. Tolerant — bad records skipped silently.
 */
export async function loadThreadHistory(
  threadId: string,
  options: LoadThreadHistoryOptions = {},
): Promise<ThreadHistoryResult> {
  if (!threadId) {
    return { messages: [], conversationsRead: 0, messagesTrimmed: 0, totalBytes: 0 };
  }
  const maxConversations = options.maxConversations ?? 10;
  const maxMessages = options.maxMessages ?? 40;
  const maxBytes = options.maxBytes ?? 50_000;
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;
  const includeAborted = options.includeAborted ?? false;

  if (maxConversations === 0) {
    return { messages: [], conversationsRead: 0, messagesTrimmed: 0, totalBytes: 0 };
  }

  const index = await readIndex(traceDir);
  const matching = index
    .filter((r) => r.thread_id === threadId)
    .filter((r) => includeAborted || (r.status !== 'aborted_error' && r.status !== 'aborted_user'))
    .sort((a, b) => (b.started_at < a.started_at ? -1 : b.started_at > a.started_at ? 1 : 0))
    .slice(0, maxConversations)
    // Reverse to chronological for replay
    .reverse();

  const messages: Message[] = [];
  for (const idxRec of matching) {
    const startedAt = new Date(idxRec.started_at);
    const records = await readConversation(idxRec.conversation_id, startedAt, traceDir);
    // Sort by step ascending; keep only user/assistant turns with string content
    const turns = records
      .filter((r) => (r.type === 'user' || r.type === 'assistant') && typeof r.content === 'string')
      .sort((a, b) => a.step - b.step);
    for (const t of turns) {
      const role = t.role === 'user' || t.role === 'assistant' ? t.role : t.type === 'user' ? 'user' : 'assistant';
      messages.push({ role: role as Message['role'], content: t.content as string });
    }
  }

  // Apply caps from the END (most recent messages preferred when trimming)
  let trimmed = 0;
  let working = messages;
  if (working.length > maxMessages) {
    trimmed += working.length - maxMessages;
    working = working.slice(working.length - maxMessages);
  }
  if (maxBytes > 0) {
    let runningBytes = 0;
    const reversed: Message[] = [];
    for (let i = working.length - 1; i >= 0; i--) {
      const item = working[i]!;
      const b = Buffer.byteLength(item.content, 'utf-8');
      if (runningBytes + b > maxBytes && reversed.length > 0) {
        // Drop everything older than this point
        trimmed += i + 1;
        break;
      }
      runningBytes += b;
      reversed.push(item);
    }
    working = reversed.reverse();
  }

  const totalBytes = working.reduce((s, m) => s + Buffer.byteLength(m.content, 'utf-8'), 0);
  return {
    messages: working,
    conversationsRead: matching.length,
    messagesTrimmed: trimmed,
    totalBytes,
  };
}

/**
 * Convenience: write a complete conversation summary at end-of-call.
 * Builds an IndexRecord from the cumulative usage and writes it to INDEX.jsonl.
 */
export async function recordConversationEnd(args: {
  conversationId: string;
  startedAt: Date;
  endedAt: Date;
  model: ModelString;
  messageCount: number;
  cumulativeUsage: Usage;
  status: ConversationStatus;
  traceDir?: string;
  threadId?: string | undefined;
  projectId?: string | undefined;
}): Promise<void> {
  await appendIndexRecord(
    {
      conversation_id: args.conversationId,
      started_at: args.startedAt.toISOString(),
      ended_at: args.endedAt.toISOString(),
      model: args.model,
      message_count: args.messageCount,
      total_cost_usd: args.cumulativeUsage.costUsd ?? 0,
      total_input_tokens: args.cumulativeUsage.inputTokens,
      total_output_tokens: args.cumulativeUsage.outputTokens,
      total_cached_input_tokens: args.cumulativeUsage.cachedInputTokens ?? 0,
      status: args.status,
      ...(args.threadId ? { thread_id: args.threadId } : {}),
      ...(args.projectId ? { project_id: args.projectId } : {}),
    },
    args.traceDir,
  );
}
