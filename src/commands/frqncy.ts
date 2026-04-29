/**
 * `frqncy-harness frqncy [--persona <name>] [--council] "<prompt>"`
 *
 * The router command for FRQNCY OS — Orli's personal AI organization. Loads
 * persona .md files from disk (default: `<cwd>/frqncy-os/`), invokes one or
 * more via `chat()`, returns the response(s).
 *
 * Three modes:
 *   1. `frqncy "<prompt>"`              — invoke FRQNCY (the Jarvis router)
 *   2. `frqncy --persona <name> "<p>"`  — invoke a specific persona directly
 *   3. `frqncy --council "<question>"`  — invoke all 7 Council members in parallel
 *
 * Pi-aligned design (per `proposals/pi-coding-agent-zechner.md`):
 *   - Filesystem is the substrate. Personas are flat .md files; no registry.
 *   - Top-level dispatch only. No persona ever spawns another persona mid-chat.
 *   - Council convene = parallel independent invocations + structured result.
 *     The user (or FRQNCY) integrates; the personas don't share state.
 *   - Minimal command surface — three modes, one shared resolver, one shared chat call.
 *
 * Each invocation tagged with thread=`frqncy-os/<persona>`, project=`frqncy-os`
 * so all FRQNCY OS traces can be queried as one unit by `reflect`/`codify`/`gain`.
 *
 * Safety: every invocation gets the inoculation sentence (it's already baked into
 * each persona's system prompt). Cost cap inherited from config.
 *
 * v0.10 limitation: FRQNCY does NOT auto-route to other personas yet. It responds
 * with its own synthesis. To invoke a specific persona, use `--persona <name>`.
 * Auto-routing (FRQNCY decides which persona to invoke) lands in v0.11.
 */
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { chat as defaultChat } from '../chat.js';
import { loadConfig } from '../config.js';
import type { ChatInput, ChatResult, ModelString } from '../types.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
};

const DEFAULT_PERSONA_DIR = 'frqncy-os';
const DEFAULT_FRQNCY_PERSONA = 'frqncy';
const COUNCIL_MEMBERS = [
  'krishna',
  'kali',
  'merlin',
  'saraswati',
  'sai-maa',
  'gary-spivey',
  'kevin-trudeau',
] as const;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface PersonaFrontmatter {
  name: string;
  role: string;
  parent?: string;
  model?: string;
  voice?: string;
  veto_authority?: boolean;
  evolves?: boolean;
}

export interface LoadedPersona {
  /** The persona's slug (filename minus .md). */
  slug: string;
  /** Absolute path to the persona file. */
  path: string;
  /** Parsed frontmatter. */
  frontmatter: PersonaFrontmatter;
  /** The system-prompt body (everything after the frontmatter). */
  body: string;
}

export interface PersonaResponse {
  persona: string;
  conversationId: string;
  text: string;
  costUsd: number;
  model: string;
}

export type FrqncyMode = 'auto' | 'direct' | 'persona' | 'council';

/** Routing decision FRQNCY emits in auto mode. */
export type RoutingDecision =
  | { action: 'direct'; response: string }
  | { action: 'single'; persona: string; reason: string }
  | { action: 'multi'; personas: string[]; reason: string };

export interface FrqncyResult {
  mode: FrqncyMode;
  /** For mode=persona/direct: 1 response. For council: 7. For auto: 1 (direct) or 1+N (route + invocations) or 2+N (route + invocations + synthesis). */
  responses: PersonaResponse[];
  /** When auto mode dispatched a routing call, the parsed decision. */
  routingDecision?: RoutingDecision;
  /** When auto mode synthesized multi-persona responses, the synthesis text. */
  synthesisText?: string;
  /** When --save was set and a deliberation was written, the path to the saved file. */
  deliberationPath?: string;
  totalCostUsd: number;
}

export interface FrqncyCommandOptions {
  /** Persona slug to invoke directly. Mutually exclusive with --council and --no-route. */
  persona?: string;
  /** Convene the full Council (7 parallel invocations). Mutually exclusive with --persona and --no-route. */
  council?: boolean;
  /** Disable auto-routing — invoke FRQNCY persona once and return its response unmodified (v0.11 behavior). */
  noRoute?: boolean;
  /**
   * Save Council convenes (or auto-mode multi-persona deliberations) as a structured
   * Markdown record at `<cwd>/proposals/council-deliberations/<date>-<slug>.md`.
   * The trace store already captures every invocation; this is the human-readable rendering.
   */
  save?: boolean;
  /** Override the model (otherwise uses each persona's frontmatter `model`). */
  model?: string;
  /** Override the persona directory. Default: `<cwd>/frqncy-os/`. */
  personaDir?: string;
  /** Override cwd for default persona-dir resolution. */
  cwd?: string;
  /** Emit JSON instead of human-readable. */
  json?: boolean;
  // Test seams ─────────────────────────────────────────────
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
  /** Substitute the persona loader. Defaults to filesystem read. */
  loadPersonaFn?: (slug: string, baseDir: string) => Promise<LoadedPersona | null>;
}

// ────────────────────────────────────────────────────────────────────
// Routing instructions (auto mode)
// ────────────────────────────────────────────────────────────────────

export const ROUTING_INSTRUCTIONS = `

## Routing protocol (auto mode)

The user's prompt arrived without explicit persona selection. Decide who should handle it. You have three options:

1. **direct** — answer it yourself. Use this for small/conversational/meta questions where invoking another persona would be theater.
2. **single** — route to ONE other persona (Council member, CEO, C-Suite, or Worker).
3. **multi** — convene 2 or more personas in parallel (e.g. Sai Maa for grounding + CEO for the operational move).

You MUST emit your decision on a single line, prefixed exactly with \`[ROUTE]: \`, as a JSON object. Examples:

\`[ROUTE]: {"action":"direct","response":"<your full answer in your voice>"}\`
\`[ROUTE]: {"action":"single","persona":"kali","reason":"<one sentence why>"}\`
\`[ROUTE]: {"action":"multi","personas":["sai-maa","ceo"],"reason":"<one sentence why>"}\`

After the [ROUTE] line you may add prose, but the orchestrator parses only the [ROUTE] line. For action=single and action=multi, the orchestrator will invoke the named personas and may call you back to synthesize their responses.

Persona slugs you may route to (use these EXACT lowercase-hyphenated forms): frqncy, krishna, kali, merlin, saraswati, sai-maa, gary-spivey, kevin-trudeau, ceo, cto, cmo, coo, cso, cfo, frontend-dev, backend-dev, prompt-engineer, qa-engineer, text-content-writer, storyteller, video-content-producer, visual-artist, designer, sales-strategist, marketing-specialist, operations-coordinator, talent-scout, legal-researcher, finance-manager, investment-analyst, strategy-analyst, business-development, research-analyst, learning-agent.

If the prompt is small enough that routing would be wasteful, USE direct. Routing is a real cost in tokens and latency — only invoke other personas when the answer materially benefits from their voice.`;

export const SYNTHESIS_INSTRUCTIONS = `

## Synthesis (you are now integrating the personas you just convened)

Below are the user's original prompt, your routing reason, and the responses each invoked persona produced. Integrate them into a single response in YOUR voice (FRQNCY) — concise, plain, ready for Orli to act on.

Do not list the personas back at the user. Do not say "Sai Maa says... Krishna says..." — speak as FRQNCY, drawing on what you just heard.

Do not include the [ROUTE] line — the routing decision is already made. Just synthesize.`;

// ────────────────────────────────────────────────────────────────────
// Routing parser (exported for testing)
// ────────────────────────────────────────────────────────────────────

export function parseRoutingDecision(modelText: string): RoutingDecision | null {
  // Look for `[ROUTE]: {...}` on any line. The JSON ends at the matching closing brace.
  const match = modelText.match(/\[ROUTE\]:\s*(\{[\s\S]*?\})/);
  if (!match || !match[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (parsed.action === 'direct' && typeof parsed.response === 'string') {
      return { action: 'direct', response: parsed.response };
    }
    if (parsed.action === 'single' && typeof parsed.persona === 'string' && typeof parsed.reason === 'string') {
      return { action: 'single', persona: parsed.persona, reason: parsed.reason };
    }
    if (
      parsed.action === 'multi' &&
      Array.isArray(parsed.personas) &&
      parsed.personas.every((p) => typeof p === 'string') &&
      typeof parsed.reason === 'string'
    ) {
      return { action: 'multi', personas: parsed.personas as string[], reason: parsed.reason };
    }
    return null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

export async function runFrqncyCommand(prompt: string, options: FrqncyCommandOptions = {}): Promise<FrqncyResult> {
  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required. Usage: frqncy-harness frqncy [--persona <name>] [--council] [--no-route] "<prompt>"');
  }
  if (options.persona && options.council) {
    throw new Error('--persona and --council are mutually exclusive');
  }

  const config = await loadConfig();
  const cwd = options.cwd ?? process.cwd();
  const chatFn = options.chatFn ?? defaultChat;
  const loadPersonaFn = options.loadPersonaFn ?? defaultLoadPersona;
  const personaDir = options.personaDir ?? resolveDefaultPersonaDir(cwd);
  const modelOverride = options.model as ModelString | undefined;

  const banner = (msg: string): void => {
    if (!options.json) process.stdout.write(msg);
  };

  // Determine mode. The new default (no --persona, no --council, no --no-route) is `auto`.
  const mode: FrqncyMode = options.council
    ? 'council'
    : options.persona
      ? 'persona'
      : options.noRoute
        ? 'direct'
        : 'auto';

  banner(
    `${ANSI.bold}${ANSI.cyan}frqncy${ANSI.reset} ${ANSI.dim}mode=${mode}${ANSI.reset}\n` +
      `${ANSI.dim}persona dir: ${personaDir}${ANSI.reset}\n\n`,
  );

  // ── Auto mode (the v0.12 default) ──────────────────────────────
  if (mode === 'auto') {
    return runAutoMode({ prompt, personaDir, chatFn, loadPersonaFn, modelOverride, options, config, banner });
  }

  // ── persona / council / direct: load + invoke ──────────────────
  const personaSlugs: string[] =
    mode === 'council'
      ? [...COUNCIL_MEMBERS]
      : mode === 'persona'
        ? [options.persona!]
        : [DEFAULT_FRQNCY_PERSONA]; // direct mode

  const personas: LoadedPersona[] = [];
  for (const slug of personaSlugs) {
    const loaded = await loadPersonaFn(slug, personaDir);
    if (!loaded) {
      throw new Error(
        `persona "${slug}" not found in ${personaDir}. ` +
          `Run \`frqncy-harness frqncy --list\` to see available personas, or check the path.`,
      );
    }
    personas.push(loaded);
  }

  const invocations = personas.map((persona) =>
    invokePersona({
      persona,
      prompt,
      chatFn,
      modelOverride,
      costCap: config.costCap,
    }),
  );

  const responses = await Promise.all(invocations);
  const totalCostUsd = responses.reduce((sum, r) => sum + r.costUsd, 0);

  // ── Optional --save: write a Council deliberation file ──
  let deliberationPath: string | undefined;
  if (options.save && mode === 'council') {
    deliberationPath = await saveCouncilDeliberation({
      cwd,
      question: prompt,
      responses,
      generatedAt: new Date().toISOString(),
    });
    if (!options.json) {
      process.stdout.write(
        `\n${ANSI.green}✓ deliberation saved${ANSI.reset} ${ANSI.dim}${deliberationPath}${ANSI.reset}\n`,
      );
    }
  }

  const result: FrqncyResult = {
    mode,
    responses,
    totalCostUsd,
    ...(deliberationPath ? { deliberationPath } : {}),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  renderHumanReadable(result);
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Auto mode — FRQNCY routes, then dispatches
// ────────────────────────────────────────────────────────────────────

interface AutoModeArgs {
  prompt: string;
  personaDir: string;
  chatFn: (input: ChatInput) => Promise<ChatResult>;
  loadPersonaFn: (slug: string, baseDir: string) => Promise<LoadedPersona | null>;
  modelOverride: ModelString | undefined;
  options: FrqncyCommandOptions;
  config: { costCap: { softWarnUsd?: number; hardAbortUsd?: number } };
  banner: (msg: string) => void;
}

async function runAutoMode(args: AutoModeArgs): Promise<FrqncyResult> {
  // 1. Load FRQNCY persona
  const frqncyPersona = await args.loadPersonaFn(DEFAULT_FRQNCY_PERSONA, args.personaDir);
  if (!frqncyPersona) {
    throw new Error(
      `FRQNCY persona ("${DEFAULT_FRQNCY_PERSONA}") not found in ${args.personaDir}. ` +
        `This is the router persona — it must exist for auto mode.`,
    );
  }

  // 2. Ask FRQNCY for a routing decision
  args.banner(`${ANSI.dim}── routing pass: FRQNCY decides who handles this ──${ANSI.reset}\n`);
  const routingResult = await invokePersona({
    persona: frqncyPersona,
    prompt: args.prompt,
    chatFn: args.chatFn,
    modelOverride: args.modelOverride,
    costCap: args.config.costCap,
    systemPromptSuffix: ROUTING_INSTRUCTIONS,
  });

  const decision = parseRoutingDecision(routingResult.text);
  const allResponses: PersonaResponse[] = [routingResult];

  // 3a. Fallback: malformed routing → return FRQNCY's text as-is
  if (!decision) {
    args.banner(
      `${ANSI.yellow}!${ANSI.reset} ${ANSI.dim}routing decision could not be parsed; returning FRQNCY's response as-is.${ANSI.reset}\n\n`,
    );
    const result: FrqncyResult = {
      mode: 'auto',
      responses: allResponses,
      totalCostUsd: routingResult.costUsd,
    };
    if (args.options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    renderHumanReadable(result);
    return result;
  }

  args.banner(`${ANSI.dim}  decision: ${decision.action}${ANSI.reset}\n`);

  // 3b. Direct: FRQNCY answered itself
  if (decision.action === 'direct') {
    const directResponse: PersonaResponse = { ...routingResult, text: decision.response };
    const result: FrqncyResult = {
      mode: 'auto',
      responses: [directResponse],
      routingDecision: decision,
      totalCostUsd: routingResult.costUsd,
    };
    if (args.options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    renderHumanReadable(result);
    return result;
  }

  // 3c. Single or multi: invoke the chosen persona(s)
  const targetSlugs = decision.action === 'single' ? [decision.persona] : decision.personas;
  args.banner(`${ANSI.dim}  invoking: ${targetSlugs.join(', ')}${ANSI.reset}\n`);

  const targets: LoadedPersona[] = [];
  for (const slug of targetSlugs) {
    const loaded = await args.loadPersonaFn(slug, args.personaDir);
    if (!loaded) {
      throw new Error(
        `FRQNCY routed to persona "${slug}" but the file was not found in ${args.personaDir}. ` +
          `Either the routing decision is wrong, or your persona dir is missing files.`,
      );
    }
    targets.push(loaded);
  }

  const targetResponses = await Promise.all(
    targets.map((persona) =>
      invokePersona({
        persona,
        prompt: args.prompt,
        chatFn: args.chatFn,
        modelOverride: args.modelOverride,
        costCap: args.config.costCap,
      }),
    ),
  );
  allResponses.push(...targetResponses);

  // 3d. Single persona: return their response (no synthesis needed)
  if (decision.action === 'single') {
    const totalCostUsd = allResponses.reduce((sum, r) => sum + r.costUsd, 0);
    const result: FrqncyResult = {
      mode: 'auto',
      responses: allResponses,
      routingDecision: decision,
      totalCostUsd,
    };
    if (args.options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    renderHumanReadable(result);
    return result;
  }

  // 3e. Multi: call FRQNCY again to synthesize
  args.banner(`${ANSI.dim}── synthesis pass: FRQNCY integrates ${targets.length} responses ──${ANSI.reset}\n`);
  const synthesisPrompt = buildSynthesisPrompt(args.prompt, decision.reason, targetResponses);
  const synthesisResult = await invokePersona({
    persona: frqncyPersona,
    prompt: synthesisPrompt,
    chatFn: args.chatFn,
    modelOverride: args.modelOverride,
    costCap: args.config.costCap,
    systemPromptSuffix: SYNTHESIS_INSTRUCTIONS,
  });
  allResponses.push(synthesisResult);

  // 3f. Optional --save: write a deliberation file for the multi-persona convene
  let deliberationPath: string | undefined;
  if (args.options.save) {
    const userCwd = args.options.cwd ?? process.cwd();
    deliberationPath = await saveAutoModeDeliberation({
      cwd: userCwd,
      question: args.prompt,
      responses: targetResponses, // only the persona invocations, not the routing/synthesis passes
      synthesisText: synthesisResult.text,
      routingReason: decision.reason,
      generatedAt: new Date().toISOString(),
    });
    args.banner(
      `\n${ANSI.green}✓ deliberation saved${ANSI.reset} ${ANSI.dim}${deliberationPath}${ANSI.reset}\n`,
    );
  }

  const totalCostUsd = allResponses.reduce((sum, r) => sum + r.costUsd, 0);
  const result: FrqncyResult = {
    mode: 'auto',
    responses: allResponses,
    routingDecision: decision,
    synthesisText: synthesisResult.text,
    totalCostUsd,
    ...(deliberationPath ? { deliberationPath } : {}),
  };

  if (args.options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  renderHumanReadable(result);
  return result;
}

export function buildSynthesisPrompt(
  userPrompt: string,
  routingReason: string,
  personaResponses: PersonaResponse[],
): string {
  const lines = [
    `## User's original prompt`,
    ``,
    userPrompt,
    ``,
    `## Why you routed (your reason from the [ROUTE] decision)`,
    ``,
    routingReason,
    ``,
    `## Responses from the personas you invoked`,
    ``,
  ];
  for (const r of personaResponses) {
    lines.push(`### ${r.persona}`, ``, r.text.trim(), ``);
  }
  lines.push(`## Synthesize`, ``, `Integrate the above into a single response in your voice (FRQNCY) for Orli.`);
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────
// Persona invocation
// ────────────────────────────────────────────────────────────────────

interface InvokeArgs {
  persona: LoadedPersona;
  prompt: string;
  chatFn: (input: ChatInput) => Promise<ChatResult>;
  modelOverride?: ModelString;
  costCap: { softWarnUsd?: number; hardAbortUsd?: number };
  /** Appended to the persona body for routing/synthesis passes. */
  systemPromptSuffix?: string;
}

async function invokePersona(args: InvokeArgs): Promise<PersonaResponse> {
  const { persona } = args;
  const model = (args.modelOverride ?? persona.frontmatter.model ?? 'anthropic/claude-sonnet-4-6') as ModelString;
  const system = args.systemPromptSuffix ? persona.body + args.systemPromptSuffix : persona.body;
  const result = await args.chatFn({
    model,
    messages: [{ role: 'user', content: args.prompt }],
    system,
    threadId: `frqncy-os/${persona.slug}`,
    projectId: 'frqncy-os',
    costCap: { softWarnUsd: args.costCap.softWarnUsd, hardAbortUsd: args.costCap.hardAbortUsd },
  });
  return {
    persona: persona.frontmatter.name || persona.slug,
    conversationId: result.conversationId,
    text: result.text,
    costUsd: result.usage.costUsd ?? 0,
    model,
  };
}

// ────────────────────────────────────────────────────────────────────
// Persona loading (exported for testing)
// ────────────────────────────────────────────────────────────────────

const PERSONA_SUBDIRS = ['', 'council', 'c-suite', 'workers'];

export async function defaultLoadPersona(slug: string, baseDir: string): Promise<LoadedPersona | null> {
  for (const sub of PERSONA_SUBDIRS) {
    const path = sub ? join(baseDir, sub, `${slug}.md`) : join(baseDir, `${slug}.md`);
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const { frontmatter, body } = parsePersonaFile(raw);
      return { slug, path, frontmatter, body };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

export function parsePersonaFile(raw: string): { frontmatter: PersonaFrontmatter; body: string } {
  if (!raw.startsWith('---\n')) {
    return { frontmatter: { name: '', role: '' }, body: raw.trim() };
  }
  const closeIdx = raw.indexOf('\n---', 4);
  if (closeIdx === -1) {
    return { frontmatter: { name: '', role: '' }, body: raw.trim() };
  }
  const fmRaw = raw.slice(4, closeIdx);
  const body = raw.slice(closeIdx + 4).replace(/^\n+/, '').trimEnd();

  const frontmatter: PersonaFrontmatter = { name: '', role: '' };
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (!m || !m[1]) continue;
    const key = m[1];
    const valRaw = (m[2] ?? '').trim().replace(/^["']|["']$/g, '');
    if (key === 'name' || key === 'role' || key === 'parent' || key === 'model' || key === 'voice') {
      frontmatter[key] = valRaw;
    } else if (key === 'veto_authority' || key === 'evolves') {
      frontmatter[key] = valRaw === 'true';
    }
  }
  return { frontmatter, body };
}

// ────────────────────────────────────────────────────────────────────
// Persona discovery (exported)
// ────────────────────────────────────────────────────────────────────

export async function listPersonas(baseDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const sub of PERSONA_SUBDIRS) {
    const dir = sub ? join(baseDir, sub) : baseDir;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md')) {
          found.push(e.name.slice(0, -3));
        }
      }
    } catch {
      // directory missing — skip
    }
  }
  return found.sort();
}

// ────────────────────────────────────────────────────────────────────
// Grouped persona listing (v0.13.2)
// ────────────────────────────────────────────────────────────────────

export type PersonaTier = 'FRQNCY' | 'Council' | 'C-Suite' | 'Workers' | 'Meta';

export interface PersonaListing {
  slug: string;
  tier: PersonaTier;
  name: string;
  role: string;
  parent?: string;
  model?: string;
  evolves: boolean;
  vetoAuthority: boolean;
  path: string;
}

const META_PERSONAS: ReadonlySet<string> = new Set(['learning-agent']);

function tierForSlugAndPath(slug: string, path: string): PersonaTier {
  if (slug === DEFAULT_FRQNCY_PERSONA) return 'FRQNCY';
  if (META_PERSONAS.has(slug)) return 'Meta';
  if (path.includes(`/council/`)) return 'Council';
  if (path.includes(`/c-suite/`)) return 'C-Suite';
  if (path.includes(`/workers/`)) return 'Workers';
  // Root-level files that aren't FRQNCY or Meta — classify as Meta as a safe default
  return 'Meta';
}

/**
 * Walk every persona file under baseDir and return a structured listing
 * with frontmatter parsed. Useful for `frqncy --list` and any UI/inspector.
 */
export async function listPersonasGrouped(baseDir: string): Promise<PersonaListing[]> {
  const out: PersonaListing[] = [];
  for (const sub of PERSONA_SUBDIRS) {
    const dir = sub ? join(baseDir, sub) : baseDir;
    let entries: { name: string; isFile: () => boolean }[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const slug = e.name.slice(0, -3);
      const path = join(dir, e.name);
      let raw: string;
      try {
        raw = await fs.readFile(path, 'utf-8');
      } catch {
        continue;
      }
      const { frontmatter } = parsePersonaFile(raw);
      out.push({
        slug,
        tier: tierForSlugAndPath(slug, path),
        name: frontmatter.name || slug,
        role: frontmatter.role || '',
        ...(frontmatter.parent ? { parent: frontmatter.parent } : {}),
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
        evolves: frontmatter.evolves ?? true,
        vetoAuthority: frontmatter.veto_authority ?? false,
        path,
      });
    }
  }
  // Sort: tier order first, then slug
  const TIER_ORDER: Record<PersonaTier, number> = {
    FRQNCY: 0,
    Council: 1,
    'C-Suite': 2,
    Workers: 3,
    Meta: 4,
  };
  out.sort((a, b) => {
    if (TIER_ORDER[a.tier] !== TIER_ORDER[b.tier]) return TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

export interface FrqncyListOptions {
  /** Override the persona directory. Default: `<cwd>/frqncy-os/`. */
  personaDir?: string;
  cwd?: string;
  json?: boolean;
}

/**
 * `frqncy --list` — enumerate every persona in the org with tier, role, model,
 * evolves status, and veto authority.
 */
export async function runFrqncyListCommand(options: FrqncyListOptions = {}): Promise<PersonaListing[]> {
  const cwd = options.cwd ?? process.cwd();
  const personaDir = options.personaDir ?? resolveDefaultPersonaDir(cwd);
  const listing = await listPersonasGrouped(personaDir);

  if (options.json) {
    process.stdout.write(JSON.stringify(listing, null, 2) + '\n');
    return listing;
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}FRQNCY OS${ANSI.reset} ${ANSI.dim}— ${listing.length} personas in ${personaDir}${ANSI.reset}\n\n`,
  );

  const TIERS: PersonaTier[] = ['FRQNCY', 'Council', 'C-Suite', 'Workers', 'Meta'];
  for (const tier of TIERS) {
    const members = listing.filter((p) => p.tier === tier);
    if (members.length === 0) continue;
    process.stdout.write(`${ANSI.bold}${ANSI.magenta}── ${tier} (${members.length}) ──${ANSI.reset}\n`);
    for (const p of members) {
      const flags: string[] = [];
      if (!p.evolves) flags.push('evolves:false');
      if (p.vetoAuthority) flags.push('veto');
      const flagsStr = flags.length > 0 ? ` ${ANSI.yellow}[${flags.join(', ')}]${ANSI.reset}` : '';
      const modelStr = p.model ? ` ${ANSI.dim}(${p.model})${ANSI.reset}` : '';
      const parentStr = p.parent ? ` ${ANSI.dim}← ${p.parent}${ANSI.reset}` : '';
      process.stdout.write(
        `  ${ANSI.cyan}${p.slug}${ANSI.reset}${flagsStr} ${ANSI.dim}— ${p.role}${ANSI.reset}${parentStr}${modelStr}\n`,
      );
    }
    process.stdout.write(`\n`);
  }

  process.stdout.write(
    `${ANSI.dim}Invoke a specific persona: \`frqncy-harness frqncy --persona <slug> "<prompt>"\`${ANSI.reset}\n` +
      `${ANSI.dim}Convene the Council:      \`frqncy-harness frqncy --council "<question>"\`${ANSI.reset}\n` +
      `${ANSI.dim}Auto-route (default):     \`frqncy-harness frqncy "<prompt>"\`${ANSI.reset}\n`,
  );
  return listing;
}

// ────────────────────────────────────────────────────────────────────
// Persona inspector (v0.13.4)
// ────────────────────────────────────────────────────────────────────

export interface PersonaInspection {
  slug: string;
  tier: PersonaTier;
  path: string;
  frontmatter: PersonaFrontmatter;
  body: string;
  bodyBytes: number;
  hasInoculation: boolean;
}

/**
 * Read a single persona file and return everything you'd want to know about
 * it: frontmatter, full body, byte count, and whether the inoculation invariant
 * is present. Returns null if not found.
 */
export async function inspectPersona(slug: string, baseDir: string): Promise<PersonaInspection | null> {
  // Try each known subdirectory until we find it (matches defaultLoadPersona)
  for (const sub of PERSONA_SUBDIRS) {
    const path = sub ? join(baseDir, sub, `${slug}.md`) : join(baseDir, `${slug}.md`);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const { frontmatter, body } = parsePersonaFile(raw);
    return {
      slug,
      tier: tierForSlugAndPath(slug, path),
      path,
      frontmatter,
      body,
      bodyBytes: Buffer.byteLength(body, 'utf-8'),
      hasInoculation: body.includes(PERSONA_INOCULATION_INVARIANT),
    };
  }
  return null;
}

export interface FrqncyShowOptions {
  personaDir?: string;
  cwd?: string;
  json?: boolean;
}

export async function runFrqncyShowCommand(slug: string, options: FrqncyShowOptions = {}): Promise<PersonaInspection> {
  if (!slug || !slug.trim()) {
    throw new Error('Persona slug required. Usage: frqncy-harness frqncy --show <slug>');
  }
  const cwd = options.cwd ?? process.cwd();
  const personaDir = options.personaDir ?? resolveDefaultPersonaDir(cwd);
  const inspection = await inspectPersona(slug.trim(), personaDir);
  if (!inspection) {
    throw new Error(
      `persona "${slug}" not found in ${personaDir}. ` +
        `Run \`frqncy-harness frqncy --list\` to see available slugs.`,
    );
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(inspection, null, 2) + '\n');
    return inspection;
  }

  const fm = inspection.frontmatter;
  const flags: string[] = [];
  if (fm.evolves === false) flags.push('evolves:false');
  if (fm.veto_authority === true) flags.push('veto');
  const flagsStr = flags.length > 0 ? ` ${ANSI.yellow}[${flags.join(', ')}]${ANSI.reset}` : '';

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}${inspection.slug}${ANSI.reset}${flagsStr} ${ANSI.dim}(${inspection.tier})${ANSI.reset}\n` +
      `${ANSI.dim}${inspection.path}${ANSI.reset}\n\n`,
  );

  // Frontmatter section
  process.stdout.write(`${ANSI.bold}${ANSI.magenta}── frontmatter ──${ANSI.reset}\n`);
  if (fm.name) process.stdout.write(`  name:           ${fm.name}\n`);
  if (fm.role) process.stdout.write(`  role:           ${fm.role}\n`);
  if (fm.parent) process.stdout.write(`  parent:         ${fm.parent}\n`);
  if (fm.model) process.stdout.write(`  model:          ${fm.model}\n`);
  if (fm.voice) process.stdout.write(`  voice:          ${fm.voice}\n`);
  if (fm.veto_authority !== undefined) process.stdout.write(`  veto_authority: ${fm.veto_authority}\n`);
  if (fm.evolves !== undefined) process.stdout.write(`  evolves:        ${fm.evolves}\n`);

  // Body stats
  process.stdout.write(
    `\n${ANSI.bold}${ANSI.magenta}── system prompt ──${ANSI.reset} ` +
      `${ANSI.dim}${inspection.bodyBytes} bytes · inoculation: ${inspection.hasInoculation ? `${ANSI.green}✓${ANSI.dim}` : `${ANSI.yellow}✗ missing${ANSI.dim}`}${ANSI.reset}\n`,
  );
  process.stdout.write(inspection.body + '\n');
  return inspection;
}

/**
 * The canonical inoculation sentence — every persona body should include
 * this verbatim per Anthropic's Nov 2025 reward-hacking paper (arXiv 2511.18397).
 * The validator only checks for a substring match against a stable invariant
 * fragment (not the full sentence) so cosmetic edits don't trip false positives.
 */
export const PERSONA_INOCULATION_INVARIANT =
  'reward hacking — proposing fixes that pass surface checks but degrade';

/** External roots that may legitimately appear in a `parent:` string. */
const EXTERNAL_PARENT_ROOTS: ReadonlySet<string> = new Set(['orli', 'god']);

export type ValidationSeverity = 'error' | 'warning';

export type ValidationCategory =
  | 'missing-required'
  | 'orphan-parent'
  | 'duplicate-slug'
  | 'inoculation-missing'
  | 'council-rule'
  | 'evolves-rule'
  | 'frontmatter-incomplete';

export interface ValidationIssue {
  severity: ValidationSeverity;
  category: ValidationCategory;
  slug?: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  totalPersonas: number;
  errorCount: number;
  warningCount: number;
  issues: ValidationIssue[];
}

/**
 * Extract the first slug-like token from a parent string. Examples:
 *   "ceo"                                    → "ceo"
 *   "cto"                                    → "cto"
 *   "orli (via FRQNCY)"                      → "orli"
 *   "god + orli (NOT CEO; reports up only)"  → "god"
 *   ""                                       → null
 */
export function extractFirstParentSlug(parent: string | undefined): string | null {
  if (!parent) return null;
  const m = parent.trim().match(/^([a-z][a-z0-9-]*)/);
  return m && m[1] ? m[1] : null;
}

/**
 * Validate the FRQNCY OS persona dir against the architectural invariants.
 *
 * Rules (each produces zero or more issues):
 *   1. FRQNCY persona exists at root (error if missing)
 *   2. All 7 canonical Council members exist (error per missing)
 *   3. Council members must have evolves: false (error per violation)
 *   4. Learning Agent should have evolves: false (error if true; warning if missing)
 *   5. C-Suite (non-CEO) parent slug must resolve to 'ceo' (warning if not)
 *   6. Worker parent slug must resolve to an existing persona (error if orphaned)
 *   7. Every persona body should contain the inoculation invariant (warning if missing)
 *   8. No duplicate slug across tiers (error)
 *   9. Every persona must have name + role frontmatter (warning if blank)
 */
export async function validateFrqncyOs(baseDir: string): Promise<ValidationResult> {
  const listing = await listPersonasGrouped(baseDir);
  const issues: ValidationIssue[] = [];
  const slugSet = new Set<string>();
  const seenSlugs = new Set<string>();
  for (const p of listing) {
    if (seenSlugs.has(p.slug)) {
      issues.push({
        severity: 'error',
        category: 'duplicate-slug',
        slug: p.slug,
        message: `slug "${p.slug}" appears in multiple tiers — slugs must be globally unique`,
      });
    }
    seenSlugs.add(p.slug);
    slugSet.add(p.slug);
  }

  // Rule 1: FRQNCY exists
  if (!slugSet.has(DEFAULT_FRQNCY_PERSONA)) {
    issues.push({
      severity: 'error',
      category: 'missing-required',
      message: `FRQNCY persona ("${DEFAULT_FRQNCY_PERSONA}") is missing — auto-routing is impossible without it`,
    });
  }

  // Rule 2: Canonical Council
  for (const member of COUNCIL_MEMBERS) {
    if (!slugSet.has(member)) {
      issues.push({
        severity: 'error',
        category: 'missing-required',
        slug: member,
        message: `Council member "${member}" is missing — \`frqncy --council\` would fail to convene`,
      });
    }
  }

  // Rule 3 + 7 + 9: per-persona checks (read body for inoculation)
  for (const p of listing) {
    let raw: string;
    try {
      raw = await fs.readFile(p.path, 'utf-8');
    } catch {
      continue;
    }
    const { body } = parsePersonaFile(raw);

    // Rule 3: Council evolves: false
    if (p.tier === 'Council' && p.evolves !== false) {
      issues.push({
        severity: 'error',
        category: 'evolves-rule',
        slug: p.slug,
        message: `Council member "${p.slug}" must have \`evolves: false\` — Council prompts evolve only by Orli's hand`,
      });
    }

    // Rule 4: Learning Agent evolves: false
    if (p.slug === 'learning-agent' && p.evolves !== false) {
      issues.push({
        severity: 'error',
        category: 'evolves-rule',
        slug: p.slug,
        message: `Learning Agent must have \`evolves: false\` — it cannot evolve itself (would recurse)`,
      });
    }

    // Rule 7: inoculation invariant
    if (!body.includes(PERSONA_INOCULATION_INVARIANT)) {
      issues.push({
        severity: 'warning',
        category: 'inoculation-missing',
        slug: p.slug,
        message: `persona "${p.slug}" body does not contain the inoculation invariant — reward-hacking guidance is missing`,
      });
    }

    // Rule 9: name + role frontmatter
    if (!p.name) {
      issues.push({
        severity: 'warning',
        category: 'frontmatter-incomplete',
        slug: p.slug,
        message: `persona "${p.slug}" has no \`name:\` in frontmatter`,
      });
    }
    if (!p.role) {
      issues.push({
        severity: 'warning',
        category: 'frontmatter-incomplete',
        slug: p.slug,
        message: `persona "${p.slug}" has no \`role:\` in frontmatter`,
      });
    }
  }

  // Rule 4 (continued): Learning Agent missing → warning (not strictly required)
  if (!slugSet.has('learning-agent')) {
    issues.push({
      severity: 'warning',
      category: 'missing-required',
      message: `learning-agent.md is missing — the meta-tier reflection sibling is absent (FRQNCY OS works without it but loses self-improvement at the org level)`,
    });
  }

  // Rule 5 + 6: parent resolution
  for (const p of listing) {
    const firstSlug = extractFirstParentSlug(p.parent);
    if (!firstSlug) {
      // No parent — only acceptable for FRQNCY (which lists Orli) and Council. We already covered those.
      continue;
    }
    if (EXTERNAL_PARENT_ROOTS.has(firstSlug)) continue; // orli, god — fine

    if (p.tier === 'Workers') {
      // Rule 6: must resolve to an existing persona slug (typically C-Suite)
      if (!slugSet.has(firstSlug)) {
        issues.push({
          severity: 'error',
          category: 'orphan-parent',
          slug: p.slug,
          message: `worker "${p.slug}" lists parent "${firstSlug}" but no persona with that slug exists`,
        });
      }
    } else if (p.tier === 'C-Suite' && p.slug !== 'ceo') {
      // Rule 5: non-CEO C-Suite should report to CEO
      if (firstSlug !== 'ceo') {
        issues.push({
          severity: 'warning',
          category: 'council-rule',
          slug: p.slug,
          message: `C-Suite member "${p.slug}" lists parent starting with "${firstSlug}" — convention is for C-Suite to report to "ceo"`,
        });
      }
    } else if (p.tier === 'Meta' || p.tier === 'FRQNCY') {
      // Meta + FRQNCY — accept any parent that resolves OR is external; flag pure orphans
      if (!slugSet.has(firstSlug)) {
        issues.push({
          severity: 'warning',
          category: 'orphan-parent',
          slug: p.slug,
          message: `"${p.slug}" lists parent "${firstSlug}" which is not a known persona or external root (orli/god)`,
        });
      }
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return {
    ok: errorCount === 0,
    totalPersonas: listing.length,
    errorCount,
    warningCount,
    issues,
  };
}

export interface FrqncyValidateOptions {
  personaDir?: string;
  cwd?: string;
  json?: boolean;
}

export async function runFrqncyValidateCommand(options: FrqncyValidateOptions = {}): Promise<ValidationResult> {
  const cwd = options.cwd ?? process.cwd();
  const personaDir = options.personaDir ?? resolveDefaultPersonaDir(cwd);
  const result = await validateFrqncyOs(personaDir);

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}FRQNCY OS validation${ANSI.reset} ${ANSI.dim}— ${personaDir}${ANSI.reset}\n` +
      `${ANSI.dim}${result.totalPersonas} personas scanned${ANSI.reset}\n\n`,
  );

  if (result.issues.length === 0) {
    process.stdout.write(`${ANSI.green}✓ all checks pass${ANSI.reset}\n`);
    return result;
  }

  // Group by severity
  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');

  if (errors.length > 0) {
    process.stdout.write(`${ANSI.bold}\x1b[31m── ${errors.length} error${errors.length === 1 ? '' : 's'} ──${ANSI.reset}\n`);
    for (const i of errors) {
      const prefix = i.slug ? `${ANSI.cyan}${i.slug}${ANSI.reset} ${ANSI.dim}(${i.category})${ANSI.reset}` : ANSI.dim + i.category + ANSI.reset;
      process.stdout.write(`  \x1b[31m✗${ANSI.reset} ${prefix}: ${i.message}\n`);
    }
    process.stdout.write(`\n`);
  }

  if (warnings.length > 0) {
    process.stdout.write(`${ANSI.bold}${ANSI.yellow}── ${warnings.length} warning${warnings.length === 1 ? '' : 's'} ──${ANSI.reset}\n`);
    for (const i of warnings) {
      const prefix = i.slug ? `${ANSI.cyan}${i.slug}${ANSI.reset} ${ANSI.dim}(${i.category})${ANSI.reset}` : ANSI.dim + i.category + ANSI.reset;
      process.stdout.write(`  ${ANSI.yellow}!${ANSI.reset} ${prefix}: ${i.message}\n`);
    }
    process.stdout.write(`\n`);
  }

  if (result.ok) {
    process.stdout.write(
      `${ANSI.green}✓ no errors${ANSI.reset} ${ANSI.dim}(${warnings.length} warning${warnings.length === 1 ? '' : 's'} — review but not blocking)${ANSI.reset}\n`,
    );
  } else {
    process.stdout.write(
      `\x1b[31m✗ ${errors.length} error${errors.length === 1 ? '' : 's'} must be fixed${ANSI.reset} ${ANSI.dim}(plus ${warnings.length} warning${warnings.length === 1 ? '' : 's'})${ANSI.reset}\n`,
    );
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

function resolveDefaultPersonaDir(cwd: string): string {
  return resolve(join(cwd, DEFAULT_PERSONA_DIR));
}

function renderHumanReadable(result: FrqncyResult): void {
  if (result.mode === 'council') {
    process.stdout.write(`${ANSI.bold}${ANSI.magenta}── council convened (${result.responses.length} members) ──${ANSI.reset}\n\n`);
    for (const r of result.responses) {
      process.stdout.write(
        `${ANSI.bold}${ANSI.cyan}── ${r.persona} ──${ANSI.reset} ${ANSI.dim}(${r.model}, $${r.costUsd.toFixed(4)})${ANSI.reset}\n` +
          r.text.trim() +
          '\n\n',
      );
    }
  } else if (result.mode === 'auto' && result.routingDecision) {
    // Auto mode: show routing decision + final response (synthesis if multi, persona if single, direct response if direct)
    const d = result.routingDecision;
    const reasonLine =
      d.action === 'direct'
        ? `${ANSI.dim}FRQNCY answered directly${ANSI.reset}`
        : d.action === 'single'
          ? `${ANSI.dim}FRQNCY routed to ${ANSI.bold}${d.persona}${ANSI.reset} ${ANSI.dim}— ${d.reason}${ANSI.reset}`
          : `${ANSI.dim}FRQNCY routed to ${ANSI.bold}${d.personas.join(', ')}${ANSI.reset} ${ANSI.dim}— ${d.reason}${ANSI.reset}`;
    process.stdout.write(`${ANSI.magenta}[ROUTE]${ANSI.reset} ${reasonLine}\n\n`);

    if (d.action === 'multi' && result.synthesisText) {
      // Final response is the synthesis (last in the responses array)
      process.stdout.write(
        `${ANSI.bold}${ANSI.cyan}── FRQNCY (synthesized) ──${ANSI.reset}\n` + result.synthesisText.trim() + '\n',
      );
    } else if (d.action === 'single') {
      // Final response is the invoked persona's response (responses[1])
      const r = result.responses[1]!;
      process.stdout.write(
        `${ANSI.bold}${ANSI.cyan}── ${r.persona} ──${ANSI.reset} ${ANSI.dim}(${r.model}, $${r.costUsd.toFixed(4)})${ANSI.reset}\n` +
          r.text.trim() +
          '\n',
      );
    } else if (d.action === 'direct') {
      // Direct response is responses[0] but with the parsed text
      const r = result.responses[0]!;
      process.stdout.write(`${ANSI.bold}${ANSI.cyan}── FRQNCY ──${ANSI.reset}\n` + r.text.trim() + '\n');
    }
  } else {
    const r = result.responses[0]!;
    process.stdout.write(
      `${ANSI.bold}${ANSI.cyan}── ${r.persona} ──${ANSI.reset} ${ANSI.dim}(${r.model}, $${r.costUsd.toFixed(4)})${ANSI.reset}\n` +
        r.text.trim() +
        '\n',
    );
  }
  process.stdout.write(
    `\n${ANSI.dim}total cost: $${result.totalCostUsd.toFixed(4)} · all traces tagged thread=frqncy-os/<persona>, project=frqncy-os${ANSI.reset}\n`,
  );
}

export { COUNCIL_MEMBERS, DEFAULT_PERSONA_DIR, DEFAULT_FRQNCY_PERSONA };

// ────────────────────────────────────────────────────────────────────
// Council deliberation file (v0.13)
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_DELIBERATIONS_DIR = 'proposals/council-deliberations';

interface FormatDeliberationArgs {
  question: string;
  responses: PersonaResponse[];
  generatedAt: string;
  /** Title prefix. Default "Council deliberation". Auto-mode multi-persona uses "Routed deliberation". */
  title?: string;
  /** Source command (for the "Generated by" line). Default "frqncy --council --save". */
  source?: string;
  /** When present, the synthesis section embeds this text verbatim instead of the human-write placeholder. */
  synthesisText?: string;
  /** When present, prefixed before the synthesis section to explain WHY these personas were convened. */
  routingReason?: string;
}

/**
 * Format a multi-persona deliberation as a structured Markdown record.
 *
 * The trace store already preserves every invocation as JSONL; this is the
 * human-readable rendering — the durable artifact future agents (or Orli)
 * can read after the fact, link to from a Telegram message, or feed into
 * the Learning Agent's reflection pass.
 *
 * Used by:
 *   - `frqncy --council --save` (default args; "Council deliberation" title; placeholder synthesis)
 *   - auto-mode multi-persona with `--save` (title="Routed deliberation"; embeds FRQNCY's synthesis)
 */
export function formatCouncilDeliberation(args: FormatDeliberationArgs): string {
  const title = args.title ?? 'Council deliberation';
  const source = args.source ?? 'frqncy-harness frqncy --council --save';
  const lines: string[] = [
    `# ${title} — ${args.generatedAt.slice(0, 10)}`,
    ``,
    `> Generated by \`${source}\`. ` +
      (args.synthesisText
        ? `FRQNCY routed the question, the personas responded in parallel, FRQNCY synthesized.`
        : `The Council convened in parallel; each member responded independently. No member spoke for another. FRQNCY (or you) integrates.`),
    ``,
    `## The question`,
    ``,
    args.question,
    ``,
    `## Source metadata`,
    ``,
    `- **Generated:** ${args.generatedAt}`,
    `- **Members convened:** ${args.responses.length}`,
    `- **Total cost:** $${args.responses.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`,
    `- **Trace tags:** \`thread=frqncy-os/<persona>\`, \`project=frqncy-os\``,
    ``,
  ];
  if (args.routingReason) {
    lines.push(`## Routing reason`, ``, args.routingReason, ``);
  }
  lines.push(`---`, ``);
  for (const r of args.responses) {
    lines.push(
      `## ${r.persona}`,
      ``,
      `*Model: \`${r.model}\` · cost: $${r.costUsd.toFixed(4)} · conversation: \`${r.conversationId}\`*`,
      ``,
      r.text.trim(),
      ``,
      `---`,
      ``,
    );
  }
  if (args.synthesisText) {
    lines.push(
      `## Synthesis (FRQNCY)`,
      ``,
      args.synthesisText.trim(),
      ``,
    );
  } else {
    lines.push(
      `## Synthesis (yours to write)`,
      ``,
      `The Council does not vote. They each speak from their domain. Read carefully, ` +
        `feel where they converge, where they diverge, and where one of them named the thing ` +
        `the others danced around. Then write the call you're going to make.`,
      ``,
      `_Your synthesis goes here. Edit this section as the deliberation lands in your nervous system._`,
      ``,
    );
  }
  return lines.join('\n');
}

export function generateDeliberationSlug(question: string, generatedAt: string): string {
  const datePrefix = generatedAt.slice(0, 10);
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 5)
    .join('-')
    .slice(0, 50);
  return `${datePrefix}-${slug || 'council'}`;
}

interface SaveDeliberationArgs {
  cwd: string;
  question: string;
  responses: PersonaResponse[];
  generatedAt: string;
}

async function saveCouncilDeliberation(args: SaveDeliberationArgs): Promise<string> {
  const slug = generateDeliberationSlug(args.question, args.generatedAt);
  const path = join(args.cwd, DEFAULT_DELIBERATIONS_DIR, `${slug}.md`);
  await fs.mkdir(dirname(path), { recursive: true });
  const content = formatCouncilDeliberation({
    question: args.question,
    responses: args.responses,
    generatedAt: args.generatedAt,
  });
  await fs.writeFile(path, content, 'utf-8');
  return path;
}

interface SaveAutoModeDeliberationArgs {
  cwd: string;
  question: string;
  responses: PersonaResponse[];
  synthesisText: string;
  routingReason: string;
  generatedAt: string;
}

async function saveAutoModeDeliberation(args: SaveAutoModeDeliberationArgs): Promise<string> {
  const slug = generateDeliberationSlug(args.question, args.generatedAt);
  const path = join(args.cwd, DEFAULT_DELIBERATIONS_DIR, `${slug}.md`);
  await fs.mkdir(dirname(path), { recursive: true });
  const content = formatCouncilDeliberation({
    question: args.question,
    responses: args.responses,
    generatedAt: args.generatedAt,
    title: 'Routed deliberation',
    source: 'frqncy-harness frqncy --save (auto-routed)',
    synthesisText: args.synthesisText,
    routingReason: args.routingReason,
  });
  await fs.writeFile(path, content, 'utf-8');
  return path;
}
