/**
 * gtr worktree sandbox.
 *
 * Per HARNESS-PLAN.md decision 5: each agent run creates a temporary git
 * worktree (via the gtr CLI we documented in harness.md) so the agent works
 * on its own branch in a separate folder. Cleanup on exit. Filesystem-isolated,
 * ~100ms cold start, free, leverages git history for audit.
 *
 * Requirements:
 *   - The cwd must be inside a git repository
 *   - `git gtr` must be installed (`brew install git-gtr`)
 *
 * Falls back to tempdir if either requirement is missing — see ../sandbox/index.ts.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Sandbox, CreateSandboxOptions } from './index.js';

const exec = promisify(execFile);

/**
 * Quick check whether gtr is available for a given cwd:
 *   - cwd is inside a git repo
 *   - `git gtr version` exits 0
 */
export async function isGtrAvailable(cwd: string): Promise<boolean> {
  try {
    // Is cwd a git repo?
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  } catch {
    return false;
  }
  try {
    // Is gtr installed?
    await exec('git', ['gtr', 'version'], { cwd });
    return true;
  } catch {
    return false;
  }
}

export async function createGtrSandbox(opts: CreateSandboxOptions): Promise<Sandbox> {
  // Branch name based on conversation id (short version)
  const shortId = opts.conversationId.replace(/-/g, '').slice(0, 12);
  const branchName = `frqncy-harness/${shortId}`;

  // Create the worktree via `git gtr new <branch>`. gtr places the worktree
  // adjacent to the main repo by default; we capture the resulting path.
  let worktreePath: string;
  try {
    await exec('git', ['gtr', 'new', branchName, '--from-current', '--no-fetch', '--no-hooks', '--yes'], {
      cwd: opts.cwd,
    });
    // Read back the worktree list to find the path gtr created.
    const { stdout } = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: opts.cwd });
    worktreePath = parseWorktreePath(stdout, branchName);
  } catch (err) {
    throw new Error(
      `Failed to create gtr worktree: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    backend: 'gtr',
    path: worktreePath,
    metadata: { branch: branchName, originalCwd: opts.cwd },
    cleanup: async () => {
      try {
        // Remove the worktree (gtr handles the bookkeeping)
        await exec('git', ['gtr', 'rm', branchName, '--force', '--yes'], { cwd: opts.cwd });
      } catch {
        // Fall back to direct removal if gtr isn't available at cleanup time
        try {
          await fs.rm(worktreePath, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    },
  };
}

/**
 * Parse `git worktree list --porcelain` output to find the worktree path
 * for a specific branch.
 *
 * Format:
 *   worktree /path/to/worktree
 *   HEAD <sha>
 *   branch refs/heads/<branch>
 *   <blank line>
 *   ...
 */
function parseWorktreePath(porcelain: string, branchName: string): string {
  const blocks = porcelain.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    let path: string | undefined;
    let branch: string | undefined;
    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      if (line.startsWith('branch ')) branch = line.slice('branch '.length).trim();
    }
    if (branch === `refs/heads/${branchName}` && path) {
      // Sanity check it exists
      return path;
    }
  }
  // Heuristic fallback: look for any path containing the short branch suffix
  const fallback = porcelain.match(new RegExp(`worktree (\\S*${branchName.replace(/[/.]/g, '.')}\\S*)`, ));
  if (fallback?.[1]) return fallback[1];

  throw new Error(`Could not locate worktree path for branch ${branchName} in: ${porcelain}`);
}

/**
 * Detect whether a sandbox is gtr-backed.
 */
export function isGtrSandbox(sandbox: Sandbox): boolean {
  return sandbox.backend === 'gtr';
}
