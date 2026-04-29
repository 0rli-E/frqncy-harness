/**
 * `gain` x402 spend aggregation — offline.
 *
 * Builds a fake trace store with a mix of LLM and `payment`-type records,
 * then runs `runGainCommand` and asserts the x402Spend buckets are correct.
 *
 * Confirms:
 *   - Settled out + in records aggregate per (network, asset, direction)
 *   - Failed settlements count under failedSettlements but DON'T inflate totalAtomic
 *   - distinctConversations dedupes per bucket
 *   - --thread filter limits to thread-tagged conversations
 *   - Empty trace dir produces an empty x402Spend list (back-compat)
 *   - Records sort by direction first ('out' then 'in') and then by atomic descending
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runGainCommand } from '../src/commands/gain.js';
import {
  TRACE_SCHEMA_VERSION,
  type TraceRecord,
  type IndexRecord,
} from '../src/types.js';
import { getIndexFilePath, getTraceFilePath } from '../src/trace.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

interface FixtureConvOpts {
  traceDir: string;
  startedAt: Date;
  threadId?: string;
  costUsd?: number;
  payments?: Array<{
    direction: 'out' | 'in';
    network: string;
    asset?: string;
    amountAtomic: string;
    settled?: boolean;
  }>;
}

async function createFixtureConversation(opts: FixtureConvOpts): Promise<string> {
  const conversationId = randomUUID();
  const indexEntry: IndexRecord = {
    conversation_id: conversationId,
    started_at: opts.startedAt.toISOString(),
    ended_at: opts.startedAt.toISOString(),
    model: 'anthropic/claude-sonnet-4-6',
    message_count: 1,
    total_cost_usd: opts.costUsd ?? 0.01,
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cached_input_tokens: 0,
    status: 'completed',
    ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    schema_version: TRACE_SCHEMA_VERSION,
  };

  // Append index entry
  await fs.mkdir(opts.traceDir, { recursive: true });
  await fs.appendFile(getIndexFilePath(opts.traceDir), JSON.stringify(indexEntry) + '\n');

  // Append per-conversation JSONL with one user record + the payment records
  const traceFile = getTraceFilePath(conversationId, opts.startedAt, opts.traceDir);
  await fs.mkdir(join(traceFile, '..'), { recursive: true });

  let step = 0;
  const lines: string[] = [];
  // user message
  const userRecord: TraceRecord = {
    ts: opts.startedAt.toISOString(),
    conversation_id: conversationId,
    step: step++,
    type: 'user',
    role: 'user',
    content: 'hi',
    schema_version: TRACE_SCHEMA_VERSION,
  };
  lines.push(JSON.stringify(userRecord));

  for (const p of opts.payments ?? []) {
    const settled = p.settled ?? true;
    const paymentRecord: TraceRecord = {
      ts: opts.startedAt.toISOString(),
      conversation_id: conversationId,
      step: step++,
      type: 'payment',
      content: {
        direction: p.direction,
        resource: 'http://example.com/x',
        amountAtomic: p.amountAtomic,
        asset: p.asset ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        network: p.network,
        payee: '0x2222222222222222222222222222222222222222',
        settled,
        scheme: 'exact',
      },
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
      schema_version: TRACE_SCHEMA_VERSION,
    };
    lines.push(JSON.stringify(paymentRecord));
  }
  await fs.writeFile(traceFile, lines.join('\n') + '\n');

  return conversationId;
}

// ────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────

describe('runGainCommand — x402Spend aggregation', () => {
  let traceDir: string;

  beforeEach(async () => {
    traceDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-gain-x402-'));
  });

  afterEach(async () => {
    await fs.rm(traceDir, { recursive: true, force: true });
  });

  it('returns an empty x402Spend when no payment records exist', async () => {
    await createFixtureConversation({ traceDir, startedAt: new Date() });
    // Suppress human-readable output during test
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.x402Spend).toEqual([]);
  });

  it('aggregates settled out payments by (network, asset)', async () => {
    await createFixtureConversation({
      traceDir,
      startedAt: new Date(),
      payments: [
        { direction: 'out', network: 'base', amountAtomic: '50000' },
        { direction: 'out', network: 'base', amountAtomic: '25000' },
        { direction: 'out', network: 'base-sepolia', amountAtomic: '10000' },
      ],
    });
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.x402Spend).toHaveLength(2);
    const base = result.x402Spend.find((s) => s.network === 'base');
    expect(base).toBeDefined();
    expect(base?.direction).toBe('out');
    expect(base?.settlements).toBe(2);
    expect(base?.totalAtomic).toBe('75000');
    expect(base?.distinctConversations).toBe(1);
  });

  it('counts failed settlements separately from totalAtomic', async () => {
    await createFixtureConversation({
      traceDir,
      startedAt: new Date(),
      payments: [
        { direction: 'out', network: 'base', amountAtomic: '10000', settled: true },
        { direction: 'out', network: 'base', amountAtomic: '50000', settled: false },
      ],
    });
    const result = await runGainCommand({ traceDir, json: true });
    const base = result.x402Spend.find((s) => s.network === 'base' && s.direction === 'out');
    expect(base?.settlements).toBe(1);
    expect(base?.failedSettlements).toBe(1);
    // Failed settlement does NOT inflate totalAtomic
    expect(base?.totalAtomic).toBe('10000');
  });

  it('separates out and in directions', async () => {
    await createFixtureConversation({
      traceDir,
      startedAt: new Date(),
      payments: [
        { direction: 'out', network: 'base', amountAtomic: '50000' },
        { direction: 'in', network: 'base', amountAtomic: '100000' },
      ],
    });
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.x402Spend).toHaveLength(2);
    const out = result.x402Spend.find((s) => s.direction === 'out');
    const inb = result.x402Spend.find((s) => s.direction === 'in');
    expect(out?.totalAtomic).toBe('50000');
    expect(inb?.totalAtomic).toBe('100000');
    // Sort order: 'out' first, then 'in'
    expect(result.x402Spend[0]?.direction).toBe('out');
    expect(result.x402Spend[1]?.direction).toBe('in');
  });

  it('sorts within direction by totalAtomic descending', async () => {
    await createFixtureConversation({
      traceDir,
      startedAt: new Date(),
      payments: [
        { direction: 'out', network: 'base-sepolia', amountAtomic: '500000' },
        { direction: 'out', network: 'base', amountAtomic: '100000' },
        { direction: 'out', network: 'polygon', amountAtomic: '300000' },
      ],
    });
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.x402Spend.map((s) => s.network)).toEqual([
      'base-sepolia',
      'polygon',
      'base',
    ]);
  });

  it('dedupes distinctConversations per bucket', async () => {
    const startedAt = new Date();
    // Three separate conversations, each pays once on `base`
    for (let i = 0; i < 3; i++) {
      await createFixtureConversation({
        traceDir,
        startedAt,
        payments: [{ direction: 'out', network: 'base', amountAtomic: '10000' }],
      });
    }
    const result = await runGainCommand({ traceDir, json: true });
    const base = result.x402Spend.find((s) => s.network === 'base');
    expect(base?.settlements).toBe(3);
    expect(base?.distinctConversations).toBe(3);
    expect(base?.totalAtomic).toBe('30000');
  });

  it('filters by --thread', async () => {
    const startedAt = new Date();
    await createFixtureConversation({
      traceDir,
      startedAt,
      threadId: 'team-alpha',
      payments: [{ direction: 'out', network: 'base', amountAtomic: '10000' }],
    });
    await createFixtureConversation({
      traceDir,
      startedAt,
      threadId: 'team-beta',
      payments: [{ direction: 'out', network: 'base', amountAtomic: '99999' }],
    });
    const result = await runGainCommand({ traceDir, json: true, threadId: 'team-alpha' });
    expect(result.x402Spend).toHaveLength(1);
    expect(result.x402Spend[0]?.totalAtomic).toBe('10000');
  });

  it('handles BigInt-sized atomic values without precision loss', async () => {
    await createFixtureConversation({
      traceDir,
      startedAt: new Date(),
      payments: [
        // ~$999,999.99 at 6 decimals — comfortably above JS Number safe range
        // when summed many times. We use one entry so we can pin the value.
        { direction: 'out', network: 'base', amountAtomic: '999999999999' },
        { direction: 'out', network: 'base', amountAtomic: '1' },
      ],
    });
    const result = await runGainCommand({ traceDir, json: true });
    const base = result.x402Spend.find((s) => s.network === 'base');
    expect(base?.totalAtomic).toBe('1000000000000');
  });
});
