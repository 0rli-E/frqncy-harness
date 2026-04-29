import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runRalphCommand,
  matchesCompletionPredicate,
  buildInitialPrompt,
  buildContinuationPrompt,
  fileExists,
  RALPH_SYSTEM_PROMPT,
  type RalphCommandOptions,
} from '../src/commands/ralph.js';
import type { ChatInput, ChatResult } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('matchesCompletionPredicate', () => {
  it('matches a substring case-sensitively', () => {
    expect(matchesCompletionPredicate('All work complete. DONE', 'DONE')).toBe(true);
    expect(matchesCompletionPredicate('all work done', 'DONE')).toBe(false);
  });

  it('matches the default completion-promise sentinel', () => {
    expect(matchesCompletionPredicate('Wrapping up. <promise>DONE</promise>', '<promise>DONE</promise>')).toBe(true);
  });

  it('matches a /regex/ pattern', () => {
    expect(matchesCompletionPredicate('All done.', '/done/i')).toBe(true);
    expect(matchesCompletionPredicate('All complete.', '/done/i')).toBe(false);
  });

  it('respects regex flags', () => {
    expect(matchesCompletionPredicate('DONE', '/done/')).toBe(false); // case-sensitive without /i
    expect(matchesCompletionPredicate('DONE', '/done/i')).toBe(true);
  });

  it('falls back to substring match when regex is malformed', () => {
    // A regex like /[/ has unbalanced character class; we shouldn't crash
    expect(matchesCompletionPredicate('text containing /[/', '/[/')).toBe(true);
  });

  it('returns false on empty input text', () => {
    expect(matchesCompletionPredicate('', 'DONE')).toBe(false);
  });

  it('handles multi-line responses correctly', () => {
    const text = 'Line 1\nLine 2\n<promise>DONE</promise>\n';
    expect(matchesCompletionPredicate(text, '<promise>DONE</promise>')).toBe(true);
  });
});

describe('RALPH_SYSTEM_PROMPT', () => {
  it('includes the inoculation sentence (load-bearing safety hook)', () => {
    expect(RALPH_SYSTEM_PROMPT.toLowerCase()).toMatch(/reward.hacking/);
  });

  it('explicitly tells the agent not to fake completion', () => {
    expect(RALPH_SYSTEM_PROMPT.toLowerCase()).toMatch(/do not.*emit.*to escape|false promise|wastes/);
  });

  it('explains the loop semantics so the model knows it will be re-invoked', () => {
    expect(RALPH_SYSTEM_PROMPT.toLowerCase()).toMatch(/re.invoked|iteration|loop/);
  });
});

describe('buildInitialPrompt', () => {
  it('includes the task, working directory, and completion predicate', () => {
    const out = buildInitialPrompt('write a haiku', 'DONE', '/work/dir');
    expect(out).toContain('iteration 1');
    expect(out).toContain('write a haiku');
    expect(out).toContain('/work/dir');
    expect(out).toContain('DONE');
  });
});

describe('buildContinuationPrompt', () => {
  it('numbers the iteration and references the original task + thread context', () => {
    const out = buildContinuationPrompt('write a haiku', 5, 25, 'DONE');
    expect(out).toContain('iteration 5 of 25');
    expect(out).toContain('write a haiku');
    expect(out).toContain('DONE');
    expect(out.toLowerCase()).toContain('thread_id');
  });

  it('warns the model not to fabricate completion to escape a hard problem', () => {
    const out = buildContinuationPrompt('x', 2, 5, 'D');
    expect(out.toLowerCase()).toContain('do not fabricate');
  });
});

describe('fileExists', () => {
  it('returns true for an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ralph-fileexists-'));
    const filePath = join(dir, 'present');
    await writeFile(filePath, 'x');
    try {
      expect(await fileExists(filePath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false for a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ralph-fileexists-'));
    try {
      expect(await fileExists(join(dir, 'missing'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests (chat function seam, no real LLM calls)
// ────────────────────────────────────────────────────────────────────

describe('runRalphCommand', () => {
  let killFlagPath: string;
  let cleanupDirs: string[] = [];
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ralph-test-'));
    cleanupDirs.push(dir);
    killFlagPath = join(dir, 'kill.flag');
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs = [];
  });

  // Helpers ─────────────────────────────────────────────────

  function makeStubChat(responses: string[]): {
    chatFn: NonNullable<RalphCommandOptions['chatFn']>;
    callCount: () => number;
    inputs: ChatInput[];
  } {
    const inputs: ChatInput[] = [];
    let i = 0;
    const chatFn: NonNullable<RalphCommandOptions['chatFn']> = async (input: ChatInput) => {
      // Defensive: the inoculation sentence MUST appear in the system prompt
      if (!input.system?.toLowerCase().includes('reward hacking')) {
        throw new Error('ralph chat invocation missing inoculation sentence in system prompt');
      }
      inputs.push(input);
      const text = responses[Math.min(i, responses.length - 1)] ?? '';
      i++;
      return {
        text,
        conversationId: `stub-${i}-${'00000000-0000-4000-8000-000000000000'.slice(0, 36)}`,
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    return { chatFn, callCount: () => i, inputs };
  }

  // Tests ────────────────────────────────────────────────────

  it('halts on the first iteration when the predicate matches immediately', async () => {
    const { chatFn, callCount } = makeStubChat(['Done. <promise>DONE</promise>']);
    const result = await runRalphCommand('do the thing', { chatFn, killFlagPath });
    expect(result.status).toBe('completed');
    expect(result.completed).toBe(true);
    expect(result.iterations).toHaveLength(1);
    expect(callCount()).toBe(1);
    expect(result.iterations[0]!.predicateMatched).toBe(true);
  });

  it('loops until the predicate matches on iteration N', async () => {
    const { chatFn } = makeStubChat([
      'still working',
      'almost there',
      'finished. <promise>DONE</promise>',
    ]);
    const result = await runRalphCommand('write a thing', { chatFn, killFlagPath, maxIterations: 10 });
    expect(result.status).toBe('completed');
    expect(result.iterations).toHaveLength(3);
    expect(result.iterations.slice(0, 2).every((i) => !i.predicateMatched)).toBe(true);
    expect(result.iterations[2]!.predicateMatched).toBe(true);
  });

  it('stops at maxIterations with status "exhausted" when the predicate never matches', async () => {
    const { chatFn } = makeStubChat(['nope', 'still nope', 'nope again']);
    const result = await runRalphCommand('do x', { chatFn, killFlagPath, maxIterations: 3 });
    expect(result.status).toBe('exhausted');
    expect(result.completed).toBe(false);
    expect(result.iterations).toHaveLength(3);
  });

  it('respects a custom --until predicate (substring)', async () => {
    const { chatFn } = makeStubChat(['hmm', 'BUILD GREEN']);
    const result = await runRalphCommand('build it', { chatFn, killFlagPath, until: 'BUILD GREEN', maxIterations: 5 });
    expect(result.status).toBe('completed');
    expect(result.iterations).toHaveLength(2);
  });

  it('respects a /regex/ --until predicate', async () => {
    const { chatFn } = makeStubChat(['working', 'lighthouse score: 92']);
    const result = await runRalphCommand('lighthouse pass', {
      chatFn,
      killFlagPath,
      until: '/lighthouse score:\\s*9\\d/i',
      maxIterations: 5,
    });
    expect(result.status).toBe('completed');
    expect(result.iterations).toHaveLength(2);
  });

  it('halts with status "killed" when the kill flag exists at iteration start', async () => {
    await writeFile(killFlagPath, '');
    const { chatFn, callCount } = makeStubChat(['should never run']);
    const result = await runRalphCommand('do x', { chatFn, killFlagPath });
    expect(result.status).toBe('killed');
    expect(callCount()).toBe(0);
    expect(result.iterations).toHaveLength(0);
  });

  it('halts mid-loop when the kill flag appears between iterations', async () => {
    let iteration = 0;
    const chatFn: NonNullable<RalphCommandOptions['chatFn']> = async (input: ChatInput) => {
      iteration++;
      // After iteration 2, drop the kill flag — should stop before iteration 3
      if (iteration === 2) {
        await writeFile(killFlagPath, '');
      }
      return {
        text: 'not done',
        conversationId: `stub-${iteration}-uuid-here-padding-padding`,
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    // Wrap so the inoculation check still passes
    const guarded: NonNullable<RalphCommandOptions['chatFn']> = async (input: ChatInput) => {
      if (!input.system?.toLowerCase().includes('reward hacking')) {
        throw new Error('missing inoculation');
      }
      return chatFn(input);
    };
    const result = await runRalphCommand('do x', { chatFn: guarded, killFlagPath, maxIterations: 10 });
    expect(result.status).toBe('killed');
    expect(result.iterations).toHaveLength(2);
  });

  it('halts cleanly when the chat function throws a cost-cap error', async () => {
    const chatFn: NonNullable<RalphCommandOptions['chatFn']> = async (input: ChatInput) => {
      if (!input.system?.toLowerCase().includes('reward hacking')) {
        throw new Error('missing inoculation');
      }
      throw new Error('cost cap exceeded ($25 hard cap)');
    };
    const result = await runRalphCommand('expensive task', { chatFn, killFlagPath });
    expect(result.status).toBe('cost_aborted');
    expect(result.iterations).toHaveLength(0);
  });

  it('rethrows non-cost-cap errors from the chat function', async () => {
    const chatFn: NonNullable<RalphCommandOptions['chatFn']> = async (input: ChatInput) => {
      if (!input.system?.toLowerCase().includes('reward hacking')) {
        throw new Error('missing inoculation');
      }
      throw new Error('connection refused');
    };
    await expect(runRalphCommand('x', { chatFn, killFlagPath })).rejects.toThrow(/connection refused/);
  });

  it('uses the same threadId across all iterations so traces can be queried as one unit', async () => {
    const { chatFn, inputs } = makeStubChat(['nope', 'nope', 'DONE']);
    const result = await runRalphCommand('x', { chatFn, killFlagPath, until: 'DONE', maxIterations: 5 });
    expect(result.status).toBe('completed');
    const threadIds = inputs.map((i) => i.threadId);
    expect(threadIds.every((id) => id === result.threadId)).toBe(true);
    expect(result.threadId.startsWith('ralph-')).toBe(true);
  });

  it('honors a user-provided --thread', async () => {
    const { chatFn, inputs } = makeStubChat(['DONE']);
    await runRalphCommand('x', { chatFn, killFlagPath, threadId: 'frqncy-evolve' });
    expect(inputs[0]!.threadId).toBe('frqncy-evolve');
  });

  it('emits structured JSON on --json', async () => {
    const { chatFn } = makeStubChat(['DONE']);
    const result = await runRalphCommand('x', { chatFn, killFlagPath, until: 'DONE', json: true });
    const parsed = JSON.parse(stdoutBuffer.split('\n').filter(Boolean).join('\n'));
    expect(parsed.status).toBe('completed');
    expect(parsed.iterations).toHaveLength(1);
    expect(parsed.threadId).toBe(result.threadId);
  });

  it('aggregates total cost across iterations', async () => {
    const { chatFn } = makeStubChat(['nope', 'DONE']);
    const result = await runRalphCommand('x', { chatFn, killFlagPath, until: 'DONE' });
    expect(result.iterations).toHaveLength(2);
    expect(result.totalCostUsd).toBeCloseTo(0.002, 6);
  });

  it('refuses an empty prompt', async () => {
    await expect(runRalphCommand('   ', { killFlagPath })).rejects.toThrow(/Prompt is required/);
  });

  it('refuses maxIterations < 1', async () => {
    await expect(runRalphCommand('x', { killFlagPath, maxIterations: 0 })).rejects.toThrow(
      /maxIterations must be at least 1/,
    );
  });

  it('uses a continuation prompt on iterations 2+ that references the original task', async () => {
    const { chatFn, inputs } = makeStubChat(['nope', 'DONE']);
    await runRalphCommand('build the haiku page', { chatFn, killFlagPath, until: 'DONE' });
    expect(inputs[0]!.messages[0]!.content).toContain('iteration 1');
    expect(inputs[1]!.messages[0]!.content).toContain('iteration 2');
    expect(inputs[1]!.messages[0]!.content).toContain('build the haiku page');
  });

  it('records the conversationId of each iteration so reflect/codify can query them', async () => {
    const { chatFn } = makeStubChat(['nope', 'DONE']);
    const result = await runRalphCommand('x', { chatFn, killFlagPath, until: 'DONE' });
    expect(result.iterations.map((i) => i.conversationId).every((id) => id.length > 0)).toBe(true);
    expect(new Set(result.iterations.map((i) => i.conversationId)).size).toBe(2); // unique
  });
});
