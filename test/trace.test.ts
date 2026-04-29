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

// ────────────────────────────────────────────────────────────────────
// loadThreadHistory (v0.14.0)
// ────────────────────────────────────────────────────────────────────

import { loadThreadHistory, readIndex, readConversation } from '../src/trace.js';

async function seedConversation(args: {
  traceDir: string;
  threadId: string;
  startedAt: string;
  userMsg: string;
  assistantMsg: string;
  status?: 'completed' | 'aborted_error' | 'aborted_user';
}): Promise<string> {
  const conversationId = randomUUID();
  const startedDate = new Date(args.startedAt);
  const traceFile = getTraceFilePath(conversationId, startedDate, args.traceDir);
  await appendTraceRecord(traceFile, {
    ts: args.startedAt,
    conversation_id: conversationId,
    step: 0,
    type: 'user',
    role: 'user',
    content: args.userMsg,
    thread_id: args.threadId,
  });
  await appendTraceRecord(traceFile, {
    ts: args.startedAt,
    conversation_id: conversationId,
    step: 1,
    type: 'assistant',
    role: 'assistant',
    content: args.assistantMsg,
    thread_id: args.threadId,
  });
  await appendIndexRecord(
    {
      conversation_id: conversationId,
      started_at: args.startedAt,
      ended_at: args.startedAt,
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 2,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      status: args.status ?? 'completed',
      thread_id: args.threadId,
    },
    args.traceDir,
  );
  return conversationId;
}

describe('loadThreadHistory', () => {
  it('returns empty when threadId is empty', async () => {
    const result = await loadThreadHistory('', { traceDir: testDir });
    expect(result.messages).toEqual([]);
    expect(result.conversationsRead).toBe(0);
  });

  it('returns empty when no INDEX.jsonl exists', async () => {
    const result = await loadThreadHistory('frqncy-os/kali', { traceDir: testDir });
    expect(result.messages).toEqual([]);
  });

  it('returns empty when no conversations match the threadId', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/krishna',
      startedAt: '2026-04-29T10:00:00.000Z',
      userMsg: 'q1',
      assistantMsg: 'a1',
    });
    const result = await loadThreadHistory('frqncy-os/kali', { traceDir: testDir });
    expect(result.messages).toEqual([]);
    expect(result.conversationsRead).toBe(0);
  });

  it('loads user/assistant turns from one matching conversation', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-29T10:00:00.000Z',
      userMsg: 'cut what?',
      assistantMsg: 'the old story',
    });
    const result = await loadThreadHistory('frqncy-os/kali', { traceDir: testDir });
    expect(result.conversationsRead).toBe(1);
    expect(result.messages).toEqual([
      { role: 'user', content: 'cut what?' },
      { role: 'assistant', content: 'the old story' },
    ]);
  });

  it('orders messages chronologically across multiple conversations', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-27T10:00:00.000Z',
      userMsg: 'oldest q',
      assistantMsg: 'oldest a',
    });
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-29T10:00:00.000Z',
      userMsg: 'newest q',
      assistantMsg: 'newest a',
    });
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-28T10:00:00.000Z',
      userMsg: 'middle q',
      assistantMsg: 'middle a',
    });
    const result = await loadThreadHistory('frqncy-os/kali', { traceDir: testDir });
    expect(result.conversationsRead).toBe(3);
    const contents = result.messages.map((m) => m.content);
    // Oldest first, newest last
    expect(contents).toEqual([
      'oldest q', 'oldest a',
      'middle q', 'middle a',
      'newest q', 'newest a',
    ]);
  });

  it('caps by maxConversations (most-recent kept)', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedConversation({
        traceDir: testDir,
        threadId: 'frqncy-os/kali',
        startedAt: `2026-04-2${i}T10:00:00.000Z`,
        userMsg: `q${i}`,
        assistantMsg: `a${i}`,
      });
    }
    const result = await loadThreadHistory('frqncy-os/kali', {
      traceDir: testDir,
      maxConversations: 2,
    });
    expect(result.conversationsRead).toBe(2);
    // Only the 2 most-recent (q4/a4 and q5/a5) should survive, in chronological order
    const contents = result.messages.map((m) => m.content);
    expect(contents).toEqual(['q4', 'a4', 'q5', 'a5']);
  });

  it('caps by maxMessages (most-recent kept when trimming)', async () => {
    for (let i = 1; i <= 3; i++) {
      await seedConversation({
        traceDir: testDir,
        threadId: 'frqncy-os/kali',
        startedAt: `2026-04-2${i}T10:00:00.000Z`,
        userMsg: `q${i}`,
        assistantMsg: `a${i}`,
      });
    }
    // 3 convos × 2 messages = 6 total. Cap at 3.
    const result = await loadThreadHistory('frqncy-os/kali', {
      traceDir: testDir,
      maxMessages: 3,
    });
    expect(result.messages).toHaveLength(3);
    expect(result.messagesTrimmed).toBe(3);
    // Most-recent 3: a2, q3, a3
    expect(result.messages.map((m) => m.content)).toEqual(['a2', 'q3', 'a3']);
  });

  it('caps by maxBytes (most-recent kept when trimming)', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-27T10:00:00.000Z',
      userMsg: 'a'.repeat(100),
      assistantMsg: 'b'.repeat(100),
    });
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-28T10:00:00.000Z',
      userMsg: 'c'.repeat(50),
      assistantMsg: 'd'.repeat(50),
    });
    // Total 300 bytes. Cap at 150 — should drop the older 200-byte convo
    // and keep the newer 100-byte convo.
    const result = await loadThreadHistory('frqncy-os/kali', {
      traceDir: testDir,
      maxBytes: 150,
    });
    expect(result.totalBytes).toBeLessThanOrEqual(150);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.content).toBe('c'.repeat(50));
    expect(result.messages[1]!.content).toBe('d'.repeat(50));
  });

  it('skips aborted conversations by default', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-29T10:00:00.000Z',
      userMsg: 'q-broken',
      assistantMsg: 'a-broken',
      status: 'aborted_error',
    });
    const result = await loadThreadHistory('frqncy-os/kali', { traceDir: testDir });
    expect(result.messages).toEqual([]);
  });

  it('includes aborted conversations when includeAborted: true', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-29T10:00:00.000Z',
      userMsg: 'q-broken',
      assistantMsg: 'a-broken',
      status: 'aborted_error',
    });
    const result = await loadThreadHistory('frqncy-os/kali', {
      traceDir: testDir,
      includeAborted: true,
    });
    expect(result.messages).toHaveLength(2);
  });

  it('respects maxConversations: 0 as "disabled"', async () => {
    await seedConversation({
      traceDir: testDir,
      threadId: 'frqncy-os/kali',
      startedAt: '2026-04-29T10:00:00.000Z',
      userMsg: 'q1',
      assistantMsg: 'a1',
    });
    const result = await loadThreadHistory('frqncy-os/kali', {
      traceDir: testDir,
      maxConversations: 0,
    });
    expect(result.messages).toEqual([]);
  });
});

describe('readIndex / readConversation (v0.14.0 read API)', () => {
  it('readIndex returns [] when INDEX is missing', async () => {
    const result = await readIndex(testDir);
    expect(result).toEqual([]);
  });

  it('readIndex returns parsed records, skips malformed lines', async () => {
    const indexPath = getIndexFilePath(testDir);
    await fs.mkdir(testDir, { recursive: true });
    const valid = JSON.stringify({
      conversation_id: randomUUID(),
      started_at: '2026-04-29T10:00:00.000Z',
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 2,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      status: 'completed',
      schema_version: TRACE_SCHEMA_VERSION,
    });
    await fs.writeFile(indexPath, valid + '\n{not json\n' + valid + '\n', 'utf-8');
    const result = await readIndex(testDir);
    expect(result).toHaveLength(2);
  });

  it('readConversation returns [] when file is missing', async () => {
    const result = await readConversation(randomUUID(), new Date(), testDir);
    expect(result).toEqual([]);
  });
});
