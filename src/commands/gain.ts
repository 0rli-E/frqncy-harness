/**
 * `frqncy-harness gain [--period 7d] [--top N] [--json]`
 *
 * Cost decomposition by tool / model / lane / conversation. Where `costs` shows
 * the total spend for a period, `gain` decomposes that spend so you can see
 * *what* the tokens went to. Turns the $5/$25 cap from a limit into a tunable.
 *
 * Per `proposals/SELF-IMPROVING-HARNESS.md` Tier B.3: the actionable signal isn't
 * "I spent $4.20 this week" — it's "I spent $3.80 of that on undeduplicated docker
 * logs in 5 conversations on this thread."
 *
 * Three views, one command:
 *   1. Spend by model — which lanes are eating the budget
 *   2. Tool-call distribution — what tools the agents are reaching for
 *   3. Top N most-expensive single conversations — the outliers worth replaying with --diff
 *
 * Reads the same INDEX.jsonl + per-conversation JSONL trace files the rest of the
 * harness writes. Zero new state, no new cost.
 *
 * v0.9 limitation: no per-tool-call cost attribution (the trace records `usage`
 * on the assistant record only, not per tool_call). Top-N expensive conversations
 * + tool-call distribution gets you 80% of the actionable signal; per-tool-cost
 * attribution lands when a future RTK-style filter registry tracks bytes-saved.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { IndexRecordSchema, TraceRecordSchema, type IndexRecord, type TraceRecord } from '../types.js';
import { getIndexFilePath, DEFAULT_TRACE_DIR } from '../trace.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

const DEFAULT_PERIOD = '7d';
const DEFAULT_TOP_N = 10;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface GainCommandOptions {
  /** Time window — `7d`/`4w`/`3m`/`1y`/`all`. Default `7d`. */
  period?: string;
  /** How many top-expensive conversations to surface. Default 10. */
  top?: number;
  /** Filter to one thread tag. */
  threadId?: string;
  /** Filter to one project tag. */
  projectId?: string;
  /** Emit JSON instead of human-readable status. */
  json?: boolean;
  /** Test seam — override trace dir. */
  traceDir?: string;
}

export interface ModelSpend {
  model: string;
  conversations: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface ToolCallStat {
  toolName: string;
  callCount: number;
  conversationsWithThisTool: number;
}

/**
 * x402 spend bucket — one row per (network, asset, direction) tuple.
 *
 * `direction: 'out'` is what the harness *paid* (cost in USDC).
 * `direction: 'in'`  is what the harness *received* via monetized endpoints.
 *
 * `totalAtomic` is the sum of `amountAtomic` across settlement records — the
 * source of truth for "how much USDC moved." `failedSettlements` tallies the
 * `settled === false` records so the user can see attempted but unsettled
 * spend distinct from successful spend.
 */
export interface X402Spend {
  network: string;
  asset: string;
  direction: 'out' | 'in';
  settlements: number;
  failedSettlements: number;
  totalAtomic: string;
  distinctConversations: number;
}

export interface TopConversation {
  conversationId: string;
  startedAt: string;
  model: string;
  costUsd: number;
  threadId?: string;
  projectId?: string;
  status: string;
}

export interface GainResult {
  period: string;
  windowStart: string;
  totalConversations: number;
  totalCostUsd: number;
  byModel: ModelSpend[];
  byTool: ToolCallStat[];
  topConversations: TopConversation[];
  /** v0.13 — x402 spend decomposition by network/asset/direction. */
  x402Spend: X402Spend[];
}

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

export async function runGainCommand(options: GainCommandOptions = {}): Promise<GainResult> {
  const traceDir = options.traceDir ?? DEFAULT_TRACE_DIR;
  const period = options.period ?? DEFAULT_PERIOD;
  const topN = options.top ?? DEFAULT_TOP_N;
  const periodMs = parsePeriod(period);
  const cutoffMs = periodMs === Number.POSITIVE_INFINITY ? 0 : Date.now() - periodMs;
  const windowStart = new Date(cutoffMs).toISOString();

  // 1. Read INDEX.jsonl
  const index = await loadIndex(traceDir);

  const inWindow = index.filter((r) => {
    if (Date.parse(r.started_at) < cutoffMs) return false;
    if (options.threadId && r.thread_id !== options.threadId) return false;
    if (options.projectId && r.project_id !== options.projectId) return false;
    return true;
  });

  // 2. Aggregate by model
  const byModelMap = new Map<string, ModelSpend>();
  for (const r of inWindow) {
    const existing = byModelMap.get(r.model);
    if (existing) {
      existing.conversations += 1;
      existing.totalCostUsd += r.total_cost_usd;
      existing.totalInputTokens += r.total_input_tokens;
      existing.totalOutputTokens += r.total_output_tokens;
    } else {
      byModelMap.set(r.model, {
        model: r.model,
        conversations: 1,
        totalCostUsd: r.total_cost_usd,
        totalInputTokens: r.total_input_tokens,
        totalOutputTokens: r.total_output_tokens,
      });
    }
  }
  const byModel = Array.from(byModelMap.values()).sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  // 3. Top N most-expensive conversations
  const topConversations: TopConversation[] = inWindow
    .slice()
    .sort((a, b) => b.total_cost_usd - a.total_cost_usd)
    .slice(0, topN)
    .map((r) => ({
      conversationId: r.conversation_id,
      startedAt: r.started_at,
      model: r.model,
      costUsd: r.total_cost_usd,
      ...(r.thread_id ? { threadId: r.thread_id } : {}),
      ...(r.project_id ? { projectId: r.project_id } : {}),
      status: r.status,
    }));

  // 4. Tool-call distribution — read per-conversation trace files for the top-N
  // (We read only top-N to bound the cost of `gain` itself; broader sampling can
  // be added if the user passes --top all.)
  const toolStats = await collectToolStats(inWindow, traceDir);

  // 5. x402 spend decomposition — same pass through per-conversation traces,
  // filtered to `payment`-type records.
  const x402Spend = await collectX402Spend(inWindow, traceDir);

  const totalCostUsd = inWindow.reduce((sum, r) => sum + r.total_cost_usd, 0);

  const result: GainResult = {
    period,
    windowStart,
    totalConversations: inWindow.length,
    totalCostUsd,
    byModel,
    byTool: toolStats,
    topConversations,
    x402Spend,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }

  renderHumanReadable(result, topN);
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

const PERIOD_REGEX = /^(\d+)([dwmy])$/;

export function parsePeriod(period: string): number {
  if (period === 'all') return Number.POSITIVE_INFINITY;
  const match = period.match(PERIOD_REGEX);
  if (!match) {
    throw new Error(`invalid --period "${period}" — expected like 7d, 4w, 3m, 1y, or all`);
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
      throw new Error(`invalid time unit in --period "${period}"`);
  }
}

export function aggregateToolStats(records: TraceRecord[]): Map<string, { calls: number; conversations: Set<string> }> {
  const map = new Map<string, { calls: number; conversations: Set<string> }>();
  for (const r of records) {
    if (r.type === 'tool_call') {
      // Tool name is in `tools_called` array (one entry per tool_call record by convention)
      // OR can be inferred from content if structured. We accept either path.
      const toolName = inferToolName(r);
      if (!toolName) continue;
      const entry = map.get(toolName) ?? { calls: 0, conversations: new Set<string>() };
      entry.calls += 1;
      entry.conversations.add(r.conversation_id);
      map.set(toolName, entry);
    }
  }
  return map;
}

export function inferToolName(record: TraceRecord): string | null {
  // Preferred: tools_called array on the record (set by chat/stream when known)
  if (record.tools_called && record.tools_called.length > 0) {
    return record.tools_called[0]!;
  }
  // Fallback: structured content with toolName field
  if (typeof record.content === 'object' && record.content !== null) {
    const c = record.content as { toolName?: unknown };
    if (typeof c.toolName === 'string') return c.toolName;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

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
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch {
    return [];
  }
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

/**
 * Aggregate `payment`-type trace records across the in-window conversations,
 * grouped by (network, asset, direction).
 *
 * Returns a flat list sorted by `direction='out'` first (spend) then `'in'`
 * (revenue), each direction sorted by total_atomic descending. We use a
 * BigInt running sum on `totalAtomic` and only stringify at the end so
 * cents-level precision survives across many settlements.
 */
async function collectX402Spend(inWindow: IndexRecord[], traceDir: string): Promise<X402Spend[]> {
  // key = `${direction}|${network}|${asset}`
  const map = new Map<
    string,
    {
      network: string;
      asset: string;
      direction: 'out' | 'in';
      settlements: number;
      failedSettlements: number;
      totalAtomic: bigint;
      conversations: Set<string>;
    }
  >();

  for (const indexEntry of inWindow) {
    const records = await loadConversationRecords(indexEntry, traceDir);
    for (const r of records) {
      if (r.type !== 'payment') continue;
      // Trust the trace body shape — we validated on write via PaymentTraceBodySchema.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = r.content as any;
      if (!c || (c.direction !== 'out' && c.direction !== 'in')) continue;
      const network = String(c.network ?? 'unknown');
      const asset = String(c.asset ?? 'unknown');
      const direction = c.direction as 'out' | 'in';
      const key = `${direction}|${network}|${asset}`;
      const entry =
        map.get(key) ??
        {
          network,
          asset,
          direction,
          settlements: 0,
          failedSettlements: 0,
          totalAtomic: 0n,
          conversations: new Set<string>(),
        };
      const settled = c.settled === true;
      if (settled) {
        entry.settlements += 1;
        try {
          entry.totalAtomic += BigInt(String(c.amountAtomic ?? '0'));
        } catch {
          // skip malformed amount
        }
      } else {
        entry.failedSettlements += 1;
      }
      entry.conversations.add(r.conversation_id);
      map.set(key, entry);
    }
  }

  return Array.from(map.values())
    .map((e) => ({
      network: e.network,
      asset: e.asset,
      direction: e.direction,
      settlements: e.settlements,
      failedSettlements: e.failedSettlements,
      totalAtomic: e.totalAtomic.toString(),
      distinctConversations: e.conversations.size,
    }))
    .sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
      // Numerically compare via BigInt to avoid string-sort surprises
      const ba = BigInt(a.totalAtomic);
      const bb = BigInt(b.totalAtomic);
      return bb > ba ? 1 : bb < ba ? -1 : 0;
    });
}

async function collectToolStats(inWindow: IndexRecord[], traceDir: string): Promise<ToolCallStat[]> {
  const aggregate = new Map<string, { calls: number; conversations: Set<string> }>();
  for (const indexEntry of inWindow) {
    const records = await loadConversationRecords(indexEntry, traceDir);
    const local = aggregateToolStats(records);
    for (const [name, stat] of local.entries()) {
      const existing = aggregate.get(name);
      if (existing) {
        existing.calls += stat.calls;
        for (const c of stat.conversations) existing.conversations.add(c);
      } else {
        aggregate.set(name, { calls: stat.calls, conversations: new Set(stat.conversations) });
      }
    }
  }
  return Array.from(aggregate.entries())
    .map(([toolName, stat]) => ({
      toolName,
      callCount: stat.calls,
      conversationsWithThisTool: stat.conversations.size,
    }))
    .sort((a, b) => b.callCount - a.callCount);
}

/**
 * Local 6-decimal USDC formatter — kept self-contained so `gain` doesn't pull
 * the payments module just for one helper. Mirrors `formatAtomicUsdc` from
 * `src/payments/budget.ts`.
 */
function formatAtomicUsdcLocal(atomic: bigint): string {
  const sign = atomic < 0n ? '-' : '';
  const a = atomic < 0n ? -atomic : atomic;
  const whole = a / 1_000_000n;
  const frac = a % 1_000_000n;
  return `$${sign}${whole}.${frac.toString().padStart(6, '0').slice(0, 2)}`;
}

function renderHumanReadable(r: GainResult, topN: number): void {
  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}gain — ${r.period} window${ANSI.reset}` +
      ` ${ANSI.dim}(${r.totalConversations} conversation${r.totalConversations === 1 ? '' : 's'}, ` +
      `total $${r.totalCostUsd.toFixed(4)})${ANSI.reset}\n\n`,
  );

  // Spend by model
  process.stdout.write(`${ANSI.bold}Spend by model${ANSI.reset}\n`);
  if (r.byModel.length === 0) {
    process.stdout.write(`  ${ANSI.dim}(no conversations in window)${ANSI.reset}\n`);
  } else {
    const widest = Math.max(...r.byModel.map((m) => m.model.length));
    for (const m of r.byModel) {
      const padded = m.model.padEnd(widest);
      process.stdout.write(
        `  ${padded}  ${ANSI.green}$${m.totalCostUsd.toFixed(4).padStart(8)}${ANSI.reset}` +
          `  ${ANSI.dim}${m.conversations.toString().padStart(3)} conv  ` +
          `in=${m.totalInputTokens}  out=${m.totalOutputTokens}${ANSI.reset}\n`,
      );
    }
    process.stdout.write(
      `  ${'TOTAL'.padEnd(widest)}  ${ANSI.bold}$${r.totalCostUsd.toFixed(4).padStart(8)}${ANSI.reset}\n`,
    );
  }
  process.stdout.write('\n');

  // Tool-call distribution
  process.stdout.write(`${ANSI.bold}Tool-call distribution${ANSI.reset}\n`);
  if (r.byTool.length === 0) {
    process.stdout.write(`  ${ANSI.dim}(no tool calls recorded in window)${ANSI.reset}\n`);
  } else {
    const widest = Math.max(...r.byTool.map((t) => t.toolName.length));
    for (const t of r.byTool) {
      process.stdout.write(
        `  ${t.toolName.padEnd(widest)}  ${ANSI.cyan}${t.callCount.toString().padStart(5)}${ANSI.reset} calls` +
          `  ${ANSI.dim}across ${t.conversationsWithThisTool} conv${ANSI.reset}\n`,
      );
    }
  }
  process.stdout.write('\n');

  // x402 spend (only render when there's any payment activity)
  if (r.x402Spend.length > 0) {
    process.stdout.write(`${ANSI.bold}x402 spend${ANSI.reset}\n`);
    const widestNetwork = Math.max(...r.x402Spend.map((s) => s.network.length), 7);
    let totalOut = 0n;
    let totalIn = 0n;
    for (const s of r.x402Spend) {
      const arrow = s.direction === 'out' ? '→' : '←';
      const formatted = formatAtomicUsdcLocal(BigInt(s.totalAtomic));
      const failedNote = s.failedSettlements > 0
        ? ` ${ANSI.dim}(+${s.failedSettlements} failed)${ANSI.reset}`
        : '';
      process.stdout.write(
        `  ${arrow} ${s.network.padEnd(widestNetwork)}  ` +
          `${ANSI.green}${formatted.padStart(10)}${ANSI.reset}  ` +
          `${ANSI.dim}${s.settlements.toString().padStart(4)} settlement${s.settlements === 1 ? '' : 's'}` +
          `, ${s.distinctConversations} conv${ANSI.reset}${failedNote}\n`,
      );
      if (s.direction === 'out') totalOut += BigInt(s.totalAtomic);
      else totalIn += BigInt(s.totalAtomic);
    }
    if (totalOut > 0n || totalIn > 0n) {
      process.stdout.write(
        `\n  ${ANSI.bold}net${ANSI.reset}: ` +
          `${ANSI.green}${formatAtomicUsdcLocal(totalIn - totalOut)}${ANSI.reset} ` +
          `${ANSI.dim}(out ${formatAtomicUsdcLocal(totalOut)} / in ${formatAtomicUsdcLocal(totalIn)})${ANSI.reset}\n`,
      );
    }
    process.stdout.write('\n');
  }

  // Top N expensive conversations
  process.stdout.write(`${ANSI.bold}Top ${Math.min(topN, r.topConversations.length)} most-expensive conversations${ANSI.reset}\n`);
  if (r.topConversations.length === 0) {
    process.stdout.write(`  ${ANSI.dim}(no conversations in window)${ANSI.reset}\n`);
  } else {
    for (let i = 0; i < r.topConversations.length; i++) {
      const c = r.topConversations[i]!;
      const tag = c.threadId ? ` ${ANSI.dim}thread=${c.threadId}${ANSI.reset}` : '';
      process.stdout.write(
        `  ${(i + 1).toString().padStart(2)}. ${c.conversationId.slice(0, 8)}` +
          `  ${ANSI.green}$${c.costUsd.toFixed(4).padStart(8)}${ANSI.reset}` +
          `  ${ANSI.dim}${c.model}${ANSI.reset}` +
          `  ${ANSI.dim}${c.status}${ANSI.reset}${tag}\n`,
      );
    }
    process.stdout.write(
      `\n${ANSI.yellow}tip:${ANSI.reset} replay any of these with ${ANSI.bold}frqncy-harness replay <conv-id> --diff${ANSI.reset} ` +
        `to see what they actually produced.\n`,
    );
  }
}
