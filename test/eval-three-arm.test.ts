import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runEvalThreeArmCommand,
  scoreFixture,
  loadFixtures,
  type EvalThreeArmCommandOptions,
  type EvalFixture,
} from '../src/commands/eval-three-arm.js';
import type { ChatInput, ChatResult } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('scoreFixture', () => {
  it('passes when expected_contains is found', () => {
    expect(scoreFixture({ prompt: 'x', expected_contains: 'hello' }, 'hello world')).toBe(true);
    expect(scoreFixture({ prompt: 'x', expected_contains: 'hello' }, 'goodbye')).toBe(false);
  });

  it('passes when expected_match regex matches', () => {
    expect(scoreFixture({ prompt: 'x', expected_match: '\\d+' }, 'value: 42')).toBe(true);
    expect(scoreFixture({ prompt: 'x', expected_match: '\\d+' }, 'no numbers')).toBe(false);
  });

  it('fails when any banned phrase is present (case-insensitive)', () => {
    const fixture = { prompt: 'x', banned_phrases: ['unlock', 'synergy'] };
    expect(scoreFixture(fixture, 'unleash the synergy')).toBe(false);
    expect(scoreFixture(fixture, 'UNLOCK the value')).toBe(false);
    expect(scoreFixture(fixture, 'a clean response')).toBe(true);
  });

  it('combines criteria — all must pass', () => {
    const fixture = {
      prompt: 'x',
      expected_contains: 'value',
      banned_phrases: ['unlock'],
    };
    expect(scoreFixture(fixture, 'value created')).toBe(true);
    expect(scoreFixture(fixture, 'unlock the value')).toBe(false); // banned phrase
    expect(scoreFixture(fixture, 'something else')).toBe(false); // missing expected_contains
  });

  it('returns true when no scoring criteria are provided (auto-pass on malformed fixtures)', () => {
    expect(scoreFixture({ prompt: 'x' }, 'any text')).toBe(true);
  });

  it('does not crash on malformed regex — returns false', () => {
    expect(scoreFixture({ prompt: 'x', expected_match: '[unclosed' }, 'anything')).toBe(false);
  });
});

describe('loadFixtures', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'eval-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty when the file does not exist', async () => {
    expect(await loadFixtures(join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('parses one fixture per line', async () => {
    const path = join(dir, 'fix.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({ prompt: 'p1', expected_contains: 'ok' }),
        JSON.stringify({ prompt: 'p2', banned_phrases: ['bad'] }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const fixtures = await loadFixtures(path);
    expect(fixtures).toHaveLength(2);
    expect(fixtures[0]!.prompt).toBe('p1');
    expect(fixtures[1]!.banned_phrases).toEqual(['bad']);
  });

  it('skips malformed lines + lines with no prompt', async () => {
    const path = join(dir, 'fix.jsonl');
    await writeFile(
      path,
      [
        JSON.stringify({ prompt: 'good' }),
        'not-json',
        JSON.stringify({ no_prompt: true }),
        '',
        JSON.stringify({ prompt: 'also good' }),
      ].join('\n'),
      'utf-8',
    );
    const fixtures = await loadFixtures(path);
    expect(fixtures).toHaveLength(2);
    expect(fixtures.map((f) => f.prompt)).toEqual(['good', 'also good']);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests
// ────────────────────────────────────────────────────────────────────

describe('runEvalThreeArmCommand', () => {
  let cwd: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'eval-3arm-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(cwd, { recursive: true, force: true });
  });

  async function seedDataset(fixtures: EvalFixture[]): Promise<string> {
    const datasetPath = join(cwd, 'fixtures.jsonl');
    await writeFile(datasetPath, fixtures.map((f) => JSON.stringify(f)).join('\n') + '\n', 'utf-8');
    return datasetPath;
  }

  /**
   * Make a chat stub where the response depends on the system prompt.
   * - If system contains the SKILL marker, return `skillResponse`
   * - Else if system contains the GENERIC marker, return `genericResponse`
   * - Else return `baselineResponse`
   */
  function makeStubChat(opts: {
    skillResponse: string;
    genericResponse: string;
    baselineResponse: string;
    skillMarker?: string;
    genericMarker?: string;
  }): NonNullable<EvalThreeArmCommandOptions['chatFn']> {
    const skillMarker = opts.skillMarker ?? 'SKILL_BODY_HERE';
    const genericMarker = opts.genericMarker ?? 'Answer concisely';
    return async (input: ChatInput): Promise<ChatResult> => {
      if (!input.system?.toLowerCase().includes('reward hacking')) {
        throw new Error('eval-three-arm chat invocation missing inoculation sentence');
      }
      const system = input.system ?? '';
      const text = system.includes(skillMarker)
        ? opts.skillResponse
        : system.includes(genericMarker)
          ? opts.genericResponse
          : opts.baselineResponse;
      return {
        text,
        conversationId: 'stub',
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  const skillBodyStub = async (skillName: string): Promise<string | null> =>
    skillName === 'real-skill' ? 'SKILL_BODY_HERE: this is the skill content' : null;

  it('runs three arms across all fixtures and counts passes per arm', async () => {
    await seedDataset([
      { prompt: 'p1', expected_contains: 'GOOD' },
      { prompt: 'p2', expected_contains: 'GOOD' },
    ]);
    const chatFn = makeStubChat({
      baselineResponse: 'BAD',
      genericResponse: 'BAD',
      skillResponse: 'GOOD',
    });
    const result = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      json: true,
    });
    expect(result.fixtures).toBe(2);
    expect(result.arms.baseline.passed).toBe(0);
    expect(result.arms.generic.passed).toBe(0);
    expect(result.arms.skill.passed).toBe(2);
    expect(result.arms.skill.passRate).toBe(1);
  });

  it('computes positive lift when the skill outperforms the generic modifier', async () => {
    await seedDataset([
      { prompt: 'p1', expected_contains: 'SKILL_OK' },
      { prompt: 'p2', expected_contains: 'SKILL_OK' },
      { prompt: 'p3', expected_contains: 'SKILL_OK' },
      { prompt: 'p4', expected_contains: 'SKILL_OK' },
    ]);
    const chatFn = makeStubChat({
      baselineResponse: 'plain',
      genericResponse: 'plain',
      skillResponse: 'SKILL_OK output',
    });
    const result = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      json: true,
    });
    expect(result.liftSkillOverBaselinePp).toBe(100); // 100% pass rate vs 0%
    expect(result.liftSkillOverGenericPp).toBe(100);
    expect(result.passedThreshold).toBe(true);
  });

  it('flags the skill as failing when its lift is not separable from the generic modifier', async () => {
    await seedDataset([
      { prompt: 'p1', banned_phrases: ['BAD'] },
      { prompt: 'p2', banned_phrases: ['BAD'] },
    ]);
    // Both generic AND skill produce clean output; baseline produces "BAD"
    const chatFn = makeStubChat({
      baselineResponse: 'BAD verbose',
      genericResponse: 'clean',
      skillResponse: 'clean',
    });
    const result = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      json: true,
    });
    // skill and generic both pass at 100%; lift = 0pp; below threshold (default 5pp)
    expect(result.liftSkillOverGenericPp).toBe(0);
    expect(result.passedThreshold).toBe(false);
  });

  it('honors --lift-threshold to make the gate stricter or looser', async () => {
    await seedDataset([
      { prompt: 'p1', expected_contains: 'SKILL_OK' },
    ]);
    const chatFn = makeStubChat({
      baselineResponse: 'plain',
      genericResponse: 'plain',
      skillResponse: 'SKILL_OK output',
    });
    const r1 = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      liftThreshold: 0,
      json: true,
    });
    expect(r1.passedThreshold).toBe(true);
    const r2 = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      liftThreshold: 200, // impossible threshold
      json: true,
    });
    expect(r2.passedThreshold).toBe(false);
  });

  it('throws when the skill is not found', async () => {
    await seedDataset([{ prompt: 'p1' }]);
    await expect(
      runEvalThreeArmCommand('nonexistent', {
        cwd,
        dataset: 'fixtures.jsonl',
        chatFn: makeStubChat({ baselineResponse: 'a', genericResponse: 'b', skillResponse: 'c' }),
        resolveSkillBodyFn: skillBodyStub,
      }),
    ).rejects.toThrow(/not found/);
  });

  it('throws when the dataset is empty or missing', async () => {
    await expect(
      runEvalThreeArmCommand('real-skill', {
        cwd,
        dataset: 'missing.jsonl',
        chatFn: makeStubChat({ baselineResponse: 'a', genericResponse: 'b', skillResponse: 'c' }),
        resolveSkillBodyFn: skillBodyStub,
      }),
    ).rejects.toThrow(/no fixtures found/);
  });

  it('runs each fixture once per arm (3 chat calls per fixture)', async () => {
    await seedDataset([{ prompt: 'p1' }, { prompt: 'p2' }]);
    let callCount = 0;
    const chatFn: NonNullable<EvalThreeArmCommandOptions['chatFn']> = async (input: ChatInput) => {
      if (!input.system?.toLowerCase().includes('reward hacking')) throw new Error('missing inoculation');
      callCount += 1;
      return {
        text: 'ok',
        conversationId: 'stub',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      json: true,
    });
    expect(callCount).toBe(2 * 3); // 2 fixtures × 3 arms
  });

  it('aggregates total cost across all arms × all fixtures', async () => {
    await seedDataset([{ prompt: 'p1' }, { prompt: 'p2' }, { prompt: 'p3' }]);
    const chatFn = makeStubChat({
      baselineResponse: 'a',
      genericResponse: 'b',
      skillResponse: 'c',
    });
    const result = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      json: true,
    });
    // 3 fixtures × 3 arms × $0.001 = $0.009
    expect(result.totalCostUsd).toBeCloseTo(0.009, 6);
  });

  it('emits structured JSON on --json', async () => {
    await seedDataset([{ prompt: 'p1' }]);
    await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      json: true,
      chatFn: makeStubChat({ baselineResponse: 'a', genericResponse: 'b', skillResponse: 'c' }),
      resolveSkillBodyFn: skillBodyStub,
    });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.skillName).toBe('real-skill');
    expect(parsed.fixtures).toBe(1);
    expect(parsed.arms.skill.total).toBe(1);
  });

  it('records each fixture run with all three arm responses', async () => {
    await seedDataset([{ prompt: 'p1', label: 'first', expected_contains: 'ok' }]);
    const chatFn = makeStubChat({
      baselineResponse: 'baseline-text',
      genericResponse: 'generic-text',
      skillResponse: 'ok skill-text',
    });
    const result = await runEvalThreeArmCommand('real-skill', {
      cwd,
      dataset: 'fixtures.jsonl',
      chatFn,
      resolveSkillBodyFn: skillBodyStub,
      json: true,
    });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]!.fixtureLabel).toBe('first');
    expect(result.runs[0]!.baselineText).toBe('baseline-text');
    expect(result.runs[0]!.genericText).toBe('generic-text');
    expect(result.runs[0]!.skillText).toBe('ok skill-text');
    expect(result.runs[0]!.skillPassed).toBe(true);
  });
});
