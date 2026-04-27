import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillFile,
  loadSkills,
  matchSkills,
  formatSkillsForSystemPrompt,
  resolveSkillsForPrompt,
} from '../src/skills/index.js';

describe('parseSkillFile', () => {
  it('parses frontmatter + body', () => {
    const raw = [
      '---',
      'name: hermes',
      'description: Build Hermes-style ReACT agents',
      'keywords: [hermes, react]',
      'always: false',
      '---',
      '',
      '# body',
      'content',
    ].join('\n');
    const parsed = parseSkillFile(raw, '/fake/SKILL.md');
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('hermes');
    expect(parsed!.description).toContain('ReACT');
    expect(parsed!.keywords).toEqual(['hermes', 'react']);
    expect(parsed!.always).toBe(false);
    expect(parsed!.body).toContain('# body');
  });

  it('returns null without frontmatter', () => {
    expect(parseSkillFile('just a markdown file', '/fake/SKILL.md')).toBeNull();
  });

  it('returns null with malformed frontmatter (missing name)', () => {
    const raw = '---\ndescription: only desc\n---\n\nbody';
    expect(parseSkillFile(raw, '/fake/SKILL.md')).toBeNull();
  });

  it('strips quoted scalar values', () => {
    const raw = `---
name: "quoted-name"
description: 'single-quoted desc'
---
body`;
    const parsed = parseSkillFile(raw, '/fake/SKILL.md');
    expect(parsed?.name).toBe('quoted-name');
    expect(parsed?.description).toBe('single-quoted desc');
  });
});

describe('loadSkills', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skills-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns empty array when dir does not exist', async () => {
    expect(await loadSkills(join(dir, 'missing'))).toEqual([]);
  });

  it('discovers and parses skill files in subdirectories', async () => {
    await fs.mkdir(join(dir, 'alpha'));
    await fs.writeFile(
      join(dir, 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: First skill\n---\n\nbody-a',
    );
    await fs.mkdir(join(dir, 'beta'));
    await fs.writeFile(
      join(dir, 'beta', 'SKILL.md'),
      '---\nname: beta\ndescription: Second skill\n---\n\nbody-b',
    );
    const skills = await loadSkills(dir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'beta']);
  });

  it('skips subdirectories without SKILL.md', async () => {
    await fs.mkdir(join(dir, 'alpha'));
    await fs.writeFile(join(dir, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: X\n---\n\nx');
    await fs.mkdir(join(dir, 'empty'));
    const skills = await loadSkills(dir);
    expect(skills.map((s) => s.name)).toEqual(['alpha']);
  });
});

describe('matchSkills', () => {
  const fixtures = [
    {
      name: 'hermes',
      description: 'Build hermes-style ReACT agents',
      keywords: ['hermes', 'react'],
      always: false,
      body: 'h-body',
      path: '/h',
    },
    {
      name: 'editorial',
      description: 'Editorial values for FRQNCY content',
      keywords: ['editorial', 'frqncy'],
      always: false,
      body: 'e-body',
      path: '/e',
    },
    {
      name: 'always-on',
      description: 'Always loaded',
      keywords: [],
      always: true,
      body: 'a-body',
      path: '/a',
    },
  ];

  it('matches when a keyword appears in the prompt', () => {
    const matched = matchSkills('please use hermes for this', fixtures);
    expect(matched.map((s) => s.name)).toContain('hermes');
  });

  it('matches when a description word appears in the prompt', () => {
    const matched = matchSkills('I need help with FRQNCY editorial values', fixtures);
    expect(matched.map((s) => s.name)).toContain('editorial');
  });

  it('always-skills are returned even with empty prompt', () => {
    const matched = matchSkills('totally unrelated topic', fixtures);
    expect(matched.map((s) => s.name)).toContain('always-on');
  });

  it('does not match unrelated prompts beyond always-skills', () => {
    const matched = matchSkills('color of the sky', fixtures);
    expect(matched.map((s) => s.name)).toEqual(['always-on']);
  });

  it('returns always-skills first', () => {
    const matched = matchSkills('hermes editorial', fixtures);
    expect(matched[0]?.name).toBe('always-on');
  });

  it('matches whole words only — substring of a keyword does not trigger', () => {
    // 'hermesx' should not match keyword 'hermes'
    const matched = matchSkills('reading about hermesx topology', fixtures);
    expect(matched.map((s) => s.name)).not.toContain('hermes');
  });
});

describe('formatSkillsForSystemPrompt', () => {
  it('returns empty string for no skills', () => {
    expect(formatSkillsForSystemPrompt([])).toBe('');
  });

  it('formats matched skills with headers', () => {
    const out = formatSkillsForSystemPrompt([
      { name: 'a', description: 'd-a', keywords: [], always: false, body: 'body-a', path: '/a' },
      { name: 'b', description: 'd-b', keywords: [], always: false, body: 'body-b', path: '/b' },
    ]);
    expect(out).toContain('LOADED SKILLS (2)');
    expect(out).toContain('### Skill: a');
    expect(out).toContain('body-a');
    expect(out).toContain('### Skill: b');
    expect(out).toContain('body-b');
  });
});

describe('resolveSkillsForPrompt', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skills-resolve-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no skills installed', async () => {
    expect(await resolveSkillsForPrompt('hello', dir)).toBeNull();
  });

  it('returns null when nothing matches', async () => {
    await fs.mkdir(join(dir, 'k'));
    await fs.writeFile(
      join(dir, 'k', 'SKILL.md'),
      '---\nname: k\ndescription: kubernetes deployments\nkeywords: [kubernetes, k8s]\n---\n\nk-body',
    );
    expect(await resolveSkillsForPrompt('write a poem about clouds', dir)).toBeNull();
  });

  it('returns matched skills + addendum when prompt matches', async () => {
    await fs.mkdir(join(dir, 'k'));
    await fs.writeFile(
      join(dir, 'k', 'SKILL.md'),
      '---\nname: k\ndescription: kubernetes deployments\nkeywords: [kubernetes, k8s]\n---\n\nk-body',
    );
    const resolved = await resolveSkillsForPrompt('how do I roll out a kubernetes deploy?', dir);
    expect(resolved).not.toBeNull();
    expect(resolved!.matched.map((s) => s.name)).toEqual(['k']);
    expect(resolved!.systemAddendum).toContain('k-body');
  });
});
