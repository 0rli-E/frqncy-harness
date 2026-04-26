import { describe, it, expect } from 'vitest';
import {
  ModelStringSchema,
  TraceRecordSchema,
  IndexRecordSchema,
  TRACE_SCHEMA_VERSION,
} from '../src/types.js';

describe('ModelStringSchema', () => {
  it('accepts valid provider/model strings', () => {
    expect(() => ModelStringSchema.parse('anthropic/claude-sonnet-4-6')).not.toThrow();
    expect(() => ModelStringSchema.parse('openai/gpt-5')).not.toThrow();
    expect(() => ModelStringSchema.parse('google/gemini-2.5-pro')).not.toThrow();
    expect(() =>
      ModelStringSchema.parse('openrouter/nousresearch/hermes-4-405b'),
    ).not.toThrow();
  });

  it('rejects strings without a slash', () => {
    expect(() => ModelStringSchema.parse('claude-sonnet')).toThrow();
  });

  it('rejects empty strings', () => {
    expect(() => ModelStringSchema.parse('')).toThrow();
  });
});

describe('TraceRecordSchema', () => {
  it('accepts a minimal valid record', () => {
    expect(() =>
      TraceRecordSchema.parse({
        ts: '2026-04-26T12:00:00.000Z',
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        step: 0,
        type: 'user',
        role: 'user',
        content: 'hello',
        schema_version: TRACE_SCHEMA_VERSION,
      }),
    ).not.toThrow();
  });

  it('accepts a rich assistant record', () => {
    expect(() =>
      TraceRecordSchema.parse({
        ts: '2026-04-26T12:00:01.000Z',
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        step: 1,
        type: 'assistant',
        role: 'assistant',
        content: 'hi there',
        model: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cachedInputTokens: 0,
        },
        latency_ms: 250,
        schema_version: TRACE_SCHEMA_VERSION,
      }),
    ).not.toThrow();
  });

  it('rejects an unknown type', () => {
    expect(() =>
      TraceRecordSchema.parse({
        ts: '2026-04-26T12:00:00.000Z',
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        step: 0,
        type: 'invalid-type',
        content: 'hi',
        schema_version: TRACE_SCHEMA_VERSION,
      }),
    ).toThrow();
  });

  it('rejects mismatched schema_version', () => {
    expect(() =>
      TraceRecordSchema.parse({
        ts: '2026-04-26T12:00:00.000Z',
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        step: 0,
        type: 'user',
        role: 'user',
        content: 'hi',
        schema_version: '99.0.0',
      }),
    ).toThrow();
  });
});

describe('IndexRecordSchema', () => {
  it('accepts a complete summary record', () => {
    expect(() =>
      IndexRecordSchema.parse({
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: '2026-04-26T12:00:00.000Z',
        ended_at: '2026-04-26T12:00:30.000Z',
        model: 'anthropic/claude-sonnet-4-6',
        message_count: 4,
        total_cost_usd: 0.0123,
        total_input_tokens: 150,
        total_output_tokens: 80,
        total_cached_input_tokens: 100,
        status: 'completed',
        schema_version: TRACE_SCHEMA_VERSION,
      }),
    ).not.toThrow();
  });

  it('rejects negative token counts', () => {
    expect(() =>
      IndexRecordSchema.parse({
        conversation_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: '2026-04-26T12:00:00.000Z',
        model: 'anthropic/claude-sonnet-4-6',
        message_count: 1,
        total_cost_usd: 0,
        total_input_tokens: -1,
        total_output_tokens: 0,
        total_cached_input_tokens: 0,
        status: 'completed',
        schema_version: TRACE_SCHEMA_VERSION,
      }),
    ).toThrow();
  });
});
