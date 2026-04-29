/**
 * Pre-evolve safety gates — the C-tier hooks from `proposals/SELF-IMPROVING-HARNESS.md`.
 *
 * Three composable gates, run BEFORE `npm test` inside `runEvolveCommand`:
 *
 *   1. **rubricAnchorGate** (C.5) — path-based refusal. Agents cannot modify files
 *      matching anchor patterns (default: `rubrics/`, `AGENT.md`, `proposals/SELF-IMPROVING-HARNESS.md`).
 *      The agent's implementation prompt already says "do not modify these," but a
 *      safety gate that *enforces* the rule is strictly better than one that *requests* it.
 *
 *   2. **voiceAnchorGate** (C.4 — regex form for v0.9; embedding-distance v1.0) —
 *      reads `~/.frqncy-harness/voice-anchor.md` (operator-curated, hand-pinned), parses
 *      banned-phrase lists out of it, scans the agent's added lines for matches.
 *      Off-brand prose triggers a block. v1.0 adds embedding-distance against a canonical
 *      voice exemplar; today this is purely lexical and blunt-but-fast.
 *
 *   3. **inoculationAuditGate** — verifies the agent's system prompt for the run actually
 *      contained the inoculation sentence (per Anthropic Nov 2025, arXiv 2511.18397).
 *      Defense-in-depth: our code already injects it, but a future refactor that drops
 *      the sentence would surface here as a blocked gate, not a silent regression.
 *
 * Each gate is a pure function over a `ChangeSet`. The composite `runPreEvolveGate`
 * runs them in sequence (rubric → inoculation → voice) and returns the first failure
 * or a composite pass. Order matters: rubric and inoculation are cheap and authoritative
 * (path/string match); voice is more expensive (file read + regex over diffs).
 *
 * Why these run BEFORE `npm test`:
 *   - The test gate verifies code correctness; these verify content/scope correctness.
 *   - An agent can write tests that lock in off-brand prose. The voice gate catches that.
 *   - An agent can modify a rubric and then write a test that asserts the new rubric.
 *     The rubric gate catches that.
 *   - Both failure modes pass `npm test` cleanly. Without these gates, the test suite
 *     gives a false sense of safety.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type GateName =
  | 'rubric-anchor'
  | 'voice-anchor'
  | 'inoculation-audit'
  | 'pre-evolve-gate';

export interface GateResult {
  passed: boolean;
  gate: GateName;
  /** One-line summary suitable for printing on a non-pass. */
  reason?: string;
  /** Detail payload — gate-specific. Not free-form prose; intended for structured logs/JSON. */
  details?: Record<string, unknown>;
}

/**
 * The set of changes the gates inspect. Built by `runEvolveCommand` from
 * `git diff --name-only HEAD` + per-file `git diff` content + the agent's
 * actual system prompt.
 */
export interface ChangeSet {
  /** Paths relative to cwd of files the agent modified. */
  changedFiles: string[];
  /**
   * Map of `path → diff content` (full unified diff including +/- lines for that file).
   * Voice-anchor scans only the lines beginning with `+` (additions).
   */
  diffByPath: Record<string, string>;
  /** The system prompt the agent ran with — should contain the inoculation sentence. */
  agentSystemPrompt: string;
}

export interface VoiceAnchor {
  /** Phrases banned anywhere in agent-added lines (case-insensitive substring match). */
  bannedPhrases: string[];
  /** Phrases banned only in code-comment lines (lines starting with //, #, or *). */
  bannedInCodeComments: string[];
  /** Optional metadata — not enforced. */
  notes?: string;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/**
 * Default anchor patterns the rubric-anchor gate refuses to let the agent modify.
 * Each entry is matched as either an exact filename, a directory prefix (when ending in `/`),
 * or a glob-ish suffix (when starting with `*` — e.g. `*.lock`).
 */
export const DEFAULT_RUBRIC_ANCHORS: readonly string[] = [
  'rubrics/',
  'AGENT.md',
  'proposals/SELF-IMPROVING-HARNESS.md',
];

export const DEFAULT_VOICE_ANCHOR_PATH = join(homedir(), '.frqncy-harness', 'voice-anchor.md');

/**
 * The literal substring the inoculation-audit gate requires in the agent's system prompt.
 * Kept loose ("reward hacking") so it works against either the codify, reflect, ralph,
 * or evolve constants — all of them include this phrase.
 */
export const INOCULATION_REQUIRED_PHRASE = 'reward hacking';

// ────────────────────────────────────────────────────────────────────
// Individual gates — pure functions
// ────────────────────────────────────────────────────────────────────

export function rubricAnchorGate(
  changedFiles: readonly string[],
  anchors: readonly string[] = DEFAULT_RUBRIC_ANCHORS,
): GateResult {
  const violations: string[] = [];
  for (const file of changedFiles) {
    if (matchesAnyAnchor(file, anchors)) {
      violations.push(file);
    }
  }
  if (violations.length === 0) {
    return { passed: true, gate: 'rubric-anchor' };
  }
  return {
    passed: false,
    gate: 'rubric-anchor',
    reason:
      `agent modified ${violations.length} anchored file(s): ${violations.join(', ')}. ` +
      `These are protected from automated evolution per proposals/SELF-IMPROVING-HARNESS.md (C.5). ` +
      `Submit a proposal for human review instead.`,
    details: { violations, anchors: [...anchors] },
  };
}

export function inoculationAuditGate(systemPrompt: string): GateResult {
  const lower = systemPrompt.toLowerCase();
  if (lower.includes(INOCULATION_REQUIRED_PHRASE)) {
    return { passed: true, gate: 'inoculation-audit' };
  }
  return {
    passed: false,
    gate: 'inoculation-audit',
    reason:
      `agent's system prompt did not contain the required inoculation phrase ("reward hacking"). ` +
      `Per Anthropic Nov 2025 (arXiv 2511.18397), this single-line mitigation reduces misalignment ` +
      `generalization 75-90% even at high reward-hacking rates. Refusing to proceed without it.`,
    details: { promptLength: systemPrompt.length, requiredPhrase: INOCULATION_REQUIRED_PHRASE },
  };
}

export function voiceAnchorGate(diffByPath: Record<string, string>, anchor: VoiceAnchor | null): GateResult {
  if (!anchor || (anchor.bannedPhrases.length === 0 && anchor.bannedInCodeComments.length === 0)) {
    // No anchor configured — gate is a no-op pass. Operator can configure
    // `~/.frqncy-harness/voice-anchor.md` to enable.
    return {
      passed: true,
      gate: 'voice-anchor',
      details: { skipped: 'no voice anchor configured' },
    };
  }

  const violations: { file: string; phrase: string; line: string; scope: 'all' | 'code-comment' }[] = [];

  for (const [path, diff] of Object.entries(diffByPath)) {
    const addedLines = extractAddedLines(diff);
    for (const lineRaw of addedLines) {
      const line = lineRaw.toLowerCase();
      // Banned anywhere
      for (const phrase of anchor.bannedPhrases) {
        const needle = phrase.toLowerCase();
        if (needle && line.includes(needle)) {
          violations.push({ file: path, phrase, line: lineRaw.slice(0, 200), scope: 'all' });
        }
      }
      // Banned only in code-comments
      if (isCommentLine(lineRaw)) {
        for (const phrase of anchor.bannedInCodeComments) {
          const needle = phrase.toLowerCase();
          if (needle && line.includes(needle)) {
            violations.push({ file: path, phrase, line: lineRaw.slice(0, 200), scope: 'code-comment' });
          }
        }
      }
    }
  }

  if (violations.length === 0) {
    return { passed: true, gate: 'voice-anchor' };
  }

  // Build a tight reason — first violation only, with the file + phrase
  const first = violations[0]!;
  return {
    passed: false,
    gate: 'voice-anchor',
    reason:
      `agent's added lines contain ${violations.length} voice-anchor violation(s). ` +
      `First: "${first.phrase}" in ${first.file} (scope: ${first.scope}). ` +
      `See ~/.frqncy-harness/voice-anchor.md for the full banned-phrase list.`,
    details: { violations: violations.slice(0, 20) }, // cap details payload
  };
}

// ────────────────────────────────────────────────────────────────────
// Composite gate — run all three in order
// ────────────────────────────────────────────────────────────────────

export interface PreEvolveGateInput {
  changeSet: ChangeSet;
  /** Override the voice-anchor file path. Test seam. */
  voiceAnchorPath?: string;
  /** Override the rubric anchors. Test seam + operator configurability. */
  rubricAnchors?: readonly string[];
  /** Test seam — substitute the voice-anchor loader. */
  loadVoiceAnchorFn?: (path: string) => Promise<VoiceAnchor | null>;
}

export interface PreEvolveGateResult extends GateResult {
  gate: 'pre-evolve-gate';
  /** Per-gate breakdown, in the order they ran. */
  subResults: GateResult[];
}

export async function runPreEvolveGate(input: PreEvolveGateInput): Promise<PreEvolveGateResult> {
  const subResults: GateResult[] = [];
  const loadFn = input.loadVoiceAnchorFn ?? loadVoiceAnchor;

  // 1. Rubric — cheapest, authoritative, run first
  const rubric = rubricAnchorGate(input.changeSet.changedFiles, input.rubricAnchors ?? DEFAULT_RUBRIC_ANCHORS);
  subResults.push(rubric);
  if (!rubric.passed) {
    return composite(false, rubric, subResults);
  }

  // 2. Inoculation — also cheap, authoritative
  const inoculation = inoculationAuditGate(input.changeSet.agentSystemPrompt);
  subResults.push(inoculation);
  if (!inoculation.passed) {
    return composite(false, inoculation, subResults);
  }

  // 3. Voice — requires loading the anchor file; runs last
  const anchor = await loadFn(input.voiceAnchorPath ?? DEFAULT_VOICE_ANCHOR_PATH);
  const voice = voiceAnchorGate(input.changeSet.diffByPath, anchor);
  subResults.push(voice);
  if (!voice.passed) {
    return composite(false, voice, subResults);
  }

  return composite(true, null, subResults);
}

function composite(
  passed: boolean,
  failingGate: GateResult | null,
  subResults: GateResult[],
): PreEvolveGateResult {
  if (passed) {
    return {
      passed: true,
      gate: 'pre-evolve-gate',
      subResults,
    };
  }
  return {
    passed: false,
    gate: 'pre-evolve-gate',
    reason: failingGate?.reason ?? 'pre-evolve-gate failed',
    details: {
      failingGate: failingGate?.gate ?? 'unknown',
      ...failingGate?.details,
    },
    subResults,
  };
}

// ────────────────────────────────────────────────────────────────────
// Voice-anchor file loader + parser (exported for testing)
// ────────────────────────────────────────────────────────────────────

export async function loadVoiceAnchor(path: string): Promise<VoiceAnchor | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return parseVoiceAnchor(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Parse a voice-anchor markdown file. Format (intentionally minimal):
 *
 * ```markdown
 * # Voice anchor for FRQNCY
 *
 * ## Banned phrases
 *
 * - unlock
 * - leverage
 * - synergy
 *
 * ## Banned in code comments
 *
 * - TODO without owner
 * - @ts-ignore
 *
 * ## Notes
 *
 * Free-form prose, ignored by the gate.
 * ```
 *
 * Sections are matched by H2 heading (`## `). Phrase lists are bullets (`- `, `* `, `+ `).
 */
export function parseVoiceAnchor(raw: string): VoiceAnchor {
  const sections = splitH2Sections(raw);
  const bannedPhrases = sections['banned phrases'] ? extractBullets(sections['banned phrases']) : [];
  const bannedInCodeComments = sections['banned in code comments']
    ? extractBullets(sections['banned in code comments'])
    : [];
  const notesRaw = sections['notes'] ?? '';
  const result: VoiceAnchor = {
    bannedPhrases,
    bannedInCodeComments,
  };
  const notesTrimmed = notesRaw.trim();
  if (notesTrimmed.length > 0) {
    result.notes = notesTrimmed;
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers (exported for testing where useful)
// ────────────────────────────────────────────────────────────────────

export function matchesAnyAnchor(file: string, anchors: readonly string[]): boolean {
  for (const anchor of anchors) {
    if (matchesAnchor(file, anchor)) return true;
  }
  return false;
}

function matchesAnchor(file: string, anchor: string): boolean {
  // Directory-prefix anchor — `rubrics/` matches any file under `rubrics/`
  if (anchor.endsWith('/')) {
    return file === anchor || file.startsWith(anchor) || file.includes('/' + anchor);
  }
  // Suffix glob — `*.lock` matches anything ending in `.lock`
  if (anchor.startsWith('*')) {
    return file.endsWith(anchor.slice(1));
  }
  // Exact filename — match either bare or as basename
  if (file === anchor) return true;
  if (file.endsWith('/' + anchor)) return true;
  return false;
}

export function extractAddedLines(diff: string): string[] {
  // Lines starting with `+` (but not `+++` which is the file marker) are additions.
  const out: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('+')) {
      out.push(line.slice(1)); // drop the leading `+`
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('--')
  );
}

function splitH2Sections(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on H2 headings — `## <name>` at the start of a line.
  // We don't use the `m` flag because of the same trap as in evolve.ts (it
  // makes `$` match every newline). Instead, look for `\n## ` boundaries.
  const lines = raw.split('\n');
  let currentName: string | null = null;
  let currentBuf: string[] = [];

  const flush = (): void => {
    if (currentName) {
      out[currentName] = currentBuf.join('\n');
    }
  };

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headerMatch && headerMatch[1]) {
      flush();
      currentName = headerMatch[1].trim().toLowerCase();
      currentBuf = [];
    } else if (currentName !== null) {
      currentBuf.push(line);
    }
  }
  flush();
  return out;
}

function extractBullets(sectionBody: string): string[] {
  const out: string[] = [];
  for (const line of sectionBody.split('\n')) {
    const m = line.match(/^[\s]*[-*+]\s+(.+?)\s*$/);
    if (m && m[1]) {
      // Strip surrounding backticks if present (`\`unlock\`` → `unlock`)
      let phrase = m[1].trim();
      if (phrase.startsWith('`') && phrase.endsWith('`') && phrase.length > 2) {
        phrase = phrase.slice(1, -1);
      }
      if (phrase.length > 0) out.push(phrase);
    }
  }
  return out;
}
