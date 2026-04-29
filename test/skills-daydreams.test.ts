/**
 * skills/daydreams/* bundle tests.
 *
 * Confirms:
 *   - Every directory under skills/daydreams/ that contains SKILL.md
 *     parses cleanly via parseSkillFile
 *   - Frontmatter is valid (name, description, keywords)
 *   - All skill names are unique
 *   - The master `frqncy-network-wallet` is `always: true`
 *   - The README.md exists
 *   - The full set covers the documented Daydreams + Lucid surface
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillFile } from '../src/skills/index.js';

// Resolve skills/daydreams from the test file's location.
const here = fileURLToPath(import.meta.url);
// test/skills-daydreams.test.ts → ../skills/daydreams
const BUNDLE_DIR = resolve(here, '..', '..', 'skills', 'daydreams');

interface ScannedSkill {
  dirName: string;
  filePath: string;
  raw: string;
}

async function scanBundle(): Promise<ScannedSkill[]> {
  const entries = await fs.readdir(BUNDLE_DIR, { withFileTypes: true });
  const skills: ScannedSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const filePath = join(BUNDLE_DIR, e.name, 'SKILL.md');
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      skills.push({ dirName: e.name, filePath, raw });
    } catch {
      // Not a skill pack
    }
  }
  return skills;
}

describe('skills/daydreams/* bundle', () => {
  it('contains a README.md', async () => {
    await expect(fs.access(join(BUNDLE_DIR, 'README.md'))).resolves.toBeUndefined();
  });

  it('every skill pack has SKILL.md that parses cleanly', async () => {
    const skills = await scanBundle();
    expect(skills.length).toBeGreaterThanOrEqual(10);
    for (const s of skills) {
      // parseSkillFile validates the frontmatter via Zod and extracts the body
      const parsed = parseSkillFile(s.raw, s.filePath);
      expect(parsed.name, `${s.dirName}: name must be set`).toBeTruthy();
      expect(parsed.description, `${s.dirName}: description must be set`).toBeTruthy();
      expect(parsed.body.length, `${s.dirName}: body must be non-empty`).toBeGreaterThan(50);
    }
  });

  it('every skill name is unique', async () => {
    const skills = await scanBundle();
    const names = new Set<string>();
    for (const s of skills) {
      const parsed = parseSkillFile(s.raw, s.filePath);
      expect(names.has(parsed.name), `duplicate skill name: ${parsed.name}`).toBe(false);
      names.add(parsed.name);
    }
  });

  it('skill name matches its directory name', async () => {
    const skills = await scanBundle();
    for (const s of skills) {
      const parsed = parseSkillFile(s.raw, s.filePath);
      expect(
        parsed.name,
        `${s.dirName}: name in frontmatter (${parsed.name}) must match directory name`,
      ).toBe(s.dirName);
    }
  });

  it('frqncy-network-wallet is always:true', async () => {
    const path = join(BUNDLE_DIR, 'frqncy-network-wallet', 'SKILL.md');
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = parseSkillFile(raw, path);
    expect(parsed.always, 'master skill must be always:true').toBe(true);
  });

  it('every non-master skill has at least 3 keywords', async () => {
    const skills = await scanBundle();
    for (const s of skills) {
      const parsed = parseSkillFile(s.raw, s.filePath);
      if (parsed.always) continue; // master skill matches via always:true
      expect(
        parsed.keywords.length,
        `${parsed.name}: must have ≥3 keywords (has ${parsed.keywords.length})`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it('covers the documented Daydreams + Lucid surface', async () => {
    const skills = await scanBundle();
    const names = new Set(skills.map((s) => parseSkillFile(s.raw, s.filePath).name));
    // Required minimum coverage — every name from the README's table:
    const required = [
      'frqncy-network-wallet',
      'agent-commerce',
      'defi-evm-actions',
      'defi-sui-aggregator',
      'defi-solana-actions',
      'defi-starknet-actions',
      'hyperliquid-trading',
      'twitter-post',
      'discord-post',
      'telegram-post',
      'genai-media',
      'mcp-orchestration',
      'vector-chroma',
      'store-firebase',
      'store-mongo',
      'store-supabase',
      'lucid-a2a',
      'lucid-ap2',
      'synthetic-training',
    ];
    for (const r of required) {
      expect(names.has(r), `bundle missing required skill: ${r}`).toBe(true);
    }
  });

  it('descriptions are concise (≤500 chars)', async () => {
    const skills = await scanBundle();
    for (const s of skills) {
      const parsed = parseSkillFile(s.raw, s.filePath);
      expect(
        parsed.description.length,
        `${parsed.name}: description must be ≤500 chars (was ${parsed.description.length})`,
      ).toBeLessThanOrEqual(500);
    }
  });
});

describe('skills install command — package layout', () => {
  it('exposes a discoverable bundle directory at the package root', async () => {
    const stat = await fs.stat(BUNDLE_DIR);
    expect(stat.isDirectory()).toBe(true);
  });

  it('has a frqncy-network-wallet directory', async () => {
    const stat = await fs.stat(join(BUNDLE_DIR, 'frqncy-network-wallet'));
    expect(stat.isDirectory()).toBe(true);
  });
});
