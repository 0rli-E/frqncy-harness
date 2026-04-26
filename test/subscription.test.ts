import { describe, it, expect } from 'vitest';
import {
  PROVIDERS,
  API_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  isSubscriptionProvider,
} from '../src/types.js';
import { parseModelString } from '../src/providers/index.js';
import { isClaudeCodeAvailable, isCodexAvailable } from '../src/providers/subprocess.js';

describe('PROVIDERS taxonomy', () => {
  it('PROVIDERS includes both API and subscription providers', () => {
    expect(PROVIDERS).toContain('anthropic');
    expect(PROVIDERS).toContain('openai');
    expect(PROVIDERS).toContain('google');
    expect(PROVIDERS).toContain('openrouter');
    expect(PROVIDERS).toContain('claude-code');
    expect(PROVIDERS).toContain('codex');
  });

  it('API_PROVIDERS does NOT include subscription providers', () => {
    expect(API_PROVIDERS).not.toContain('claude-code');
    expect(API_PROVIDERS).not.toContain('codex');
  });

  it('SUBSCRIPTION_PROVIDERS contains exactly claude-code and codex', () => {
    expect([...SUBSCRIPTION_PROVIDERS].sort()).toEqual(['claude-code', 'codex']);
  });
});

describe('isSubscriptionProvider', () => {
  it('returns true for subscription providers', () => {
    expect(isSubscriptionProvider('claude-code')).toBe(true);
    expect(isSubscriptionProvider('codex')).toBe(true);
  });
  it('returns false for API providers', () => {
    expect(isSubscriptionProvider('anthropic')).toBe(false);
    expect(isSubscriptionProvider('openai')).toBe(false);
    expect(isSubscriptionProvider('google')).toBe(false);
    expect(isSubscriptionProvider('openrouter')).toBe(false);
  });
});

describe('parseModelString — subscription providers', () => {
  it('parses claude-code model strings', () => {
    expect(parseModelString('claude-code/sonnet')).toEqual({
      provider: 'claude-code',
      modelId: 'sonnet',
    });
    expect(parseModelString('claude-code/opus')).toEqual({
      provider: 'claude-code',
      modelId: 'opus',
    });
    expect(parseModelString('claude-code/haiku')).toEqual({
      provider: 'claude-code',
      modelId: 'haiku',
    });
  });

  it('parses codex model strings', () => {
    expect(parseModelString('codex/default')).toEqual({
      provider: 'codex',
      modelId: 'default',
    });
    expect(parseModelString('codex/gpt-5')).toEqual({
      provider: 'codex',
      modelId: 'gpt-5',
    });
  });

  it('rejects fully made-up providers', () => {
    expect(() => parseModelString('not-a-provider/anything')).toThrow(/Unknown provider/);
  });
});

describe('isClaudeCodeAvailable / isCodexAvailable', () => {
  it('returns false when binary not installed (timeout-bounded)', async () => {
    // We don't assume claude/codex is installed in CI — these should
    // resolve to false within a few seconds without throwing.
    const claude = await isClaudeCodeAvailable();
    const codex = await isCodexAvailable();
    expect(typeof claude).toBe('boolean');
    expect(typeof codex).toBe('boolean');
  }, 10_000);
});
