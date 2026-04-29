import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runFrqncyCommand,
  parsePersonaFile,
  defaultLoadPersona,
  listPersonas,
  parseRoutingDecision,
  buildSynthesisPrompt,
  formatCouncilDeliberation,
  generateDeliberationSlug,
  listPersonasGrouped,
  runFrqncyListCommand,
  validateFrqncyOs,
  runFrqncyValidateCommand,
  extractFirstParentSlug,
  PERSONA_INOCULATION_INVARIANT,
  inspectPersona,
  runFrqncyShowCommand,
  runFrqncyHistoryCommand,
  parseDeliberation,
  loadDeliberations,
  runFrqncyDeliberationsCommand,
  runFrqncyDeliberationCommand,
  summarizeDeliberation,
  buildReflectionPrompt,
  runFrqncyReflectCommand,
  REFLECT_SYSTEM_PROMPT,
  DEFAULT_REFLECTIONS_DIR,
  parseReflection,
  loadReflections,
  runFrqncyReflectionsCommand,
  runFrqncyActionsCommand,
  ROUTING_INSTRUCTIONS,
  SYNTHESIS_INSTRUCTIONS,
  COUNCIL_MEMBERS,
  DEFAULT_PERSONA_DIR,
  DEFAULT_FRQNCY_PERSONA,
  type FrqncyCommandOptions,
  type LoadedPersona,
  type RoutingDecision,
} from '../src/commands/frqncy.js';
import { readFile, access } from 'node:fs/promises';
import type { ChatInput, ChatResult } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('parsePersonaFile', () => {
  it('parses frontmatter + body', () => {
    const raw = `---\nname: Krishna\nrole: Council member\nmodel: anthropic/claude-opus-4-6\nveto_authority: true\nevolves: false\n---\n\nYou are Krishna.\n\nBody text.\n`;
    const { frontmatter, body } = parsePersonaFile(raw);
    expect(frontmatter.name).toBe('Krishna');
    expect(frontmatter.role).toBe('Council member');
    expect(frontmatter.model).toBe('anthropic/claude-opus-4-6');
    expect(frontmatter.veto_authority).toBe(true);
    expect(frontmatter.evolves).toBe(false);
    expect(body).toContain('You are Krishna.');
    expect(body).toContain('Body text.');
  });

  it('strips quoted scalar values', () => {
    const raw = `---\nname: "FRQNCY"\nrole: 'router'\n---\nbody`;
    const { frontmatter } = parsePersonaFile(raw);
    expect(frontmatter.name).toBe('FRQNCY');
    expect(frontmatter.role).toBe('router');
  });

  it('returns empty frontmatter when no fence is present', () => {
    const raw = '# Just a markdown file\n\nbody';
    const { frontmatter, body } = parsePersonaFile(raw);
    expect(frontmatter.name).toBe('');
    expect(body).toContain('# Just a markdown file');
  });

  it('returns empty frontmatter when closing fence is missing', () => {
    const raw = `---\nname: incomplete\nno close\nbody`;
    const { frontmatter, body } = parsePersonaFile(raw);
    expect(frontmatter.name).toBe('');
    expect(body).toContain('no close');
  });

  it('coerces veto_authority and evolves to booleans', () => {
    expect(parsePersonaFile(`---\nveto_authority: true\nevolves: false\n---\nx`).frontmatter.veto_authority).toBe(true);
    expect(parsePersonaFile(`---\nveto_authority: false\nevolves: true\n---\nx`).frontmatter.veto_authority).toBe(false);
  });
});

describe('defaultLoadPersona + listPersonas', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-personas-'));
    await mkdir(join(dir, 'council'), { recursive: true });
    await mkdir(join(dir, 'c-suite'), { recursive: true });
    await mkdir(join(dir, 'workers'), { recursive: true });
    await writeFile(join(dir, 'frqncy.md'), `---\nname: FRQNCY\nrole: router\n---\nbody-frqncy`, 'utf-8');
    await writeFile(join(dir, 'council', 'kali.md'), `---\nname: Kali\nrole: council\nveto_authority: true\nevolves: false\n---\nbody-kali`, 'utf-8');
    await writeFile(join(dir, 'c-suite', 'ceo.md'), `---\nname: CEO\nrole: ops\n---\nbody-ceo`, 'utf-8');
    await writeFile(join(dir, 'workers', 'frontend-dev.md'), `---\nname: Frontend Dev\nrole: ui\n---\nbody-fe`, 'utf-8');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds personas at the root level', async () => {
    const loaded = await defaultLoadPersona('frqncy', dir);
    expect(loaded?.frontmatter.name).toBe('FRQNCY');
    expect(loaded?.body).toBe('body-frqncy');
  });

  it('finds personas in the council subdirectory', async () => {
    const loaded = await defaultLoadPersona('kali', dir);
    expect(loaded?.frontmatter.name).toBe('Kali');
    expect(loaded?.frontmatter.veto_authority).toBe(true);
  });

  it('finds personas in the c-suite subdirectory', async () => {
    const loaded = await defaultLoadPersona('ceo', dir);
    expect(loaded?.frontmatter.name).toBe('CEO');
  });

  it('finds personas in the workers subdirectory', async () => {
    const loaded = await defaultLoadPersona('frontend-dev', dir);
    expect(loaded?.frontmatter.name).toBe('Frontend Dev');
  });

  it('returns null when not found anywhere', async () => {
    expect(await defaultLoadPersona('nonexistent', dir)).toBeNull();
  });

  it('lists all personas across subdirectories, sorted', async () => {
    const slugs = await listPersonas(dir);
    expect(slugs).toContain('frqncy');
    expect(slugs).toContain('kali');
    expect(slugs).toContain('ceo');
    expect(slugs).toContain('frontend-dev');
    // sorted
    const sorted = [...slugs].sort();
    expect(slugs).toEqual(sorted);
  });
});

describe('COUNCIL_MEMBERS constant', () => {
  it('has exactly 7 members', () => {
    expect(COUNCIL_MEMBERS).toHaveLength(7);
  });

  it('includes the canonical roster', () => {
    expect(COUNCIL_MEMBERS).toContain('krishna');
    expect(COUNCIL_MEMBERS).toContain('kali');
    expect(COUNCIL_MEMBERS).toContain('merlin');
    expect(COUNCIL_MEMBERS).toContain('saraswati');
    expect(COUNCIL_MEMBERS).toContain('sai-maa');
    expect(COUNCIL_MEMBERS).toContain('gary-spivey');
    expect(COUNCIL_MEMBERS).toContain('kevin-trudeau');
  });

  it('exports DEFAULT_PERSONA_DIR + DEFAULT_FRQNCY_PERSONA', () => {
    expect(DEFAULT_PERSONA_DIR).toBe('frqncy-os');
    expect(DEFAULT_FRQNCY_PERSONA).toBe('frqncy');
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests
// ────────────────────────────────────────────────────────────────────

describe('runFrqncyCommand', () => {
  let cwd: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'frqncy-test-'));
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

  function makePersona(slug: string, overrides: { name?: string; model?: string; body?: string } = {}): LoadedPersona {
    return {
      slug,
      path: `/fake/${slug}.md`,
      frontmatter: {
        name: overrides.name ?? slug,
        role: 'test',
        ...(overrides.model ? { model: overrides.model } : {}),
      },
      body: overrides.body ?? `you are ${slug}. reward hacking is disallowed.`,
    };
  }

  function makeStubChat(responseFn: (slug: string) => string): NonNullable<FrqncyCommandOptions['chatFn']> {
    return async (input: ChatInput): Promise<ChatResult> => {
      // Each persona's threadId is `frqncy-os/<slug>` — we extract the slug for the response stub
      const slug = input.threadId?.replace(/^frqncy-os\//, '') ?? 'unknown';
      return {
        text: responseFn(slug),
        conversationId: `stub-${slug}-conv`,
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.005 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  function makeLoaderStub(personas: Record<string, LoadedPersona | null>): NonNullable<FrqncyCommandOptions['loadPersonaFn']> {
    return async (slug: string) => personas[slug] ?? null;
  }

  // Mode 1: --no-route (v0.11 behavior — FRQNCY responds in own voice, no routing) ──

  it('--no-route invokes the FRQNCY persona once and returns its response unmodified', async () => {
    const result = await runFrqncyCommand('what should I do', {
      cwd,
      noRoute: true,
      chatFn: makeStubChat((s) => `frqncy says: do this`),
      loadPersonaFn: makeLoaderStub({ frqncy: makePersona('frqncy', { name: 'FRQNCY' }) }),
      json: true,
    });
    expect(result.mode).toBe('direct');
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]!.persona).toBe('FRQNCY');
    expect(result.responses[0]!.text).toBe('frqncy says: do this');
  });

  it('default mode (auto) falls back to FRQNCY persona when routing decision is unparseable', async () => {
    const result = await runFrqncyCommand('what should I do', {
      cwd,
      // FRQNCY emits no [ROUTE] line — fallback returns the response as-is
      chatFn: makeStubChat(() => `frqncy says: do this`),
      loadPersonaFn: makeLoaderStub({ frqncy: makePersona('frqncy', { name: 'FRQNCY' }) }),
      json: true,
    });
    expect(result.mode).toBe('auto');
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]!.persona).toBe('FRQNCY');
    expect(result.routingDecision).toBeUndefined();
  });

  // Mode 2: --persona ────────────────────────────────────────────

  it('--persona invokes the named persona directly', async () => {
    const result = await runFrqncyCommand('what should I do', {
      cwd,
      persona: 'kali',
      chatFn: makeStubChat(() => 'kali speaks'),
      loadPersonaFn: makeLoaderStub({ kali: makePersona('kali', { name: 'Kali' }) }),
      json: true,
    });
    expect(result.mode).toBe('persona');
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]!.persona).toBe('Kali');
  });

  it('--persona uses the persona\'s frontmatter model when set', async () => {
    let observedModel = '';
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      observedModel = input.model;
      return {
        text: 'ok',
        conversationId: 'x',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      chatFn,
      loadPersonaFn: makeLoaderStub({ kali: makePersona('kali', { model: 'anthropic/claude-opus-4-6' }) }),
      json: true,
    });
    expect(observedModel).toBe('anthropic/claude-opus-4-6');
  });

  it('--model overrides the persona\'s frontmatter model', async () => {
    let observedModel = '';
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      observedModel = input.model;
      return {
        text: 'ok',
        conversationId: 'x',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      model: 'claude-code/sonnet',
      chatFn,
      loadPersonaFn: makeLoaderStub({ kali: makePersona('kali', { model: 'anthropic/claude-opus-4-6' }) }),
      json: true,
    });
    expect(observedModel).toBe('claude-code/sonnet');
  });

  // Mode 3: --council ────────────────────────────────────────────

  it('--council invokes all 7 Council members in parallel', async () => {
    const personas: Record<string, LoadedPersona> = {};
    for (const slug of COUNCIL_MEMBERS) personas[slug] = makePersona(slug);
    const result = await runFrqncyCommand('what would the Council say', {
      cwd,
      council: true,
      chatFn: makeStubChat((s) => `${s} response`),
      loadPersonaFn: makeLoaderStub(personas),
      json: true,
    });
    expect(result.mode).toBe('council');
    expect(result.responses).toHaveLength(7);
    const personaNames = result.responses.map((r) => r.persona);
    for (const member of COUNCIL_MEMBERS) {
      expect(personaNames).toContain(member);
    }
  });

  it('--council aggregates total cost across all 7 invocations', async () => {
    const personas: Record<string, LoadedPersona> = {};
    for (const slug of COUNCIL_MEMBERS) personas[slug] = makePersona(slug);
    const result = await runFrqncyCommand('q', {
      cwd,
      council: true,
      chatFn: makeStubChat(() => 'response'),
      loadPersonaFn: makeLoaderStub(personas),
      json: true,
    });
    // 7 personas × $0.005 stub cost = $0.035
    expect(result.totalCostUsd).toBeCloseTo(0.035, 6);
  });

  // Errors ────────────────────────────────────────────────────────

  it('throws when --persona and --council are combined', async () => {
    await expect(
      runFrqncyCommand('q', {
        cwd,
        persona: 'kali',
        council: true,
        chatFn: makeStubChat(() => 'x'),
        loadPersonaFn: makeLoaderStub({}),
      }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('throws when prompt is empty', async () => {
    await expect(runFrqncyCommand('   ', { cwd })).rejects.toThrow(/Prompt is required/);
  });

  it('throws when the named persona is not found', async () => {
    await expect(
      runFrqncyCommand('q', {
        cwd,
        persona: 'nonexistent',
        chatFn: makeStubChat(() => 'x'),
        loadPersonaFn: makeLoaderStub({}),
      }),
    ).rejects.toThrow(/persona "nonexistent" not found/);
  });

  it('throws when any council member is missing (fail-fast)', async () => {
    const incomplete: Record<string, LoadedPersona | null> = {};
    for (const slug of COUNCIL_MEMBERS) incomplete[slug] = makePersona(slug);
    incomplete['kali'] = null; // pretend kali is missing
    await expect(
      runFrqncyCommand('q', {
        cwd,
        council: true,
        chatFn: makeStubChat(() => 'x'),
        loadPersonaFn: makeLoaderStub(incomplete),
      }),
    ).rejects.toThrow(/persona "kali" not found/);
  });

  // Trace tagging ─────────────────────────────────────────────────

  it('tags each invocation with thread=frqncy-os/<persona> and project=frqncy-os', async () => {
    let capturedThread = '';
    let capturedProject = '';
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      capturedThread = input.threadId ?? '';
      capturedProject = input.projectId ?? '';
      return {
        text: 'x',
        conversationId: 'x',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      chatFn,
      loadPersonaFn: makeLoaderStub({ kali: makePersona('kali') }),
      json: true,
    });
    expect(capturedThread).toBe('frqncy-os/kali');
    expect(capturedProject).toBe('frqncy-os');
  });

  it('uses each persona body as the system prompt verbatim', async () => {
    let capturedSystem = '';
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      capturedSystem = input.system ?? '';
      return {
        text: 'x',
        conversationId: 'x',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    const personaBody = 'you are kali. reward hacking is disallowed.';
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      chatFn,
      loadPersonaFn: makeLoaderStub({ kali: makePersona('kali', { body: personaBody }) }),
      json: true,
    });
    expect(capturedSystem).toBe(personaBody);
  });

  it('emits structured JSON on --json', async () => {
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      json: true,
      chatFn: makeStubChat(() => 'x'),
      loadPersonaFn: makeLoaderStub({ kali: makePersona('kali') }),
    });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.mode).toBe('persona');
    expect(parsed.responses).toHaveLength(1);
  });

  // ── Auto-routing: direct ──────────────────────────────────────

  it('auto mode: action=direct returns FRQNCY\'s self-answer with the routing decision attached', async () => {
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      // FRQNCY (routing pass) emits a direct decision
      return {
        text: '[ROUTE]: {"action":"direct","response":"my direct answer"}',
        conversationId: 'route-conv',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    const result = await runFrqncyCommand('a small question', {
      cwd,
      chatFn,
      loadPersonaFn: makeLoaderStub({ frqncy: makePersona('frqncy', { name: 'FRQNCY' }) }),
      json: true,
    });
    expect(result.mode).toBe('auto');
    expect(result.routingDecision?.action).toBe('direct');
    expect(result.responses).toHaveLength(1);
    expect(result.responses[0]!.text).toBe('my direct answer');
  });

  // ── Auto-routing: single ──────────────────────────────────────

  it('auto mode: action=single routes to one persona and returns their response', async () => {
    let callCount = 0;
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      callCount++;
      const text =
        callCount === 1
          ? '[ROUTE]: {"action":"single","persona":"kali","reason":"old pattern needs to die"}'
          : 'kali responds';
      return {
        text,
        conversationId: `conv-${callCount}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.005 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    const result = await runFrqncyCommand('this old project keeps coming back', {
      cwd,
      chatFn,
      loadPersonaFn: makeLoaderStub({
        frqncy: makePersona('frqncy', { name: 'FRQNCY' }),
        kali: makePersona('kali', { name: 'Kali' }),
      }),
      json: true,
    });
    expect(result.mode).toBe('auto');
    expect(result.routingDecision?.action).toBe('single');
    expect(callCount).toBe(2); // 1 routing pass + 1 persona invocation
    expect(result.responses).toHaveLength(2);
    expect(result.responses[1]!.persona).toBe('Kali');
    expect(result.responses[1]!.text).toBe('kali responds');
  });

  // ── Auto-routing: multi with synthesis ────────────────────────

  it('auto mode: action=multi invokes personas in parallel then calls FRQNCY to synthesize', async () => {
    let callCount = 0;
    const seen: { system?: string; threadId?: string; text: string }[] = [];
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      callCount++;
      let text: string;
      if (callCount === 1) {
        text = '[ROUTE]: {"action":"multi","personas":["sai-maa","ceo"],"reason":"ground first then move"}';
      } else if (callCount === 2 || callCount === 3) {
        text = `${input.threadId} responds`;
      } else {
        text = 'synthesized response';
      }
      seen.push({
        ...(input.system ? { system: input.system } : {}),
        ...(input.threadId ? { threadId: input.threadId } : {}),
        text,
      });
      return {
        text,
        conversationId: `conv-${callCount}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.01 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    const result = await runFrqncyCommand('I need a read on whether to take Lugano', {
      cwd,
      chatFn,
      loadPersonaFn: makeLoaderStub({
        frqncy: makePersona('frqncy', { name: 'FRQNCY' }),
        'sai-maa': makePersona('sai-maa', { name: 'Sai Maa' }),
        ceo: makePersona('ceo', { name: 'CEO' }),
      }),
      json: true,
    });
    expect(result.mode).toBe('auto');
    expect(result.routingDecision?.action).toBe('multi');
    expect(callCount).toBe(4); // 1 routing + 2 personas + 1 synthesis
    expect(result.responses).toHaveLength(4);
    expect(result.synthesisText).toBe('synthesized response');
    // The first call (routing) should include ROUTING_INSTRUCTIONS in system; the last call (synthesis) should include SYNTHESIS_INSTRUCTIONS
    expect(seen[0]!.system).toContain('Routing protocol');
    expect(seen[3]!.system).toContain('Synthesis');
  });

  it('auto mode: routing pass receives the ROUTING_INSTRUCTIONS suffix on the system prompt', async () => {
    let routingSystem = '';
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input: ChatInput) => {
      routingSystem = input.system ?? '';
      return {
        text: '[ROUTE]: {"action":"direct","response":"x"}',
        conversationId: 'r',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runFrqncyCommand('q', {
      cwd,
      chatFn,
      loadPersonaFn: makeLoaderStub({ frqncy: makePersona('frqncy', { body: 'frqncy persona body' }) }),
      json: true,
    });
    expect(routingSystem).toContain('frqncy persona body');
    expect(routingSystem).toContain('[ROUTE]:');
  });

  it('auto mode: throws when FRQNCY routes to a non-existent persona', async () => {
    const chatFn = makeStubChat(
      () => '[ROUTE]: {"action":"single","persona":"made-up","reason":"x"}',
    );
    await expect(
      runFrqncyCommand('q', {
        cwd,
        chatFn,
        loadPersonaFn: makeLoaderStub({ frqncy: makePersona('frqncy', { name: 'FRQNCY' }) }),
      }),
    ).rejects.toThrow(/routed to persona "made-up" but the file was not found/);
  });
});

// ────────────────────────────────────────────────────────────────────
// parseRoutingDecision tests
// ────────────────────────────────────────────────────────────────────

describe('parseRoutingDecision', () => {
  it('parses direct shape', () => {
    const d = parseRoutingDecision('[ROUTE]: {"action":"direct","response":"hi"}');
    expect(d).toEqual({ action: 'direct', response: 'hi' } satisfies RoutingDecision);
  });

  it('parses single shape', () => {
    const d = parseRoutingDecision('[ROUTE]: {"action":"single","persona":"kali","reason":"why"}');
    expect(d).toEqual({ action: 'single', persona: 'kali', reason: 'why' } satisfies RoutingDecision);
  });

  it('parses multi shape', () => {
    const d = parseRoutingDecision(
      '[ROUTE]: {"action":"multi","personas":["sai-maa","ceo"],"reason":"why"}',
    );
    expect(d).toEqual({ action: 'multi', personas: ['sai-maa', 'ceo'], reason: 'why' } satisfies RoutingDecision);
  });

  it('returns null when there is no [ROUTE] line', () => {
    expect(parseRoutingDecision('just a regular response')).toBeNull();
  });

  it('returns null when the JSON is malformed', () => {
    expect(parseRoutingDecision('[ROUTE]: {bad json')).toBeNull();
  });

  it('returns null when action is missing or unknown', () => {
    expect(parseRoutingDecision('[ROUTE]: {"action":"weird"}')).toBeNull();
    expect(parseRoutingDecision('[ROUTE]: {"foo":"bar"}')).toBeNull();
  });

  it('returns null when single is missing persona/reason', () => {
    expect(parseRoutingDecision('[ROUTE]: {"action":"single","persona":"kali"}')).toBeNull();
    expect(parseRoutingDecision('[ROUTE]: {"action":"single","reason":"x"}')).toBeNull();
  });

  it('returns null when multi has non-string entries in personas', () => {
    expect(
      parseRoutingDecision('[ROUTE]: {"action":"multi","personas":["a",42],"reason":"r"}'),
    ).toBeNull();
  });

  it('extracts the [ROUTE] line even when surrounded by other text', () => {
    const text = `Some preamble.\n[ROUTE]: {"action":"direct","response":"answer"}\nSome trailing text.`;
    const d = parseRoutingDecision(text);
    expect(d?.action).toBe('direct');
  });
});

describe('buildSynthesisPrompt', () => {
  it('embeds the user prompt, routing reason, and each persona response', () => {
    const out = buildSynthesisPrompt('original q', 'because reasons', [
      {
        persona: 'Sai Maa',
        conversationId: 'a',
        text: 'sai maa says ground',
        costUsd: 0,
        model: 'm',
      },
      {
        persona: 'CEO',
        conversationId: 'b',
        text: 'ceo says move',
        costUsd: 0,
        model: 'm',
      },
    ]);
    expect(out).toContain('original q');
    expect(out).toContain('because reasons');
    expect(out).toContain('### Sai Maa');
    expect(out).toContain('sai maa says ground');
    expect(out).toContain('### CEO');
    expect(out).toContain('ceo says move');
  });
});

// ────────────────────────────────────────────────────────────────────
// Council deliberation files (v0.13)
// ────────────────────────────────────────────────────────────────────

describe('generateDeliberationSlug', () => {
  it('prefixes the date and kebab-cases the question', () => {
    const slug = generateDeliberationSlug(
      'should we take the Lugano partnership',
      '2026-04-29T12:00:00.000Z',
    );
    expect(slug).toBe('2026-04-29-should-we-take-the-lugano');
  });

  it('caps to 5 words from the question', () => {
    const slug = generateDeliberationSlug(
      'one two three four five six seven eight',
      '2026-04-29T12:00:00.000Z',
    );
    expect(slug).toBe('2026-04-29-one-two-three-four-five');
  });

  it('falls back to "council" when the question has no usable words', () => {
    const slug = generateDeliberationSlug('!!!@@@', '2026-04-29T12:00:00.000Z');
    expect(slug).toBe('2026-04-29-council');
  });

  it('strips punctuation', () => {
    const slug = generateDeliberationSlug('what?! is this?!?', '2026-04-29T00:00:00.000Z');
    expect(slug).toMatch(/^2026-04-29-[a-z0-9-]+$/);
  });
});

describe('formatCouncilDeliberation', () => {
  const responses = [
    {
      persona: 'Krishna',
      conversationId: 'a-uuid',
      text: 'krishna speaks about dharma',
      costUsd: 0.005,
      model: 'anthropic/claude-opus-4-6',
    },
    {
      persona: 'Kali',
      conversationId: 'b-uuid',
      text: 'kali speaks about cutting',
      costUsd: 0.005,
      model: 'anthropic/claude-opus-4-6',
    },
  ];

  it('starts with the date-prefixed H1', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(out.split('\n')[0]).toBe('# Council deliberation — 2026-04-29');
  });

  it('embeds the question verbatim', () => {
    const out = formatCouncilDeliberation({
      question: 'should we take the Lugano partnership',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(out).toContain('should we take the Lugano partnership');
  });

  it('renders one section per Council member with name, model, cost, conv-id', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(out).toContain('## Krishna');
    expect(out).toContain('## Kali');
    expect(out).toContain('krishna speaks about dharma');
    expect(out).toContain('kali speaks about cutting');
    expect(out).toContain('a-uuid');
    expect(out).toContain('b-uuid');
    expect(out).toContain('anthropic/claude-opus-4-6');
  });

  it('totals cost across all members', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(out).toContain('$0.0100'); // 0.005 + 0.005
  });

  it('appends a "Synthesis (yours to write)" placeholder section', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    expect(out).toContain('## Synthesis (yours to write)');
    expect(out).toMatch(/Council does not vote/);
  });

  it('does not include trailing trace tag info inside member bodies', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    // The trace tag info appears once in the metadata block, not per-member
    const tagOccurrences = (out.match(/Trace tags/g) ?? []).length;
    expect(tagOccurrences).toBe(1);
  });
});

describe('runFrqncyCommand --council --save (integration)', () => {
  let cwd: string;
  let originalWrite: typeof process.stdout.write;
  let stdoutBuffer: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'council-save-'));
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

  function makeCouncilStub(): NonNullable<FrqncyCommandOptions['chatFn']> {
    return async (input) => {
      const slug = (input.threadId ?? '').replace(/^frqncy-os\//, '');
      return {
        text: `${slug} responds`,
        conversationId: `conv-${slug}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.005 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  function makeCouncilLoaderStub(): NonNullable<FrqncyCommandOptions['loadPersonaFn']> {
    return async (slug) => {
      if (!(COUNCIL_MEMBERS as readonly string[]).includes(slug)) return null;
      return {
        slug,
        path: `/fake/${slug}.md`,
        frontmatter: { name: slug, role: 'council' },
        body: `you are ${slug}. reward hacking is disallowed.`,
      };
    };
  }

  it('writes a deliberation file when --save is set', async () => {
    const result = await runFrqncyCommand('should we take Lugano', {
      cwd,
      council: true,
      save: true,
      chatFn: makeCouncilStub(),
      loadPersonaFn: makeCouncilLoaderStub(),
      json: true,
    });
    expect(result.deliberationPath).toBeDefined();
    expect(result.deliberationPath!).toContain('proposals/council-deliberations/');
    expect(result.deliberationPath!).toMatch(/should-we-take-lugano\.md$/);
    const written = await readFile(result.deliberationPath!, 'utf-8');
    expect(written).toContain('# Council deliberation');
    expect(written).toContain('should we take Lugano');
    // All 7 Council members should appear as their own sections
    for (const member of COUNCIL_MEMBERS) {
      expect(written).toContain(`## ${member}`);
    }
  });

  it('does NOT write a deliberation file when --save is unset', async () => {
    const result = await runFrqncyCommand('should we take Lugano', {
      cwd,
      council: true,
      // save: false (omitted)
      chatFn: makeCouncilStub(),
      loadPersonaFn: makeCouncilLoaderStub(),
      json: true,
    });
    expect(result.deliberationPath).toBeUndefined();
    // No file was written
    await expect(access(join(cwd, 'proposals/council-deliberations'))).rejects.toThrow();
  });

  it('does NOT write a deliberation file for --persona mode even with --save (council-only)', async () => {
    const result = await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      save: true,
      chatFn: async (input) => ({
        text: 'kali responds',
        conversationId: 'c',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.005 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      }),
      loadPersonaFn: makeCouncilLoaderStub(),
      json: true,
    });
    expect(result.deliberationPath).toBeUndefined();
  });
});

describe('formatCouncilDeliberation (auto-mode synthesis variant)', () => {
  const responses = [
    {
      persona: 'Sai Maa',
      conversationId: 'sm-uuid',
      text: 'sai maa says ground first',
      costUsd: 0.005,
      model: 'anthropic/claude-opus-4-6',
    },
    {
      persona: 'CEO',
      conversationId: 'ceo-uuid',
      text: 'ceo says move on the partnership',
      costUsd: 0.005,
      model: 'anthropic/claude-sonnet-4-6',
    },
  ];

  it('uses the custom title when provided', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
      title: 'Routed deliberation',
    });
    expect(out.split('\n')[0]).toBe('# Routed deliberation — 2026-04-29');
  });

  it('uses the custom source line when provided', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
      source: 'frqncy-harness frqncy --save (auto-routed)',
    });
    expect(out).toContain('frqncy-harness frqncy --save (auto-routed)');
  });

  it('embeds synthesisText into a "Synthesis (FRQNCY)" section when provided', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
      synthesisText: 'FRQNCY integrates: take it but ground first',
    });
    expect(out).toContain('## Synthesis (FRQNCY)');
    expect(out).toContain('FRQNCY integrates: take it but ground first');
    // The placeholder is suppressed
    expect(out).not.toContain('## Synthesis (yours to write)');
    expect(out).not.toContain('Council does not vote');
  });

  it('renders the routing reason as its own section before personas', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
      routingReason: 'ground first then move',
      synthesisText: 's',
    });
    expect(out).toContain('## Routing reason');
    expect(out).toContain('ground first then move');
    // Routing reason appears before persona sections
    const routingIdx = out.indexOf('## Routing reason');
    const firstPersonaIdx = out.indexOf('## Sai Maa');
    expect(routingIdx).toBeLessThan(firstPersonaIdx);
  });

  it('omits the "Council convened" preamble when synthesis is embedded (auto-mode tone)', () => {
    const out = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
      synthesisText: 's',
    });
    expect(out).toContain('FRQNCY routed the question');
    expect(out).not.toContain('No member spoke for another');
  });
});

describe('runFrqncyCommand auto-mode --save (integration)', () => {
  let cwd: string;
  let originalWrite: typeof process.stdout.write;
  let stdoutBuffer: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'auto-save-'));
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

  function makeAutoMultiChat(): NonNullable<FrqncyCommandOptions['chatFn']> {
    let callCount = 0;
    return async (input) => {
      callCount++;
      let text: string;
      if (callCount === 1) {
        text = '[ROUTE]: {"action":"multi","personas":["sai-maa","ceo"],"reason":"ground first then move"}';
      } else if (callCount === 4) {
        text = 'FRQNCY synthesis: take it but with grounding first';
      } else {
        const slug = (input.threadId ?? '').replace(/^frqncy-os\//, '');
        text = `${slug} responds`;
      }
      return {
        text,
        conversationId: `conv-${callCount}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.005 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  function makeAutoMultiLoader(): NonNullable<FrqncyCommandOptions['loadPersonaFn']> {
    return async (slug) => {
      if (slug === 'frqncy') {
        return {
          slug: 'frqncy',
          path: '/fake/frqncy.md',
          frontmatter: { name: 'FRQNCY', role: 'router' },
          body: 'you are frqncy. reward hacking is disallowed.',
        };
      }
      if (slug === 'sai-maa' || slug === 'ceo') {
        return {
          slug,
          path: `/fake/${slug}.md`,
          frontmatter: { name: slug === 'sai-maa' ? 'Sai Maa' : 'CEO', role: 'persona' },
          body: `you are ${slug}. reward hacking is disallowed.`,
        };
      }
      return null;
    };
  }

  it('writes an auto-mode deliberation file when --save is set on a multi-persona route', async () => {
    const result = await runFrqncyCommand('should we take the Lugano partnership', {
      cwd,
      save: true,
      chatFn: makeAutoMultiChat(),
      loadPersonaFn: makeAutoMultiLoader(),
      json: true,
    });
    expect(result.routingDecision?.action).toBe('multi');
    expect(result.deliberationPath).toBeDefined();
    expect(result.deliberationPath!).toContain('proposals/council-deliberations/');
    expect(result.deliberationPath!).toMatch(/should-we-take-the-lugano\.md$/);

    const written = await readFile(result.deliberationPath!, 'utf-8');
    // Auto-mode title
    expect(written).toContain('# Routed deliberation');
    // The user's question
    expect(written).toContain('should we take the Lugano partnership');
    // Each invoked persona has a section
    expect(written).toContain('## Sai Maa');
    expect(written).toContain('## CEO');
    // Routing reason section
    expect(written).toContain('## Routing reason');
    expect(written).toContain('ground first then move');
    // FRQNCY's synthesis is embedded, not a placeholder
    expect(written).toContain('## Synthesis (FRQNCY)');
    expect(written).toContain('take it but with grounding first');
    expect(written).not.toContain('## Synthesis (yours to write)');
    // Source line names auto-routed
    expect(written).toContain('frqncy-harness frqncy --save (auto-routed)');
  });

  it('does NOT include the routing/synthesis passes in the deliberation file (only invoked personas)', async () => {
    const result = await runFrqncyCommand('should we take Lugano', {
      cwd,
      save: true,
      chatFn: makeAutoMultiChat(),
      loadPersonaFn: makeAutoMultiLoader(),
      json: true,
    });
    const written = await readFile(result.deliberationPath!, 'utf-8');
    // The routing pass and synthesis pass produce text on FRQNCY's thread —
    // they should NOT appear as their own ## sections. Only the invoked personas (sai-maa, ceo).
    // Count the ## headings that aren't structural (## The question, ## Source metadata, ## Routing reason, ## Synthesis (FRQNCY))
    // Persona sections: ## Sai Maa, ## CEO. That's 2.
    const personaSectionMatches = written.match(/\n## (Sai Maa|CEO|FRQNCY)\b/g) ?? [];
    // ## FRQNCY appears nowhere as a persona section (FRQNCY's contribution is the synthesis section, which has a different header)
    expect(personaSectionMatches.filter((m) => m.includes('FRQNCY'))).toHaveLength(0);
    // ## Sai Maa and ## CEO each appear exactly once
    expect(personaSectionMatches.filter((m) => m.includes('Sai Maa'))).toHaveLength(1);
    expect(personaSectionMatches.filter((m) => m.includes('CEO'))).toHaveLength(1);
  });

  it('does NOT write a deliberation file when auto mode resolves to a direct response', async () => {
    const result = await runFrqncyCommand('what time is it', {
      cwd,
      save: true,
      chatFn: async (input) => ({
        text: '[ROUTE]: {"action":"direct","response":"i answer myself"}',
        conversationId: 'r',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      }),
      loadPersonaFn: makeAutoMultiLoader(),
      json: true,
    });
    expect(result.routingDecision?.action).toBe('direct');
    expect(result.deliberationPath).toBeUndefined();
    await expect(access(join(cwd, 'proposals/council-deliberations'))).rejects.toThrow();
  });

  it('does NOT write a deliberation file when auto mode routes to a single persona', async () => {
    let callCount = 0;
    const result = await runFrqncyCommand('cut this old project', {
      cwd,
      save: true,
      chatFn: async (input) => {
        callCount++;
        const text =
          callCount === 1
            ? '[ROUTE]: {"action":"single","persona":"sai-maa","reason":"ground"}'
            : 'sai maa responds';
        return {
          text,
          conversationId: `c-${callCount}`,
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0.005 },
          model: input.model,
          provider: 'anthropic',
          finishReason: 'stop',
        };
      },
      loadPersonaFn: makeAutoMultiLoader(),
      json: true,
    });
    expect(result.routingDecision?.action).toBe('single');
    // Single-persona auto mode is treated like --persona — no deliberation file written.
    expect(result.deliberationPath).toBeUndefined();
    await expect(access(join(cwd, 'proposals/council-deliberations'))).rejects.toThrow();
  });

  it('does NOT write a deliberation file when --save is unset on auto-mode multi route', async () => {
    const result = await runFrqncyCommand('should we take Lugano', {
      cwd,
      // save: false (omitted)
      chatFn: makeAutoMultiChat(),
      loadPersonaFn: makeAutoMultiLoader(),
      json: true,
    });
    expect(result.routingDecision?.action).toBe('multi');
    expect(result.deliberationPath).toBeUndefined();
    await expect(access(join(cwd, 'proposals/council-deliberations'))).rejects.toThrow();
  });
});

describe('listPersonasGrouped', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-list-'));
    await mkdir(join(dir, 'council'), { recursive: true });
    await mkdir(join(dir, 'c-suite'), { recursive: true });
    await mkdir(join(dir, 'workers'), { recursive: true });
    await writeFile(
      join(dir, 'frqncy.md'),
      `---\nname: FRQNCY\nrole: router\nmodel: anthropic/claude-sonnet-4-6\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'council', 'kali.md'),
      `---\nname: Kali\nrole: council member\nmodel: anthropic/claude-opus-4-6\nveto_authority: true\nevolves: false\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'council', 'krishna.md'),
      `---\nname: Krishna\nrole: council member\nveto_authority: true\nevolves: false\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'c-suite', 'ceo.md'),
      `---\nname: CEO\nrole: chief executive\nparent: Orli\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'workers', 'frontend-dev.md'),
      `---\nname: Frontend Dev\nrole: ui craftsman\nparent: cto\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'learning-agent.md'),
      `---\nname: Learning Agent\nrole: meta-tier reflection\n---\nbody`,
      'utf-8',
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('classifies personas by tier from their directory', async () => {
    const list = await listPersonasGrouped(dir);
    const tierBySlug = Object.fromEntries(list.map((p) => [p.slug, p.tier]));
    expect(tierBySlug['frqncy']).toBe('FRQNCY');
    expect(tierBySlug['kali']).toBe('Council');
    expect(tierBySlug['krishna']).toBe('Council');
    expect(tierBySlug['ceo']).toBe('C-Suite');
    expect(tierBySlug['frontend-dev']).toBe('Workers');
    expect(tierBySlug['learning-agent']).toBe('Meta');
  });

  it('parses frontmatter (name, role, model, parent, evolves, veto_authority)', async () => {
    const list = await listPersonasGrouped(dir);
    const kali = list.find((p) => p.slug === 'kali')!;
    expect(kali.name).toBe('Kali');
    expect(kali.role).toBe('council member');
    expect(kali.model).toBe('anthropic/claude-opus-4-6');
    expect(kali.evolves).toBe(false);
    expect(kali.vetoAuthority).toBe(true);

    const fe = list.find((p) => p.slug === 'frontend-dev')!;
    expect(fe.parent).toBe('cto');
    expect(fe.evolves).toBe(true); // default when not set
    expect(fe.vetoAuthority).toBe(false);
  });

  it('sorts by tier order then by slug', async () => {
    const list = await listPersonasGrouped(dir);
    const slugs = list.map((p) => p.slug);
    // FRQNCY first
    expect(slugs[0]).toBe('frqncy');
    // Council members are after FRQNCY, alphabetical
    const kaliIdx = slugs.indexOf('kali');
    const krishnaIdx = slugs.indexOf('krishna');
    expect(kaliIdx).toBeLessThan(krishnaIdx);
    // C-Suite (ceo) comes after Council
    expect(slugs.indexOf('ceo')).toBeGreaterThan(krishnaIdx);
    // Workers (frontend-dev) come after C-Suite
    expect(slugs.indexOf('frontend-dev')).toBeGreaterThan(slugs.indexOf('ceo'));
    // Meta (learning-agent) comes last
    expect(slugs.indexOf('learning-agent')).toBe(slugs.length - 1);
  });

  it('returns empty array when persona dir does not exist', async () => {
    const list = await listPersonasGrouped(join(dir, 'does-not-exist'));
    expect(list).toEqual([]);
  });

  it('skips non-md files', async () => {
    await writeFile(join(dir, 'README.txt'), 'not a persona', 'utf-8');
    const list = await listPersonasGrouped(dir);
    expect(list.find((p) => p.slug === 'README')).toBeUndefined();
  });
});

describe('runFrqncyListCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-list-cmd-'));
    await mkdir(join(dir, 'council'), { recursive: true });
    await mkdir(join(dir, 'c-suite'), { recursive: true });
    await writeFile(
      join(dir, 'frqncy.md'),
      `---\nname: FRQNCY\nrole: router\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'council', 'kali.md'),
      `---\nname: Kali\nrole: council member\nveto_authority: true\nevolves: false\n---\nbody`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'c-suite', 'ceo.md'),
      `---\nname: CEO\nrole: chief executive\n---\nbody`,
      'utf-8',
    );
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it('emits human-readable output grouped by tier', async () => {
    await runFrqncyListCommand({ personaDir: dir });
    expect(stdoutBuffer).toContain('FRQNCY OS');
    expect(stdoutBuffer).toContain('── FRQNCY (1) ──');
    expect(stdoutBuffer).toContain('── Council (1) ──');
    expect(stdoutBuffer).toContain('── C-Suite (1) ──');
    // Each persona line has slug + role
    expect(stdoutBuffer).toContain('frqncy');
    expect(stdoutBuffer).toContain('kali');
    expect(stdoutBuffer).toContain('council member');
    expect(stdoutBuffer).toContain('ceo');
    expect(stdoutBuffer).toContain('chief executive');
    // Veto + evolves:false flag annotations
    expect(stdoutBuffer).toContain('veto');
    expect(stdoutBuffer).toContain('evolves:false');
  });

  it('emits structured JSON when --json is set', async () => {
    const listing = await runFrqncyListCommand({ personaDir: dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ slug: 'frqncy', tier: 'FRQNCY', name: 'FRQNCY' });
    expect(parsed[1]).toMatchObject({ slug: 'kali', tier: 'Council', vetoAuthority: true, evolves: false });
    expect(parsed[2]).toMatchObject({ slug: 'ceo', tier: 'C-Suite' });
    // Returned listing matches what was emitted
    expect(listing).toHaveLength(3);
  });

  it('does not require a prompt (prompt-free command)', async () => {
    // The fact that runFrqncyListCommand has no prompt parameter is the test —
    // this test asserts the function signature accepts only options
    const result = await runFrqncyListCommand({ personaDir: dir, json: true });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('extractFirstParentSlug', () => {
  it('returns the first slug-like token', () => {
    expect(extractFirstParentSlug('ceo')).toBe('ceo');
    expect(extractFirstParentSlug('cto')).toBe('cto');
    expect(extractFirstParentSlug('orli (via FRQNCY)')).toBe('orli');
    expect(extractFirstParentSlug('god + orli (NOT CEO; reports up only)')).toBe('god');
  });

  it('handles hyphenated slugs', () => {
    expect(extractFirstParentSlug('learning-agent')).toBe('learning-agent');
  });

  it('returns null for empty/missing input', () => {
    expect(extractFirstParentSlug(undefined)).toBeNull();
    expect(extractFirstParentSlug('')).toBeNull();
    expect(extractFirstParentSlug('   ')).toBeNull();
    expect(extractFirstParentSlug('CEO')).toBeNull(); // uppercase doesn't match leading-lowercase
  });
});

describe('validateFrqncyOs', () => {
  let dir: string;

  // Helper: build a fully-valid FRQNCY OS structure, then individual tests mutate it.
  async function setupValidOs(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-validate-'));
    await mkdir(join(dir, 'council'), { recursive: true });
    await mkdir(join(dir, 'c-suite'), { recursive: true });
    await mkdir(join(dir, 'workers'), { recursive: true });

    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest of sentence.';

    // FRQNCY at root
    await writeFile(
      join(dir, 'frqncy.md'),
      `---\nname: FRQNCY\nrole: router\nparent: orli\n---\n${inoc}`,
      'utf-8',
    );
    // Council (all 7, all evolves: false)
    for (const m of [
      'krishna',
      'kali',
      'merlin',
      'saraswati',
      'sai-maa',
      'gary-spivey',
      'kevin-trudeau',
    ]) {
      await writeFile(
        join(dir, 'council', `${m}.md`),
        `---\nname: ${m}\nrole: council\nparent: god + orli (NOT CEO)\nveto_authority: true\nevolves: false\n---\n${inoc}`,
        'utf-8',
      );
    }
    // C-Suite — CEO has parent orli, others have parent ceo
    await writeFile(
      join(dir, 'c-suite', 'ceo.md'),
      `---\nname: CEO\nrole: chief executive\nparent: orli (via FRQNCY)\n---\n${inoc}`,
      'utf-8',
    );
    for (const m of ['cto', 'cfo', 'cmo', 'coo', 'cso']) {
      await writeFile(
        join(dir, 'c-suite', `${m}.md`),
        `---\nname: ${m}\nrole: c-suite\nparent: ceo\n---\n${inoc}`,
        'utf-8',
      );
    }
    // One worker under each C-Suite for parent-resolution coverage
    await writeFile(
      join(dir, 'workers', 'frontend-dev.md'),
      `---\nname: Frontend Dev\nrole: ui\nparent: cto\n---\n${inoc}`,
      'utf-8',
    );
    // Learning Agent
    await writeFile(
      join(dir, 'learning-agent.md'),
      `---\nname: Learning Agent\nrole: meta\nparent: god + orli\nevolves: false\n---\n${inoc}`,
      'utf-8',
    );
  }

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('passes a fully-valid FRQNCY OS structure', async () => {
    await setupValidOs();
    const result = await validateFrqncyOs(dir);
    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
    expect(result.totalPersonas).toBe(16); // 1 FRQNCY + 7 Council + 6 C-Suite + 1 Worker + 1 Meta
  });

  it('flags missing FRQNCY persona as an error', async () => {
    await setupValidOs();
    await rm(join(dir, 'frqncy.md'));
    const result = await validateFrqncyOs(dir);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.category === 'missing-required' && i.message.includes('FRQNCY'));
    expect(issue?.severity).toBe('error');
  });

  it('flags each missing Council member as an error', async () => {
    await setupValidOs();
    await rm(join(dir, 'council', 'kali.md'));
    await rm(join(dir, 'council', 'merlin.md'));
    const result = await validateFrqncyOs(dir);
    expect(result.ok).toBe(false);
    const kali = result.issues.find((i) => i.slug === 'kali' && i.category === 'missing-required');
    const merlin = result.issues.find((i) => i.slug === 'merlin' && i.category === 'missing-required');
    expect(kali?.severity).toBe('error');
    expect(merlin?.severity).toBe('error');
  });

  it('flags Council member with evolves:true as an error', async () => {
    await setupValidOs();
    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest.';
    await writeFile(
      join(dir, 'council', 'kali.md'),
      `---\nname: kali\nrole: council\nparent: god + orli\nevolves: true\n---\n${inoc}`,
      'utf-8',
    );
    const result = await validateFrqncyOs(dir);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.slug === 'kali' && i.category === 'evolves-rule');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('evolves: false');
  });

  it('flags Learning Agent with evolves:true as an error', async () => {
    await setupValidOs();
    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest.';
    await writeFile(
      join(dir, 'learning-agent.md'),
      `---\nname: Learning Agent\nrole: meta\nparent: god + orli\nevolves: true\n---\n${inoc}`,
      'utf-8',
    );
    const result = await validateFrqncyOs(dir);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.slug === 'learning-agent' && i.category === 'evolves-rule');
    expect(issue?.severity).toBe('error');
  });

  it('flags worker with orphan parent slug as an error', async () => {
    await setupValidOs();
    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest.';
    await writeFile(
      join(dir, 'workers', 'rogue-worker.md'),
      `---\nname: Rogue Worker\nrole: nope\nparent: nonexistent-suite\n---\n${inoc}`,
      'utf-8',
    );
    const result = await validateFrqncyOs(dir);
    expect(result.ok).toBe(false);
    const issue = result.issues.find((i) => i.slug === 'rogue-worker' && i.category === 'orphan-parent');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('nonexistent-suite');
  });

  it('flags non-CEO C-Suite that does not report to ceo as a warning', async () => {
    await setupValidOs();
    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest.';
    // CTO with bogus parent (not ceo, not external)
    await writeFile(
      join(dir, 'c-suite', 'cto.md'),
      `---\nname: CTO\nrole: tech\nparent: cfo\n---\n${inoc}`,
      'utf-8',
    );
    const result = await validateFrqncyOs(dir);
    const issue = result.issues.find((i) => i.slug === 'cto' && i.category === 'council-rule');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('ceo');
  });

  it('flags persona body missing the inoculation invariant as a warning', async () => {
    await setupValidOs();
    // Replace one worker with a body that has no inoculation
    await writeFile(
      join(dir, 'workers', 'frontend-dev.md'),
      `---\nname: Frontend Dev\nrole: ui\nparent: cto\n---\nbody without the magic words`,
      'utf-8',
    );
    const result = await validateFrqncyOs(dir);
    const issue = result.issues.find((i) => i.slug === 'frontend-dev' && i.category === 'inoculation-missing');
    expect(issue?.severity).toBe('warning');
  });

  it('treats external parent roots (orli, god) as valid', async () => {
    await setupValidOs();
    const result = await validateFrqncyOs(dir);
    // FRQNCY (parent: orli) and Council (parent: god + orli) and Learning Agent (parent: god + orli)
    // — none of these should produce orphan-parent issues
    const orphanIssues = result.issues.filter((i) => i.category === 'orphan-parent');
    expect(orphanIssues).toEqual([]);
  });

  it('returns no issues for a missing learning-agent — only a warning', async () => {
    await setupValidOs();
    await rm(join(dir, 'learning-agent.md'));
    const result = await validateFrqncyOs(dir);
    // No errors (Learning Agent absence is recoverable)
    expect(result.errorCount).toBe(0);
    expect(result.ok).toBe(true);
    const issue = result.issues.find((i) => i.category === 'missing-required' && i.message.includes('learning-agent'));
    expect(issue?.severity).toBe('warning');
  });
});

describe('runFrqncyValidateCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-validate-cmd-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it('emits human-readable output with error/warning sections', async () => {
    // Empty dir → many missing-required errors (FRQNCY + 7 Council)
    const result = await runFrqncyValidateCommand({ personaDir: dir });
    expect(result.ok).toBe(false);
    expect(result.errorCount).toBeGreaterThanOrEqual(8); // FRQNCY + 7 Council
    expect(stdoutBuffer).toContain('FRQNCY OS validation');
    expect(stdoutBuffer).toMatch(/error/);
  });

  it('emits structured JSON with --json', async () => {
    const result = await runFrqncyValidateCommand({ personaDir: dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.ok).toBe(false);
    expect(parsed.totalPersonas).toBe(0);
    expect(parsed.errorCount).toBeGreaterThan(0);
    expect(Array.isArray(parsed.issues)).toBe(true);
    expect(parsed.issues[0]).toHaveProperty('severity');
    expect(parsed.issues[0]).toHaveProperty('category');
    expect(parsed.issues[0]).toHaveProperty('message');
    expect(result.errorCount).toBe(parsed.errorCount);
  });
});

describe('inspectPersona', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-inspect-'));
    await mkdir(join(dir, 'council'), { recursive: true });
    await mkdir(join(dir, 'workers'), { recursive: true });
    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest of inoculation.';
    await writeFile(
      join(dir, 'frqncy.md'),
      `---\nname: FRQNCY\nrole: router\nmodel: anthropic/claude-sonnet-4-6\nparent: orli\n---\nyou are FRQNCY.\n${inoc}`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'council', 'kali.md'),
      `---\nname: Kali\nrole: council\nveto_authority: true\nevolves: false\nmodel: anthropic/claude-opus-4-6\n---\nyou are Kali.\n${inoc}`,
      'utf-8',
    );
    await writeFile(
      join(dir, 'workers', 'no-inoc.md'),
      `---\nname: No Inoc\nrole: worker\nparent: cto\n---\nbody without the magic words`,
      'utf-8',
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns frontmatter, body, byte count, and inoculation status', async () => {
    const inspection = await inspectPersona('kali', dir);
    expect(inspection).not.toBeNull();
    expect(inspection!.slug).toBe('kali');
    expect(inspection!.tier).toBe('Council');
    expect(inspection!.frontmatter.name).toBe('Kali');
    expect(inspection!.frontmatter.veto_authority).toBe(true);
    expect(inspection!.frontmatter.evolves).toBe(false);
    expect(inspection!.frontmatter.model).toBe('anthropic/claude-opus-4-6');
    expect(inspection!.body).toContain('you are Kali');
    expect(inspection!.bodyBytes).toBeGreaterThan(0);
    expect(inspection!.hasInoculation).toBe(true);
  });

  it('reports hasInoculation: false when invariant is missing', async () => {
    const inspection = await inspectPersona('no-inoc', dir);
    expect(inspection!.hasInoculation).toBe(false);
  });

  it('finds personas at the root level', async () => {
    const inspection = await inspectPersona('frqncy', dir);
    expect(inspection!.tier).toBe('FRQNCY');
    expect(inspection!.path).toContain('frqncy.md');
  });

  it('returns null when persona is not found', async () => {
    expect(await inspectPersona('nonexistent', dir)).toBeNull();
  });

  it('classifies tier from the directory the persona was found in', async () => {
    expect((await inspectPersona('frqncy', dir))!.tier).toBe('FRQNCY');
    expect((await inspectPersona('kali', dir))!.tier).toBe('Council');
    expect((await inspectPersona('no-inoc', dir))!.tier).toBe('Workers');
  });
});

describe('runFrqncyShowCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-show-cmd-'));
    await mkdir(join(dir, 'council'), { recursive: true });
    const inoc = PERSONA_INOCULATION_INVARIANT + ' rest.';
    await writeFile(
      join(dir, 'council', 'kali.md'),
      `---\nname: Kali\nrole: council member\nveto_authority: true\nevolves: false\nmodel: anthropic/claude-opus-4-6\n---\nyou are Kali. cut what must be cut.\n${inoc}`,
      'utf-8',
    );
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it('renders frontmatter section, system-prompt section, and the body', async () => {
    await runFrqncyShowCommand('kali', { personaDir: dir });
    expect(stdoutBuffer).toContain('kali');
    expect(stdoutBuffer).toContain('Council');
    expect(stdoutBuffer).toContain('── frontmatter ──');
    expect(stdoutBuffer).toContain('name:');
    expect(stdoutBuffer).toContain('Kali');
    expect(stdoutBuffer).toContain('role:');
    expect(stdoutBuffer).toContain('council member');
    expect(stdoutBuffer).toContain('veto_authority: true');
    expect(stdoutBuffer).toContain('evolves:        false');
    expect(stdoutBuffer).toContain('── system prompt ──');
    expect(stdoutBuffer).toContain('cut what must be cut');
    // Inoculation status indicator
    expect(stdoutBuffer).toContain('inoculation:');
  });

  it('emits structured JSON with --json', async () => {
    const result = await runFrqncyShowCommand('kali', { personaDir: dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.slug).toBe('kali');
    expect(parsed.tier).toBe('Council');
    expect(parsed.frontmatter.name).toBe('Kali');
    expect(parsed.frontmatter.evolves).toBe(false);
    expect(parsed.body).toContain('cut what must be cut');
    expect(parsed.bodyBytes).toBeGreaterThan(0);
    expect(parsed.hasInoculation).toBe(true);
    expect(result.slug).toBe(parsed.slug);
  });

  it('throws when slug is empty', async () => {
    await expect(runFrqncyShowCommand('', { personaDir: dir })).rejects.toThrow(/slug required/);
    await expect(runFrqncyShowCommand('   ', { personaDir: dir })).rejects.toThrow(/slug required/);
  });

  it('throws with a helpful message when persona is not found', async () => {
    await expect(runFrqncyShowCommand('nonexistent', { personaDir: dir })).rejects.toThrow(
      /persona "nonexistent" not found/,
    );
  });
});

describe('persona memory wiring (v0.14.0)', () => {
  let cwd: string;
  let originalWrite: typeof process.stdout.write;
  let stdoutBuffer: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'frqncy-memory-'));
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

  function makePersona(slug: string, name: string): LoadedPersona {
    return {
      slug,
      path: `/fake/${slug}.md`,
      frontmatter: { name, role: 'test' },
      body: `you are ${slug}.`,
    };
  }

  function makeRecordingChat(): {
    chatFn: NonNullable<FrqncyCommandOptions['chatFn']>;
    calls: { threadId?: string; loadHistory?: boolean | object; system?: string }[];
  } {
    const calls: { threadId?: string; loadHistory?: boolean | object; system?: string }[] = [];
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input) => {
      calls.push({
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.loadHistory !== undefined ? { loadHistory: input.loadHistory } : {}),
        ...(input.system ? { system: input.system } : {}),
      });
      // Default: no [ROUTE] line so auto mode falls back to direct
      return {
        text: 'response',
        conversationId: `c-${calls.length}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    return { chatFn, calls };
  }

  it('--persona invocation passes loadHistory: true by default', async () => {
    const { chatFn, calls } = makeRecordingChat();
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      chatFn,
      loadPersonaFn: async (slug) => (slug === 'kali' ? makePersona('kali', 'Kali') : null),
      json: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.loadHistory).toBe(true);
    expect(calls[0]!.threadId).toBe('frqncy-os/kali');
  });

  it('--no-memory disables loadHistory on persona invocation', async () => {
    const { chatFn, calls } = makeRecordingChat();
    await runFrqncyCommand('q', {
      cwd,
      persona: 'kali',
      noMemory: true,
      chatFn,
      loadPersonaFn: async (slug) => (slug === 'kali' ? makePersona('kali', 'Kali') : null),
      json: true,
    });
    expect(calls[0]!.loadHistory).toBe(false);
  });

  it('--council passes loadHistory: true to all 7 invocations by default', async () => {
    const personas: Record<string, LoadedPersona> = {};
    for (const m of COUNCIL_MEMBERS) personas[m] = makePersona(m, m);
    const { chatFn, calls } = makeRecordingChat();
    await runFrqncyCommand('q', {
      cwd,
      council: true,
      chatFn,
      loadPersonaFn: async (slug) => personas[slug] ?? null,
      json: true,
    });
    expect(calls).toHaveLength(7);
    for (const c of calls) expect(c.loadHistory).toBe(true);
  });

  it('--council with --no-memory disables loadHistory on all 7', async () => {
    const personas: Record<string, LoadedPersona> = {};
    for (const m of COUNCIL_MEMBERS) personas[m] = makePersona(m, m);
    const { chatFn, calls } = makeRecordingChat();
    await runFrqncyCommand('q', {
      cwd,
      council: true,
      noMemory: true,
      chatFn,
      loadPersonaFn: async (slug) => personas[slug] ?? null,
      json: true,
    });
    for (const c of calls) expect(c.loadHistory).toBe(false);
  });

  it('auto-mode routing pass is stateless (loadHistory: false)', async () => {
    const { chatFn, calls } = makeRecordingChat();
    await runFrqncyCommand('q', {
      cwd,
      // default = auto mode
      chatFn,
      loadPersonaFn: async (slug) =>
        slug === 'frqncy' ? makePersona('frqncy', 'FRQNCY') : null,
      json: true,
    });
    // The first call IS the routing pass — must be stateless
    expect(calls[0]!.system).toContain('Routing protocol');
    expect(calls[0]!.loadHistory).toBe(false);
  });

  it('auto-mode multi: routing+synthesis stateless, persona invocations get memory', async () => {
    let callCount = 0;
    const seen: { loadHistory?: boolean | object; system?: string }[] = [];
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input) => {
      callCount++;
      seen.push({
        ...(input.loadHistory !== undefined ? { loadHistory: input.loadHistory } : {}),
        ...(input.system ? { system: input.system } : {}),
      });
      const text =
        callCount === 1
          ? '[ROUTE]: {"action":"multi","personas":["sai-maa","ceo"],"reason":"r"}'
          : callCount === 4
            ? 'synthesized'
            : `${input.threadId} responds`;
      return {
        text,
        conversationId: `c-${callCount}`,
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runFrqncyCommand('q', {
      cwd,
      chatFn,
      loadPersonaFn: async (slug) => {
        if (slug === 'frqncy') return makePersona('frqncy', 'FRQNCY');
        if (slug === 'sai-maa') return makePersona('sai-maa', 'Sai Maa');
        if (slug === 'ceo') return makePersona('ceo', 'CEO');
        return null;
      },
      json: true,
    });
    expect(seen).toHaveLength(4);
    // Call 1: routing pass — stateless
    expect(seen[0]!.system).toContain('Routing protocol');
    expect(seen[0]!.loadHistory).toBe(false);
    // Calls 2 & 3: persona invocations — memory ON
    expect(seen[1]!.loadHistory).toBe(true);
    expect(seen[2]!.loadHistory).toBe(true);
    // Call 4: synthesis — stateless
    expect(seen[3]!.system).toContain('Synthesis');
    expect(seen[3]!.loadHistory).toBe(false);
  });

  it('--no-route passes loadHistory: true (default) to FRQNCY persona', async () => {
    const { chatFn, calls } = makeRecordingChat();
    await runFrqncyCommand('q', {
      cwd,
      noRoute: true,
      chatFn,
      loadPersonaFn: async (slug) =>
        slug === 'frqncy' ? makePersona('frqncy', 'FRQNCY') : null,
      json: true,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.loadHistory).toBe(true);
  });
});

describe('runFrqncyHistoryCommand reads real trace data (end-to-end)', () => {
  let traceDir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'frqncy-history-e2e-'));
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

  it('shows messages that were previously written to a thread', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { randomUUID } = await import('node:crypto');
    const { TRACE_SCHEMA_VERSION } = await import('../src/types.js');
    const conversationId = randomUUID();
    const startedAt = '2026-04-29T10:00:00.000Z';
    const datedDir = join(traceDir, '2026-04-29');
    await mkdir(datedDir, { recursive: true });
    const traceFile = join(datedDir, `${conversationId}.jsonl`);

    const SCHEMA_V = TRACE_SCHEMA_VERSION;
    const userRecord = JSON.stringify({
      ts: startedAt,
      conversation_id: conversationId,
      step: 0,
      type: 'user',
      role: 'user',
      content: 'cut what is dying',
      thread_id: 'frqncy-os/kali',
      schema_version: SCHEMA_V,
    });
    const asstRecord = JSON.stringify({
      ts: startedAt,
      conversation_id: conversationId,
      step: 1,
      type: 'assistant',
      role: 'assistant',
      content: 'the old story',
      thread_id: 'frqncy-os/kali',
      schema_version: SCHEMA_V,
    });
    await writeFile(traceFile, userRecord + '\n' + asstRecord + '\n', 'utf-8');

    const indexRecord = JSON.stringify({
      conversation_id: conversationId,
      started_at: startedAt,
      ended_at: startedAt,
      model: 'anthropic/claude-sonnet-4-6',
      message_count: 2,
      total_cost_usd: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cached_input_tokens: 0,
      status: 'completed',
      thread_id: 'frqncy-os/kali',
      schema_version: SCHEMA_V,
    });
    await mkdir(traceDir, { recursive: true });
    await writeFile(join(traceDir, 'INDEX.jsonl'), indexRecord + '\n', 'utf-8');

    const result = await runFrqncyHistoryCommand('kali', { json: true, traceDir });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.threadId).toBe('frqncy-os/kali');
    expect(parsed.messages).toEqual([
      { role: 'user', content: 'cut what is dying' },
      { role: 'assistant', content: 'the old story' },
    ]);
    expect(parsed.conversationsRead).toBe(1);
    expect(result.totalBytes).toBeGreaterThan(0);
  });
});

describe('runFrqncyHistoryCommand', () => {
  let traceDir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    traceDir = await mkdtemp(join(tmpdir(), 'frqncy-history-cmd-'));
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

  it('throws when slug is empty', async () => {
    await expect(runFrqncyHistoryCommand('')).rejects.toThrow(/slug required/);
    await expect(runFrqncyHistoryCommand('   ')).rejects.toThrow(/slug required/);
  });

  it('renders a friendly empty-state message when no history exists', async () => {
    // Point the loader at an empty trace dir by overriding env temporarily
    // is brittle; instead, just call against a slug that won't match anything
    // in the user's real ~/.frqncy-harness/traces (we can't isolate the
    // default trace dir without a parameter). Use --json to avoid relying
    // on real user traces affecting human output.
    const result = await runFrqncyHistoryCommand('does-not-exist-' + Date.now(), {
      json: true,
      maxConversations: 1,
    });
    expect(result.messages).toEqual([]);
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.threadId).toMatch(/^frqncy-os\/does-not-exist-/);
    expect(parsed.messages).toEqual([]);
    expect(parsed.conversationsRead).toBe(0);
  });
});

describe('parseDeliberation', () => {
  it('parses a council deliberation (placeholder synthesis)', () => {
    const responses = [
      { persona: 'Krishna', conversationId: 'k-uuid', text: 'krishna body', costUsd: 0.005, model: 'anthropic/claude-opus-4-6' },
      { persona: 'Kali', conversationId: 'kali-uuid', text: 'kali body', costUsd: 0.005, model: 'anthropic/claude-opus-4-6' },
    ];
    const raw = formatCouncilDeliberation({
      question: 'should we take Lugano',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const r = parseDeliberation(raw, '2026-04-29-should-we-take-lugano', '/fake/path.md');
    expect(r.title).toBe('Council deliberation');
    expect(r.date).toBe('2026-04-29');
    expect(r.source).toContain('frqncy --council --save');
    expect(r.question).toBe('should we take Lugano');
    expect(r.members).toHaveLength(2);
    expect(r.members[0]!.name).toBe('Krishna');
    expect(r.members[0]!.model).toBe('anthropic/claude-opus-4-6');
    expect(r.members[0]!.costUsd).toBe(0.005);
    expect(r.members[0]!.conversationId).toBe('k-uuid');
    expect(r.members[1]!.name).toBe('Kali');
    expect(r.totalCostUsd).toBeCloseTo(0.01, 4);
    expect(r.hasSynthesis).toBe(false);
    expect(r.synthesisText).toBeUndefined();
    expect(r.routingReason).toBeUndefined();
  });

  it('parses a routed deliberation with embedded synthesis + routing reason', () => {
    const responses = [
      { persona: 'Sai Maa', conversationId: 'sm-uuid', text: 'ground first', costUsd: 0.005, model: 'anthropic/claude-opus-4-6' },
      { persona: 'CEO', conversationId: 'ceo-uuid', text: 'move on it', costUsd: 0.005, model: 'anthropic/claude-sonnet-4-6' },
    ];
    const raw = formatCouncilDeliberation({
      question: 'should we take Lugano',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
      title: 'Routed deliberation',
      source: 'frqncy-harness frqncy --save (auto-routed)',
      synthesisText: 'take it but ground first',
      routingReason: 'ground then move',
    });
    const r = parseDeliberation(raw, '2026-04-29-should-we-take-lugano', '/fake/path.md');
    expect(r.title).toBe('Routed deliberation');
    expect(r.routingReason).toBe('ground then move');
    expect(r.hasSynthesis).toBe(true);
    expect(r.synthesisText).toBe('take it but ground first');
    expect(r.source).toContain('auto-routed');
    expect(r.members).toHaveLength(2);
    expect(r.members[0]!.name).toBe('Sai Maa');
  });

  it('records body byte count per member', () => {
    const responses = [
      { persona: 'Krishna', conversationId: 'a', text: 'short body', costUsd: 0, model: 'm' },
    ];
    const raw = formatCouncilDeliberation({
      question: 'q',
      responses,
      generatedAt: '2026-04-29T12:00:00.000Z',
    });
    const r = parseDeliberation(raw, 'slug', '/x.md');
    expect(r.members[0]!.bodyBytes).toBeGreaterThan(0);
  });
});

describe('loadDeliberations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-delibs-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeDeliberation(slug: string, opts: {
    question: string;
    generatedAt: string;
    title?: string;
    synthesisText?: string;
    routingReason?: string;
  }): Promise<void> {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut it', costUsd: 0.005, model: 'anthropic/claude-opus-4-6' },
    ];
    const content = formatCouncilDeliberation({
      question: opts.question,
      responses,
      generatedAt: opts.generatedAt,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.synthesisText ? { synthesisText: opts.synthesisText } : {}),
      ...(opts.routingReason ? { routingReason: opts.routingReason } : {}),
    });
    await writeFile(join(dir, `${slug}.md`), content, 'utf-8');
  }

  it('returns [] when the dir does not exist', async () => {
    expect(await loadDeliberations(join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('returns [] when the dir is empty', async () => {
    expect(await loadDeliberations(dir)).toEqual([]);
  });

  it('parses every .md file and skips non-md files', async () => {
    await writeDeliberation('2026-04-29-q1', {
      question: 'first question',
      generatedAt: '2026-04-29T10:00:00.000Z',
    });
    await writeDeliberation('2026-04-28-q2', {
      question: 'second question',
      generatedAt: '2026-04-28T10:00:00.000Z',
    });
    await writeFile(join(dir, 'README.txt'), 'not a deliberation', 'utf-8');
    const records = await loadDeliberations(dir);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.slug === '2026-04-29-q1')).toBeDefined();
    expect(records.find((r) => r.slug === 'README')).toBeUndefined();
  });

  it('sorts records by date descending', async () => {
    await writeDeliberation('2026-04-27-old', {
      question: 'old',
      generatedAt: '2026-04-27T10:00:00.000Z',
    });
    await writeDeliberation('2026-04-29-new', {
      question: 'new',
      generatedAt: '2026-04-29T10:00:00.000Z',
    });
    await writeDeliberation('2026-04-28-mid', {
      question: 'mid',
      generatedAt: '2026-04-28T10:00:00.000Z',
    });
    const records = await loadDeliberations(dir);
    const dates = records.map((r) => r.date);
    expect(dates).toEqual(['2026-04-29', '2026-04-28', '2026-04-27']);
  });
});

describe('runFrqncyDeliberationsCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-delibs-cmd-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it('emits empty-state hint when no records exist', async () => {
    const records = await runFrqncyDeliberationsCommand({ dir });
    expect(records).toEqual([]);
    expect(stdoutBuffer).toContain('no deliberation files yet');
  });

  it('lists records grouped by routed/council with synthesis status', async () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, '2026-04-29-q.md'),
      formatCouncilDeliberation({
        question: 'a question',
        responses,
        generatedAt: '2026-04-29T10:00:00.000Z',
        title: 'Routed deliberation',
        synthesisText: 's',
      }),
      'utf-8',
    );
    await runFrqncyDeliberationsCommand({ dir });
    expect(stdoutBuffer).toContain('2026-04-29-q');
    expect(stdoutBuffer).toContain('routed');
    expect(stdoutBuffer).toContain('synthesized');
  });

  it('emits structured JSON with --json', async () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, '2026-04-29-q.md'),
      formatCouncilDeliberation({
        question: 'q',
        responses,
        generatedAt: '2026-04-29T10:00:00.000Z',
      }),
      'utf-8',
    );
    await runFrqncyDeliberationsCommand({ dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe('2026-04-29-q');
  });
});

describe('runFrqncyDeliberationCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-delib-cmd-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it('throws when slug is empty', async () => {
    await expect(runFrqncyDeliberationCommand('', { dir })).rejects.toThrow(/slug required/);
    await expect(runFrqncyDeliberationCommand('   ', { dir })).rejects.toThrow(/slug required/);
  });

  it('throws helpfully when the file is not found', async () => {
    await expect(runFrqncyDeliberationCommand('does-not-exist', { dir })).rejects.toThrow(
      /not found/,
    );
  });

  it('strips trailing .md from slug', async () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, '2026-04-29-q.md'),
      formatCouncilDeliberation({
        question: 'q',
        responses,
        generatedAt: '2026-04-29T10:00:00.000Z',
      }),
      'utf-8',
    );
    const result = await runFrqncyDeliberationCommand('2026-04-29-q.md', { dir, json: true });
    expect(result.slug).toBe('2026-04-29-q');
  });

  it('renders question, members, synthesis, source in human mode', async () => {
    const responses = [
      { persona: 'Sai Maa', conversationId: 'a', text: 'ground', costUsd: 0.005, model: 'm' },
      { persona: 'CEO', conversationId: 'b', text: 'move', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, '2026-04-29-q.md'),
      formatCouncilDeliberation({
        question: 'should we take lugano',
        responses,
        generatedAt: '2026-04-29T10:00:00.000Z',
        title: 'Routed deliberation',
        source: 'frqncy-harness frqncy --save (auto-routed)',
        synthesisText: 'take it but ground first',
        routingReason: 'ground then move',
      }),
      'utf-8',
    );
    await runFrqncyDeliberationCommand('2026-04-29-q', { dir });
    expect(stdoutBuffer).toContain('── question ──');
    expect(stdoutBuffer).toContain('should we take lugano');
    expect(stdoutBuffer).toContain('── routing reason ──');
    expect(stdoutBuffer).toContain('ground then move');
    expect(stdoutBuffer).toContain('── members convened (2) ──');
    expect(stdoutBuffer).toContain('Sai Maa');
    expect(stdoutBuffer).toContain('CEO');
    expect(stdoutBuffer).toContain('── synthesis (FRQNCY) ──');
    expect(stdoutBuffer).toContain('take it but ground first');
  });

  it('flags missing synthesis with a hint', async () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, '2026-04-29-q.md'),
      formatCouncilDeliberation({
        question: 'q',
        responses,
        generatedAt: '2026-04-29T10:00:00.000Z',
      }),
      'utf-8',
    );
    await runFrqncyDeliberationCommand('2026-04-29-q', { dir });
    expect(stdoutBuffer).toContain('no embedded synthesis');
  });

  it('emits structured JSON with --json', async () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, '2026-04-29-q.md'),
      formatCouncilDeliberation({
        question: 'q',
        responses,
        generatedAt: '2026-04-29T10:00:00.000Z',
      }),
      'utf-8',
    );
    await runFrqncyDeliberationCommand('2026-04-29-q', { dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.slug).toBe('2026-04-29-q');
    expect(parsed.question).toBe('q');
    expect(parsed.members).toHaveLength(1);
  });
});

describe('summarizeDeliberation', () => {
  function makeRecord(opts: {
    title?: string;
    routingReason?: string;
    synthesisText?: string;
    members?: { persona: string; conversationId: string; text: string; costUsd: number; model: string }[];
  } = {}) {
    const responses = opts.members ?? [
      { persona: 'Kali', conversationId: 'a', text: 'cut it', costUsd: 0.005, model: 'm' },
    ];
    const raw = formatCouncilDeliberation({
      question: 'test question',
      responses,
      generatedAt: '2026-04-29T10:00:00.000Z',
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.routingReason ? { routingReason: opts.routingReason } : {}),
      ...(opts.synthesisText ? { synthesisText: opts.synthesisText } : {}),
    });
    return parseDeliberation(raw, '2026-04-29-test-question', '/x.md');
  }

  it('produces a compact summary including question, members, and synthesis', () => {
    const r = makeRecord({ synthesisText: 'integrate this' });
    const s = summarizeDeliberation(r);
    expect(s).toContain('*2026-04-29-test-question*');
    expect(s).toContain('test question');
    expect(s).toContain('Kali');
    expect(s).toContain('integrate this');
  });

  it('marks placeholder synthesis explicitly', () => {
    const r = makeRecord();
    const s = summarizeDeliberation(r);
    expect(s).toContain('placeholder — not yet written');
  });

  it('includes routing reason when present', () => {
    const r = makeRecord({ routingReason: 'ground first', synthesisText: 's' });
    const s = summarizeDeliberation(r);
    expect(s).toContain('Routing reason: ground first');
  });

  it('tags routed vs council based on title', () => {
    const routed = makeRecord({ title: 'Routed deliberation', synthesisText: 's' });
    const council = makeRecord();
    expect(summarizeDeliberation(routed)).toContain('(routed,');
    expect(summarizeDeliberation(council)).toContain('(council,');
  });

  it('truncates long synthesis to ~400 chars with ellipsis', () => {
    const r = makeRecord({ synthesisText: 'x'.repeat(800) });
    const s = summarizeDeliberation(r);
    expect(s).toContain('…');
    // Cap at 400 + the prefix; we don't need the exact byte count
    expect(s.length).toBeLessThan(800);
  });
});

describe('buildReflectionPrompt', () => {
  it('handles empty corpus gracefully', () => {
    const p = buildReflectionPrompt([], '2026-04-29T10:00:00.000Z');
    expect(p).toContain('Records reviewed: 0');
    expect(p).toContain('no records');
  });

  it('includes one summary block per record', () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    const r1 = parseDeliberation(
      formatCouncilDeliberation({ question: 'q1', responses, generatedAt: '2026-04-29T10:00:00.000Z' }),
      '2026-04-29-q1', '/x.md',
    );
    const r2 = parseDeliberation(
      formatCouncilDeliberation({ question: 'q2', responses, generatedAt: '2026-04-28T10:00:00.000Z' }),
      '2026-04-28-q2', '/y.md',
    );
    const p = buildReflectionPrompt([r1, r2], '2026-04-29T10:00:00.000Z');
    expect(p).toContain('Records reviewed: 2');
    expect(p).toContain('q1');
    expect(p).toContain('q2');
    expect(p).toContain('*2026-04-29-q1*');
    expect(p).toContain('*2026-04-28-q2*');
  });

  it('reports a date range across the corpus', () => {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0, model: 'm' },
    ];
    const r1 = parseDeliberation(
      formatCouncilDeliberation({ question: 'q1', responses, generatedAt: '2026-04-29T10:00:00.000Z' }),
      '2026-04-29-q1', '/x.md',
    );
    const r2 = parseDeliberation(
      formatCouncilDeliberation({ question: 'q2', responses, generatedAt: '2026-04-25T10:00:00.000Z' }),
      '2026-04-25-q2', '/y.md',
    );
    const p = buildReflectionPrompt([r1, r2], '2026-04-29T10:00:00.000Z');
    expect(p).toContain('Date range: 2026-04-25 → 2026-04-29');
  });
});

describe('REFLECT_SYSTEM_PROMPT', () => {
  it('contains the inoculation invariant', () => {
    expect(REFLECT_SYSTEM_PROMPT).toContain('reward hacking');
  });

  it('names all output sections', () => {
    expect(REFLECT_SYSTEM_PROMPT).toContain('## Themes');
    expect(REFLECT_SYSTEM_PROMPT).toContain('## Routing patterns');
    expect(REFLECT_SYSTEM_PROMPT).toContain('## Voice signals');
    expect(REFLECT_SYSTEM_PROMPT).toContain('## Action items');
    expect(REFLECT_SYSTEM_PROMPT).toContain('## Open questions for Orli');
  });

  it('explicitly tells the model not to invent themes from a too-small corpus', () => {
    expect(REFLECT_SYSTEM_PROMPT).toMatch(/too small|too small/);
  });
});

describe('runFrqncyReflectCommand', () => {
  let cwd: string;
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'frqncy-reflect-cwd-'));
    dir = join(cwd, 'proposals/council-deliberations');
    await mkdir(dir, { recursive: true });
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

  async function seedDeliberation(slug: string, opts: { question: string; generatedAt: string }) {
    const responses = [
      { persona: 'Kali', conversationId: 'a', text: 'cut', costUsd: 0.005, model: 'm' },
    ];
    await writeFile(
      join(dir, `${slug}.md`),
      formatCouncilDeliberation({
        question: opts.question,
        responses,
        generatedAt: opts.generatedAt,
      }),
      'utf-8',
    );
  }

  function makeChatStub(text: string): NonNullable<FrqncyCommandOptions['chatFn']> {
    return async (input: ChatInput): Promise<ChatResult> => ({
      text,
      conversationId: 'reflect-conv',
      usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.012 },
      model: input.model,
      provider: 'anthropic',
      finishReason: 'stop',
    });
  }

  it('throws when no deliberations exist', async () => {
    await expect(runFrqncyReflectCommand({ cwd, chatFn: makeChatStub('x') })).rejects.toThrow(
      /No deliberation records to reflect on/,
    );
  });

  it('throws when --since filters everything out', async () => {
    await seedDeliberation('2026-04-29-q', { question: 'q', generatedAt: '2026-04-29T10:00:00.000Z' });
    await expect(
      runFrqncyReflectCommand({ cwd, since: '2026-05-01', chatFn: makeChatStub('x') }),
    ).rejects.toThrow(/No deliberation records.*since 2026-05-01/);
  });

  it('reviews up to --last N most-recent records', async () => {
    await seedDeliberation('2026-04-25-q1', { question: 'q1', generatedAt: '2026-04-25T10:00:00.000Z' });
    await seedDeliberation('2026-04-26-q2', { question: 'q2', generatedAt: '2026-04-26T10:00:00.000Z' });
    await seedDeliberation('2026-04-27-q3', { question: 'q3', generatedAt: '2026-04-27T10:00:00.000Z' });
    const result = await runFrqncyReflectCommand({
      cwd,
      last: 2,
      json: true,
      chatFn: makeChatStub('reflection text'),
    });
    expect(result.reviewed).toHaveLength(2);
    // Most recent should win — 27, 26
    expect(result.reviewed[0]).toBe('2026-04-27-q3');
    expect(result.reviewed[1]).toBe('2026-04-26-q2');
  });

  it('passes the right system prompt + threadId to the chat call', async () => {
    await seedDeliberation('2026-04-29-q', { question: 'q', generatedAt: '2026-04-29T10:00:00.000Z' });
    const captured: { system?: string; threadId?: string; projectId?: string } = {};
    const chatFn: NonNullable<FrqncyCommandOptions['chatFn']> = async (input) => {
      captured.system = input.system;
      captured.threadId = input.threadId;
      captured.projectId = input.projectId;
      return {
        text: 'r',
        conversationId: 'c',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
    await runFrqncyReflectCommand({ cwd, chatFn, json: true });
    expect(captured.system).toBe(REFLECT_SYSTEM_PROMPT);
    expect(captured.threadId).toBe('frqncy-os/learning-agent');
    expect(captured.projectId).toBe('frqncy-os');
  });

  it('emits structured JSON with --json', async () => {
    await seedDeliberation('2026-04-29-q', { question: 'q', generatedAt: '2026-04-29T10:00:00.000Z' });
    await runFrqncyReflectCommand({ cwd, json: true, chatFn: makeChatStub('r') });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.reviewed).toEqual(['2026-04-29-q']);
    expect(parsed.reflectionText).toBe('r');
    expect(parsed.costUsd).toBe(0.012);
  });

  it('saves the reflection to proposals/reflections/ when --save', async () => {
    await seedDeliberation('2026-04-29-q', { question: 'q', generatedAt: '2026-04-29T10:00:00.000Z' });
    const result = await runFrqncyReflectCommand({
      cwd,
      save: true,
      chatFn: makeChatStub('the actual reflection'),
      json: true,
    });
    expect(result.savedTo).toBeDefined();
    expect(result.savedTo!).toContain('proposals/reflections/');
    expect(result.savedTo!).toMatch(/-deliberation-reflection\.md$/);
    const written = await readFile(result.savedTo!, 'utf-8');
    expect(written).toContain('# Deliberation reflection');
    expect(written).toContain('Reviewed 1 deliberation');
    expect(written).toContain('the actual reflection');
    expect(written).toContain('*2026-04-29-q*');
  });

  it('saves to a custom --output path when provided', async () => {
    await seedDeliberation('2026-04-29-q', { question: 'q', generatedAt: '2026-04-29T10:00:00.000Z' });
    const customPath = join(cwd, 'custom-output.md');
    const result = await runFrqncyReflectCommand({
      cwd,
      output: customPath,
      chatFn: makeChatStub('r'),
      json: true,
    });
    expect(result.savedTo).toBe(customPath);
    const written = await readFile(customPath, 'utf-8');
    expect(written).toContain('# Deliberation reflection');
  });
});

describe('DEFAULT_REFLECTIONS_DIR', () => {
  it('is "proposals/reflections"', () => {
    expect(DEFAULT_REFLECTIONS_DIR).toBe('proposals/reflections');
  });
});

describe('parseReflection', () => {
  function makeReflectionRaw(opts: {
    date?: string;
    recordsReviewed?: number;
    model?: string;
    cost?: number;
    dateRange?: string;
    corpus?: string[];
    body?: string;
  } = {}) {
    const date = opts.date ?? '2026-04-29';
    const recordsReviewed = opts.recordsReviewed ?? 3;
    const model = opts.model ?? 'anthropic/claude-sonnet-4-6';
    const cost = (opts.cost ?? 0.0123).toFixed(4);
    const dateRange = opts.dateRange ?? `from 2026-04-25 to ${date}`;
    const corpus = opts.corpus ?? ['2026-04-29-q3', '2026-04-27-q2', '2026-04-25-q1'];
    const body = opts.body ?? `## Themes\n\nTheme one in *2026-04-29-q3*.\n\n## Action items\n\n- [ ] do this\n- [x] already done\n- [ ] another open one`;
    return [
      `# Deliberation reflection — ${date}`,
      ``,
      `> Generated by \`frqncy-harness frqncy --reflect\`. Reviewed ${recordsReviewed} deliberations ${dateRange}. Model: \`${model}\`. Cost: $${cost}.`,
      ``,
      `## Corpus reviewed`,
      ``,
      ...corpus.map((s) => `- *${s}*`),
      ``,
      `---`,
      ``,
      body,
      ``,
    ].join('\n');
  }

  it('parses date from H1', () => {
    const r = parseReflection(makeReflectionRaw(), '2026-04-29-deliberation-reflection', '/x.md');
    expect(r.date).toBe('2026-04-29');
  });

  it('parses provenance line (recordsReviewed, model, cost, dateRange)', () => {
    const r = parseReflection(makeReflectionRaw(), 'slug', '/x.md');
    expect(r.recordsReviewed).toBe(3);
    expect(r.model).toBe('anthropic/claude-sonnet-4-6');
    expect(r.costUsd).toBe(0.0123);
    expect(r.dateRange).toContain('from 2026-04-25 to');
  });

  it('parses corpus list', () => {
    const r = parseReflection(makeReflectionRaw(), 'slug', '/x.md');
    expect(r.corpus).toEqual(['2026-04-29-q3', '2026-04-27-q2', '2026-04-25-q1']);
  });

  it('extracts action items distinguishing checked vs unchecked', () => {
    const r = parseReflection(makeReflectionRaw(), 'slug', '/x.md');
    expect(r.actionItems).toHaveLength(3);
    expect(r.actionItems[0]).toEqual({ text: 'do this', done: false });
    expect(r.actionItems[1]).toEqual({ text: 'already done', done: true });
    expect(r.actionItems[2]).toEqual({ text: 'another open one', done: false });
  });

  it('returns empty actionItems when the section is missing', () => {
    const raw = makeReflectionRaw({ body: '## Themes\n\njust themes here.' });
    const r = parseReflection(raw, 'slug', '/x.md');
    expect(r.actionItems).toEqual([]);
  });

  it('handles single-record provenance ("from <date>" without "to")', () => {
    const raw = makeReflectionRaw({ recordsReviewed: 1, dateRange: 'from 2026-04-29' });
    const r = parseReflection(raw, 'slug', '/x.md');
    expect(r.recordsReviewed).toBe(1);
    expect(r.dateRange).toBe('from 2026-04-29');
  });
});

describe('loadReflections', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-reflections-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeRaw(date: string): string {
    return `# Deliberation reflection — ${date}

> Generated by \`frqncy-harness frqncy --reflect\`. Reviewed 1 deliberation from ${date}. Model: \`m\`. Cost: $0.01.

## Corpus reviewed

- *${date}-q*

---

## Action items

- [ ] open
`;
  }

  it('returns [] when dir is missing', async () => {
    expect(await loadReflections(join(dir, 'nope'))).toEqual([]);
  });

  it('returns [] when dir is empty', async () => {
    expect(await loadReflections(dir)).toEqual([]);
  });

  it('loads .md files and skips others', async () => {
    await writeFile(join(dir, '2026-04-29-r.md'), makeRaw('2026-04-29'), 'utf-8');
    await writeFile(join(dir, 'README.txt'), 'not a reflection', 'utf-8');
    const r = await loadReflections(dir);
    expect(r).toHaveLength(1);
    expect(r[0]!.slug).toBe('2026-04-29-r');
  });

  it('sorts by date descending', async () => {
    await writeFile(join(dir, '2026-04-25-old.md'), makeRaw('2026-04-25'), 'utf-8');
    await writeFile(join(dir, '2026-04-29-new.md'), makeRaw('2026-04-29'), 'utf-8');
    await writeFile(join(dir, '2026-04-27-mid.md'), makeRaw('2026-04-27'), 'utf-8');
    const r = await loadReflections(dir);
    expect(r.map((x) => x.date)).toEqual(['2026-04-29', '2026-04-27', '2026-04-25']);
  });
});

describe('runFrqncyReflectionsCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-reflections-cmd-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  it('shows empty-state message when no reflections exist', async () => {
    const result = await runFrqncyReflectionsCommand({ dir });
    expect(result).toEqual([]);
    expect(stdoutBuffer).toContain('no reflections yet');
  });

  it('lists reflections with action-item counts (open / done)', async () => {
    const raw = `# Deliberation reflection — 2026-04-29

> Generated by \`frqncy-harness frqncy --reflect\`. Reviewed 2 deliberations from 2026-04-25 to 2026-04-29. Model: \`m\`. Cost: $0.01.

## Corpus reviewed

- *2026-04-29-q1*
- *2026-04-25-q2*

---

## Action items

- [ ] open one
- [ ] open two
- [x] done one
`;
    await writeFile(join(dir, '2026-04-29-r.md'), raw, 'utf-8');
    await runFrqncyReflectionsCommand({ dir });
    expect(stdoutBuffer).toContain('2026-04-29-r');
    expect(stdoutBuffer).toContain('2 open');
    expect(stdoutBuffer).toContain('1 done');
  });

  it('emits structured JSON with --json', async () => {
    const raw = `# Deliberation reflection — 2026-04-29

> Generated by \`frqncy-harness frqncy --reflect\`. Reviewed 1 deliberation from 2026-04-29. Model: \`m\`. Cost: $0.01.

## Corpus reviewed

- *2026-04-29-q*

---

## Action items

- [ ] open
`;
    await writeFile(join(dir, '2026-04-29-r.md'), raw, 'utf-8');
    await runFrqncyReflectionsCommand({ dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].slug).toBe('2026-04-29-r');
    expect(parsed[0].actionItems).toHaveLength(1);
  });
});

describe('runFrqncyActionsCommand', () => {
  let dir: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frqncy-actions-cmd-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(dir, { recursive: true, force: true });
  });

  async function seedReflection(slug: string, date: string, items: string) {
    const raw = `# Deliberation reflection — ${date}

> Generated by \`frqncy-harness frqncy --reflect\`. Reviewed 1 deliberation from ${date}. Model: \`m\`. Cost: $0.01.

## Corpus reviewed

- *${date}-q*

---

## Action items

${items}
`;
    await writeFile(join(dir, `${slug}.md`), raw, 'utf-8');
  }

  it('returns empty + clean-state hint when no open items', async () => {
    await seedReflection('2026-04-29-r', '2026-04-29', '- [x] all done\n- [x] also done');
    const result = await runFrqncyActionsCommand({ dir });
    expect(result).toEqual([]);
    expect(stdoutBuffer).toContain('no open action items');
  });

  it('lists open items grouped by reflection in date-desc order', async () => {
    await seedReflection('2026-04-25-old', '2026-04-25', '- [ ] older open\n- [x] older done');
    await seedReflection('2026-04-29-new', '2026-04-29', '- [ ] newer open A\n- [ ] newer open B');
    await runFrqncyActionsCommand({ dir });
    // Most-recent reflection should be rendered first
    const newerIdx = stdoutBuffer.indexOf('2026-04-29-new');
    const olderIdx = stdoutBuffer.indexOf('2026-04-25-old');
    expect(newerIdx).toBeGreaterThan(0);
    expect(olderIdx).toBeGreaterThan(newerIdx);
    expect(stdoutBuffer).toContain('newer open A');
    expect(stdoutBuffer).toContain('newer open B');
    expect(stdoutBuffer).toContain('older open');
    expect(stdoutBuffer).not.toContain('older done');
  });

  it('--include-done shows checked items too', async () => {
    await seedReflection('2026-04-29-r', '2026-04-29', '- [ ] open\n- [x] done');
    const result = await runFrqncyActionsCommand({ dir, includeDone: true });
    expect(result).toHaveLength(2);
    expect(stdoutBuffer).toContain('open');
    expect(stdoutBuffer).toContain('done');
  });

  it('emits structured JSON with --json (includes reflectionSlug + reflectionDate per item)', async () => {
    await seedReflection('2026-04-29-r', '2026-04-29', '- [ ] item one');
    await runFrqncyActionsCommand({ dir, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      text: 'item one',
      done: false,
      reflectionSlug: '2026-04-29-r',
      reflectionDate: '2026-04-29',
    });
  });
});

describe('ROUTING_INSTRUCTIONS and SYNTHESIS_INSTRUCTIONS', () => {
  it('routing instructions name all three actions', () => {
    expect(ROUTING_INSTRUCTIONS).toContain('direct');
    expect(ROUTING_INSTRUCTIONS).toContain('single');
    expect(ROUTING_INSTRUCTIONS).toContain('multi');
  });

  it('routing instructions list every available persona slug', () => {
    for (const member of COUNCIL_MEMBERS) {
      expect(ROUTING_INSTRUCTIONS).toContain(member);
    }
    // Spot-check non-Council slugs
    expect(ROUTING_INSTRUCTIONS).toContain('ceo');
    expect(ROUTING_INSTRUCTIONS).toContain('frontend-dev');
    expect(ROUTING_INSTRUCTIONS).toContain('learning-agent');
  });

  it('synthesis instructions tell FRQNCY to speak as itself, not list back personas', () => {
    expect(SYNTHESIS_INSTRUCTIONS.toLowerCase()).toContain('do not say');
    expect(SYNTHESIS_INSTRUCTIONS.toLowerCase()).toContain('your voice');
  });
});
