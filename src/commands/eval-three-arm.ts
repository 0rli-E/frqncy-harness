/**
 * `frqncy-harness eval-three-arm <skill-name> [--dataset <path>] [--model <m>] [--lift-threshold N] [--json]`
 *
 * Three-arm eval methodology — the C-tier methodological gate from
 * `proposals/SELF-IMPROVING-HARNESS.md` Tier B.5, borrowed from
 * juliusbrussee/caveman.
 *
 * The trap most skill claims fall into: comparing `(skill on)` to `(no skill)`
 * and crediting the skill with whatever generic effect it triggered. A "be
 * concise" prompt addendum looks like a win against a verbose baseline — but
 * if a generic "answer concisely" addendum produces the same lift, the skill
 * is doing nothing the generic modifier wasn't already doing.
 *
 * This command runs every fixture three times:
 *   1. **baseline** — prompt only, no addendum
 *   2. **generic-modifier** — prompt + a short generic addendum (passed via --modifier or default)
 *   3. **full-skill** — prompt + the named skill's body as a system addendum
 *
 * Aggregates pass-rates across the dataset, computes:
 *   - lift of (skill) over (baseline) — does the skill help at all?
 *   - lift of (skill) over (generic-modifier) — is the lift separable from a generic prompt addendum?
 *
 * The gate fails if `(skill - generic) < --lift-threshold` (default 5pp).
 * That's the headline result: "your skill is a placebo for the generic effect"
 * vs. "your skill has measurable specific lift."
 *
 * v0.9 scope: deterministic scoring (regex/contains/banned-phrase). No LLM-as-judge.
 * v1.0 adds: LLM-as-judge for fixtures with free-form rubrics.
 *
 * Safety: inoculation sentence in every chat call (per Anthropic Nov 2025).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { chat as defaultChat } from '../chat.js';
import { loadConfig } from '../config.js';
import { INOCULATION_SENTENCE } from './codify.js';
import { resolveSkillsForPrompt } from '../skills/index.js';
import type { ChatInput, ChatResult, ModelString } from '../types.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const DEFAULT_DATASET_PATH = 'test/eval-fixtures.jsonl';
const DEFAULT_LIFT_THRESHOLD = 5; // percentage points
const DEFAULT_GENERIC_MODIFIER = 'Answer concisely. Drop filler. Keep code blocks unchanged.';

const EVAL_SYSTEM_BASE = `You are a careful, helpful assistant. ${INOCULATION_SENTENCE}`;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface EvalFixture {
  /** Required: the prompt to send. */
  prompt: string;
  /** Required (one of expected_match, expected_contains, banned_phrases): how to score the response. */
  expected_match?: string; // regex source (matched case-sensitive)
  expected_contains?: string; // substring (case-sensitive)
  banned_phrases?: string[]; // any presence fails
  /** Optional human-readable label for the fixture. */
  label?: string;
}

export type ArmName = 'baseline' | 'generic' | 'skill';

export interface ArmResult {
  arm: ArmName;
  passed: number;
  failed: number;
  total: number;
  passRate: number; // 0..1
}

export interface FixtureRun {
  fixtureLabel?: string;
  baselineText: string;
  baselinePassed: boolean;
  genericText: string;
  genericPassed: boolean;
  skillText: string;
  skillPassed: boolean;
}

export interface EvalThreeArmResult {
  skillName: string;
  datasetPath: string;
  fixtures: number;
  arms: { baseline: ArmResult; generic: ArmResult; skill: ArmResult };
  liftSkillOverBaselinePp: number; // percentage points
  liftSkillOverGenericPp: number; // percentage points
  passedThreshold: boolean;
  threshold: number;
  totalCostUsd: number;
  runs: FixtureRun[];
}

export interface EvalThreeArmCommandOptions {
  /** Override the dataset path. Default `test/eval-fixtures.jsonl` (relative to cwd). */
  dataset?: string;
  /** Override the LLM lane. Defaults to config.defaultModel. */
  model?: string;
  /** Override the generic modifier text. */
  modifier?: string;
  /** Lift threshold in percentage points (skill must beat generic by this much). Default 5. */
  liftThreshold?: number;
  /** Override cwd for dataset resolution. */
  cwd?: string;
  /** Emit JSON instead of human-readable status. */
  json?: boolean;
  // Test seams ─────────────────────────────────────────────
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
  /** Override skill resolution (otherwise uses real ~/.frqncy-harness/skills/). */
  resolveSkillBodyFn?: (skillName: string) => Promise<string | null>;
}

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

export async function runEvalThreeArmCommand(
  skillName: string,
  options: EvalThreeArmCommandOptions = {},
): Promise<EvalThreeArmResult> {
  const config = await loadConfig();
  const cwd = options.cwd ?? process.cwd();
  const chatFn = options.chatFn ?? defaultChat;
  const model = (options.model ?? config.defaultModel ?? 'anthropic/claude-sonnet-4-6') as ModelString;
  const modifier = options.modifier ?? DEFAULT_GENERIC_MODIFIER;
  const threshold = options.liftThreshold ?? DEFAULT_LIFT_THRESHOLD;
  const datasetPath = resolveDatasetPath(options.dataset ?? DEFAULT_DATASET_PATH, cwd);

  const banner = (msg: string): void => {
    if (!options.json) process.stdout.write(msg);
  };

  // 1. Load fixtures
  const fixtures = await loadFixtures(datasetPath);
  if (fixtures.length === 0) {
    throw new Error(
      `no fixtures found at ${datasetPath}. ` +
        `Format: JSONL, one fixture per line: {"prompt":"...","expected_contains":"..."} or expected_match (regex) or banned_phrases.`,
    );
  }

  // 2. Resolve the skill body
  const resolveSkillFn = options.resolveSkillBodyFn ?? defaultResolveSkillBody;
  const skillBody = await resolveSkillFn(skillName);
  if (!skillBody) {
    throw new Error(`skill "${skillName}" not found. Run \`frqncy-harness skills list\` to see what's installed.`);
  }

  banner(
    `${ANSI.bold}${ANSI.cyan}eval-three-arm${ANSI.reset} ${ANSI.dim}skill=${skillName} ` +
      `dataset=${datasetPath} fixtures=${fixtures.length} model=${model}${ANSI.reset}\n\n`,
  );

  // 3. Run all three arms across all fixtures
  const runs: FixtureRun[] = [];
  let totalCostUsd = 0;
  const arms = {
    baseline: { arm: 'baseline' as const, passed: 0, failed: 0, total: 0, passRate: 0 },
    generic: { arm: 'generic' as const, passed: 0, failed: 0, total: 0, passRate: 0 },
    skill: { arm: 'skill' as const, passed: 0, failed: 0, total: 0, passRate: 0 },
  };

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i]!;
    const label = fixture.label ?? `fixture ${i + 1}`;
    banner(`${ANSI.dim}  [${i + 1}/${fixtures.length}] ${label}${ANSI.reset}\n`);

    const baseline = await runArm(chatFn, model, fixture.prompt, EVAL_SYSTEM_BASE, config.costCap);
    const generic = await runArm(chatFn, model, fixture.prompt, `${EVAL_SYSTEM_BASE}\n\n${modifier}`, config.costCap);
    const skill = await runArm(chatFn, model, fixture.prompt, `${EVAL_SYSTEM_BASE}\n\n${skillBody}`, config.costCap);

    totalCostUsd += baseline.costUsd + generic.costUsd + skill.costUsd;

    const baselinePassed = scoreFixture(fixture, baseline.text);
    const genericPassed = scoreFixture(fixture, generic.text);
    const skillPassed = scoreFixture(fixture, skill.text);

    arms.baseline.total += 1;
    arms.generic.total += 1;
    arms.skill.total += 1;
    if (baselinePassed) arms.baseline.passed += 1;
    else arms.baseline.failed += 1;
    if (genericPassed) arms.generic.passed += 1;
    else arms.generic.failed += 1;
    if (skillPassed) arms.skill.passed += 1;
    else arms.skill.failed += 1;

    runs.push({
      ...(fixture.label ? { fixtureLabel: fixture.label } : {}),
      baselineText: baseline.text,
      baselinePassed,
      genericText: generic.text,
      genericPassed,
      skillText: skill.text,
      skillPassed,
    });
  }

  // 4. Compute pass rates + lifts
  arms.baseline.passRate = arms.baseline.passed / arms.baseline.total;
  arms.generic.passRate = arms.generic.passed / arms.generic.total;
  arms.skill.passRate = arms.skill.passed / arms.skill.total;

  const liftSkillOverBaselinePp = (arms.skill.passRate - arms.baseline.passRate) * 100;
  const liftSkillOverGenericPp = (arms.skill.passRate - arms.generic.passRate) * 100;
  const passedThreshold = liftSkillOverGenericPp >= threshold;

  const result: EvalThreeArmResult = {
    skillName,
    datasetPath,
    fixtures: fixtures.length,
    arms,
    liftSkillOverBaselinePp,
    liftSkillOverGenericPp,
    passedThreshold,
    threshold,
    totalCostUsd,
    runs,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }

  renderHumanReadable(result);
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

export function scoreFixture(fixture: EvalFixture, text: string): boolean {
  if (fixture.expected_match) {
    try {
      const re = new RegExp(fixture.expected_match);
      if (!re.test(text)) return false;
    } catch {
      return false;
    }
  }
  if (fixture.expected_contains) {
    if (!text.includes(fixture.expected_contains)) return false;
  }
  if (fixture.banned_phrases && fixture.banned_phrases.length > 0) {
    const lower = text.toLowerCase();
    for (const phrase of fixture.banned_phrases) {
      if (lower.includes(phrase.toLowerCase())) return false;
    }
  }
  // If no scoring criteria provided, treat as auto-pass (operator wrote a malformed fixture)
  if (!fixture.expected_match && !fixture.expected_contains && (!fixture.banned_phrases || fixture.banned_phrases.length === 0)) {
    return true;
  }
  return true;
}

export async function loadFixtures(path: string): Promise<EvalFixture[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const fixtures: EvalFixture[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as EvalFixture;
      if (typeof parsed.prompt === 'string' && parsed.prompt.length > 0) {
        fixtures.push(parsed);
      }
    } catch {
      // skip malformed lines
    }
  }
  return fixtures;
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function runArm(
  chatFn: (input: ChatInput) => Promise<ChatResult>,
  model: ModelString,
  prompt: string,
  system: string,
  costCap: { softWarnUsd?: number; hardAbortUsd?: number },
): Promise<{ text: string; costUsd: number }> {
  const result = await chatFn({
    model,
    messages: [{ role: 'user', content: prompt }],
    system,
    costCap,
  });
  return { text: result.text, costUsd: result.usage.costUsd ?? 0 };
}

async function defaultResolveSkillBody(skillName: string): Promise<string | null> {
  const resolved = await resolveSkillsForPrompt(skillName);
  // resolveSkillsForPrompt matches against the prompt to find triggered skills.
  // For eval, we want a specific named skill — find it among the matched set.
  if (!resolved) return null;
  const found = resolved.matched.find((s) => s.name === skillName);
  return found ? found.body : null;
}

function resolveDatasetPath(p: string, cwd: string): string {
  if (p.startsWith('/')) return p;
  return join(cwd, p);
}

function renderHumanReadable(r: EvalThreeArmResult): void {
  process.stdout.write(`\n${ANSI.bold}results${ANSI.reset}\n`);
  for (const arm of [r.arms.baseline, r.arms.generic, r.arms.skill]) {
    const color = arm.arm === 'skill' ? ANSI.green : ANSI.dim;
    process.stdout.write(
      `  ${color}${arm.arm.padEnd(9)}${ANSI.reset}` +
        `  ${(arm.passRate * 100).toFixed(1).padStart(5)}%` +
        `  ${ANSI.dim}(${arm.passed}/${arm.total})${ANSI.reset}\n`,
    );
  }
  process.stdout.write(
    `\n${ANSI.bold}lifts${ANSI.reset}\n` +
      `  skill vs baseline:  ${liftColor(r.liftSkillOverBaselinePp)}${formatPp(r.liftSkillOverBaselinePp)}${ANSI.reset}\n` +
      `  skill vs generic:   ${liftColor(r.liftSkillOverGenericPp)}${formatPp(r.liftSkillOverGenericPp)}${ANSI.reset}` +
      `  ${ANSI.dim}(threshold: +${r.threshold.toFixed(1)}pp)${ANSI.reset}\n`,
  );
  if (r.passedThreshold) {
    process.stdout.write(
      `\n${ANSI.green}✓ skill passes the three-arm gate${ANSI.reset} ` +
        `${ANSI.dim}— skill lift over generic-modifier is ≥ ${r.threshold}pp${ANSI.reset}\n`,
    );
  } else {
    process.stdout.write(
      `\n${ANSI.red}× skill does NOT pass the three-arm gate${ANSI.reset}\n` +
        `${ANSI.dim}  the lift over generic-modifier is ${formatPp(r.liftSkillOverGenericPp)}, below the ${r.threshold}pp threshold.${ANSI.reset}\n` +
        `${ANSI.dim}  this means: whatever lift you measured against baseline is mostly the generic-modifier effect, not the skill itself.${ANSI.reset}\n` +
        `${ANSI.yellow}  recommendation:${ANSI.reset} either revise the skill content or accept that a generic terseness modifier delivers the same value.\n`,
    );
  }
  process.stdout.write(`${ANSI.dim}\ntotal eval cost: $${r.totalCostUsd.toFixed(4)}${ANSI.reset}\n`);
}

function liftColor(pp: number): string {
  if (pp >= 5) return ANSI.green;
  if (pp >= 0) return ANSI.yellow;
  return ANSI.red;
}

function formatPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}
