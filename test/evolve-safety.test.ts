import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rubricAnchorGate,
  voiceAnchorGate,
  inoculationAuditGate,
  runPreEvolveGate,
  parseVoiceAnchor,
  loadVoiceAnchor,
  matchesAnyAnchor,
  extractAddedLines,
  DEFAULT_RUBRIC_ANCHORS,
  INOCULATION_REQUIRED_PHRASE,
  type VoiceAnchor,
  type ChangeSet,
} from '../src/commands/evolve-safety.js';

// ────────────────────────────────────────────────────────────────────
// rubricAnchorGate
// ────────────────────────────────────────────────────────────────────

describe('rubricAnchorGate', () => {
  it('passes when no changed files match an anchor', () => {
    const result = rubricAnchorGate(['src/foo.ts', 'README.md']);
    expect(result.passed).toBe(true);
    expect(result.gate).toBe('rubric-anchor');
  });

  it('blocks when a changed file is exactly an anchored filename (AGENT.md)', () => {
    const result = rubricAnchorGate(['AGENT.md']);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/AGENT\.md/);
  });

  it('blocks when a changed file is in an anchored directory (rubrics/)', () => {
    const result = rubricAnchorGate(['rubrics/brand-voice.md']);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/rubrics\/brand-voice\.md/);
  });

  it('blocks when a changed file is the proposal doc itself', () => {
    const result = rubricAnchorGate(['proposals/SELF-IMPROVING-HARNESS.md']);
    expect(result.passed).toBe(false);
  });

  it('honors a custom anchor list', () => {
    const result = rubricAnchorGate(['src/foo.ts'], ['src/foo.ts']);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/src\/foo\.ts/);
  });

  it('reports all violations in details, not just the first', () => {
    const result = rubricAnchorGate(['AGENT.md', 'rubrics/brand.md']);
    expect(result.passed).toBe(false);
    expect((result.details?.violations as string[]).length).toBe(2);
  });

  it('exposes the anchors in details for audit', () => {
    const result = rubricAnchorGate(['AGENT.md']);
    expect(result.details?.anchors).toEqual([...DEFAULT_RUBRIC_ANCHORS]);
  });

  it('passes on an empty changed-files list', () => {
    const result = rubricAnchorGate([]);
    expect(result.passed).toBe(true);
  });
});

describe('matchesAnyAnchor', () => {
  it('matches exact filename', () => {
    expect(matchesAnyAnchor('AGENT.md', ['AGENT.md'])).toBe(true);
  });

  it('matches a basename in a subdirectory', () => {
    expect(matchesAnyAnchor('packages/x/AGENT.md', ['AGENT.md'])).toBe(true);
  });

  it('matches a directory-prefix anchor', () => {
    expect(matchesAnyAnchor('rubrics/brand.md', ['rubrics/'])).toBe(true);
    expect(matchesAnyAnchor('rubrics/sub/x.md', ['rubrics/'])).toBe(true);
  });

  it('matches a suffix-glob anchor', () => {
    expect(matchesAnyAnchor('package-lock.json', ['*.json'])).toBe(true);
    expect(matchesAnyAnchor('foo.txt', ['*.json'])).toBe(false);
  });

  it('does not match unrelated files', () => {
    expect(matchesAnyAnchor('src/foo.ts', DEFAULT_RUBRIC_ANCHORS)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// inoculationAuditGate
// ────────────────────────────────────────────────────────────────────

describe('inoculationAuditGate', () => {
  it('passes when the system prompt contains "reward hacking"', () => {
    const sys = 'You are a helpful assistant. Note: reward hacking is disallowed.';
    expect(inoculationAuditGate(sys).passed).toBe(true);
  });

  it('blocks when the inoculation phrase is missing', () => {
    const result = inoculationAuditGate('You are a helpful assistant.');
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/inoculation/i);
    expect(result.reason).toMatch(/2511\.18397/);
  });

  it('is case-insensitive on the inoculation match', () => {
    expect(inoculationAuditGate('REWARD HACKING is bad').passed).toBe(true);
    expect(inoculationAuditGate('Reward Hacking is bad').passed).toBe(true);
  });

  it('exposes prompt length in details for audit', () => {
    const result = inoculationAuditGate('short prompt');
    expect(result.details?.promptLength).toBe(12);
    expect(result.details?.requiredPhrase).toBe(INOCULATION_REQUIRED_PHRASE);
  });
});

// ────────────────────────────────────────────────────────────────────
// extractAddedLines
// ────────────────────────────────────────────────────────────────────

describe('extractAddedLines', () => {
  it('returns lines starting with + (without the leading +)', () => {
    const diff = ' context line\n+added one\n+added two\n-removed';
    expect(extractAddedLines(diff)).toEqual(['added one', 'added two']);
  });

  it('skips +++ file markers', () => {
    const diff = '+++ b/src/foo.ts\n+real addition\n';
    expect(extractAddedLines(diff)).toEqual(['real addition']);
  });

  it('returns empty for an empty diff', () => {
    expect(extractAddedLines('')).toEqual([]);
  });

  it('returns empty when there are no additions', () => {
    expect(extractAddedLines(' context\n-removed\n--- a/foo')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// parseVoiceAnchor + loadVoiceAnchor
// ────────────────────────────────────────────────────────────────────

describe('parseVoiceAnchor', () => {
  it('parses banned-phrases bullets out of an H2 section', () => {
    const raw = `# Voice anchor

## Banned phrases

- unlock
- leverage
- synergy

## Notes

free-form prose
`;
    const anchor = parseVoiceAnchor(raw);
    expect(anchor.bannedPhrases).toEqual(['unlock', 'leverage', 'synergy']);
    expect(anchor.notes).toContain('free-form');
  });

  it('parses banned-in-code-comments separately', () => {
    const raw = `## Banned phrases

- foo

## Banned in code comments

- @ts-ignore
- TODO without owner
`;
    const anchor = parseVoiceAnchor(raw);
    expect(anchor.bannedPhrases).toEqual(['foo']);
    expect(anchor.bannedInCodeComments).toEqual(['@ts-ignore', 'TODO without owner']);
  });

  it('strips backticks around bullet items', () => {
    const raw = `## Banned phrases

- \`unlock\`
- \`leverage\`
`;
    const anchor = parseVoiceAnchor(raw);
    expect(anchor.bannedPhrases).toEqual(['unlock', 'leverage']);
  });

  it('returns empty arrays when sections are absent', () => {
    const anchor = parseVoiceAnchor('# Some other doc with no banned-phrase section');
    expect(anchor.bannedPhrases).toEqual([]);
    expect(anchor.bannedInCodeComments).toEqual([]);
  });

  it('handles bullets with *, +, or -', () => {
    const raw = `## Banned phrases

- one
* two
+ three
`;
    const anchor = parseVoiceAnchor(raw);
    expect(anchor.bannedPhrases).toEqual(['one', 'two', 'three']);
  });

  it('case-insensitively matches the section heading name', () => {
    const raw = `## BANNED PHRASES

- shout
`;
    const anchor = parseVoiceAnchor(raw);
    expect(anchor.bannedPhrases).toEqual(['shout']);
  });
});

describe('loadVoiceAnchor', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'voice-anchor-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    expect(await loadVoiceAnchor(join(dir, 'nope.md'))).toBeNull();
  });

  it('loads and parses a real file from disk', async () => {
    const path = join(dir, 'voice-anchor.md');
    await writeFile(path, '## Banned phrases\n\n- unlock\n', 'utf-8');
    const anchor = await loadVoiceAnchor(path);
    expect(anchor?.bannedPhrases).toEqual(['unlock']);
  });
});

// ────────────────────────────────────────────────────────────────────
// voiceAnchorGate
// ────────────────────────────────────────────────────────────────────

describe('voiceAnchorGate', () => {
  const anchor: VoiceAnchor = {
    bannedPhrases: ['unlock', 'synergy'],
    bannedInCodeComments: ['@ts-ignore'],
  };

  it('passes when the anchor is null (no config)', () => {
    const result = voiceAnchorGate({ 'src/foo.ts': '+unlock the value\n' }, null);
    expect(result.passed).toBe(true);
    expect(result.details?.skipped).toBe('no voice anchor configured');
  });

  it('passes when both phrase lists are empty', () => {
    const empty: VoiceAnchor = { bannedPhrases: [], bannedInCodeComments: [] };
    const result = voiceAnchorGate({ 'src/foo.ts': '+anything goes\n' }, empty);
    expect(result.passed).toBe(true);
  });

  it('passes when no added lines contain banned phrases', () => {
    const result = voiceAnchorGate({ 'src/foo.ts': '+a clean addition\n' }, anchor);
    expect(result.passed).toBe(true);
  });

  it('blocks when an added line contains a banned phrase', () => {
    const result = voiceAnchorGate({ 'src/page.md': '+unlock the value\n' }, anchor);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/unlock/);
    expect(result.reason).toMatch(/page\.md/);
  });

  it('blocks case-insensitively', () => {
    const result = voiceAnchorGate({ 'src/page.md': '+UNLOCK the value\n' }, anchor);
    expect(result.passed).toBe(false);
  });

  it('does not flag matches in REMOVED lines (only added)', () => {
    const result = voiceAnchorGate({ 'src/page.md': '-unlock the value\n+clean text\n' }, anchor);
    expect(result.passed).toBe(true);
  });

  it('does not flag matches in CONTEXT lines (only added)', () => {
    const result = voiceAnchorGate({ 'src/page.md': ' unlock the value\n+clean text\n' }, anchor);
    expect(result.passed).toBe(true);
  });

  it('blocks code-comment phrases only inside comment lines', () => {
    const r1 = voiceAnchorGate({ 'src/foo.ts': '+// @ts-ignore\n' }, anchor);
    expect(r1.passed).toBe(false);
    const r2 = voiceAnchorGate({ 'src/foo.ts': '+const x = "@ts-ignore";\n' }, anchor);
    expect(r2.passed).toBe(true);
  });

  it('reports all violations in details (capped at 20)', () => {
    const big = Array.from({ length: 50 }, (_, i) => `+line ${i} unlock\n`).join('');
    const result = voiceAnchorGate({ 'src/x.md': big }, anchor);
    expect(result.passed).toBe(false);
    expect((result.details?.violations as unknown[]).length).toBeLessThanOrEqual(20);
  });
});

// ────────────────────────────────────────────────────────────────────
// runPreEvolveGate (composite)
// ────────────────────────────────────────────────────────────────────

describe('runPreEvolveGate', () => {
  function makeChangeSet(overrides: Partial<ChangeSet> = {}): ChangeSet {
    return {
      changedFiles: ['src/foo.ts'],
      diffByPath: { 'src/foo.ts': '+const x = 1;\n' },
      agentSystemPrompt: 'You may not engage in reward hacking.',
      ...overrides,
    };
  }

  const stubAnchorLoader = async (): Promise<VoiceAnchor | null> => null;

  it('passes the composite when all three sub-gates pass', async () => {
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet(),
      loadVoiceAnchorFn: stubAnchorLoader,
    });
    expect(result.passed).toBe(true);
    expect(result.gate).toBe('pre-evolve-gate');
    expect(result.subResults).toHaveLength(3);
    expect(result.subResults.every((r) => r.passed)).toBe(true);
  });

  it('runs gates in order: rubric → inoculation → voice', async () => {
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet(),
      loadVoiceAnchorFn: stubAnchorLoader,
    });
    expect(result.subResults[0]!.gate).toBe('rubric-anchor');
    expect(result.subResults[1]!.gate).toBe('inoculation-audit');
    expect(result.subResults[2]!.gate).toBe('voice-anchor');
  });

  it('short-circuits on rubric failure (does not run inoculation or voice)', async () => {
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet({ changedFiles: ['AGENT.md'] }),
      loadVoiceAnchorFn: stubAnchorLoader,
    });
    expect(result.passed).toBe(false);
    expect(result.subResults).toHaveLength(1);
    expect(result.subResults[0]!.gate).toBe('rubric-anchor');
    expect(result.details?.failingGate).toBe('rubric-anchor');
  });

  it('short-circuits on inoculation failure (does not run voice)', async () => {
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet({ agentSystemPrompt: 'no inoculation here' }),
      loadVoiceAnchorFn: stubAnchorLoader,
    });
    expect(result.passed).toBe(false);
    expect(result.subResults).toHaveLength(2);
    expect(result.subResults[1]!.gate).toBe('inoculation-audit');
    expect(result.details?.failingGate).toBe('inoculation-audit');
  });

  it('blocks on voice failure when an anchor is configured', async () => {
    const anchor: VoiceAnchor = { bannedPhrases: ['unlock'], bannedInCodeComments: [] };
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet({ diffByPath: { 'src/foo.ts': '+unlock the value\n' } }),
      loadVoiceAnchorFn: async () => anchor,
    });
    expect(result.passed).toBe(false);
    expect(result.subResults[2]!.gate).toBe('voice-anchor');
    expect(result.details?.failingGate).toBe('voice-anchor');
  });

  it('honors a custom rubric-anchors override', async () => {
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet({ changedFiles: ['src/foo.ts'] }),
      rubricAnchors: ['src/foo.ts'],
      loadVoiceAnchorFn: stubAnchorLoader,
    });
    expect(result.passed).toBe(false);
    expect(result.subResults[0]!.gate).toBe('rubric-anchor');
  });

  it('passes voice gate silently when no anchor file is configured (loader returns null)', async () => {
    const result = await runPreEvolveGate({
      changeSet: makeChangeSet({ diffByPath: { 'src/foo.ts': '+unlock\n' } }),
      loadVoiceAnchorFn: async () => null,
    });
    expect(result.passed).toBe(true);
    expect(result.subResults[2]!.gate).toBe('voice-anchor');
    expect(result.subResults[2]!.details?.skipped).toBe('no voice anchor configured');
  });
});
