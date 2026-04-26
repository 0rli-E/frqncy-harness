/**
 * Sandbox abstraction.
 *
 * A sandbox is the isolated working directory where state-changing tools
 * (bash, write, etc.) execute. Decision 5 in HARNESS-PLAN.md:
 *
 *   gtr worktree per agent run for v0.2 (filesystem isolation, ~100ms,
 *   leverages git history for audit). E2B microVMs for v2 product surfaces
 *   with untrusted user input.
 *
 * In v0.2 sprint #1 we ship two backends:
 *   - gtr — when cwd is a git repo and `git gtr` is installed
 *   - tempdir — fallback that copies cwd into /tmp (no isolation guarantees
 *     beyond "different folder")
 *
 * createSandbox() picks the best backend automatically.
 */
import { createGtrSandbox, isGtrAvailable } from './gtr.js';
import { createTempdirSandbox } from './tempdir.js';

export interface Sandbox {
  /** Backend that created this sandbox */
  backend: 'gtr' | 'tempdir';
  /** Absolute path the agent should run inside */
  path: string;
  /** Optional metadata (branch name for gtr, etc.) */
  metadata?: Record<string, unknown>;
  /** Tear down the sandbox. Always safe to call multiple times. */
  cleanup: () => Promise<void>;
}

export interface CreateSandboxOptions {
  /** Original working directory we're sandboxing FROM */
  cwd: string;
  /** Conversation ID — used to name the sandbox (branch name for gtr, dir name for tempdir) */
  conversationId: string;
  /** Force a specific backend (for testing). Default: auto-detect. */
  backend?: 'gtr' | 'tempdir' | 'auto';
}

/**
 * Pick the best sandbox backend for the given cwd and create it.
 *
 * Auto-detection rules:
 *   - If cwd is a git repo AND `git gtr` is installed → gtr
 *   - Otherwise → tempdir (with implicit warning logged via metadata)
 */
export async function createSandbox(opts: CreateSandboxOptions): Promise<Sandbox> {
  const backend = opts.backend ?? 'auto';

  if (backend === 'gtr' || (backend === 'auto' && (await isGtrAvailable(opts.cwd)))) {
    return createGtrSandbox(opts);
  }

  return createTempdirSandbox(opts);
}

export { createGtrSandbox, isGtrAvailable } from './gtr.js';
export { createTempdirSandbox } from './tempdir.js';
