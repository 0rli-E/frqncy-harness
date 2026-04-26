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
    },
    args.traceDir,
  );
}
