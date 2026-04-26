import { describe, it, expect } from 'vitest';
import { computeCost, getModelRate } from '../src/pricing.js';

describe('getModelRate', () => {
  it('returns rates for known Claude models', () => {
    const rate = getModelRate('anthropic', 'claude-sonnet-4-6');
    expect(rate).toBeDefined();
    expect(rate?.inputUsdPerM).toBe(3.0);
    expect(rate?.outputUsdPerM).toBe(15.0);
    expect(rate?.cachedInputUsdPerM).toBe(0.3);
  });

  it('returns undefined for unknown models', () => {
    expect(getModelRate('anthropic', 'made-up-model')).toBeUndefined();
  });
});

describe('computeCost', () => {
  it('computes cost for a Claude Sonnet call without caching', () => {
    const cost = computeCost({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
    });
    // 1000 input * $3/M = $0.003
    // 500 output * $15/M = $0.0075
    // Total: $0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('discounts cached input tokens', () => {
    const cost = computeCost({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 900,
    });
    // 100 regular input * $3/M = $0.0003
    // 900 cached input * $0.3/M = $0.00027
    // Total: $0.00057
    expect(cost).toBeCloseTo(0.00057, 6);
  });

  it('returns undefined for unknown models', () => {
    const cost = computeCost({
      provider: 'anthropic',
      modelId: 'unknown-future-model',
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
    });
    expect(cost).toBeUndefined();
  });

  it('handles zero tokens', () => {
    const cost = computeCost({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('computes cost for Hermes via OpenRouter', () => {
    const cost = computeCost({
      provider: 'openrouter',
      modelId: 'nousresearch/hermes-4-405b',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
    });
    // 1M input * $1/M + 1M output * $3/M = $4.00
    expect(cost).toBeCloseTo(4.0, 4);
  });
});
