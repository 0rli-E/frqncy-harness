import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runLearningAgentRun,
  isCouncilPersona,
  shouldRefusePersonaUpdate,
  formatProposalMarkdown,
  type LearningAgentSubcommandRunOptions,
} from '../src/commands/learning-agent.js';
import type { ReflectResult } from '../src/commands/reflect.js';
import type { LoadedPersona } from '../src/commands/frqncy.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('isCouncilPersona', () => {
  it('returns true for the 7 canonical Council members', () => {
    expect(isCouncilPersona('krishna')).toBe(true);
    expect(isCouncilPersona('kali')).toBe(true);
    expect(isCouncilPersona('merlin')).toBe(true);
    expect(isCouncilPersona('saraswati')).toBe(true);
    expect(isCouncilPersona('sai-maa')).toBe(true);
    expect(isCouncilPersona('gary-spivey')).toBe(true);
    expect(isCouncilPersona('kevin-trudeau')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isCouncilPersona('Kali')).toBe(true);
    expect(isCouncilPersona('KRISHNA')).toBe(true);
  });

  it('returns false for non-Council personas', () => {
    expect(isCouncilPersona('ceo')).toBe(false);
    expect(isCouncilPersona('frontend-dev')).toBe(false);
    expect(isCouncilPersona('frqncy')).toBe(false);
    expect(isCouncilPersona('learning-agent')).toBe(false);
  });
});

describe('shouldRefusePersonaUpdate', () => {
  function makePersona(slug: string, evolves: boolean | undefined = true): LoadedPersona {
    return {
      slug,
      path: `/fake/${slug}.md`,
      frontmatter: {
        name: slug,
        role: 'test',
        evolves,
      },
      body: 'test body',
    };
  }

  it('refuses any Council member by name', () => {
    const result = shouldRefusePersonaUpdate(makePersona('kali', true));
    expect(result.refused).toBe(true);
    if (result.refused) expect(result.reason).toMatch(/council/i);
  });

  it('refuses any persona with evolves: false', () => {
    const result = shouldRefusePersonaUpdate(makePersona('custom', false));
    expect(result.refused).toBe(true);
    if (result.refused) expect(result.reason).toMatch(/evolves: false/);
  });

  it('allows non-Council personas with evolves: true', () => {
    expect(shouldRefusePersonaUpdate(makePersona('ceo', true)).refused).toBe(false);
    expect(shouldRefusePersonaUpdate(makePersona('frontend-dev', true)).refused).toBe(false);
  });

  it('allows non-Council personas where evolves is undefined (defaults to allowed)', () => {
    expect(shouldRefusePersonaUpdate(makePersona('new-worker', undefined)).refused).toBe(false);
  });
});

describe('formatProposalMarkdown', () => {
  const args = {
    personaSlug: 'ceo',
    reflectionPath: '/proj/proposals/reflection-2026-04-29.md',
    reflectionMarkdown: '## Recurring failure modes\n\n### 1. CEO drifts to corporate-speak',
    tracesAnalyzed: 12,
    generatedAt: '2026-04-29T12:00:00.000Z',
  };

  it('includes all source metadata', () => {
    const out = formatProposalMarkdown(args);
    expect(out).toContain('# Learning Agent proposal — ceo');
    expect(out).toContain('frqncy-os/.../ceo.md');
    expect(out).toContain('reflection-2026-04-29.md');
    expect(out).toContain('Traces analyzed: 12');
    expect(out).toContain('2026-04-29T12:00:00.000Z');
  });

  it('embeds the reflection synthesis verbatim', () => {
    const out = formatProposalMarkdown(args);
    expect(out).toContain('CEO drifts to corporate-speak');
  });

  it('cites the Anthropic reward-hacking paper', () => {
    const out = formatProposalMarkdown(args);
    expect(out).toMatch(/2511\.18397/);
  });

  it('explicitly states no prompt change has been applied', () => {
    const out = formatProposalMarkdown(args);
    expect(out.toLowerCase()).toMatch(/no prompt change applied yet/);
  });

  it('shows next-step commands the operator can run verbatim', () => {
    const out = formatProposalMarkdown(args);
    expect(out).toContain('frqncy-harness eval-three-arm ceo');
    expect(out).toContain('learning-agent run --persona ceo --apply --auto-pr');
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests
// ────────────────────────────────────────────────────────────────────

describe('runLearningAgentRun', () => {
  let cwd: string;
  let stdoutBuffer: string;
  let stderrBuffer: string;
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'learning-agent-test-'));
    stdoutBuffer = '';
    stderrBuffer = '';
    originalStdout = process.stdout.write.bind(process.stdout);
    originalStderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    await rm(cwd, { recursive: true, force: true });
  });

  function makeReflectStub(result: ReflectResult): NonNullable<LearningAgentSubcommandRunOptions['reflectFn']> {
    return async () => result;
  }

  function makeReflectFailureStub(message: string): NonNullable<LearningAgentSubcommandRunOptions['reflectFn']> {
    return async () => {
      throw new Error(message);
    };
  }

  function makePersonaLoaderStub(personas: Record<string, LoadedPersona | null>): NonNullable<LearningAgentSubcommandRunOptions['loadPersonaFn']> {
    return async (slug: string) => personas[slug] ?? null;
  }

  function makeReflectResult(overrides: Partial<ReflectResult> = {}): ReflectResult {
    return {
      tracesAnalyzed: 5,
      tracesFailed: 3,
      outputPath: join(cwd, 'proposals/reflection-2026-04-29.md'),
      proposalMarkdown: '## Recurring failure modes\n\n### 1. Sample drift',
      written: true,
      filter: { last: 30, since: '7d', includeSuccess: false },
      ...overrides,
    };
  }

  // Council refusal ──────────────────────────────────────────

  it('refuses to process a Council persona explicitly named via --persona', async () => {
    const result = await runLearningAgentRun({
      cwd,
      persona: 'kali',
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({
        kali: { slug: 'kali', path: '/fake', frontmatter: { name: 'Kali', role: 'council', evolves: false }, body: 'b' },
      }),
      json: true,
    });
    expect(result.status).toBe('council_refused');
    expect(result.personasRefused).toContain('kali');
    expect(result.proposals).toHaveLength(0);
  });

  it('refuses any persona whose evolves: false (defensive belt + suspenders)', async () => {
    const result = await runLearningAgentRun({
      cwd,
      persona: 'custom-fixed-persona',
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({
        'custom-fixed-persona': {
          slug: 'custom-fixed-persona',
          path: '/fake',
          frontmatter: { name: 'Custom', role: 'fixed', evolves: false },
          body: 'b',
        },
      }),
      json: true,
    });
    expect(result.status).toBe('council_refused'); // hard-rule status
    expect(result.personasRefused).toContain('custom-fixed-persona');
  });

  it('returns persona_not_found when --persona references a missing file', async () => {
    const result = await runLearningAgentRun({
      cwd,
      persona: 'nonexistent',
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(result.status).toBe('persona_not_found');
  });

  // Happy path ───────────────────────────────────────────────

  it('generates a dry-run proposal by default (does not write)', async () => {
    const result = await runLearningAgentRun({
      cwd,
      persona: 'ceo',
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({
        ceo: { slug: 'ceo', path: '/fake', frontmatter: { name: 'CEO', role: 'ops', evolves: true }, body: 'b' },
      }),
      json: true,
    });
    expect(result.status).toBe('completed');
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.written).toBe(false);
    // Proposal file should NOT exist on disk
    await expect(access(result.proposals[0]!.proposalPath)).rejects.toThrow();
  });

  it('writes the proposal when --apply is set', async () => {
    const result = await runLearningAgentRun({
      cwd,
      persona: 'ceo',
      apply: true,
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({
        ceo: { slug: 'ceo', path: '/fake', frontmatter: { name: 'CEO', role: 'ops', evolves: true }, body: 'b' },
      }),
      json: true,
    });
    expect(result.proposals[0]!.written).toBe(true);
    const written = await readFile(result.proposals[0]!.proposalPath, 'utf-8');
    expect(written).toContain('# Learning Agent proposal — ceo');
    expect(written).toContain('Sample drift');
  });

  it('processes the whole frqncy-os project when --persona is unset', async () => {
    let capturedThreadId = '';
    const reflectFn: NonNullable<LearningAgentSubcommandRunOptions['reflectFn']> = async (opts) => {
      capturedThreadId = opts?.threadId ?? '';
      return makeReflectResult();
    };
    const result = await runLearningAgentRun({
      cwd,
      reflectFn,
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(result.status).toBe('completed');
    expect(capturedThreadId).toBe(''); // no thread filter when targeting whole project
    expect(result.proposals[0]!.persona).toBe('frqncy-os');
  });

  it('passes thread=frqncy-os/<persona> to reflect when --persona is set', async () => {
    let capturedThreadId = '';
    const reflectFn: NonNullable<LearningAgentSubcommandRunOptions['reflectFn']> = async (opts) => {
      capturedThreadId = opts?.threadId ?? '';
      return makeReflectResult();
    };
    await runLearningAgentRun({
      cwd,
      persona: 'ceo',
      reflectFn,
      loadPersonaFn: makePersonaLoaderStub({
        ceo: { slug: 'ceo', path: '/fake', frontmatter: { name: 'CEO', role: 'ops', evolves: true }, body: 'b' },
      }),
      json: true,
    });
    expect(capturedThreadId).toBe('frqncy-os/ceo');
  });

  it('always passes project=frqncy-os to reflect', async () => {
    let capturedProjectId = '';
    const reflectFn: NonNullable<LearningAgentSubcommandRunOptions['reflectFn']> = async (opts) => {
      capturedProjectId = opts?.projectId ?? '';
      return makeReflectResult();
    };
    await runLearningAgentRun({
      cwd,
      reflectFn,
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(capturedProjectId).toBe('frqncy-os');
  });

  it('honors --since and --last passed through to reflect', async () => {
    let captured: { since?: string; last?: number } = {};
    const reflectFn: NonNullable<LearningAgentSubcommandRunOptions['reflectFn']> = async (opts) => {
      captured = { ...(opts?.since ? { since: opts.since } : {}), ...(opts?.last ? { last: opts.last } : {}) };
      return makeReflectResult();
    };
    await runLearningAgentRun({
      cwd,
      since: '30d',
      last: 100,
      reflectFn,
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(captured.since).toBe('30d');
    expect(captured.last).toBe(100);
  });

  // No-traces handling ───────────────────────────────────────

  it('returns no_traces gracefully when reflect throws "no traces match the filter"', async () => {
    const result = await runLearningAgentRun({
      cwd,
      reflectFn: makeReflectFailureStub('no traces match the filter (...)'),
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(result.status).toBe('no_traces');
    expect(result.proposals).toHaveLength(0);
  });

  it('returns no_traces gracefully when reflect throws "no failed traces"', async () => {
    const result = await runLearningAgentRun({
      cwd,
      reflectFn: makeReflectFailureStub('no failed traces in the matching window'),
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(result.status).toBe('no_traces');
  });

  it('rethrows non-recoverable errors from reflect', async () => {
    await expect(
      runLearningAgentRun({
        cwd,
        reflectFn: makeReflectFailureStub('cost cap exceeded'),
        loadPersonaFn: makePersonaLoaderStub({}),
      }),
    ).rejects.toThrow(/cost cap/);
  });

  // Output formatting ────────────────────────────────────────

  it('emits structured JSON on --json', async () => {
    await runLearningAgentRun({
      cwd,
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.status).toBe('completed');
    expect(parsed.proposals).toHaveLength(1);
  });

  it('writes to proposals/learning-agent/ subdirectory by default', async () => {
    const result = await runLearningAgentRun({
      cwd,
      apply: true,
      reflectFn: makeReflectStub(makeReflectResult()),
      loadPersonaFn: makePersonaLoaderStub({}),
      json: true,
    });
    expect(result.proposals[0]!.proposalPath).toContain('proposals/learning-agent/');
  });
});
