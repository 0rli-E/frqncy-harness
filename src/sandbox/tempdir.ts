/**
 * Tempdir sandbox.
 *
 * Fallback when gtr isn't available. Creates a directory under the OS temp
 * dir, optionally copies cwd contents into it, and returns a Sandbox that
 * cleans up on dispose.
 *
 * NOT real isolation — the agent can still escape via absolute paths or
 * network. For untrusted prompts use E2B (v2) or Docker.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox, CreateSandboxOptions } from './index.js';

export interface CreateTempdirSandboxOptions extends CreateSandboxOptions {
  /** Whether to copy cwd contents into the sandbox dir. Default: false (empty dir) */
  copyContents?: boolean;
}

export async function createTempdirSandbox(opts: CreateTempdirSandboxOptions): Promise<Sandbox> {
  const sandboxName = `frqncy-harness-${opts.conversationId}`;
  const sandboxPath = join(tmpdir(), sandboxName);

  await fs.mkdir(sandboxPath, { recursive: true });

  if (opts.copyContents) {
    await copyDirectory(opts.cwd, sandboxPath);
  }

  return {
    backend: 'tempdir',
    path: sandboxPath,
    metadata: { copiedContents: opts.copyContents ?? false, originalCwd: opts.cwd },
    cleanup: async () => {
      try {
        await fs.rm(sandboxPath, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

/**
 * Recursive directory copy. Skips node_modules, .git, dist, and other heavy
 * dirs by default to keep the sandbox lean.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '.cache']);
  const entries = await fs.readdir(src, { withFileTypes: true });

  await fs.mkdir(dest, { recursive: true });

  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
    // skip symlinks, sockets, etc.
  }
}
