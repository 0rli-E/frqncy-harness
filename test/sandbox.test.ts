import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTempdirSandbox, isGtrAvailable } from '../src/sandbox/index.js';

const sandboxes: { cleanup: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const s of sandboxes.splice(0)) {
    await s.cleanup().catch(() => {});
  }
});

describe('createTempdirSandbox', () => {
  it('creates a fresh empty sandbox dir', async () => {
    const conversationId = randomUUID();
    const sandbox = await createTempdirSandbox({
      cwd: tmpdir(),
      conversationId,
    });
    sandboxes.push(sandbox);

    expect(sandbox.backend).toBe('tempdir');
    expect(sandbox.path).toContain('frqncy-harness-');
    const exists = await fs.access(sandbox.path).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('cleans up when asked', async () => {
    const sandbox = await createTempdirSandbox({
      cwd: tmpdir(),
      conversationId: randomUUID(),
    });
    const path = sandbox.path;
    await sandbox.cleanup();
    const exists = await fs.access(path).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('cleanup is idempotent', async () => {
    const sandbox = await createTempdirSandbox({
      cwd: tmpdir(),
      conversationId: randomUUID(),
    });
    await sandbox.cleanup();
    // Second call should not throw
    await expect(sandbox.cleanup()).resolves.toBeUndefined();
  });

  it('copies cwd contents when copyContents=true', async () => {
    // Make a fake source directory with a file
    const srcDir = join(tmpdir(), `src-${randomUUID()}`);
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(join(srcDir, 'file.txt'), 'hello');

    const sandbox = await createTempdirSandbox({
      cwd: srcDir,
      conversationId: randomUUID(),
      copyContents: true,
    });
    sandboxes.push(sandbox);

    const copiedFile = await fs.readFile(join(sandbox.path, 'file.txt'), 'utf-8');
    expect(copiedFile).toBe('hello');

    // Cleanup the source too
    await fs.rm(srcDir, { recursive: true, force: true });
  });

  it('skips heavy directories when copying', async () => {
    const srcDir = join(tmpdir(), `src-${randomUUID()}`);
    await fs.mkdir(join(srcDir, 'node_modules'), { recursive: true });
    await fs.writeFile(join(srcDir, 'node_modules', 'big.txt'), 'x'.repeat(1000));
    await fs.writeFile(join(srcDir, 'keep.txt'), 'kept');

    const sandbox = await createTempdirSandbox({
      cwd: srcDir,
      conversationId: randomUUID(),
      copyContents: true,
    });
    sandboxes.push(sandbox);

    const kept = await fs.readFile(join(sandbox.path, 'keep.txt'), 'utf-8');
    expect(kept).toBe('kept');

    const skipped = await fs.access(join(sandbox.path, 'node_modules')).then(() => true).catch(() => false);
    expect(skipped).toBe(false);

    await fs.rm(srcDir, { recursive: true, force: true });
  });
});

describe('isGtrAvailable', () => {
  it('returns false for non-git directories', async () => {
    expect(await isGtrAvailable(tmpdir())).toBe(false);
  });
});
