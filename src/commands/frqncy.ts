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
import { loadThreadHistory, type ThreadHistoryResult } from '../trace.js';
import { INOCULATION_SENTENCE } from './codify.js';
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
  /**
   * v0.14.0 — disable persona memory for this invocation. By default, every
   * persona auto-loads its prior thread history (the trace IS the memory).
   * Set this to true to invoke the persona stateless (useful for testing
   * a fresh prompt or when memory is interfering with a one-shot question).
   */
  noMemory?: boolean;
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

  // Persona memory: ON by default (continuity is the whole point of personas);
  // OFF when --no-memory is set OR when the invocation is a meta-routing pass.
  const useMemory = !options.noMemory;

  const invocations = personas.map((persona) =>
    invokePersona({
      persona,
      prompt,
      chatFn,
      modelOverride,
      costCap: config.costCap,
      loadHistory: useMemory,
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

  // 2. Ask FRQNCY for a routing decision.
  // Routing passes are stateless meta-operations — FRQNCY's routing logic should
  // not be confused by prior conversational context. The actual persona being
  // routed to gets full memory (handled below).
  args.banner(`${ANSI.dim}── routing pass: FRQNCY decides who handles this ──${ANSI.reset}\n`);
  const routingResult = await invokePersona({
    persona: frqncyPersona,
    prompt: args.prompt,
    chatFn: args.chatFn,
    modelOverride: args.modelOverride,
    costCap: args.config.costCap,
    systemPromptSuffix: ROUTING_INSTRUCTIONS,
    loadHistory: false,
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

  // Persona memory: ON for the actual invocations (continuity), OFF only via
  // explicit --no-memory.
  const useMemory = !args.options.noMemory;
  const targetResponses = await Promise.all(
    targets.map((persona) =>
      invokePersona({
        persona,
        prompt: args.prompt,
        chatFn: args.chatFn,
        modelOverride: args.modelOverride,
        costCap: args.config.costCap,
        loadHistory: useMemory,
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

  // 3e. Multi: call FRQNCY again to synthesize.
  // Synthesis is a stateless meta-operation — FRQNCY integrates THIS convene's
  // responses, not prior FRQNCY context (which would lead to drift across
  // unrelated convenes).
  args.banner(`${ANSI.dim}── synthesis pass: FRQNCY integrates ${targets.length} responses ──${ANSI.reset}\n`);
  const synthesisPrompt = buildSynthesisPrompt(args.prompt, decision.reason, targetResponses);
  const synthesisResult = await invokePersona({
    persona: frqncyPersona,
    prompt: synthesisPrompt,
    chatFn: args.chatFn,
    modelOverride: args.modelOverride,
    costCap: args.config.costCap,
    systemPromptSuffix: SYNTHESIS_INSTRUCTIONS,
    loadHistory: false,
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
  /**
   * v0.14.0 — load this persona's prior thread history before the call.
   * Default ON for FRQNCY OS continuity (a Council member should remember the
   * last conversation with Orli). Disabled per-call for routing/synthesis
   * passes (those are stateless meta-operations) and via `--no-memory`.
   */
  loadHistory?: boolean | { maxConversations?: number; maxMessages?: number; maxBytes?: number };
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
    ...(args.loadHistory !== undefined ? { loadHistory: args.loadHistory } : {}),
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
// Persona memory inspector (v0.14.0)
// ────────────────────────────────────────────────────────────────────

export interface FrqncyHistoryOptions {
  personaDir?: string;
  cwd?: string;
  json?: boolean;
  /** Override the trace directory (for tests + custom installs). */
  traceDir?: string;
  /** Cap on conversations looked back. Default 10. */
  maxConversations?: number;
  /** Cap on messages returned. Default 40. */
  maxMessages?: number;
  /** Cap on bytes. Default 50000. */
  maxBytes?: number;
}

/**
 * `frqncy --history <slug>` — show what one persona "remembers" from prior
 * thread history. The persona's threadId is `frqncy-os/<slug>`; we load via
 * loadThreadHistory and render the messages chronologically.
 *
 * No LLM calls. Pure read of the trace store.
 */
export async function runFrqncyHistoryCommand(
  slug: string,
  options: FrqncyHistoryOptions = {},
): Promise<ThreadHistoryResult> {
  if (!slug || !slug.trim()) {
    throw new Error('Persona slug required. Usage: frqncy-harness frqncy --history <slug>');
  }
  const cleanSlug = slug.trim();
  const threadId = `frqncy-os/${cleanSlug}`;
  const history = await loadThreadHistory(threadId, {
    ...(options.traceDir ? { traceDir: options.traceDir } : {}),
    ...(options.maxConversations !== undefined ? { maxConversations: options.maxConversations } : {}),
    ...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ threadId, ...history }, null, 2) + '\n');
    return history;
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}${cleanSlug}${ANSI.reset} ${ANSI.dim}— memory inspector${ANSI.reset}\n` +
      `${ANSI.dim}thread: ${threadId} · ${history.conversationsRead} convos read · ` +
      `${history.messages.length} messages loaded · ${history.totalBytes} bytes` +
      (history.messagesTrimmed > 0 ? ` · ${history.messagesTrimmed} trimmed by caps` : '') +
      `${ANSI.reset}\n\n`,
  );

  if (history.messages.length === 0) {
    process.stdout.write(
      `${ANSI.dim}(no prior conversation history found for this persona)${ANSI.reset}\n`,
    );
    return history;
  }

  for (const msg of history.messages) {
    const tag = msg.role === 'user'
      ? `${ANSI.bold}${ANSI.green}user${ANSI.reset}`
      : `${ANSI.bold}${ANSI.cyan}assistant${ANSI.reset}`;
    process.stdout.write(`${tag}\n${msg.content.trim()}\n\n`);
  }
  return history;
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

// ────────────────────────────────────────────────────────────────────
// Deliberation reader / inspector (v0.14.1)
// ────────────────────────────────────────────────────────────────────

export interface DeliberationMember {
  /** Persona name as recorded in the file (e.g. "Kali", "Sai Maa", "CEO"). */
  name: string;
  /** Model used (parsed from the per-member metadata line). */
  model?: string;
  /** Cost in USD (parsed from the per-member metadata line). */
  costUsd?: number;
  /** Conversation ID (parsed from the per-member metadata line). */
  conversationId?: string;
  /** Length of the member's response body in bytes. */
  bodyBytes: number;
}

export interface DeliberationRecord {
  /** Filename without .md (e.g. "2026-04-29-should-we-take-the-lugano"). */
  slug: string;
  /** Absolute path to the deliberation file. */
  path: string;
  /** "Council deliberation" or "Routed deliberation" — parsed from the H1. */
  title: string;
  /** ISO date prefix from the H1 (e.g. "2026-04-29"). */
  date: string;
  /** What "Generated by" line says. */
  source: string;
  /** The user's original question. */
  question: string;
  /** Parsed members in the order they appear in the file. */
  members: DeliberationMember[];
  /** Total cost summed from member metadata. */
  totalCostUsd: number;
  /** Routing reason, when present (auto-mode multi only). */
  routingReason?: string;
  /** True when the file embeds FRQNCY's synthesis (auto-mode multi); false when it's a placeholder ("yours to write"). */
  hasSynthesis: boolean;
  /** When hasSynthesis is true, the embedded synthesis body. */
  synthesisText?: string;
  /** File size in bytes. */
  fileBytes: number;
}

/**
 * Parse one deliberation .md file into a structured record.
 * Format invariants come from `formatCouncilDeliberation` — keep this in sync
 * if the writer ever changes shape.
 */
export function parseDeliberation(raw: string, slug: string, path: string): DeliberationRecord {
  // H1: "# <Title> — <YYYY-MM-DD>"
  const h1Match = raw.match(/^#\s+(.+?)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/m);
  const title = h1Match?.[1] ?? 'Council deliberation';
  const date = h1Match?.[2] ?? slug.slice(0, 10);

  // "> Generated by `<source>`. ..."
  const sourceMatch = raw.match(/^>\s+Generated by\s+`([^`]+)`/m);
  const source = sourceMatch?.[1] ?? 'unknown';

  // Question section: "## The question\n\n<question>\n\n"
  const questionMatch = raw.match(/##\s+The question\s*\n+([\s\S]*?)\n+##\s/);
  const question = questionMatch?.[1]?.trim() ?? '';

  // Routing reason section: "## Routing reason\n\n<reason>\n\n"
  const routingMatch = raw.match(/##\s+Routing reason\s*\n+([\s\S]*?)\n+(?:##|---)/);
  const routingReason = routingMatch?.[1]?.trim();

  // Synthesis section
  const synthFrqncyMatch = raw.match(/##\s+Synthesis \(FRQNCY\)\s*\n+([\s\S]*?)$/);
  const synthPlaceholderMatch = raw.match(/##\s+Synthesis \(yours to write\)/);
  const hasSynthesis = !!synthFrqncyMatch;
  const synthesisText = synthFrqncyMatch?.[1]?.trim();
  const _hasPlaceholder = !!synthPlaceholderMatch;

  // Member sections — between "---\n" markers, each section starts with "## <Name>"
  // followed by "*Model: `...` · cost: $... · conversation: `...`*"
  const members: DeliberationMember[] = [];
  // Find all "## <name>\n\n*Model: `<model>` · cost: $<cost> · conversation: `<conv>`*" patterns
  const memberPattern = /\n## ([^\n]+)\n\n\*Model: `([^`]+)` · cost: \$([0-9.]+) · conversation: `([^`]+)`\*\n+([\s\S]*?)\n+---/g;
  let match;
  while ((match = memberPattern.exec(raw)) !== null) {
    const name = match[1]!.trim();
    // Skip structural sections that happen to start with "##"
    if (name === 'The question' || name === 'Source metadata' || name === 'Routing reason' || name.startsWith('Synthesis')) {
      continue;
    }
    const body = match[5]!.trim();
    members.push({
      name,
      model: match[2]!,
      costUsd: parseFloat(match[3]!),
      conversationId: match[4]!,
      bodyBytes: Buffer.byteLength(body, 'utf-8'),
    });
  }
  const totalCostUsd = members.reduce((s, m) => s + (m.costUsd ?? 0), 0);

  return {
    slug,
    path,
    title,
    date,
    source,
    question,
    members,
    totalCostUsd,
    ...(routingReason ? { routingReason } : {}),
    hasSynthesis,
    ...(synthesisText ? { synthesisText } : {}),
    fileBytes: Buffer.byteLength(raw, 'utf-8'),
  };
}

/**
 * Read every .md file from the deliberations directory and parse each.
 * Returns records sorted by date descending (most recent first).
 */
export async function loadDeliberations(deliberationsDir: string): Promise<DeliberationRecord[]> {
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = await fs.readdir(deliberationsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: DeliberationRecord[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.slice(0, -3);
    const path = join(deliberationsDir, e.name);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch {
      continue;
    }
    try {
      records.push(parseDeliberation(raw, slug, path));
    } catch {
      // Skip files that don't parse — never throw on read
    }
  }
  // Sort by date desc, then by slug desc as tiebreaker
  records.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? 1 : -1;
  });
  return records;
}

export interface FrqncyDeliberationsOptions {
  cwd?: string;
  /** Override the deliberations dir. Default `<cwd>/proposals/council-deliberations/`. */
  dir?: string;
  json?: boolean;
}

/**
 * `frqncy --deliberations` — list every saved deliberation with summary metadata.
 * Pure read of the filesystem, no LLM cost.
 */
export async function runFrqncyDeliberationsCommand(
  options: FrqncyDeliberationsOptions = {},
): Promise<DeliberationRecord[]> {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dir ?? join(cwd, DEFAULT_DELIBERATIONS_DIR);
  const records = await loadDeliberations(dir);

  if (options.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + '\n');
    return records;
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}deliberations${ANSI.reset} ${ANSI.dim}— ${records.length} record${records.length === 1 ? '' : 's'} in ${dir}${ANSI.reset}\n\n`,
  );

  if (records.length === 0) {
    process.stdout.write(
      `${ANSI.dim}(no deliberation files yet — run \`frqncy --council --save "<question>"\` or \`frqncy --save "<question>"\` to create one)${ANSI.reset}\n`,
    );
    return records;
  }

  for (const r of records) {
    const titleTag = r.title === 'Routed deliberation' ? `${ANSI.magenta}routed${ANSI.reset}` : `${ANSI.cyan}council${ANSI.reset}`;
    const synthTag = r.hasSynthesis
      ? ` ${ANSI.green}✓ synthesized${ANSI.reset}`
      : ` ${ANSI.yellow}⚠ awaiting synthesis${ANSI.reset}`;
    process.stdout.write(
      `${ANSI.bold}${r.slug}${ANSI.reset} ${titleTag}${synthTag}\n` +
        `  ${ANSI.dim}${r.date} · ${r.members.length} member${r.members.length === 1 ? '' : 's'} · $${r.totalCostUsd.toFixed(4)} · ${r.fileBytes} bytes${ANSI.reset}\n` +
        `  ${ANSI.dim}q: ${r.question.slice(0, 80)}${r.question.length > 80 ? '…' : ''}${ANSI.reset}\n`,
    );
    if (r.routingReason) {
      process.stdout.write(`  ${ANSI.dim}routing: ${r.routingReason.slice(0, 80)}${r.routingReason.length > 80 ? '…' : ''}${ANSI.reset}\n`);
    }
    process.stdout.write(`\n`);
  }

  process.stdout.write(
    `${ANSI.dim}Inspect one in detail: \`frqncy-harness frqncy --deliberation <slug>\`${ANSI.reset}\n`,
  );
  return records;
}

export interface FrqncyDeliberationOptions {
  cwd?: string;
  dir?: string;
  json?: boolean;
}

/**
 * `frqncy --deliberation <slug>` — show one deliberation in full detail.
 */
export async function runFrqncyDeliberationCommand(
  slug: string,
  options: FrqncyDeliberationOptions = {},
): Promise<DeliberationRecord> {
  if (!slug || !slug.trim()) {
    throw new Error('Deliberation slug required. Usage: frqncy-harness frqncy --deliberation <slug>');
  }
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dir ?? join(cwd, DEFAULT_DELIBERATIONS_DIR);
  const cleanSlug = slug.trim().replace(/\.md$/, '');
  const path = join(dir, `${cleanSlug}.md`);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `deliberation "${cleanSlug}" not found at ${path}. Run \`frqncy-harness frqncy --deliberations\` to see available slugs.`,
      );
    }
    throw err;
  }
  const record = parseDeliberation(raw, cleanSlug, path);

  if (options.json) {
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  const titleTag = record.title === 'Routed deliberation' ? `${ANSI.magenta}[routed]${ANSI.reset}` : `${ANSI.cyan}[council]${ANSI.reset}`;
  const synthTag = record.hasSynthesis ? `${ANSI.green}✓ synthesized${ANSI.reset}` : `${ANSI.yellow}⚠ awaiting synthesis${ANSI.reset}`;
  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}${record.slug}${ANSI.reset} ${titleTag} ${synthTag}\n` +
      `${ANSI.dim}${record.path}${ANSI.reset}\n\n`,
  );

  process.stdout.write(`${ANSI.bold}${ANSI.magenta}── question ──${ANSI.reset}\n${record.question}\n\n`);

  if (record.routingReason) {
    process.stdout.write(`${ANSI.bold}${ANSI.magenta}── routing reason ──${ANSI.reset}\n${record.routingReason}\n\n`);
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.magenta}── members convened (${record.members.length}) ──${ANSI.reset}\n`,
  );
  for (const m of record.members) {
    process.stdout.write(
      `  ${ANSI.cyan}${m.name}${ANSI.reset} ${ANSI.dim}${m.model ?? '?'} · $${(m.costUsd ?? 0).toFixed(4)} · ${m.bodyBytes} bytes · conv ${m.conversationId ?? '?'}${ANSI.reset}\n`,
    );
  }
  process.stdout.write(`  ${ANSI.dim}total: $${record.totalCostUsd.toFixed(4)}${ANSI.reset}\n\n`);

  if (record.hasSynthesis && record.synthesisText) {
    process.stdout.write(`${ANSI.bold}${ANSI.magenta}── synthesis (FRQNCY) ──${ANSI.reset}\n${record.synthesisText}\n\n`);
  } else {
    process.stdout.write(
      `${ANSI.yellow}!${ANSI.reset} ${ANSI.dim}This deliberation has no embedded synthesis. ` +
        `Open the file and write yours: ${record.path}${ANSI.reset}\n\n`,
    );
  }

  process.stdout.write(
    `${ANSI.dim}Source: ${record.source} · file: ${record.fileBytes} bytes${ANSI.reset}\n`,
  );
  return record;
}

// ────────────────────────────────────────────────────────────────────
// Cross-deliberation reflection (v0.14.2)
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_REFLECTIONS_DIR = 'proposals/reflections';

export const REFLECT_SYSTEM_PROMPT = `You are the Learning Agent for FRQNCY OS — Orli's personal AI organization. ${INOCULATION_SENTENCE}

Your job: given N recent deliberation summaries (each captures a question, the personas convened, their voices, and the synthesis if any), surface PATTERNS that the org needs to see in order to learn from itself. You are NOT writing for an audience; you are writing for Orli, who runs this org.

Output a structured Markdown reflection with these sections, in order:

## Themes
The 1-3 most recurring contexts/questions across the corpus. Be specific (not "leadership decisions" — say "decisions about saying no to existing partners"). For each theme, name which deliberations cluster.

## Routing patterns
When FRQNCY routed direct vs single-persona vs multi-persona convene — were the choices coherent? Cite specific decisions where the routing seemed wrong (e.g. "this was clearly a Sai Maa moment but FRQNCY answered direct").

## Voice signals
Where Council members converged with each other vs diverged. Where any persona seemed to drift from their voice (Kali being soft, Sai Maa being strategic, etc.). Where the synthesis honored each voice vs flattened them.

## Action items
Concrete suggestions Orli could act on this week. Not vague ("invoke Council more"); concrete ("add a morning grounding shortcut that defaults to Sai Maa + Saraswati"). Each item as a checkbox.

## Open questions for Orli
Things the deliberations raised that haven't been resolved or even named explicitly yet. Things only Orli can answer.

Hard rules:
- Do NOT include code blocks, emoji, or fluff.
- Cite deliberation slugs in italics when referencing specific records (e.g. *2026-04-29-should-we-take-lugano*).
- If the corpus is too small (fewer than 3 deliberations) for meaningful patterns, say so plainly in a "Coverage note" at the top — do not invent themes.
- If a theme appears in only one deliberation, do NOT call it a pattern.`;

/**
 * Build a compact one-paragraph summary of one deliberation, suitable for
 * including in the reflection prompt without blowing context.
 */
export function summarizeDeliberation(r: DeliberationRecord): string {
  const tag = r.title === 'Routed deliberation' ? 'routed' : 'council';
  const memberList = r.members.map((m) => m.name).join(', ');
  const synthLine = r.hasSynthesis && r.synthesisText
    ? `Synthesis (FRQNCY): ${r.synthesisText.replace(/\s+/g, ' ').slice(0, 400)}${r.synthesisText.length > 400 ? '…' : ''}`
    : 'Synthesis: (placeholder — not yet written)';
  const routingLine = r.routingReason ? `Routing reason: ${r.routingReason}` : '';
  const memberSummaries = r.members
    .map((m) => {
      const cost = (m.costUsd ?? 0).toFixed(4);
      return `  - **${m.name}** ($${cost}, ${m.bodyBytes}B)`;
    })
    .join('\n');
  return [
    `### *${r.slug}* (${tag}, ${r.date})`,
    `Question: ${r.question}`,
    routingLine,
    `Members convened (${r.members.length}):`,
    memberSummaries,
    synthLine,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the full reflection prompt the LLM sees.
 * Pure function — testable without the LLM.
 */
export function buildReflectionPrompt(records: DeliberationRecord[], generatedAt: string): string {
  const dateRange = records.length === 0
    ? 'no records'
    : records.length === 1
      ? records[0]!.date
      : `${records[records.length - 1]!.date} → ${records[0]!.date}`;
  const lines = [
    `## Reflection request`,
    ``,
    `Generated at: ${generatedAt}`,
    `Records reviewed: ${records.length}`,
    `Date range: ${dateRange}`,
    ``,
    `## Deliberation corpus`,
    ``,
    ...records.map((r) => summarizeDeliberation(r)),
    ``,
    `## Your task`,
    ``,
    `Reflect on the corpus above per the rules in your system prompt. Output the structured Markdown reflection now.`,
  ];
  return lines.join('\n\n');
}

export interface FrqncyReflectOptions {
  cwd?: string;
  /** Override the deliberations dir. Default `<cwd>/proposals/council-deliberations/`. */
  dir?: string;
  /** Cap how many most-recent deliberations to consider. Default 10. */
  last?: number;
  /** Only include deliberations with date >= this YYYY-MM-DD. Optional. */
  since?: string;
  /** Override the model. Default 'anthropic/claude-sonnet-4-6'. */
  model?: string;
  /** Save the reflection to `<cwd>/proposals/reflections/<date>-deliberation-reflection.md`. */
  save?: boolean;
  /** Override the save path explicitly. Implies save behavior even without --save. */
  output?: string;
  /** Emit JSON instead of human prose. */
  json?: boolean;
  /** Test seam: substitute the chat function. */
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
}

export interface FrqncyReflectResult {
  /** The corpus reviewed (slugs only). */
  reviewed: string[];
  /** The reflection markdown the LLM produced. */
  reflectionText: string;
  /** Cost of the LLM call. */
  costUsd: number;
  /** Model used. */
  model: string;
  /** Path the reflection was saved to (when --save / --output). */
  savedTo?: string;
}

export async function runFrqncyReflectCommand(options: FrqncyReflectOptions = {}): Promise<FrqncyReflectResult> {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dir ?? join(cwd, DEFAULT_DELIBERATIONS_DIR);
  const allRecords = await loadDeliberations(dir);
  const sinceFilter = options.since;
  const filtered = sinceFilter
    ? allRecords.filter((r) => r.date >= sinceFilter)
    : allRecords;
  const last = options.last ?? 10;
  const records = filtered.slice(0, last);

  if (records.length === 0) {
    throw new Error(
      `No deliberation records to reflect on${sinceFilter ? ` since ${sinceFilter}` : ''} in ${dir}. ` +
        `Run \`frqncy --council --save "<question>"\` or \`frqncy --save "<question>"\` to create one.`,
    );
  }

  const config = await loadConfig();
  const chatFn = options.chatFn ?? defaultChat;
  const model = (options.model ?? 'anthropic/claude-sonnet-4-6') as ModelString;
  const generatedAt = new Date().toISOString();
  const prompt = buildReflectionPrompt(records, generatedAt);

  const result = await chatFn({
    model,
    messages: [{ role: 'user', content: prompt }],
    system: REFLECT_SYSTEM_PROMPT,
    threadId: 'frqncy-os/learning-agent',
    projectId: 'frqncy-os',
    costCap: { softWarnUsd: config.costCap.softWarnUsd, hardAbortUsd: config.costCap.hardAbortUsd },
  });

  // Optional save
  let savedTo: string | undefined;
  if (options.save || options.output) {
    const savePath = options.output
      ? options.output
      : join(cwd, DEFAULT_REFLECTIONS_DIR, `${generatedAt.slice(0, 10)}-deliberation-reflection.md`);
    await fs.mkdir(dirname(savePath), { recursive: true });
    const fullDoc = [
      `# Deliberation reflection — ${generatedAt.slice(0, 10)}`,
      ``,
      `> Generated by \`frqncy-harness frqncy --reflect\`. Reviewed ${records.length} deliberation${records.length === 1 ? '' : 's'} ` +
        (records.length > 1 ? `from ${records[records.length - 1]!.date} to ${records[0]!.date}` : `from ${records[0]!.date}`) +
        `. Model: \`${model}\`. Cost: $${(result.usage.costUsd ?? 0).toFixed(4)}.`,
      ``,
      `## Corpus reviewed`,
      ``,
      ...records.map((r) => `- *${r.slug}*${r.routingReason ? ` (routed)` : ''}`),
      ``,
      `---`,
      ``,
      result.text.trim(),
      ``,
    ].join('\n');
    await fs.writeFile(savePath, fullDoc, 'utf-8');
    savedTo = savePath;
  }

  const out: FrqncyReflectResult = {
    reviewed: records.map((r) => r.slug),
    reflectionText: result.text,
    costUsd: result.usage.costUsd ?? 0,
    model,
    ...(savedTo ? { savedTo } : {}),
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return out;
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}deliberation reflection${ANSI.reset} ${ANSI.dim}— ${records.length} reviewed, $${out.costUsd.toFixed(4)} on ${model}${ANSI.reset}\n\n`,
  );
  process.stdout.write(result.text.trim() + '\n');
  if (savedTo) {
    process.stdout.write(
      `\n${ANSI.green}✓ saved${ANSI.reset} ${ANSI.dim}${savedTo}${ANSI.reset}\n`,
    );
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Reflection inspector + action extractor (v0.14.3)
// ────────────────────────────────────────────────────────────────────

export interface ReflectionActionItem {
  /** Original line text (without the `- [ ]` / `- [x]` prefix). */
  text: string;
  /** Whether the checkbox is checked. */
  done: boolean;
}

export interface ReflectionRecord {
  /** Filename without .md (e.g. "2026-04-29-deliberation-reflection"). */
  slug: string;
  path: string;
  /** ISO date prefix from the H1 (e.g. "2026-04-29"). */
  date: string;
  /** Provenance line: number of records reviewed. */
  recordsReviewed?: number;
  /** Provenance line: model used. */
  model?: string;
  /** Provenance line: cost in USD. */
  costUsd?: number;
  /** Provenance line: date range (start → end). */
  dateRange?: string;
  /** Slugs of the deliberations the reflection reviewed. */
  corpus: string[];
  /** The body of the reflection (everything after the `---` separator). */
  body: string;
  /** Parsed action items from the `## Action items` section. */
  actionItems: ReflectionActionItem[];
  /** Total file size in bytes. */
  fileBytes: number;
}

/**
 * Parse one reflection .md file into a structured record.
 * Format invariants come from how `runFrqncyReflectCommand` writes the file
 * (provenance header + corpus list + LLM body with sections).
 */
export function parseReflection(raw: string, slug: string, path: string): ReflectionRecord {
  // H1: "# Deliberation reflection — YYYY-MM-DD"
  const h1Match = raw.match(/^#\s+Deliberation reflection\s+—\s+(\d{4}-\d{2}-\d{2})/m);
  const date = h1Match?.[1] ?? slug.slice(0, 10);

  // Provenance: "> Generated by `...`. Reviewed N deliberation(s) [from <date> to <date>|from <date>]. Model: `<m>`. Cost: $<c>."
  const provMatch = raw.match(
    /^>\s+Generated by\s+`[^`]+`\.\s+Reviewed\s+(\d+)\s+deliberations?\s+(from\s+\d{4}-\d{2}-\d{2}(?:\s+to\s+\d{4}-\d{2}-\d{2})?)\.\s+Model:\s+`([^`]+)`\.\s+Cost:\s+\$([0-9.]+)/m,
  );
  const recordsReviewed = provMatch?.[1] ? parseInt(provMatch[1], 10) : undefined;
  const dateRange = provMatch?.[2];
  const model = provMatch?.[3];
  const costUsd = provMatch?.[4] ? parseFloat(provMatch[4]) : undefined;

  // Corpus list: "## Corpus reviewed\n\n- *<slug>*[ (routed)]\n- ..."
  const corpusMatch = raw.match(/##\s+Corpus reviewed\s*\n+([\s\S]*?)\n+---/);
  const corpus: string[] = [];
  if (corpusMatch?.[1]) {
    for (const line of corpusMatch[1].split('\n')) {
      const m = line.match(/^-\s+\*([^*]+)\*/);
      if (m && m[1]) corpus.push(m[1].trim());
    }
  }

  // Body: everything after the FIRST `---` line on its own.
  const sepIdx = raw.indexOf('\n---\n');
  const body = sepIdx === -1 ? raw : raw.slice(sepIdx + 5).trim();

  // Action items: lines starting with "- [ ]" or "- [x]" inside the "## Action items" section.
  const actionItems: ReflectionActionItem[] = [];
  const actionsMatch = body.match(/##\s+Action items\s*\n+([\s\S]*?)(?:\n##\s|\n---|$)/);
  if (actionsMatch?.[1]) {
    for (const line of actionsMatch[1].split('\n')) {
      const m = line.match(/^-\s+\[([ xX])\]\s+(.+)$/);
      if (m && m[2]) {
        actionItems.push({ text: m[2].trim(), done: m[1] !== ' ' });
      }
    }
  }

  return {
    slug,
    path,
    date,
    ...(recordsReviewed !== undefined ? { recordsReviewed } : {}),
    ...(model ? { model } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(dateRange ? { dateRange } : {}),
    corpus,
    body,
    actionItems,
    fileBytes: Buffer.byteLength(raw, 'utf-8'),
  };
}

/**
 * Read every .md file from the reflections directory and parse each.
 * Sorted by date descending. Tolerant: ENOENT → []; unparseable → skipped.
 */
export async function loadReflections(reflectionsDir: string): Promise<ReflectionRecord[]> {
  let entries: { name: string; isFile: () => boolean }[];
  try {
    entries = await fs.readdir(reflectionsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const records: ReflectionRecord[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.slice(0, -3);
    const path = join(reflectionsDir, e.name);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch {
      continue;
    }
    try {
      records.push(parseReflection(raw, slug, path));
    } catch {
      // skip unparseable
    }
  }
  records.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? 1 : -1;
  });
  return records;
}

export interface FrqncyReflectionsOptions {
  cwd?: string;
  /** Override the reflections dir. Default `<cwd>/proposals/reflections/`. */
  dir?: string;
  json?: boolean;
}

/**
 * `frqncy --reflections` — list every saved reflection with action-item counts.
 */
export async function runFrqncyReflectionsCommand(
  options: FrqncyReflectionsOptions = {},
): Promise<ReflectionRecord[]> {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dir ?? join(cwd, DEFAULT_REFLECTIONS_DIR);
  const records = await loadReflections(dir);

  if (options.json) {
    process.stdout.write(JSON.stringify(records, null, 2) + '\n');
    return records;
  }

  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}reflections${ANSI.reset} ${ANSI.dim}— ${records.length} record${records.length === 1 ? '' : 's'} in ${dir}${ANSI.reset}\n\n`,
  );

  if (records.length === 0) {
    process.stdout.write(
      `${ANSI.dim}(no reflections yet — run \`frqncy --reflect --save\` after you have a few deliberations)${ANSI.reset}\n`,
    );
    return records;
  }

  for (const r of records) {
    const open = r.actionItems.filter((a) => !a.done).length;
    const done = r.actionItems.filter((a) => a.done).length;
    const actionTag =
      r.actionItems.length === 0
        ? `${ANSI.dim}no actions${ANSI.reset}`
        : open === 0
          ? `${ANSI.green}✓ ${done}/${r.actionItems.length} done${ANSI.reset}`
          : `${ANSI.yellow}${open} open${ANSI.reset} ${ANSI.dim}/ ${done} done${ANSI.reset}`;
    const costLine = r.costUsd !== undefined ? `$${r.costUsd.toFixed(4)}` : '?';
    process.stdout.write(
      `${ANSI.bold}${r.slug}${ANSI.reset} ${actionTag}\n` +
        `  ${ANSI.dim}${r.date} · reviewed ${r.recordsReviewed ?? '?'} · ${costLine} · ${r.fileBytes} bytes${ANSI.reset}\n` +
        `  ${ANSI.dim}corpus: ${r.corpus.length > 0 ? r.corpus.join(', ').slice(0, 100) + (r.corpus.join(', ').length > 100 ? '…' : '') : '(none parsed)'}${ANSI.reset}\n\n`,
    );
  }

  process.stdout.write(
    `${ANSI.dim}Open actions across all reflections: \`frqncy-harness frqncy --actions\`${ANSI.reset}\n`,
  );
  return records;
}

export interface FrqncyActionsOptions {
  cwd?: string;
  dir?: string;
  /** Include items already marked done (default false — only open shown). */
  includeDone?: boolean;
  json?: boolean;
}

export interface ActionItemEntry extends ReflectionActionItem {
  /** Slug of the reflection this item came from. */
  reflectionSlug: string;
  /** Date of the reflection this item came from. */
  reflectionDate: string;
}

/**
 * `frqncy --actions` — flat list of every action item across all reflections,
 * grouped by reflection date. Defaults to open-only.
 */
export async function runFrqncyActionsCommand(options: FrqncyActionsOptions = {}): Promise<ActionItemEntry[]> {
  const cwd = options.cwd ?? process.cwd();
  const dir = options.dir ?? join(cwd, DEFAULT_REFLECTIONS_DIR);
  const records = await loadReflections(dir);
  const includeDone = options.includeDone ?? false;

  const entries: ActionItemEntry[] = [];
  for (const r of records) {
    for (const a of r.actionItems) {
      if (!includeDone && a.done) continue;
      entries.push({ ...a, reflectionSlug: r.slug, reflectionDate: r.date });
    }
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return entries;
  }

  const totalOpen = records.reduce((s, r) => s + r.actionItems.filter((a) => !a.done).length, 0);
  const totalDone = records.reduce((s, r) => s + r.actionItems.filter((a) => a.done).length, 0);
  process.stdout.write(
    `${ANSI.bold}${ANSI.cyan}action items${ANSI.reset} ${ANSI.dim}— ${totalOpen} open across ${records.length} reflection${records.length === 1 ? '' : 's'}` +
      (includeDone ? ` (showing all, ${totalDone} done)` : ` (use --include-done to also show ${totalDone} completed)`) +
      `${ANSI.reset}\n\n`,
  );

  if (entries.length === 0) {
    process.stdout.write(
      includeDone
        ? `${ANSI.dim}(no action items in any reflection)${ANSI.reset}\n`
        : `${ANSI.green}✓ no open action items${ANSI.reset}\n`,
    );
    return entries;
  }

  // Group by reflection slug, render in date-desc order
  let lastSlug = '';
  for (const e of entries) {
    if (e.reflectionSlug !== lastSlug) {
      process.stdout.write(
        `${ANSI.bold}${ANSI.magenta}── ${e.reflectionSlug}${ANSI.reset} ${ANSI.dim}(${e.reflectionDate})${ANSI.reset}\n`,
      );
      lastSlug = e.reflectionSlug;
    }
    const checkbox = e.done ? `${ANSI.green}[x]${ANSI.reset}` : `${ANSI.yellow}[ ]${ANSI.reset}`;
    process.stdout.write(`  ${checkbox} ${e.text}\n`);
  }
  process.stdout.write(
    `\n${ANSI.dim}Edit the reflection file directly to check off items. Open it: \`frqncy --reflections --json | jq -r '.[].path'\`${ANSI.reset}\n`,
  );
  return entries;
}
