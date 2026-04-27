/**
 * Skills primitive — opt-in, auto-loaded skill packs.
 *
 * A "skill" is a self-contained markdown file with YAML frontmatter that lives
 * at `~/.frqncy-harness/skills/<name>/SKILL.md`. When the user runs
 * chat / repl / agent, the harness scans available skills, scores each against
 * the prompt, and auto-injects matching skill content into the system prompt.
 *
 * Frontmatter shape:
 *
 *   ---
 *   name: my-skill
 *   description: One-line description of when to use this skill
 *   keywords: [optional, list, of, terms]
 *   always: false   # if true, always inject regardless of prompt match
 *   ---
 *
 *   # Skill body in markdown
 *
 * Matching is intentionally simple in v0.7: a skill matches when ANY of its
 * keywords (or words from its description, ≥4 chars) appears in the prompt
 * (case-insensitive, word-boundary). Skills with `always: true` always match.
 *
 * v0.8+ may introduce semantic matching, but the simple substring approach is
 * predictable, fast, and works well for the current ~10-skill scale.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export const DEFAULT_SKILLS_DIR = join(homedir(), '.frqncy-harness', 'skills');

// ────────────────────────────────────────────────────────────────────
// Skill file schema
// ────────────────────────────────────────────────────────────────────

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  keywords: z.array(z.string().min(1).max(50)).optional(),
  always: z.boolean().optional(),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface LoadedSkill {
  /** Skill name from frontmatter */
  name: string;
  /** One-line description */
  description: string;
  /** Optional keyword triggers */
  keywords: string[];
  /** Always inject, regardless of prompt content */
  always: boolean;
  /** Skill body (everything after the frontmatter block) */
  body: string;
  /** Absolute path to the SKILL.md file */
  path: string;
}

// ────────────────────────────────────────────────────────────────────
// Loader
// ────────────────────────────────────────────────────────────────────

/**
 * Discover all skills in a directory. Each subdirectory containing a
 * `SKILL.md` file is loaded; malformed skills are silently skipped (to avoid
 * one bad file breaking the loader for the user's full set).
 */
export async function loadSkills(skillsDir = DEFAULT_SKILLS_DIR): Promise<LoadedSkill[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(skillsDir);
  } catch (err) {
    if (isFileNotFound(err)) return [];
    throw err;
  }

  const skills: LoadedSkill[] = [];
  for (const entry of entries) {
    const skillFile = join(skillsDir, entry, 'SKILL.md');
    try {
      const raw = await fs.readFile(skillFile, 'utf-8');
      const parsed = parseSkillFile(raw, skillFile);
      if (parsed) skills.push(parsed);
    } catch {
      // skip — likely not a directory, or no SKILL.md inside
    }
  }
  return skills;
}

/**
 * Parse a SKILL.md file. Returns null if the file has no frontmatter or fails
 * validation; we don't throw because a single bad skill should not break the
 * loader for the entire set.
 */
export function parseSkillFile(raw: string, path: string): LoadedSkill | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;
  const frontmatterText = match[1] ?? '';
  const body = (match[2] ?? '').trim();

  const fm: Record<string, unknown> = {};
  for (const line of frontmatterText.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const valueRaw = (m[2] ?? '').trim();
    fm[key] = parseScalarOrList(valueRaw);
  }

  const validated = SkillFrontmatterSchema.safeParse(fm);
  if (!validated.success) return null;

  return {
    name: validated.data.name,
    description: validated.data.description,
    keywords: validated.data.keywords ?? [],
    always: validated.data.always === true,
    body,
    path,
  };
}

function parseScalarOrList(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === '') return '';
  // YAML-ish list:  [a, b, c]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
  }
  return stripQuotes(raw);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ────────────────────────────────────────────────────────────────────
// Matcher
// ────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'with', 'this', 'that', 'from', 'have', 'when', 'what', 'where', 'which',
  'into', 'using', 'about', 'after', 'before', 'their', 'there', 'these',
  'those', 'would', 'should', 'could', 'every', 'each',
]);

/**
 * Pick the skills that match a prompt. A skill matches if:
 *   - its `always` flag is true, OR
 *   - any of its keywords appears as a whole word in the prompt, OR
 *   - any ≥4-char non-stopword from its description appears as a whole word in the prompt.
 *
 * Matching is case-insensitive. Returns skills in a stable order
 * (always-skills first, then by name).
 */
export function matchSkills(prompt: string, skills: readonly LoadedSkill[]): LoadedSkill[] {
  const lowered = ` ${prompt.toLowerCase()} `;
  const matched: LoadedSkill[] = [];
  for (const skill of skills) {
    if (skill.always) {
      matched.push(skill);
      continue;
    }
    const triggers = collectTriggers(skill);
    if (triggers.some((t) => containsWord(lowered, t))) {
      matched.push(skill);
    }
  }
  return matched.sort((a, b) => {
    if (a.always !== b.always) return a.always ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function collectTriggers(skill: LoadedSkill): string[] {
  const out = new Set<string>();
  for (const k of skill.keywords) {
    const lower = k.toLowerCase().trim();
    if (lower.length > 0) out.add(lower);
  }
  for (const word of skill.description.toLowerCase().split(/[^a-z0-9-]+/)) {
    if (word.length >= 4 && !STOPWORDS.has(word)) out.add(word);
  }
  return [...out];
}

function containsWord(loweredPaddedHaystack: string, needle: string): boolean {
  // Build a regex that matches the needle as a whole word.
  // Escape regex specials.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
  return re.test(loweredPaddedHaystack);
}

// ────────────────────────────────────────────────────────────────────
// Prompt assembler
// ────────────────────────────────────────────────────────────────────

/**
 * Format a list of matched skills as a system-prompt addendum. Caller appends
 * the result to its base system prompt (after any AGENT.md / CLAUDE.md content).
 *
 * Returns an empty string when no skills were matched.
 */
export function formatSkillsForSystemPrompt(skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) return '';
  const sections = skills.map((s) => {
    const header = `### Skill: ${s.name}\n_${s.description}_`;
    return `${header}\n\n${s.body}`;
  });
  return `--- LOADED SKILLS (${skills.length}) ---\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * One-shot: load skills from disk, match against prompt, format for injection.
 * Returns null when nothing matched (caller can skip the addendum entirely).
 */
export interface ResolvedSkills {
  matched: LoadedSkill[];
  systemAddendum: string;
}

export async function resolveSkillsForPrompt(
  prompt: string,
  skillsDir = DEFAULT_SKILLS_DIR,
): Promise<ResolvedSkills | null> {
  const all = await loadSkills(skillsDir);
  if (all.length === 0) return null;
  const matched = matchSkills(prompt, all);
  if (matched.length === 0) return null;
  return {
    matched,
    systemAddendum: formatSkillsForSystemPrompt(matched),
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function isFileNotFound(err: unknown): boolean {
  return (
    err !== null && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT'
  );
}
