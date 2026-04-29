import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGainCommand,
  parsePeriod,
  aggregateToolStats,
  inferToolName,
} from '../src/commands/gain.js';
import { TRACE_SCHEMA_VERSION, type IndexRecord, type TraceRecord } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('parsePeriod', () => {
  it('parses standard time units', () => {
    expect(parsePeriod('1d')).toBe(86_400_000);
    expect(parsePeriod('7d')).toBe(7 * 86_400_000);
    expect(parsePeriod('4w')).toBe(4 * 7 * 86_400_000);
    expect(parsePeriod('3m')).toBe(3 * 30 * 86_400_000);
    expect(parsePeriod('1y')).toBe(365 * 86_400_000);
  });

  it('returns Infinity for "all"', () => {
    expect(parsePeriod('all')).toBe(Number.POSITIVE_INFINITY);
  });

  it('throws on garbage input', () => {
    expect(() => parsePeriod('7days')).toThrow();
    expect(() => parsePeriod('whatever')).toThrow();
    expect(() => parsePeriod('')).toThrow();
  });
});

describe('inferToolName', () => {
  function makeRecord(overrides: Partial<TraceRecord> = {}): TraceRecord {
    return {
      ts: '2026-04-28T10:00:00.000Z',
      conversation_id: '00000000-0000-4000-8000-000000000001',
      step: 1,
      type: 'tool_call',
      content: {},
      schema_version: TRACE_SCHEMA_VERSION,
      ...overrides,
    };
  }

  it('returns the first entry of tools_called when present', () => {
    expect(inferToolName(makeRecord({ tools_called: ['bash'] }))).toBe('bash');
  });

  it('falls back to content.toolName', () => {
    expect(inferToolName(makeRecord({ content: { toolName: 'read' } }))).toBe('read');
  });

  it('returns null when no signal is available', () => {
    expect(inferToolName(makeRecord({ content: 'just text' }))).toBeNull();
    expect(inferToolName(makeRecord({ content: {} }))).toBeNull();
  });
});

describe('aggregateToolStats', () => {
  function makeToolCall(toolName: string, conversationId: string): TraceRecord {
    return {
      ts: '2026-04-28T10:00:00.000Z',
      conversation_id: conversationId,
      step: 1,
      type: 'tool_call',
      content: { toolName },
      schema_version: TRACE_SCHEMA_VERSION,
    };
  }

  it('counts calls per tool', () => {
    const records: TraceRecord[] = [
      makeToolCall('bash', '00000000-0000-4000-8000-000000000001'),
      makeToolCall('bash', '00000000-0000-4000-8000-000000000001'),
      makeToolCall('read', '00000000-0000-4000-8000-000000000001'),
    ];
    const stats = aggregateToolStats(records);
    expect(stats.get('bash')!.calls).toBe(2);
    expect(stats.get('read')!.calls).toBe(1);
  });

  it('counts unique conversations per tool', () => {
    const records: TraceRecord[] = [
      makeToolCall('bash', '00000000-0000-4000-8000-000000000001'),
      makeToolCall('bash', '00000000-0000-4000-8000-000000000002'),
      makeToolCall('bash', '00000000-0000-4000-8000-000000000001'),
    ];
    const stats = aggregateToolStats(records);
    expect(stats.get('bash')!.conversations.size).toBe(2);
  });

  it('ignores non-tool_call records', () => {
    const records: TraceRecord[] = [
      {
        ts: '2026-04-28T10:00:00.000Z',
        conversation_id: '00000000-0000-4000-8000-000000000001',
        step: 0,
        type: 'user',
        role: 'user',
        content: 'hi',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      makeToolCall('bash', '00000000-0000-4000-8000-000000000001'),
    ];
    const stats = aggregateToolStats(records);
    expect(stats.size).toBe(1);
    expect(stats.has('bash')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests
// ────────────────────────────────────────────────────────────────────

describe('runGainCommand', () => {
  let traceDir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'gain-test-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(traceDir, { recursive: true, force: true });
  });

  async function seedConversation(opts: {
    id: string;
    startedAt?: string;
    model?: string;
    costUsd?: number;
    threadId?: string;
    toolCalls?: string[];
  }): Promise<void> {
    const record: IndexRecord = {
      conversation_id: opts.id,
      started_at: opts.startedAt ?? new Date().toISOString(),
      ended_at: opts.startedAt ?? new Date().toISOString(),
      model: opts.model ?? 'anthropic/claude-sonnet-4-6',
      message_count: 2,
      total_cost_usd: opts.costUsd ?? 0.01,
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cached_input_tokens: 0,
      status: 'completed',
      schema_version: TRACE_SCHEMA_VERSION,
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    };
    await mkdir(traceDir, { recursive: true });
    const indexPath = join(traceDir, 'INDEX.jsonl');
    let existing = '';
    try {
      const fs = await import('node:fs/promises');
      existing = await fs.readFile(indexPath, 'utf-8');
    } catch {
      /* first */
    }
    await writeFile(indexPath, existing + JSON.stringify(record) + '\n', 'utf-8');

    const date = (opts.startedAt ?? new Date().toISOString()).slice(0, 10);
    const dateDir = join(traceDir, date);
    await mkdir(dateDir, { recursive: true });
    const records: TraceRecord[] = [];
    if (opts.toolCalls) {
      for (let i = 0; i < opts.toolCalls.length; i++) {
        records.push({
          ts: opts.startedAt ?? new Date().toISOString(),
          conversation_id: opts.id,
          step: i,
          type: 'tool_call',
          content: { toolName: opts.toolCalls[i] },
          schema_version: TRACE_SCHEMA_VERSION,
        });
      }
    }
    await writeFile(
      join(dateDir, `${opts.id}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  it('returns zero totals when there are no traces', async () => {
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.totalConversations).toBe(0);
    expect(result.totalCostUsd).toBe(0);
  });

  it('aggregates spend by model', async () => {
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa1', model: 'anthropic/claude-sonnet-4-6', costUsd: 0.10 });
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa2', model: 'anthropic/claude-sonnet-4-6', costUsd: 0.20 });
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa3', model: 'openai/gpt-5', costUsd: 0.05 });
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.totalConversations).toBe(3);
    expect(result.totalCostUsd).toBeCloseTo(0.35, 6);
    const claude = result.byModel.find((m) => m.model === 'anthropic/claude-sonnet-4-6')!;
    const openai = result.byModel.find((m) => m.model === 'openai/gpt-5')!;
    expect(claude.conversations).toBe(2);
    expect(claude.totalCostUsd).toBeCloseTo(0.30, 6);
    expect(openai.conversations).toBe(1);
  });

  it('sorts byModel descending by spend', async () => {
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa1', model: 'cheap/x', costUsd: 0.01 });
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa2', model: 'expensive/y', costUsd: 1.00 });
    const result = await runGainCommand({ traceDir, json: true });
    expect(result.byModel[0]!.model).toBe('expensive/y');
    expect(result.byModel[1]!.model).toBe('cheap/x');
  });

  it('honors --top to cap the most-expensive list', async () => {
    for (let i = 0; i < 5; i++) {
      await seedConversation({
        id: `00000000-0000-4000-8000-aaaaaaaaaaa${i}`,
        costUsd: 0.01 * (i + 1),
      });
    }
    const result = await runGainCommand({ traceDir, top: 2, json: true });
    expect(result.topConversations).toHaveLength(2);
    // top 2 = 0.05 (i=4) and 0.04 (i=3)
    expect(result.topConversations[0]!.costUsd).toBeCloseTo(0.05, 6);
    expect(result.topConversations[1]!.costUsd).toBeCloseTo(0.04, 6);
  });

  it('aggregates tool-call counts across conversations', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      toolCalls: ['bash', 'bash', 'read'],
    });
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa2',
      toolCalls: ['bash', 'grep'],
    });
    const result = await runGainCommand({ traceDir, json: true });
    const bash = result.byTool.find((t) => t.toolName === 'bash')!;
    const read = result.byTool.find((t) => t.toolName === 'read')!;
    const grep = result.byTool.find((t) => t.toolName === 'grep')!;
    expect(bash.callCount).toBe(3);
    expect(bash.conversationsWithThisTool).toBe(2);
    expect(read.callCount).toBe(1);
    expect(grep.callCount).toBe(1);
  });

  it('filters by --thread', async () => {
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa1', threadId: 'frqncy-content', costUsd: 0.10 });
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa2', threadId: 'other', costUsd: 0.20 });
    const result = await runGainCommand({ traceDir, threadId: 'frqncy-content', json: true });
    expect(result.totalConversations).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.10, 6);
  });

  it('respects --period to filter out old conversations', async () => {
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa1', startedAt: new Date(Date.now() - 60_000).toISOString(), costUsd: 0.01 });
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa2', startedAt: '2024-01-01T00:00:00.000Z', costUsd: 0.99 });
    const result = await runGainCommand({ traceDir, period: '7d', json: true });
    expect(result.totalConversations).toBe(1);
    expect(result.totalCostUsd).toBeCloseTo(0.01, 6);
  });

  it('emits JSON on --json', async () => {
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa1', costUsd: 0.05 });
    await runGainCommand({ traceDir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.totalConversations).toBe(1);
    expect(parsed.totalCostUsd).toBeCloseTo(0.05, 6);
  });

  it('renders human-readable headers for the three sections (default mode)', async () => {
    await seedConversation({ id: '00000000-0000-4000-8000-aaaaaaaaaaa1', costUsd: 0.05, toolCalls: ['bash'] });
    await runGainCommand({ traceDir });
    expect(stdoutBuffer).toMatch(/Spend by model/);
    expect(stdoutBuffer).toMatch(/Tool-call distribution/);
    expect(stdoutBuffer).toMatch(/Top \d+ most-expensive conversations/);
  });
});
