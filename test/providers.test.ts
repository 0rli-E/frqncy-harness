import { describe, it, expect } from 'vitest';
import { parseModelString } from '../src/providers/index.js';

describe('parseModelString', () => {
  it('parses anthropic models', () => {
    expect(parseModelString('anthropic/claude-sonnet-4-6')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('parses openai models', () => {
    expect(parseModelString('openai/gpt-5')).toEqual({
      provider: 'openai',
      modelId: 'gpt-5',
    });
  });

  it('parses google models', () => {
    expect(parseModelString('google/gemini-2.5-pro')).toEqual({
      provider: 'google',
      modelId: 'gemini-2.5-pro',
    });
  });

  it('parses openrouter nested models (preserves the second slash)', () => {
    expect(parseModelString('openrouter/nousresearch/hermes-4-405b')).toEqual({
      provider: 'openrouter',
      modelId: 'nousresearch/hermes-4-405b',
    });
  });

  it('parses perplexity sonar models', () => {
    expect(parseModelString('perplexity/sonar')).toEqual({
      provider: 'perplexity',
      modelId: 'sonar',
    });
    expect(parseModelString('perplexity/sonar-reasoning')).toEqual({
      provider: 'perplexity',
      modelId: 'sonar-reasoning',
    });
  });

  it('parses claude-sdk models', () => {
    expect(parseModelString('claude-sdk/claude-sonnet-4-6')).toEqual({
      provider: 'claude-sdk',
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('rejects unknown providers', () => {
    expect(() => parseModelString('mistral/mixtral-8x7b')).toThrow(/Unknown provider/);
  });

  it('rejects strings without a slash', () => {
    expect(() => parseModelString('claude-sonnet')).toThrow();
  });
});
