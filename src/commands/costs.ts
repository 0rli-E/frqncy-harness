/**
 * `frqncy-harness costs --period 7d` — read INDEX.jsonl and summarize spend.
 */
import { promises as fs } from 'node:fs';
import { IndexRecordSchema, type IndexRecord } from '../types.js';
import { getIndexFilePath, DEFAULT_TRACE_DIR } from '../trace.js';

export interface CostsCommandOptions {
  period?: string;  // e.g., "7d", "30d", "1y", "all"
  json?: boolean;
}

export async function runCostsCommand(options: CostsCommandOptions): Promise<void> {
  const periodMs = parsePeriod(options.period ?? '7d');
  const cutoffMs = Date.now() - periodMs;

  const indexPath = getIndexFilePath(DEFAULT_TRACE_DIR);
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stdout.write(
        options.json ? '{"conversations":0,"totalCostUsd":0}\n' : 'no traces yet — make a call first.\n',
      );
      return;
    }
    throw err;
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records: IndexRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      records.push(IndexRecordSchema.parse(parsed));
    } catch {
      // skip malformed lines (older schema versions, partial writes)
    }
  }

  const inWindow = records.filter((r) => Date.parse(r.started_at) >= cutoffMs);

  const totals = {
    conversations: inWindow.length,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedInputTokens: 0,
  };

  const byModel = new Map<string, { conversations: number; costUsd: number; inputTokens: number; outputTokens: number; cachedInputTokens: number }>();
  const byStatus = new Map<string, number>();

  for (const r of inWindow) {
    totals.totalCostUsd += r.total_cost_usd;
    totals.totalInputTokens += r.total_input_tokens;
    totals.totalOutputTokens += r.total_output_tokens;
    totals.totalCachedInputTokens += r.total_cached_input_tokens;

    const m = byModel.get(r.model) ?? { conversations: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    m.conversations++;
    m.costUsd += r.total_cost_usd;
    m.inputTokens += r.total_input_tokens;
    m.outputTokens += r.total_output_tokens;
    m.cachedInputTokens += r.total_cached_input_tokens;
    byModel.set(r.model, m);

    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          period: options.period ?? '7d',
          ...totals,
          byModel: Object.fromEntries(byModel),
          byStatus: Object.fromEntries(byStatus),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  // Pretty print
  const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', reset: '\x1b[0m' };
  process.stdout.write(`\n${ANSI.bold}${ANSI.cyan}@frqncy-network/harness costs${ANSI.reset} ${ANSI.dim}(last ${options.period ?? '7d'})${ANSI.reset}\n\n`);
  process.stdout.write(`  Conversations:  ${totals.conversations}\n`);
  process.stdout.write(`  Input tokens:   ${totals.totalInputTokens.toLocaleString()}\n`);
  process.stdout.write(`  Output tokens:  ${totals.totalOutputTokens.toLocaleString()}\n`);
  process.stdout.write(`  Cached input:   ${totals.totalCachedInputTokens.toLocaleString()}\n`);
  process.stdout.write(`  ${ANSI.bold}Total cost:     $${totals.totalCostUsd.toFixed(4)}${ANSI.reset}\n\n`);

  if (byModel.size > 0) {
    process.stdout.write(`  ${ANSI.dim}By model:${ANSI.reset}\n`);
    const sorted = [...byModel.entries()].sort((a, b) => b[1].costUsd - a[1].costUsd);
    for (const [model, m] of sorted) {
      process.stdout.write(
        `    ${model.padEnd(48)} ${m.conversations.toString().padStart(4)} convs  $${m.costUsd.toFixed(4).padStart(10)}\n`,
      );
    }
    process.stdout.write('\n');
  }

  if (byStatus.size > 0) {
    process.stdout.write(`  ${ANSI.dim}By status:${ANSI.reset}\n`);
    for (const [status, count] of byStatus) {
      process.stdout.write(`    ${status.padEnd(24)} ${count}\n`);
    }
    process.stdout.write('\n');
  }
}

function parsePeriod(period: string): number {
  if (period === 'all') return Number.POSITIVE_INFINITY;
  const match = period.match(/^(\d+)([dwmy])$/);
  if (!match) throw new Error(`Invalid period: ${period} (use 7d, 4w, 3m, 1y, or 'all')`);
  const n = Number(match[1]);
  const unit = match[2];
  const day = 24 * 60 * 60 * 1000;
  switch (unit) {
    case 'd': return n * day;
    case 'w': return n * 7 * day;
    case 'm': return n * 30 * day;
    case 'y': return n * 365 * day;
    default: throw new Error(`Invalid period unit: ${unit}`);
  }
}
