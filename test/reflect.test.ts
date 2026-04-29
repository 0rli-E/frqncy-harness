import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runReflectCommand,
  buildReflectionPrompt,
  buildTraceSummary,
  renderProposalDocument,
  parseSince,
  REFLECT_SYSTEM_PROMPT,
  type ReflectCommandOptions,
  type TraceSummary,
} from '../src/commands/reflect.js';
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

describe('parseSince', () => {
  it('parses common time units', () => {
    expect(parseSince('1d')).toBe(86_400_000);
    expect(parseSince('7d')).toBe(7 * 86_400_000);
    expect(parseSince('2w')).toBe(2 * 7 * 86_400_000);
    expect(parseSince('3m')).toBe(3 * 30 * 86_400_000);
    expect(parseSince('1y')).toBe(365 * 86_400_000);
  });

  it('returns Infinity for "all"', () => {
    expect(parseSince('all')).toBe(Number.POSITIVE_INFINITY);
  });

  it('throws on invalid format', () => {
    expect(() => parseSince('7days')).toThrow();
    expect(() => parseSince('garbage')).toThrow();
    expect(() => parseSince('')).toThrow();
  });
});

describe('REFLECT_SYSTEM_PROMPT', () => {
  it('includes the inoculation sentence (load-bearing safety hook)', () => {
    // Per Anthropic Nov 2025 (arXiv 2511.18397). Removing this would silently
    // weaken the harness's most important self-improvement safety primitive.
    expect(REFLECT_SYSTEM_PROMPT.toLowerCase()).toMatch(/reward.hacking/);
    expect(REFLECT_SYSTEM_PROMPT.toLowerCase()).toMatch(/disallowed|not allowed|prohibited/);
  });

  it('asks for exactly 3 recurring failure modes', () => {
    expect(REFLECT_SYSTEM_PROMPT).toMatch(/3.*recurring.*failure.*modes/i);
  });

  it('names all four recommended-fix categories', () => {
    expect(REFLECT_SYSTEM_PROMPT.toLowerCase()).toContain('new hook');
    expect(REFLECT_SYSTEM_PROMPT.toLowerCase()).toContain('new skill');
    expect(REFLECT_SYSTEM_PROMPT.toLowerCase()).toContain('system-prompt amendment');
    expect(REFLECT_SYSTEM_PROMPT.toLowerCase()).toContain('regression test');
  });
});

describe('buildTraceSummary', () => {
  function buildIndex(overrides: Partial<IndexRecord> = {}): IndexRecord {
    return {
      conversation_id: '00000000-0000-4000-8000-000000000001',
      started_at: '2026-04-28T10:00:00.000Z',
      ended_at: '2026-04-28T10:01:00.000Z',
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

  function buildRecords(): TraceRecord[] {
    return [
      {
        ts: '2026-04-28T10:00:00.000Z',
        conversation_id: '00000000-0000-4000-8000-000000000001',
        step: 0,
        type: 'user',
        role: 'user',
        content: 'hello',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      {
        ts: '2026-04-28T10:00:01.000Z',
        conversation_id: '00000000-0000-4000-8000-000000000001',
        step: 1,
        type: 'assistant',
        role: 'assistant',
        content: 'hi back',
        model: 'anthropic/claude-sonnet-4-6',
        schema_version: TRACE_SCHEMA_VERSION,
      },
    ];
  }

  it('extracts the user prompt and assistant response', () => {
    const summary = buildTraceSummary(buildIndex(), buildRecords(), { isFailure: false, reason: '' });
    expect(summary.userPrompt).toBe('hello');
    expect(summary.assistantResponse).toBe('hi back');
    expect(summary.isFailure).toBe(false);
  });

  it('marks failures and surfaces the failure reason', () => {
    const summary = buildTraceSummary(
      buildIndex({ status: 'aborted_cost_cap' }),
      buildRecords(),
      { isFailure: true, reason: 'cost cap exceeded' },
    );
    expect(summary.isFailure).toBe(true);
    expect(summary.failureReason).toMatch(/cost cap/);
  });

  it('passes through thread_id and project_id when present', () => {
    const summary = buildTraceSummary(
      buildIndex({ thread_id: 't1', project_id: 'p1' }),
      buildRecords(),
      { isFailure: false, reason: '' },
    );
    expect(summary.threadId).toBe('t1');
    expect(summary.projectId).toBe('p1');
  });

  it('extracts the first error message when an error record exists', () => {
    const records: TraceRecord[] = [
      ...buildRecords(),
      {
        ts: '2026-04-28T10:00:02.000Z',
        conversation_id: '00000000-0000-4000-8000-000000000001',
        step: 2,
        type: 'error',
        content: { name: 'TestError', message: 'something broke' },
        schema_version: TRACE_SCHEMA_VERSION,
      },
    ];
    const summary = buildTraceSummary(buildIndex(), records, { isFailure: true, reason: 'something broke' });
    expect(summary.errorMessage).toBe('something broke');
  });
});

describe('buildReflectionPrompt', () => {
  function makeSummary(overrides: Partial<TraceSummary> = {}): TraceSummary {
    return {
      conversationId: '00000000-0000-4000-8000-aaaaaaaaaaaa',
      startedAt: '2026-04-28T10:00:00.000Z',
      model: 'anthropic/claude-sonnet-4-6',
      status: 'aborted_error',
      failureReason: 'rate limit',
      isFailure: true,
      userPrompt: 'do the thing',
      assistantResponse: 'ok i did it (badly)',
      ...overrides,
    };
  }

  it('includes filter metadata, trace count, and the task prompt', () => {
    const out = buildReflectionPrompt({
      summaries: [makeSummary()],
      totalScanned: 5,
      filter: { last: 20, since: '7d', includeSuccess: false },
    });
    expect(out).toContain('thread: *');
    expect(out).toContain('project: *');
    expect(out).toContain('since: 7d');
    expect(out).toContain('focused-on: 1 trace(s) of 5');
    expect(out).toContain('Identify the 3 most recurring failure modes');
  });

  it('renders thread + project filter values when given', () => {
    const out = buildReflectionPrompt({
      summaries: [makeSummary()],
      totalScanned: 1,
      filter: { threadId: 'frqncy-content', projectId: 'frqncy', last: 20, since: '7d', includeSuccess: false },
    });
    expect(out).toContain('thread: frqncy-content');
    expect(out).toContain('project: frqncy');
  });

  it('renders each summary with model + status + prompt + response', () => {
    const out = buildReflectionPrompt({
      summaries: [makeSummary({ failureReason: 'tone score below threshold' })],
      totalScanned: 1,
      filter: { last: 20, since: '7d', includeSuccess: false },
    });
    expect(out).toContain('anthropic/claude-sonnet-4-6');
    expect(out).toContain('FAILED — tone score below threshold');
    expect(out).toContain('do the thing');
    expect(out).toContain('ok i did it (badly)');
  });

  it('truncates overall context when summaries exceed the budget', () => {
    const huge = 'x'.repeat(10_000);
    const summaries = Array.from({ length: 50 }, (_, i) =>
      makeSummary({
        conversationId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        userPrompt: huge,
        assistantResponse: huge,
      }),
    );
    const out = buildReflectionPrompt({
      summaries,
      totalScanned: 50,
      filter: { last: 50, since: '7d', includeSuccess: false },
    });
    expect(out).toContain('truncated');
  });
});

describe('renderProposalDocument', () => {
  it('wraps the model proposal with metadata + source-trace list', () => {
    const doc = renderProposalDocument({
      proposalMarkdown: '## Recurring failure modes\n\n### 1. The thing',
      tracesAnalyzed: 3,
      tracesScanned: 10,
      filter: { last: 20, since: '7d', includeSuccess: false },
      reflectModel: 'anthropic/claude-sonnet-4-6',
      generatedAt: '2026-04-28T12:00:00.000Z',
      summaries: [
        {
          conversationId: 'c1-aaaa-4bbb-8ccc-000000000001',
          startedAt: '2026-04-28T10:00:00.000Z',
          model: 'm/n',
          status: 'aborted_error',
          failureReason: 'rate limit',
          isFailure: true,
          userPrompt: 'p',
          assistantResponse: 'r',
        },
      ],
    });
    expect(doc).toContain('# Reflection — 2026-04-28');
    expect(doc).toContain('Generated by `frqncy-harness reflect`');
    expect(doc).toMatch(/Traces analyzed:\*?\*?\s*3 of 10/);
    expect(doc).toContain('## Source traces');
    expect(doc).toContain('c1-aaaa-4bbb-8ccc-000000000001');
    expect(doc).toContain('## Recurring failure modes');
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests (chat function seam, no real LLM call)
// ────────────────────────────────────────────────────────────────────

describe('runReflectCommand', () => {
  let traceDir: string;
  let cwd: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'reflect-trace-'));
    cwd = await mkdtemp(join(tmpdir(), 'reflect-cwd-'));
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

  // Helpers ────────────────────────────────────────────────

  async function seedConversation(opts: {
    id: string;
    startedAt: string;
    status?: IndexRecord['status'];
    threadId?: string;
    projectId?: string;
    userPrompt?: string;
    assistantResponse?: string;
    errorMessage?: string;
  }): Promise<void> {
    const indexRecord: IndexRecord = {
      conversation_id: opts.id,
      started_at: opts.startedAt,
      ended_at: opts.startedAt,
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 2,
      total_cost_usd: 0.01,
      total_input_tokens: 100,
      total_output_tokens: 200,
      total_cached_input_tokens: 0,
      status: opts.status ?? 'aborted_error',
      schema_version: TRACE_SCHEMA_VERSION,
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
      ...(opts.projectId ? { project_id: opts.projectId } : {}),
    };
    const indexPath = join(traceDir, 'INDEX.jsonl');
    await mkdir(traceDir, { recursive: true });
    let existing = '';
    try {
      existing = await readFile(indexPath, 'utf-8');
    } catch {
      // first write
    }
    await writeFile(indexPath, existing + JSON.stringify(indexRecord) + '\n', 'utf-8');

    const date = opts.startedAt.slice(0, 10);
    const dateDir = join(traceDir, date);
    await mkdir(dateDir, { recursive: true });

    const records: TraceRecord[] = [
      {
        ts: opts.startedAt,
        conversation_id: opts.id,
        step: 0,
        type: 'user',
        role: 'user',
        content: opts.userPrompt ?? 'do the thing',
        schema_version: TRACE_SCHEMA_VERSION,
      },
      {
        ts: opts.startedAt,
        conversation_id: opts.id,
        step: 1,
        type: 'assistant',
        role: 'assistant',
        content: opts.assistantResponse ?? 'i did the thing',
        model: 'anthropic/claude-sonnet-4-6',
        schema_version: TRACE_SCHEMA_VERSION,
      },
    ];
    if (opts.errorMessage) {
      records.push({
        ts: opts.startedAt,
        conversation_id: opts.id,
        step: 2,
        type: 'error',
        content: { name: 'TestError', message: opts.errorMessage },
        schema_version: TRACE_SCHEMA_VERSION,
      });
    }
    await writeFile(
      join(dateDir, `${opts.id}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  function makeStubChat(proposalMarkdown: string): NonNullable<ReflectCommandOptions['chatFn']> {
    return async (input: ChatInput): Promise<ChatResult> => {
      // Defensive: the inoculation sentence MUST be in the system prompt.
      if (!input.system?.includes('reward hacking')) {
        throw new Error('reflect chat invocation missing inoculation sentence in system prompt');
      }
      return {
        text: proposalMarkdown,
        conversationId: 'stub-conv-id',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  const SAMPLE_PROPOSAL = `## Recurring failure modes

### 1. Tone drift on long-form content

- **Frequency:** 3 of 5 traces
- **Pattern:** the model defaults to startup-bro register on prompts longer than 300 tokens
- **Example trace:** \`abc12345-...\`
- **Recommended fix:** \`b\` — new skill \`brand-voice-anchor\` that re-injects FRQNCY's voice on every long-form turn
- **Estimated complexity:** small

### 2. Ungrounded claims about meditation outcomes

- **Frequency:** 2 of 5 traces
- **Pattern:** confident assertions without sources on health-adjacent topics
- **Example trace:** \`def67890-...\`
- **Recommended fix:** \`a\` — new \`pre-publish-fact-check\` hook that runs on post-tool-use for write tools
- **Estimated complexity:** medium

### 3. Empty completion-promise checks

- **Frequency:** 2 of 5 traces
- **Pattern:** loops emit \`<promise>DONE</promise>\` even when work is incomplete
- **Example trace:** \`ghi11111-...\`
- **Recommended fix:** \`d\` — codify trace \`ghi11111\` with the assertion that the produced artifact passes \`npm test\`
- **Estimated complexity:** small

## Synthesis

Ship fix #3 first — codifying the broken-promise trace converts a recurring runtime failure into a permanent test gate, and the codify command already exists.`;

  // Integration tests ────────────────────────────────────

  it('reads multiple failed traces and writes a structured proposal', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'aborted_error',
      errorMessage: 'tone score below threshold',
    });
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa2',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      status: 'aborted_cost_cap',
    });
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa3',
      startedAt: new Date(Date.now() - 180_000).toISOString(),
      status: 'aborted_window_full',
    });

    const result = await runReflectCommand({
      traceDir,
      cwd,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });

    expect(result.tracesAnalyzed).toBe(3);
    expect(result.tracesFailed).toBe(3);
    expect(result.written).toBe(true);
    expect(result.outputPath).toMatch(/proposals\/reflection-\d{4}-\d{2}-\d{2}\.md$/);

    const written = await readFile(result.outputPath, 'utf-8');
    expect(written).toContain('# Reflection');
    expect(written).toContain('Recurring failure modes');
    expect(written).toContain('## Source traces');
  });

  it('filters by --thread', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      threadId: 'frqncy-content',
    });
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa2',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      threadId: 'other',
    });

    const result = await runReflectCommand({
      traceDir,
      cwd,
      threadId: 'frqncy-content',
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.tracesAnalyzed).toBe(1);
    expect(result.filter.threadId).toBe('frqncy-content');
  });

  it('filters by --project', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      projectId: 'p1',
    });
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa2',
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      projectId: 'p2',
    });

    const result = await runReflectCommand({
      traceDir,
      cwd,
      projectId: 'p2',
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.tracesAnalyzed).toBe(1);
  });

  it('respects --since (filters out traces older than the window)', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date(Date.now() - 60_000).toISOString(), // recent
    });
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa2',
      startedAt: '2024-01-01T00:00:00.000Z', // ancient
    });

    const result = await runReflectCommand({
      traceDir,
      cwd,
      since: '7d',
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.tracesAnalyzed).toBe(1);
  });

  it('orders by most-recent first then takes --last N', async () => {
    for (let i = 0; i < 5; i++) {
      await seedConversation({
        id: `00000000-0000-4000-8000-aaaaaaaaaaa${i}`,
        // i=0 oldest, i=4 newest
        startedAt: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
      });
    }

    const result = await runReflectCommand({
      traceDir,
      cwd,
      last: 2,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.tracesAnalyzed).toBe(2);
  });

  it('refuses when no traces match the filter', async () => {
    await expect(
      runReflectCommand({
        traceDir,
        cwd,
        chatFn: makeStubChat(SAMPLE_PROPOSAL),
      }),
    ).rejects.toThrow(/no traces match the filter/);
  });

  it('refuses when matching traces are all successful (without --include-success)', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date().toISOString(),
      status: 'completed',
    });
    await expect(
      runReflectCommand({
        traceDir,
        cwd,
        chatFn: makeStubChat(SAMPLE_PROPOSAL),
      }),
    ).rejects.toThrow(/no failed traces/);
  });

  it('analyzes successful traces when --include-success is set', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date().toISOString(),
      status: 'completed',
    });
    const result = await runReflectCommand({
      traceDir,
      cwd,
      includeSuccess: true,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.tracesAnalyzed).toBe(1);
    expect(result.tracesFailed).toBe(0);
    expect(result.filter.includeSuccess).toBe(true);
  });

  it('does not write any files in --dry-run mode', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date().toISOString(),
    });
    const result = await runReflectCommand({
      traceDir,
      cwd,
      dryRun: true,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.written).toBe(false);
    await expect(access(result.outputPath)).rejects.toThrow();
  });

  it('respects an explicit --output path', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date().toISOString(),
    });
    const customOut = 'analysis/today.md';
    const result = await runReflectCommand({
      traceDir,
      cwd,
      output: customOut,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.outputPath).toBe(join(cwd, customOut));
    const written = await readFile(result.outputPath, 'utf-8');
    expect(written).toContain('Recurring failure modes');
  });

  it('emits structured JSON on --json', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date().toISOString(),
    });
    await runReflectCommand({
      traceDir,
      cwd,
      json: true,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.tracesAnalyzed).toBe(1);
    expect(parsed.written).toBe(true);
    expect(parsed.proposalMarkdown).toContain('Recurring failure modes');
  });

  it('survives a corrupt conversation file by skipping it', async () => {
    await seedConversation({
      id: '00000000-0000-4000-8000-aaaaaaaaaaa1',
      startedAt: new Date().toISOString(),
    });
    // Add a bad index entry pointing at a missing file
    const indexPath = join(traceDir, 'INDEX.jsonl');
    const existing = await readFile(indexPath, 'utf-8');
    const bogus: IndexRecord = {
      conversation_id: '00000000-0000-4000-8000-bbbbbbbbbbbb',
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 0,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      status: 'aborted_error',
      schema_version: TRACE_SCHEMA_VERSION,
    };
    await writeFile(indexPath, existing + JSON.stringify(bogus) + '\n', 'utf-8');

    const result = await runReflectCommand({
      traceDir,
      cwd,
      chatFn: makeStubChat(SAMPLE_PROPOSAL),
    });
    expect(result.tracesAnalyzed).toBe(1);
  });
});
