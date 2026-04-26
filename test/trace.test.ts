import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  appendTraceRecord,
  appendIndexRecord,
  getTraceFilePath,
  getIndexFilePath,
  recordConversationEnd,
} from '../src/trace.js';
import { TRACE_SCHEMA_VERSION } from '../src/types.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `frqncy-harness-test-${randomUUID()}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('getTraceFilePath', () => {
  it('partitions traces by date', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const startedAt = new Date('2026-04-26T12:00:00.000Z');
    const path = getTraceFilePath(id, startedAt, '/tmp/traces');
    expect(path).toBe('/tmp/traces/2026-04-26/550e8400-e29b-41d4-a716-446655440000.jsonl');
  });
});

describe('appendTraceRecord', () => {
  it('writes a valid record and creates parent dirs', async () => {
    const conversationId = randomUUID();
    const filePath = getTraceFilePath(conversationId, new Date('2026-04-26T12:00:00.000Z'), testDir);

    await appendTraceRecord(filePath, {
      ts: '2026-04-26T12:00:00.000Z',
      conversation_id: conversationId,
      step: 0,
      type: 'user',
      role: 'user',
      content: 'hello world',
    });

    const contents = await fs.readFile(filePath, 'utf-8');
    const line = contents.trim();
    const parsed = JSON.parse(line);
    expect(parsed.role).toBe('user');
    expect(parsed.content).toBe('hello world');
    expect(parsed.schema_version).toBe(TRACE_SCHEMA_VERSION);
  });

  it('appends multiple records on separate lines', async () => {
    const conversationId = randomUUID();
    const filePath = getTraceFilePath(conversationId, new Date('2026-04-26T12:00:00.000Z'), testDir);

    await appendTraceRecord(filePath, {
      ts: '2026-04-26T12:00:00.000Z',
      conversation_id: conversationId,
      step: 0,
      type: 'user',
      role: 'user',
      content: 'first',
    });
    await appendTraceRecord(filePath, {
      ts: '2026-04-26T12:00:01.000Z',
      conversation_id: conversationId,
      step: 1,
      type: 'assistant',
      role: 'assistant',
      content: 'second',
    });

    const contents = await fs.readFile(filePath, 'utf-8');
    const lines = contents.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).content).toBe('first');
    expect(JSON.parse(lines[1]!).content).toBe('second');
  });

  it('refuses to write a malformed record', async () => {
    const conversationId = randomUUID();
    const filePath = getTraceFilePath(conversationId, new Date('2026-04-26T12:00:00.000Z'), testDir);

    await expect(
      appendTraceRecord(filePath, {
        ts: 'not-a-valid-iso-timestamp',
        conversation_id: conversationId,
        step: 0,
        type: 'user',
        role: 'user',
        content: 'hello',
      }),
    ).rejects.toThrow();
  });
});

describe('appendIndexRecord and recordConversationEnd', () => {
  it('writes an index summary and reads back', async () => {
    const conversationId = randomUUID();
    const startedAt = new Date('2026-04-26T12:00:00.000Z');
    const endedAt = new Date('2026-04-26T12:01:00.000Z');

    await recordConversationEnd({
      conversationId,
      startedAt,
      endedAt,
      model: 'anthropic/claude-sonnet-4-6',
      messageCount: 4,
      cumulativeUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 80,
        costUsd: 0.005,
      },
      status: 'completed',
      traceDir: testDir,
    });

    const indexContents = await fs.readFile(getIndexFilePath(testDir), 'utf-8');
    const parsed = JSON.parse(indexContents.trim());
    expect(parsed.conversation_id).toBe(conversationId);
    expect(parsed.model).toBe('anthropic/claude-sonnet-4-6');
    expect(parsed.message_count).toBe(4);
    expect(parsed.total_input_tokens).toBe(100);
    expect(parsed.status).toBe('completed');
  });

  it('writes index records as separate JSONL lines', async () => {
    await appendIndexRecord(
      {
        conversation_id: randomUUID(),
        started_at: '2026-04-26T12:00:00.000Z',
        ended_at: '2026-04-26T12:01:00.000Z',
        model: 'anthropic/claude-sonnet-4-6',
        message_count: 2,
        total_cost_usd: 0,
        total_input_tokens: 50,
        total_output_tokens: 25,
        total_cached_input_tokens: 0,
        status: 'completed',
      },
      testDir,
    );
    await appendIndexRecord(
      {
        conversation_id: randomUUID(),
        started_at: '2026-04-26T13:00:00.000Z',
        ended_at: '2026-04-26T13:00:30.000Z',
        model: 'openai/gpt-5',
        message_count: 2,
        total_cost_usd: 0,
        total_input_tokens: 30,
        total_output_tokens: 20,
        total_cached_input_tokens: 0,
        status: 'completed',
      },
      testDir,
    );

    const indexContents = await fs.readFile(getIndexFilePath(testDir), 'utf-8');
    const lines = indexContents.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).model).toBe('anthropic/claude-sonnet-4-6');
    expect(JSON.parse(lines[1]!).model).toBe('openai/gpt-5');
  });
});
