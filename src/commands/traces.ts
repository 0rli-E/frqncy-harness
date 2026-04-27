/**
 * `frqncy-harness traces` — query the never-compacted trace store.
 *
 *   frqncy-harness traces list [--thread <id>] [--project <id>] [--since 7d] [--limit 20] [--json]
 *   frqncy-harness traces show <conversation-id> [--json]
 *   frqncy-harness traces latest [--json]
 *   frqncy-harness traces path
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { IndexRecordSchema, TraceRecordSchema, type IndexRecord, type TraceRecord } from '../types.js';
import { getIndexFilePath, DEFAULT_TRACE_DIR } from '../trace.js';

export type TracesSubcommand = 'list' | 'show' | 'latest' | 'path';

/** Optional trace dir override (test hook; CLI always uses DEFAULT_TRACE_DIR). */
export interface TracesCommandOptions {
  traceDir?: string;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
};

interface ListOptions {
  threadId?: string;
  projectId?: string;
  since?: string;
  limit?: number;
  json?: boolean;
}

function flagAt(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) {
      const v = args[idx + 1];
      if (v !== undefined && !v.startsWith('-')) return v;
    }
  }
  return undefined;
}

function flagBool(args: string[], names: string[]): boolean {
  return names.some((n) => args.includes(n));
}

function withoutFlags(args: string[], flagNames: string[], boolNames: string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (boolNames.includes(a)) continue;
    if (flagNames.includes(a) && i + 1 < args.length) {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function runTracesCommand(
  sub: TracesSubcommand,
  rawArgs: string[],
  cmdOptions: TracesCommandOptions = {},
): Promise<void> {
  const traceDir = cmdOptions.traceDir ?? DEFAULT_TRACE_DIR;
  switch (sub) {
    case 'path':
      process.stdout.write(getIndexFilePath(traceDir) + '\n');
      return;

    case 'list': {
      const since = flagAt(rawArgs, ['--since']);
      const threadId = flagAt(rawArgs, ['--thread']);
      const projectId = flagAt(rawArgs, ['--project']);
      const limitStr = flagAt(rawArgs, ['--limit']);
      const json = flagBool(rawArgs, ['--json']);
      const options: ListOptions = {
        ...(threadId ? { threadId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(since ? { since } : {}),
        ...(limitStr ? { limit: Number(limitStr) } : {}),
        json,
      };
      await listTraces(options, traceDir);
      return;
    }

    case 'latest': {
      const json = flagBool(rawArgs, ['--json']);
      const records = await loadIndex(traceDir);
      if (records.length === 0) {
        process.stdout.write('no traces yet\n');
        return;
      }
      records.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
      const latest = records[0]!;
      await showConversation(latest.conversation_id, latest, json, traceDir);
      return;
    }

    case 'show': {
      const positional = withoutFlags(rawArgs, [], ['--json']);
      const id = positional[0];
      const json = flagBool(rawArgs, ['--json']);
      if (!id) throw new Error('Usage: frqncy-harness traces show <conversation-id> [--json]');
      const records = await loadIndex(traceDir);
      // Allow id-prefix matching for ergonomics (8-char prefix typical)
      const matches = records.filter((r) => r.conversation_id === id || r.conversation_id.startsWith(id));
      if (matches.length === 0) {
        throw new Error(`no trace found for conversation id "${id}"`);
      }
      if (matches.length > 1 && !matches.some((r) => r.conversation_id === id)) {
        const ids = matches.map((r) => r.conversation_id.slice(0, 8)).join(', ');
        throw new Error(`prefix "${id}" matched ${matches.length} conversations: ${ids}`);
      }
      const exact = matches.find((r) => r.conversation_id === id) ?? matches[0]!;
      await showConversation(exact.conversation_id, exact, json, traceDir);
      return;
    }

    default:
      throw new Error(`Unknown traces subcommand: ${sub}. Try: list | show | latest | path`);
  }
}

async function listTraces(options: ListOptions, traceDir: string): Promise<void> {
  const records = await loadIndex(traceDir);
  const sinceMs = options.since ? Date.now() - parseSince(options.since) : Number.NEGATIVE_INFINITY;
  const filtered = records
    .filter((r) => Date.parse(r.started_at) >= sinceMs)
    .filter((r) => !options.threadId || r.thread_id === options.threadId)
    .filter((r) => !options.projectId || r.project_id === options.projectId);

  filtered.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

  const limit = options.limit ?? 20;
  const limited = filtered.slice(0, limit);

  if (options.json) {
    process.stdout.write(JSON.stringify(limited, null, 2) + '\n');
    return;
  }

  if (limited.length === 0) {
    process.stdout.write(`${ANSI.dim}(no traces match)${ANSI.reset}\n`);
    return;
  }

  const filterParts = [
    options.threadId ? `thread=${options.threadId}` : '',
    options.projectId ? `project=${options.projectId}` : '',
    options.since ? `since=${options.since}` : '',
  ].filter(Boolean);
  const filterSuffix = filterParts.length ? ` ${ANSI.dim}[${filterParts.join(' ')}]${ANSI.reset}` : '';
  process.stdout.write(
    `\n${ANSI.bold}${ANSI.cyan}traces${ANSI.reset} ${ANSI.dim}(showing ${limited.length} of ${filtered.length})${ANSI.reset}${filterSuffix}\n\n`,
  );
  for (const r of limited) {
    const id = r.conversation_id.slice(0, 8);
    const date = r.started_at.slice(0, 16).replace('T', ' ');
    const tag = r.thread_id ? ` ${ANSI.magenta}#${r.thread_id}${ANSI.reset}` : '';
    const proj = r.project_id ? ` ${ANSI.dim}[${r.project_id}]${ANSI.reset}` : '';
    const cost = r.total_cost_usd > 0 ? `$${r.total_cost_usd.toFixed(4)}` : `${ANSI.dim}$0${ANSI.reset}`;
    const statusColor = r.status === 'completed' ? ANSI.green : r.status === 'aborted_error' ? ANSI.red : ANSI.yellow;
    process.stdout.write(
      `  ${ANSI.bold}${id}${ANSI.reset}  ${ANSI.dim}${date}${ANSI.reset}  ${r.model.padEnd(38)} ${statusColor}${r.status.padEnd(18)}${ANSI.reset} ${cost.padStart(10)}${tag}${proj}\n`,
    );
  }
  process.stdout.write('\n');
}

async function showConversation(
  conversationId: string,
  indexRecord: IndexRecord,
  json: boolean,
  traceDir: string,
): Promise<void> {
  const date = indexRecord.started_at.slice(0, 10);
  const path = join(traceDir, date, `${conversationId}.jsonl`);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`trace JSONL missing at ${path} (the index has the row but the file is gone)`);
    }
    throw err;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records: TraceRecord[] = [];
  for (const line of lines) {
    try {
      records.push(TraceRecordSchema.parse(JSON.parse(line)));
    } catch {
      // skip malformed
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ index: indexRecord, records }, null, 2) + '\n');
    return;
  }

  // Header
  const tag = indexRecord.thread_id ? ` ${ANSI.magenta}#${indexRecord.thread_id}${ANSI.reset}` : '';
  const proj = indexRecord.project_id ? ` ${ANSI.dim}[${indexRecord.project_id}]${ANSI.reset}` : '';
  process.stdout.write(
    `\n${ANSI.bold}${ANSI.cyan}${conversationId}${ANSI.reset}${tag}${proj}\n` +
      `${ANSI.dim}  model=${indexRecord.model}  status=${indexRecord.status}  cost=$${indexRecord.total_cost_usd.toFixed(4)}  ` +
      `tokens=${indexRecord.total_input_tokens}→${indexRecord.total_output_tokens}` +
      (indexRecord.total_cached_input_tokens ? ` cached=${indexRecord.total_cached_input_tokens}` : '') +
      `  started=${indexRecord.started_at.slice(0, 19)}${ANSI.reset}\n\n`,
  );

  for (const r of records) {
    const ts = r.ts.slice(11, 19);
    switch (r.type) {
      case 'user':
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${ANSI.cyan}user${ANSI.reset}\n${indent(stringContent(r.content))}\n\n`);
        break;
      case 'assistant':
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${ANSI.green}assistant${ANSI.reset}\n${indent(stringContent(r.content))}\n\n`);
        break;
      case 'tool_call':
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${ANSI.blue}→ tool_call${ANSI.reset} ${ANSI.dim}${truncate(JSON.stringify(r.content), 160)}${ANSI.reset}\n`);
        break;
      case 'tool_result':
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${ANSI.green}← tool_result${ANSI.reset} ${ANSI.dim}${truncate(JSON.stringify(r.content), 160)}${ANSI.reset}\n`);
        break;
      case 'error':
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${ANSI.red}error${ANSI.reset} ${truncate(JSON.stringify(r.content), 200)}\n`);
        break;
      case 'system':
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${ANSI.yellow}system${ANSI.reset} ${ANSI.dim}${truncate(stringContent(r.content), 200)}${ANSI.reset}\n`);
        break;
      default:
        process.stdout.write(`  ${ANSI.dim}${ts}${ANSI.reset} ${r.type}\n`);
    }
  }
  process.stdout.write('\n');
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
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records: IndexRecord[] = [];
  for (const line of lines) {
    try {
      records.push(IndexRecordSchema.parse(JSON.parse(line)));
    } catch {
      // skip malformed
    }
  }
  return records;
}

function parseSince(input: string): number {
  if (input === 'all') return Number.POSITIVE_INFINITY;
  const match = input.match(/^(\d+)([dwmy])$/);
  if (!match) {
    throw new Error(`invalid --since value: ${input} (use 7d, 4w, 3m, 1y, or 'all')`);
  }
  const n = Number(match[1]);
  const day = 24 * 60 * 60 * 1000;
  switch (match[2]) {
    case 'd': return n * day;
    case 'w': return n * 7 * day;
    case 'm': return n * 30 * day;
    case 'y': return n * 365 * day;
    default: throw new Error(`invalid unit: ${match[2]}`);
  }
}

function stringContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

function indent(text: string): string {
  return text.split('\n').map((l) => '    ' + l).join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Exported for test reuse — keeps the parser/filter logic poke-able without going through the CLI dispatcher.
export const __test = {
  parseSince,
  loadIndex,
};
