import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCodifyCommand,
  buildCodifyPrompt,
  extractFailureSignal,
  generateSlug,
  extractTestCode,
  formatManifestEntry,
  INOCULATION_SENTENCE,
  type CodifyCommandOptions,
} from '../src/commands/codify.js';
import {
  TRACE_SCHEMA_VERSION,
  type ChatInput,
  type ChatResult,
  type IndexRecord,
  type TraceRecord,
} from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('generateSlug', () => {
  it('produces a kebab-case slug from the failure reason + short conversation id', () => {
    const slug = generateSlug('aborted: cost cap exceeded', '12345678-abcd-4abc-8def-1234567890ab');
    expect(slug).toBe('aborted-cost-cap-exceeded-12345678');
  });

  it('caps the reason words at 6 and the slug at 60 chars', () => {
    const long = 'one two three four five six seven eight nine ten eleven';
    const slug = generateSlug(long, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(slug.startsWith('one-two-three-four-five-six-')).toBe(true);
    // reason portion ≤ 60 + dash + 8 = 69 max
    expect(slug.length).toBeLessThanOrEqual(69);
  });

  it('falls back to "regression-<short-id>" when the reason has no usable words', () => {
    const slug = generateSlug('!!!@@@###', '12345678-abcd-4abc-8def-1234567890ab');
    expect(slug).toBe('regression-12345678');
  });

  it('strips punctuation and is filesystem-safe', () => {
    const slug = generateSlug('error: 500 (timeout) on /api/foo', '12345678-abcd-4abc-8def-1234567890ab');
    expect(slug).toMatch(/^[a-z0-9-]+$/);
  });
});

describe('extractTestCode', () => {
  it('extracts a typescript-fenced block', () => {
    const response = 'Here is the test:\n```typescript\nimport { it } from "vitest";\nit("works", () => {});\n```\nDone.';
    expect(extractTestCode(response)).toBe('import { it } from "vitest";\nit("works", () => {});');
  });

  it('extracts a ts-fenced block', () => {
    const response = '```ts\nconst x = 1;\n```';
    expect(extractTestCode(response)).toBe('const x = 1;');
  });

  it('falls back to a generic fenced block', () => {
    const response = '```\nplain code\n```';
    expect(extractTestCode(response)).toBe('plain code');
  });

  it('returns null when there is no fenced block', () => {
    expect(extractTestCode('just prose, no code')).toBeNull();
  });

  it('prefers the typescript fence over a generic one when both appear', () => {
    const response = '```\nfirst block\n```\n\n```typescript\nsecond block\n```';
    expect(extractTestCode(response)).toBe('second block');
  });
});

describe('extractFailureSignal', () => {
  function buildIndex(overrides: Partial<IndexRecord> = {}): IndexRecord {
    return {
      conversation_id: '00000000-0000-4000-8000-000000000001',
      started_at: '2026-04-28T10:00:00.000Z',
      ended_at: '2026-04-28T10:01:00.000Z',
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 2,
      total_cost_usd: 0.1,
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cached_input_tokens: 0,
      status: 'completed',
      schema_version: TRACE_SCHEMA_VERSION,
      ...overrides,
    };
  }

  function buildErrorRecord(message: string): TraceRecord {
    return {
      ts: '2026-04-28T10:00:30.000Z',
      conversation_id: '00000000-0000-4000-8000-000000000001',
      step: 1,
      type: 'error',
      content: { name: 'TestError', message },
      schema_version: TRACE_SCHEMA_VERSION,
    };
  }

  it('returns isFailure=false on a clean completed conversation', () => {
    const signal = extractFailureSignal([], buildIndex());
    expect(signal.isFailure).toBe(false);
    expect(signal.reason).toBe('');
  });

  it('detects aborted_cost_cap status as a failure', () => {
    const signal = extractFailureSignal([], buildIndex({ status: 'aborted_cost_cap' }));
    expect(signal.isFailure).toBe(true);
    expect(signal.reason).toMatch(/cost cap/i);
  });

  it('detects aborted_window_full status as a failure', () => {
    const signal = extractFailureSignal([], buildIndex({ status: 'aborted_window_full' }));
    expect(signal.isFailure).toBe(true);
    expect(signal.reason).toMatch(/window full/i);
  });

  it('detects aborted_error status and surfaces the error message', () => {
    const records = [buildErrorRecord('rate limit hit')];
    const signal = extractFailureSignal(records, buildIndex({ status: 'aborted_error' }));
    expect(signal.isFailure).toBe(true);
    expect(signal.reason).toMatch(/rate limit/);
  });

  it('detects an error trace record even when status is "completed"', () => {
    const records = [buildErrorRecord('schema validation failed')];
    const signal = extractFailureSignal(records, buildIndex({ status: 'completed' }));
    expect(signal.isFailure).toBe(true);
    expect(signal.reason).toMatch(/schema validation/);
  });

  it('honors an explicit --reason override even on a clean trace', () => {
    const signal = extractFailureSignal([], buildIndex(), 'output was off-brand');
    expect(signal.isFailure).toBe(true);
    expect(signal.reason).toBe('output was off-brand');
  });

  it('ignores a whitespace-only --reason and falls back to inference', () => {
    const signal = extractFailureSignal([], buildIndex(), '   ');
    expect(signal.isFailure).toBe(false);
  });
});

describe('buildCodifyPrompt', () => {
  it('includes the source metadata, prompt, and response sections', () => {
    const prompt = buildCodifyPrompt({
      userPrompt: 'write a haiku',
      assistantResponse: 'Roses are red',
      failureReason: 'wrong format',
      sourceConversationId: 'abc-123',
      sourceModel: 'anthropic/claude-sonnet-4-6',
    });
    expect(prompt).toContain('Conversation ID: abc-123');
    expect(prompt).toContain('Model: anthropic/claude-sonnet-4-6');
    expect(prompt).toContain('Failure reason: wrong format');
    expect(prompt).toContain('write a haiku');
    expect(prompt).toContain('Roses are red');
  });

  it('omits the system-prompt section when none provided', () => {
    const prompt = buildCodifyPrompt({
      userPrompt: 'x',
      assistantResponse: 'y',
      failureReason: 'z',
      sourceConversationId: 'id',
      sourceModel: 'm/n',
    });
    expect(prompt).not.toContain('## System prompt');
  });

  it('includes the system-prompt section when provided', () => {
    const prompt = buildCodifyPrompt({
      userPrompt: 'x',
      assistantResponse: 'y',
      failureReason: 'z',
      sourceConversationId: 'id',
      sourceModel: 'm/n',
      systemPrompt: 'You are a helpful assistant.',
    });
    expect(prompt).toContain('## System prompt');
    expect(prompt).toContain('You are a helpful assistant.');
  });

  it('truncates oversized prompt and response payloads', () => {
    const huge = 'x'.repeat(10_000);
    const prompt = buildCodifyPrompt({
      userPrompt: huge,
      assistantResponse: huge,
      failureReason: 'too long',
      sourceConversationId: 'id',
      sourceModel: 'm/n',
    });
    expect(prompt).toContain('[... truncated]');
  });
});

describe('formatManifestEntry', () => {
  it('produces a Markdown section with all metadata fields', () => {
    const entry = formatManifestEntry({
      slug: 'wrong-format-abc12345',
      conversationId: 'abc12345-aaaa-4bbb-8ccc-dddddddddddd',
      capturedAt: '2026-04-28T12:00:00.000Z',
      failureReason: 'wrong format',
      sourceModel: 'anthropic/claude-sonnet-4-6',
      outputPath: '/proj/test/regression/wrong-format-abc12345.test.ts',
      cwd: '/proj',
    });
    expect(entry).toContain('## wrong-format-abc12345');
    expect(entry).toContain('abc12345-aaaa-4bbb-8ccc-dddddddddddd');
    expect(entry).toContain('2026-04-28T12:00:00.000Z');
    expect(entry).toContain('anthropic/claude-sonnet-4-6');
    expect(entry).toContain('test/regression/wrong-format-abc12345.test.ts');
  });
});

describe('INOCULATION_SENTENCE', () => {
  it('explicitly names reward-hacking as the load-bearing safety primitive', () => {
    // Per Anthropic Nov 2025 (arXiv 2511.18397). Removing this regex test would silently
    // weaken the harness's most important self-improvement safety hook.
    expect(INOCULATION_SENTENCE.toLowerCase()).toMatch(/reward.hacking/);
    expect(INOCULATION_SENTENCE.toLowerCase()).toMatch(/disallowed|not allowed|prohibited/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests (chat function seam, no real LLM call)
// ────────────────────────────────────────────────────────────────────

describe('runCodifyCommand', () => {
  let traceDir: string;
  let cwd: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  const FAKE_CONV_ID = '12345678-1234-4567-8abc-123456789012';

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'codify-trace-'));
    cwd = await mkdtemp(join(tmpdir(), 'codify-cwd-'));
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
    await rm(cwd, { recursive: true, force: true });
  });

  async function seedFailedConversation(opts: { status?: IndexRecord['status']; assistantText?: string } = {}): Promise<void> {
    const indexRecord: IndexRecord = {
      conversation_id: FAKE_CONV_ID,
      started_at: '2026-04-28T10:00:00.000Z',
      ended_at: '2026-04-28T10:01:00.000Z',
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 3,
      total_cost_usd: 0.05,
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cached_input_tokens: 0,
      status: opts.status ?? 'aborted_error',
      schema_version: TRACE_SCHEMA_VERSION,
    };
    await writeFile(join(traceDir, 'INDEX.jsonl'), JSON.stringify(indexRecord) + '\n', 'utf-8');

    const dateDir = join(traceDir, '2026-04-28');
    await mkdir(dateDir, { recursive: true });
    const records: TraceRecord[] = [
      {
        ts: '2026-04-28T10:00:00.000Z',
        conversation_id: FAKE_CONV_ID,
        step: 0,
        type: 'system',
        role: 'system',
        content: 'You are a helpful assistant for FRQNCY.',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      {
        ts: '2026-04-28T10:00:01.000Z',
        conversation_id: FAKE_CONV_ID,
        step: 1,
        type: 'user',
        role: 'user',
        content: 'write a topic page on equanimity',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      {
        ts: '2026-04-28T10:00:30.000Z',
        conversation_id: FAKE_CONV_ID,
        step: 2,
        type: 'assistant',
        role: 'assistant',
        content: opts.assistantText ?? 'Equanimity is when you literally do not care anymore. Just chill.',
        model: 'anthropic/claude-sonnet-4-6',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      {
        ts: '2026-04-28T10:00:31.000Z',
        conversation_id: FAKE_CONV_ID,
        step: 3,
        type: 'error',
        content: { name: 'BrandError', message: 'tone score below threshold (45/100)' },
        schema_version: TRACE_SCHEMA_VERSION,
      },
    ];
    const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await writeFile(join(dateDir, `${FAKE_CONV_ID}.jsonl`), lines, 'utf-8');
  }

  function makeStubChat(testCode: string): NonNullable<CodifyCommandOptions['chatFn']> {
    return async (input: ChatInput): Promise<ChatResult> => {
      // Sanity: the system prompt must contain the inoculation sentence.
      // Defensive — if a future refactor drops it, this stub will surface that immediately.
      if (!input.system?.includes('reward hacking')) {
        throw new Error('codify chat invocation missing inoculation sentence in system prompt');
      }
      return {
        text: '```typescript\n' + testCode + '\n```',
        conversationId: 'stub-conv-id',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  const SAMPLE_TEST_CODE = `// REGRESSION: tone score below threshold
import { describe, it, expect } from 'vitest';

describe.skip('regression: tone-score-below-threshold', () => {
  it('does not produce off-brand "just chill" phrasing', () => {
    const knownFailureResponse = 'Equanimity is when you literally do not care anymore. Just chill.';
    expect(knownFailureResponse.toLowerCase()).toContain('just chill');
    // TODO: replace with a real model call + assertion that the response NEVER contains "just chill"
  });
});`;

  it('finds an aborted_error conversation and writes a regression test', async () => {
    await seedFailedConversation();

    const result = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });

    expect(result.written).toBe(true);
    expect(result.conversationId).toBe(FAKE_CONV_ID);
    expect(result.failureReason).toMatch(/tone score/);
    expect(result.outputPath).toMatch(/test\/regression\/.*\.test\.ts$/);

    const written = await readFile(result.outputPath, 'utf-8');
    expect(written).toContain('describe.skip');
    expect(written).toContain('just chill');
  });

  it('honors an 8-character prefix instead of the full conversation id', async () => {
    await seedFailedConversation();
    const result = await runCodifyCommand(FAKE_CONV_ID.slice(0, 8), {
      traceDir,
      cwd,
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });
    expect(result.conversationId).toBe(FAKE_CONV_ID);
  });

  it('refuses to codify a clean (non-failed) conversation without --reason', async () => {
    await seedFailedConversation({ status: 'completed' });
    // Override the error record so the conversation looks clean
    const dateDir = join(traceDir, '2026-04-28');
    const records: TraceRecord[] = [
      {
        ts: '2026-04-28T10:00:01.000Z',
        conversation_id: FAKE_CONV_ID,
        step: 0,
        type: 'user',
        role: 'user',
        content: 'a clean prompt',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      {
        ts: '2026-04-28T10:00:02.000Z',
        conversation_id: FAKE_CONV_ID,
        step: 1,
        type: 'assistant',
        role: 'assistant',
        content: 'a clean response',
        model: 'anthropic/claude-sonnet-4-6',
        schema_version: TRACE_SCHEMA_VERSION,
      },
    ];
    await writeFile(
      join(dateDir, `${FAKE_CONV_ID}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );

    await expect(
      runCodifyCommand(FAKE_CONV_ID, { traceDir, cwd, chatFn: makeStubChat(SAMPLE_TEST_CODE) }),
    ).rejects.toThrow(/no obvious failure/);
  });

  it('codifies a clean conversation when --reason is explicitly given', async () => {
    await seedFailedConversation({ status: 'completed' });
    const result = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      reason: 'output was off-brand even though the model returned 200',
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });
    expect(result.written).toBe(true);
    expect(result.failureReason).toMatch(/off-brand/);
  });

  it('does not write any files in --dry-run mode', async () => {
    await seedFailedConversation();
    const result = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      dryRun: true,
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });
    expect(result.written).toBe(false);

    // Output path was never created
    await expect(access(result.outputPath)).rejects.toThrow();
    await expect(access(result.manifestPath)).rejects.toThrow();
  });

  it('appends a manifest entry with the source trace + slug', async () => {
    await seedFailedConversation();
    const result = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });

    const manifest = await readFile(result.manifestPath, 'utf-8');
    expect(manifest).toContain('# Regression manifest');
    expect(manifest).toContain(`## ${result.slug}`);
    expect(manifest).toContain(FAKE_CONV_ID);
  });

  it('appends multiple entries to a shared manifest without overwriting', async () => {
    await seedFailedConversation();

    // First codify
    const r1 = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      reason: 'first failure',
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });
    // Second codify against same conversation, different reason
    const r2 = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      reason: 'second failure',
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });

    expect(r1.slug).not.toBe(r2.slug);
    const manifest = await readFile(r1.manifestPath, 'utf-8');
    expect(manifest).toContain(r1.slug);
    expect(manifest).toContain(r2.slug);
  });

  it('throws a clear error when the LLM does not produce a code block', async () => {
    await seedFailedConversation();
    const stubChat: NonNullable<CodifyCommandOptions['chatFn']> = async (input: ChatInput) => ({
      text: 'sorry, no code today, just prose',
      conversationId: 'stub',
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
      model: input.model,
      provider: 'anthropic',
      finishReason: 'stop',
    });
    await expect(
      runCodifyCommand(FAKE_CONV_ID, { traceDir, cwd, chatFn: stubChat }),
    ).rejects.toThrow(/recognizable test code block/);
  });

  it('throws when the conversation id is unknown', async () => {
    await seedFailedConversation();
    await expect(
      runCodifyCommand('99999999-9999-4999-8999-999999999999', {
        traceDir,
        cwd,
        chatFn: makeStubChat(SAMPLE_TEST_CODE),
      }),
    ).rejects.toThrow(/no trace found/);
  });

  it('throws when INDEX.jsonl is missing entirely', async () => {
    // Don't seed — empty traceDir
    await expect(
      runCodifyCommand(FAKE_CONV_ID, { traceDir, cwd, chatFn: makeStubChat(SAMPLE_TEST_CODE) }),
    ).rejects.toThrow(/INDEX\.jsonl missing/);
  });

  it('emits structured JSON when --json is set', async () => {
    await seedFailedConversation();
    await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      json: true,
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.conversationId).toBe(FAKE_CONV_ID);
    expect(parsed.written).toBe(true);
    expect(parsed.testCode).toContain('describe.skip');
  });

  it('respects an explicit --output path', async () => {
    await seedFailedConversation();
    const customOut = 'tests-custom/myreg.test.ts';
    const result = await runCodifyCommand(FAKE_CONV_ID, {
      traceDir,
      cwd,
      output: customOut,
      chatFn: makeStubChat(SAMPLE_TEST_CODE),
    });
    expect(result.outputPath).toBe(join(cwd, customOut));
    const written = await readFile(result.outputPath, 'utf-8');
    expect(written).toContain('describe.skip');
  });
});
