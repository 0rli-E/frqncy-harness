import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTracesCommand, __test } from '../src/commands/traces.js';
import { runCostsCommand } from '../src/commands/costs.js';
import { TRACE_SCHEMA_VERSION, type IndexRecord, type TraceRecord } from '../src/types.js';

const { parseSince, loadIndex } = __test;

function buildIndex(overrides: Partial<IndexRecord>): IndexRecord {
  return {
    conversation_id: '00000000-0000-0000-0000-000000000001',
    started_at: '2026-04-27T10:00:00.000Z',
    ended_at: '2026-04-27T10:01:00.000Z',
    model: 'anthropic/claude-sonnet-4-6',
    message_count: 2,
    total_cost_usd: 0.05,
    total_input_tokens: 100,
    total_output_tokens: 200,
    total_cached_input_tokens: 0,
    status: 'completed',
    schema_version: TRACE_SCHEMA_VERSION,
    ...overrides,
  };
}

async function seedIndex(traceDir: string, records: IndexRecord[]): Promise<void> {
  await mkdir(traceDir, { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(traceDir, 'INDEX.jsonl'), lines, 'utf-8');
}

async function seedConversationFile(traceDir: string, record: IndexRecord, traceRecords: Omit<TraceRecord, 'schema_version'>[]): Promise<void> {
  const date = record.started_at.slice(0, 10);
  const dir = join(traceDir, date);
  await mkdir(dir, { recursive: true });
  const lines = traceRecords
    .map((r) => JSON.stringify({ ...r, schema_version: TRACE_SCHEMA_VERSION }))
    .join('\n') + '\n';
  await writeFile(join(dir, `${record.conversation_id}.jsonl`), lines, 'utf-8');
}

describe('traces', () => {
  let traceDir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'traces-test-'));
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

  describe('parseSince', () => {
    it('parses time units', () => {
      expect(parseSince('1d')).toBe(86400000);
      expect(parseSince('2w')).toBe(2 * 7 * 86400000);
      expect(parseSince('3m')).toBe(3 * 30 * 86400000);
      expect(parseSince('1y')).toBe(365 * 86400000);
    });
    it('returns Infinity for "all"', () => {
      expect(parseSince('all')).toBe(Number.POSITIVE_INFINITY);
    });
    it('throws on invalid format', () => {
      expect(() => parseSince('7days')).toThrow();
      expect(() => parseSince('garbage')).toThrow();
    });
  });

  describe('loadIndex', () => {
    it('returns empty array when no INDEX.jsonl exists', async () => {
      const records = await loadIndex(traceDir);
      expect(records).toEqual([]);
    });

    it('loads and validates records', async () => {
      const r1 = buildIndex({ conversation_id: '00000000-0000-0000-0000-000000000001' });
      const r2 = buildIndex({ conversation_id: '00000000-0000-0000-0000-000000000002' });
      await seedIndex(traceDir, [r1, r2]);
      const loaded = await loadIndex(traceDir);
      expect(loaded).toHaveLength(2);
      expect(loaded.map((r) => r.conversation_id).sort()).toEqual([r1.conversation_id, r2.conversation_id]);
    });

    it('skips malformed lines', async () => {
      await mkdir(traceDir, { recursive: true });
      const valid = JSON.stringify(buildIndex({}));
      await writeFile(join(traceDir, 'INDEX.jsonl'), `${valid}\nnot-json\n${valid}\n`, 'utf-8');
      const loaded = await loadIndex(traceDir);
      expect(loaded).toHaveLength(2);
    });
  });

  describe('runTracesCommand list', () => {
    it('filters by --thread', async () => {
      await seedIndex(traceDir, [
        buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', thread_id: 'a' }),
        buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', thread_id: 'b' }),
        buildIndex({ conversation_id: '00000000-0000-0000-0000-cccccccccccc' }),
      ]);
      await runTracesCommand('list', ['--thread', 'a', '--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].thread_id).toBe('a');
    });

    it('filters by --project', async () => {
      await seedIndex(traceDir, [
        buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', project_id: 'p1' }),
        buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', project_id: 'p2' }),
      ]);
      await runTracesCommand('list', ['--project', 'p1', '--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].project_id).toBe('p1');
    });

    it('respects --limit', async () => {
      const records = Array.from({ length: 5 }, (_, i) => {
        const id = `00000000-0000-0000-0000-${i.toString().padStart(12, '0')}`;
        const startedAt = new Date(Date.now() - i * 60_000).toISOString();
        return buildIndex({ conversation_id: id, started_at: startedAt });
      });
      await seedIndex(traceDir, records);
      await runTracesCommand('list', ['--limit', '2', '--since', 'all', '--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed).toHaveLength(2);
    });

    it('sorts newest first', async () => {
      await seedIndex(traceDir, [
        buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', started_at: '2026-04-25T10:00:00.000Z' }),
        buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', started_at: '2026-04-27T10:00:00.000Z' }),
        buildIndex({ conversation_id: '00000000-0000-0000-0000-cccccccccccc', started_at: '2026-04-26T10:00:00.000Z' }),
      ]);
      await runTracesCommand('list', ['--since', 'all', '--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed[0].conversation_id.endsWith('bbbb')).toBe(true);
      expect(parsed[1].conversation_id.endsWith('cccc')).toBe(true);
      expect(parsed[2].conversation_id.endsWith('aaaa')).toBe(true);
    });
  });

  describe('runTracesCommand show', () => {
    it('loads a conversation by id and prints its records', async () => {
      const idx = buildIndex({ conversation_id: '00000000-0000-0000-0000-deadbeefdead' });
      await seedIndex(traceDir, [idx]);
      await seedConversationFile(traceDir, idx, [
        { ts: '2026-04-27T10:00:00.000Z', conversation_id: idx.conversation_id, step: 0, type: 'user', role: 'user', content: 'hello' },
        { ts: '2026-04-27T10:00:01.000Z', conversation_id: idx.conversation_id, step: 1, type: 'assistant', role: 'assistant', content: 'hi back' },
      ]);
      await runTracesCommand('show', [idx.conversation_id, '--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed.records).toHaveLength(2);
      expect(parsed.records[0].content).toBe('hello');
      expect(parsed.records[1].content).toBe('hi back');
    });

    it('matches by id prefix when unambiguous', async () => {
      const idx = buildIndex({ conversation_id: '00000000-0000-0000-0000-deadbeefdead' });
      await seedIndex(traceDir, [idx]);
      await seedConversationFile(traceDir, idx, [
        { ts: '2026-04-27T10:00:00.000Z', conversation_id: idx.conversation_id, step: 0, type: 'user', role: 'user', content: 'hi' },
      ]);
      await runTracesCommand('show', ['00000000', '--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed.index.conversation_id).toBe(idx.conversation_id);
    });

    it('throws when no match', async () => {
      await seedIndex(traceDir, [buildIndex({})]);
      await expect(runTracesCommand('show', ['ffffffff'], { traceDir })).rejects.toThrow(/no trace found/);
    });

    it('throws on ambiguous prefix', async () => {
      await seedIndex(traceDir, [
        buildIndex({ conversation_id: '11111111-0000-0000-0000-aaaaaaaaaaaa' }),
        buildIndex({ conversation_id: '11111111-0000-0000-0000-bbbbbbbbbbbb' }),
      ]);
      await expect(runTracesCommand('show', ['11111111'], { traceDir })).rejects.toThrow(/matched 2 conversations/);
    });
  });

  describe('runTracesCommand latest', () => {
    it('shows the most recent conversation', async () => {
      const older = buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', started_at: '2026-04-25T10:00:00.000Z' });
      const newer = buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', started_at: '2026-04-27T10:00:00.000Z' });
      await seedIndex(traceDir, [older, newer]);
      await seedConversationFile(traceDir, newer, [
        { ts: newer.started_at, conversation_id: newer.conversation_id, step: 0, type: 'user', role: 'user', content: 'newest' },
      ]);
      await runTracesCommand('latest', ['--json'], { traceDir });
      const parsed = JSON.parse(stdoutBuffer);
      expect(parsed.index.conversation_id).toBe(newer.conversation_id);
    });
  });
});

describe('costs filter', () => {
  let traceDir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'costs-test-'));
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

  it('filters totals by thread', async () => {
    const now = new Date().toISOString();
    await seedIndex(traceDir, [
      buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', total_cost_usd: 0.10, thread_id: 'a', started_at: now }),
      buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', total_cost_usd: 0.25, thread_id: 'b', started_at: now }),
    ]);
    await runCostsCommand({ period: 'all', threadId: 'a', json: true, traceDir });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.conversations).toBe(1);
    expect(parsed.totalCostUsd).toBeCloseTo(0.10);
  });

  it('filters totals by project', async () => {
    const now = new Date().toISOString();
    await seedIndex(traceDir, [
      buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', total_cost_usd: 0.10, project_id: 'p1', started_at: now }),
      buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', total_cost_usd: 0.25, project_id: 'p2', started_at: now }),
    ]);
    await runCostsCommand({ period: 'all', projectId: 'p1', json: true, traceDir });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.conversations).toBe(1);
    expect(parsed.totalCostUsd).toBeCloseTo(0.10);
  });

  it('exposes byThread breakdown in JSON output', async () => {
    const now = new Date().toISOString();
    await seedIndex(traceDir, [
      buildIndex({ conversation_id: '00000000-0000-0000-0000-aaaaaaaaaaaa', total_cost_usd: 0.10, thread_id: 'a', started_at: now }),
      buildIndex({ conversation_id: '00000000-0000-0000-0000-bbbbbbbbbbbb', total_cost_usd: 0.25, thread_id: 'b', started_at: now }),
      buildIndex({ conversation_id: '00000000-0000-0000-0000-cccccccccccc', total_cost_usd: 0.05, started_at: now }),
    ]);
    await runCostsCommand({ period: 'all', json: true, traceDir });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.byThread.a.costUsd).toBeCloseTo(0.10);
    expect(parsed.byThread.b.costUsd).toBeCloseTo(0.25);
    expect(parsed.byThread['(untagged)'].costUsd).toBeCloseTo(0.05);
  });
});
