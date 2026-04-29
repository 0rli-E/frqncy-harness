/**
 * Payment trace + pre-payment hook integration tests.
 *
 * Offline. Exercises the wiring that makes x402 payments visible to
 * the rest of the harness:
 *   - `payment`-type trace records get appended to the right JSONL file
 *   - PaymentTraceBodySchema rejects malformed bodies
 *   - HookManager.firePrePayment aggregates a veto/allow decision
 *   - createPrePaymentHookGate returns `{ block }` when a hook vetoes
 *   - createPaymentTraceWriter increments steps monotonically
 *   - createInboundPaymentTraceWriter writes 'in' direction records
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PaymentTraceBodySchema } from '../src/types.js';
import type { PaymentRequirements } from '../src/payments/index.js';
import {
  createPaymentTraceWriter,
  createInboundPaymentTraceWriter,
  createPrePaymentHookGate,
} from '../src/payments/trace.js';
import { HookManager, type PrePaymentContext } from '../src/hooks/index.js';
import { getTraceFilePath } from '../src/trace.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function baseRequirements(): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    resource: 'http://example.com/data',
    description: 'test',
    mimeType: 'application/json',
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    extra: { name: 'USDC', version: '2' },
  };
}

async function readJsonlLines(path: string): Promise<unknown[]> {
  const raw = await fs.readFile(path, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

// ────────────────────────────────────────────────────────────────────
// PaymentTraceBodySchema
// ────────────────────────────────────────────────────────────────────

describe('PaymentTraceBodySchema', () => {
  it('accepts a well-formed body', () => {
    expect(() =>
      PaymentTraceBodySchema.parse({
        direction: 'out',
        resource: 'http://example.com/x',
        amountAtomic: '10000',
        asset: '0x' + 'a'.repeat(40),
        network: 'base',
        payee: '0x' + 'b'.repeat(40),
        settled: true,
      }),
    ).not.toThrow();
  });

  it('rejects negative amounts', () => {
    expect(() =>
      PaymentTraceBodySchema.parse({
        direction: 'out',
        resource: 'http://example.com/x',
        amountAtomic: '-1',
        asset: '0x' + 'a'.repeat(40),
        network: 'base',
        payee: '0x' + 'b'.repeat(40),
        settled: true,
      }),
    ).toThrow();
  });

  it('rejects malformed addresses', () => {
    expect(() =>
      PaymentTraceBodySchema.parse({
        direction: 'out',
        resource: 'http://example.com/x',
        amountAtomic: '10000',
        asset: 'not-an-address',
        network: 'base',
        payee: '0x' + 'b'.repeat(40),
        settled: true,
      }),
    ).toThrow();
  });

  it('rejects unknown directions', () => {
    expect(() =>
      PaymentTraceBodySchema.parse({
        direction: 'sideways',
        resource: 'x',
        amountAtomic: '0',
        asset: '0x' + 'a'.repeat(40),
        network: 'base',
        payee: '0x' + 'b'.repeat(40),
        settled: true,
      }),
    ).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// HookManager.firePrePayment
// ────────────────────────────────────────────────────────────────────

describe('HookManager.firePrePayment', () => {
  function ctx(): PrePaymentContext {
    return {
      event: 'pre-payment',
      conversationId: randomUUID(),
      resource: 'http://example.com/x',
      amountAtomic: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      payee: '0x2222222222222222222222222222222222222222',
      spentSoFarAtomic: '0',
    };
  }

  it('returns { block: false } when no hooks are configured', async () => {
    const mgr = new HookManager({});
    const decision = await mgr.firePrePayment(ctx());
    expect(decision.block).toBe(false);
    expect(decision.results).toHaveLength(0);
  });

  it('blocks when a shell hook prints {"block":true}', async () => {
    const mgr = new HookManager({
      'pre-payment': [
        // Shell hook: ignore stdin, emit JSON veto, exit 0
        `cat >/dev/null; echo '{"block":true,"reason":"unit test veto"}'`,
      ],
    });
    const decision = await mgr.firePrePayment(ctx());
    expect(decision.block).toBe(true);
    expect(decision.reason).toBe('unit test veto');
    expect(decision.results).toHaveLength(1);
    expect(decision.results[0]?.success).toBe(true);
  });

  it('does NOT block on a non-blocking hook', async () => {
    const mgr = new HookManager({
      'pre-payment': [`cat >/dev/null; echo '{"warning":"just observing"}'`],
    });
    const decision = await mgr.firePrePayment(ctx());
    expect(decision.block).toBe(false);
    expect(decision.results[0]?.warning).toBe('just observing');
  });

  it('first-mover-wins: stops after the first blocking hook', async () => {
    const mgr = new HookManager({
      'pre-payment': [
        `cat >/dev/null; echo '{"block":true,"reason":"first"}'`,
        `cat >/dev/null; echo '{"block":true,"reason":"second"}'`,
      ],
    });
    const decision = await mgr.firePrePayment(ctx());
    expect(decision.block).toBe(true);
    expect(decision.reason).toBe('first');
  });

  it('a non-zero-exit hook does NOT block by default', async () => {
    const mgr = new HookManager({
      'pre-payment': [`cat >/dev/null; exit 1`],
    });
    const decision = await mgr.firePrePayment(ctx());
    expect(decision.block).toBe(false);
    expect(decision.results[0]?.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// createPrePaymentHookGate (the wrapFetchWithPayment-shaped callback)
// ────────────────────────────────────────────────────────────────────

describe('createPrePaymentHookGate', () => {
  it('returns void when no hooks are configured', async () => {
    const hookManager = new HookManager({});
    const gate = createPrePaymentHookGate({ hookManager });
    const result = await gate({
      resource: 'http://example.com/x',
      requirements: baseRequirements(),
      spentSoFarAtomic: 0n,
    });
    expect(result).toBeUndefined();
  });

  it('returns { block: true, reason } when a hook vetoes', async () => {
    const hookManager = new HookManager({
      'pre-payment': [`cat >/dev/null; echo '{"block":true,"reason":"too pricey"}'`],
    });
    const gate = createPrePaymentHookGate({ hookManager });
    const result = await gate({
      resource: 'http://example.com/x',
      requirements: baseRequirements(),
      spentSoFarAtomic: 0n,
    });
    expect(result).toEqual({ block: true, reason: 'too pricey' });
  });
});

// ────────────────────────────────────────────────────────────────────
// createPaymentTraceWriter
// ────────────────────────────────────────────────────────────────────

describe('createPaymentTraceWriter', () => {
  let traceDir: string;

  beforeEach(async () => {
    traceDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-paytrace-'));
  });

  afterEach(async () => {
    await fs.rm(traceDir, { recursive: true, force: true });
  });

  it('appends one payment record per call', async () => {
    const conversationId = randomUUID();
    const startedAt = new Date('2026-04-29T00:00:00Z');
    const writer = createPaymentTraceWriter({
      conversationId,
      startedAt,
      traceDir,
    });
    const reqs = baseRequirements();

    await writer({
      direction: 'out',
      resource: 'http://example.com/data',
      requirements: reqs,
      amountAtomic: '10000',
      asset: reqs.asset,
      network: reqs.network,
      txHash: '0xdeadbeef',
      payer: '0x1111111111111111111111111111111111111111',
      payee: reqs.payTo,
      settled: { success: true, transaction: '0xdeadbeef', network: reqs.network },
      facilitator: 'https://x402.org/facilitator',
      triggered: 'none',
      timestamp: '2026-04-29T01:00:00.000Z',
    });

    const path = getTraceFilePath(conversationId, startedAt, traceDir);
    const records = (await readJsonlLines(path)) as Array<{
      type: string;
      content: { direction: string; settled: boolean; txHash?: string };
      step: number;
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('payment');
    expect(records[0]?.content.direction).toBe('out');
    expect(records[0]?.content.settled).toBe(true);
    expect(records[0]?.content.txHash).toBe('0xdeadbeef');
    expect(records[0]?.step).toBe(0);
  });

  it('increments step monotonically', async () => {
    const conversationId = randomUUID();
    const startedAt = new Date('2026-04-29T00:00:00Z');
    const writer = createPaymentTraceWriter({
      conversationId,
      startedAt,
      traceDir,
      step: 5,
    });
    const reqs = baseRequirements();
    for (let i = 0; i < 3; i++) {
      await writer({
        direction: 'out',
        resource: 'http://example.com/data',
        requirements: reqs,
        amountAtomic: '10000',
        asset: reqs.asset,
        network: reqs.network,
        payee: reqs.payTo,
        settled: { success: true, transaction: '0xa', network: reqs.network },
        facilitator: 'fac',
        triggered: 'none',
        timestamp: '2026-04-29T01:00:00.000Z',
      });
    }
    const path = getTraceFilePath(conversationId, startedAt, traceDir);
    const records = (await readJsonlLines(path)) as Array<{ step: number }>;
    expect(records.map((r) => r.step)).toEqual([5, 6, 7]);
  });

  it('records failed settlements with errorReason', async () => {
    const conversationId = randomUUID();
    const startedAt = new Date('2026-04-29T00:00:00Z');
    const writer = createPaymentTraceWriter({
      conversationId,
      startedAt,
      traceDir,
    });
    const reqs = baseRequirements();
    await writer({
      direction: 'out',
      resource: 'http://example.com/data',
      requirements: reqs,
      amountAtomic: '10000',
      asset: reqs.asset,
      network: reqs.network,
      payee: reqs.payTo,
      settled: {
        success: false,
        transaction: '',
        network: reqs.network,
        errorReason: 'insufficient_funds',
      },
      facilitator: 'fac',
      triggered: 'none',
      timestamp: '2026-04-29T01:00:00.000Z',
    });
    const path = getTraceFilePath(conversationId, startedAt, traceDir);
    const records = (await readJsonlLines(path)) as Array<{
      content: { settled: boolean; errorReason?: string };
    }>;
    expect(records[0]?.content.settled).toBe(false);
    expect(records[0]?.content.errorReason).toBe('insufficient_funds');
  });
});

describe('createInboundPaymentTraceWriter', () => {
  let traceDir: string;
  beforeEach(async () => {
    traceDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-paytrace-in-'));
  });
  afterEach(async () => {
    await fs.rm(traceDir, { recursive: true, force: true });
  });

  it('records direction=in records for monetized endpoints', async () => {
    const conversationId = randomUUID();
    const startedAt = new Date('2026-04-29T00:00:00Z');
    const writer = createInboundPaymentTraceWriter({
      conversationId,
      startedAt,
      traceDir,
    });
    const reqs = baseRequirements();
    await writer({
      direction: 'in',
      path: '/premium',
      requirements: reqs,
      amountAtomic: '50000',
      asset: reqs.asset,
      network: reqs.network,
      txHash: '0xabc',
      payer: '0x1111111111111111111111111111111111111111',
      payee: reqs.payTo,
      timestamp: '2026-04-29T02:00:00.000Z',
    });
    const path = getTraceFilePath(conversationId, startedAt, traceDir);
    const records = (await readJsonlLines(path)) as Array<{
      content: { direction: string; resource: string; settled: boolean };
    }>;
    expect(records[0]?.content.direction).toBe('in');
    expect(records[0]?.content.resource).toBe('/premium');
    expect(records[0]?.content.settled).toBe(true);
  });
});
