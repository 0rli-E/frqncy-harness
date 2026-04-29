/**
 * Reputation auto-write tests — `createSettleFeedbackWriter`.
 *
 * Offline. Mocks `giveFeedback` from src/identity/registry.js so we never
 * touch a real chain. Confirms:
 *   - Settled out + lookup hit → giveFeedback fires with the right args
 *   - Lookup miss → no giveFeedback
 *   - Failed settlement → no giveFeedback
 *   - Inbound direction → no giveFeedback
 *   - giveFeedback throws → caller does NOT see the error (must not propagate)
 *   - `next` callback always fires regardless of feedback outcome
 *   - AutoFeedbackConfigSchema accepts/rejects shapes correctly
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the registry module BEFORE importing the writer.
// Vitest hoists vi.mock to the top of the file, so the writer's dynamic import
// chain resolves to this mock.
vi.mock('../src/identity/registry.js', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    giveFeedback: vi.fn(async () => '0xfeedbacktx' as `0x${string}`),
  };
});

import {
  createSettleFeedbackWriter,
  AutoFeedbackConfigSchema,
} from '../src/payments/feedback.js';
import type { Signer } from '../src/wallet/index.js';
import type { PaymentRequirements, SettleResponse } from '../src/payments/index.js';
import { giveFeedback } from '../src/identity/registry.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function fakeSigner(): Signer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = {
    kind: 'viem',
    address: '0x1111111111111111111111111111111111111111',
    network: 'base-sepolia',
    async signTypedData() {
      return ('0x' + '00'.repeat(65)) as `0x${string}`;
    },
    async signMessage() {
      return ('0x' + '00'.repeat(65)) as `0x${string}`;
    },
  };
  return s;
}

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

function settleSuccess(): SettleResponse {
  return {
    success: true,
    transaction: '0xpayment-tx',
    network: 'base-sepolia',
    payer: '0x1111111111111111111111111111111111111111',
  };
}

function settleFail(): SettleResponse {
  return {
    success: false,
    transaction: '',
    network: 'base-sepolia',
    errorReason: 'insufficient_funds',
  };
}

interface PayRecord {
  direction: 'out' | 'in';
  resource: string;
  requirements: PaymentRequirements;
  amountAtomic: string;
  asset: string;
  network: 'base-sepolia';
  txHash?: string;
  payer?: string;
  payee: string;
  settled: SettleResponse | null;
  facilitator: string;
  triggered: 'none' | 'soft' | 'hard';
  timestamp: string;
}

function outboundRecord(overrides: Partial<PayRecord> = {}): PayRecord {
  const reqs = baseRequirements();
  return {
    direction: 'out',
    resource: 'http://example.com/data',
    requirements: reqs,
    amountAtomic: reqs.maxAmountRequired,
    asset: reqs.asset,
    network: reqs.network,
    txHash: '0xpayment-tx',
    payer: '0x1111111111111111111111111111111111111111',
    payee: reqs.payTo,
    settled: settleSuccess(),
    facilitator: 'fac',
    triggered: 'none',
    timestamp: '2026-04-29T01:00:00.000Z',
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────

describe('AutoFeedbackConfigSchema', () => {
  it('accepts an empty object and applies defaults', () => {
    const parsed = AutoFeedbackConfigSchema.parse({});
    expect(parsed.enabled).toBe(false);
    expect(parsed.defaultValue).toBe(1.0);
    expect(parsed.defaultDecimals).toBe(2);
  });

  it('rejects out-of-range decimals', () => {
    expect(() => AutoFeedbackConfigSchema.parse({ defaultDecimals: 19 })).toThrow();
    expect(() => AutoFeedbackConfigSchema.parse({ defaultDecimals: -1 })).toThrow();
  });

  it('accepts negative values (criticism feedback)', () => {
    expect(() => AutoFeedbackConfigSchema.parse({ defaultValue: -1.5 })).not.toThrow();
  });

  it('preserves tag1 and tag2', () => {
    const parsed = AutoFeedbackConfigSchema.parse({
      defaultTag1: 'successRate',
      defaultTag2: 'quality',
    });
    expect(parsed.defaultTag1).toBe('successRate');
    expect(parsed.defaultTag2).toBe('quality');
  });
});

// ────────────────────────────────────────────────────────────────────
// createSettleFeedbackWriter
// ────────────────────────────────────────────────────────────────────

describe('createSettleFeedbackWriter', () => {
  beforeEach(() => {
    vi.mocked(giveFeedback).mockClear();
  });

  it('writes feedback when settled-out + lookup hits', async () => {
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
      defaultValue: 5,
      defaultDecimals: 0,
      defaultTag1: 'successRate',
    });
    await writer(outboundRecord());
    expect(vi.mocked(giveFeedback)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(giveFeedback).mock.calls[0]![0];
    expect(args.agentId).toBe(42);
    expect(args.value).toBe(5);
    expect(args.valueDecimals).toBe(0);
    expect(args.tag1).toBe('successRate');
    // payer's tx hash flows through as `endpoint`
    expect(args.endpoint).toBe('0xpayment-tx');
  });

  it('skips when lookupAgentId returns null', async () => {
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => null,
    });
    await writer(outboundRecord());
    expect(vi.mocked(giveFeedback)).not.toHaveBeenCalled();
  });

  it('skips when settled.success is false', async () => {
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
    });
    await writer(outboundRecord({ settled: settleFail() }));
    expect(vi.mocked(giveFeedback)).not.toHaveBeenCalled();
  });

  it('skips when settled is null', async () => {
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
    });
    await writer(outboundRecord({ settled: null }));
    expect(vi.mocked(giveFeedback)).not.toHaveBeenCalled();
  });

  it('skips inbound payments entirely', async () => {
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
    });
    // direction:'in' is structurally outside PaymentTraceFn's `direction:'out'` constraint,
    // but the writer is defensive about it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await writer({ ...outboundRecord(), direction: 'in' as any });
    expect(vi.mocked(giveFeedback)).not.toHaveBeenCalled();
  });

  it('does NOT throw when giveFeedback throws — failure must not propagate', async () => {
    vi.mocked(giveFeedback).mockRejectedValueOnce(new Error('rpc unreachable'));
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
    });
    // Must NOT throw — the payment already settled and we're past the point of return.
    await expect(writer(outboundRecord())).resolves.toBeUndefined();
  });

  it('always invokes the next callback (success path)', async () => {
    const next = vi.fn();
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
      next,
    });
    await writer(outboundRecord());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('invokes the next callback even when feedback throws', async () => {
    vi.mocked(giveFeedback).mockRejectedValueOnce(new Error('rpc unreachable'));
    const next = vi.fn();
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => 42,
      next,
    });
    await writer(outboundRecord());
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('invokes the next callback when lookup misses', async () => {
    const next = vi.fn();
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: () => null,
      next,
    });
    await writer(outboundRecord());
    expect(vi.mocked(giveFeedback)).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lookupAgentId can be async', async () => {
    const writer = createSettleFeedbackWriter({
      signer: fakeSigner(),
      lookupAgentId: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return 99;
      },
    });
    await writer(outboundRecord());
    expect(vi.mocked(giveFeedback)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(giveFeedback).mock.calls[0]![0].agentId).toBe(99);
  });
});
