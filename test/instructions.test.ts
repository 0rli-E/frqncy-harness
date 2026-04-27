import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjectInstructions } from '../src/instructions.js';

describe('loadProjectInstructions', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'instructions-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when no instruction file exists', async () => {
    expect(await loadProjectInstructions(dir)).toBeNull();
  });

  it('loads AGENT.md when present', async () => {
    await fs.writeFile(join(dir, 'AGENT.md'), '# project rules\n');
    const result = await loadProjectInstructions(dir);
    expect(result?.source).toBe('AGENT.md');
    expect(result?.content).toBe('# project rules\n');
    expect(result?.path).toBe(join(dir, 'AGENT.md'));
  });

  it('falls back to CLAUDE.md when AGENT.md is missing', async () => {
    await fs.writeFile(join(dir, 'CLAUDE.md'), 'claude-only\n');
    const result = await loadProjectInstructions(dir);
    expect(result?.source).toBe('CLAUDE.md');
    expect(result?.content).toBe('claude-only\n');
  });

  it('prefers AGENT.md over CLAUDE.md when both exist', async () => {
    await fs.writeFile(join(dir, 'AGENT.md'), 'agent\n');
    await fs.writeFile(join(dir, 'CLAUDE.md'), 'claude\n');
    const result = await loadProjectInstructions(dir);
    expect(result?.source).toBe('AGENT.md');
    expect(result?.content).toBe('agent\n');
  });

  it('treats an empty file as missing and falls through', async () => {
    await fs.writeFile(join(dir, 'AGENT.md'), '   \n');
    await fs.writeFile(join(dir, 'CLAUDE.md'), 'fallback\n');
    const result = await loadProjectInstructions(dir);
    expect(result?.source).toBe('CLAUDE.md');
    expect(result?.content).toBe('fallback\n');
  });
});
