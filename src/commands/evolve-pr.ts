/**
 * Auto-open draft PR after a green evolve run.
 *
 * Closes the last manual step in the self-improvement loop. With `--auto-pr`,
 * `harness evolve` goes from "writes code, you run gh" to "writes code, opens
 * draft PR, you review and merge."
 *
 * Safety floor:
 *   - Refuses without `gh` CLI installed (asks user to install it)
 *   - Refuses on protected branches (main/master/develop/production) unless --yes
 *   - Always opens DRAFT — never auto-merges
 *   - Branch name is `evolve/<slug>` so it's never the user's main
 *   - Commit message includes full provenance metadata
 *   - PR body includes the source proposal, gate results, test result, file list,
 *     and explicit "review manually before merging" instructions
 *
 * Why this is opt-in (not default in v0.8.2):
 *   - Pushes to remote — has side effects on shared state (the git remote)
 *   - Today evolve runs in the user's cwd (not a worktree); auto-PR would
 *     pollute their local branch list. v1.0 pairs this with --worktree for
 *     full isolation; until then it's --auto-pr only when explicitly asked.
 */

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type AutoPrStatus = 'opened' | 'gh_missing' | 'protected_branch' | 'no_remote' | 'failed';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;

export interface AutoPrInput {
  cwd: string;
  /** Files the agent modified — used to scope `git add` surgically. */
  changedFiles: string[];
  /** Proposal name — used in branch slug + PR title. */
  proposalName: string;
  /** Full proposal markdown — embedded in the PR body. */
  proposalMarkdown: string;
  /** Source reflection file path — embedded in the PR body. */
  reflectionPath: string;
  /** Source ralph thread id — embedded in the PR body. */
  threadId: string;
  /** Model used for the inner ralph loop. */
  model: string;
  /** Number of ralph iterations executed. */
  iterations: number;
  /** Total cost across all iterations, USD. */
  totalCostUsd: number;
  /** Names of pre-evolve gates that passed (rubric-anchor, inoculation-audit, voice-anchor). */
  gatesPassed: string[];
  /** Whether `npm test` passed (true if --skip-verify, since no test ran to fail). */
  testsPassed: boolean;
  /** Bypass the protected-branch check. */
  yes?: boolean;
  // Test seams ─────────────────────────────────────────────
  execFn: ExecFn;
}

export interface AutoPrResult {
  status: AutoPrStatus;
  branch?: string;
  sha?: string;
  url?: string;
  reason?: string;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

export const PROTECTED_BRANCHES: readonly string[] = ['main', 'master', 'develop', 'production', 'release'];

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

export async function createPullRequest(input: AutoPrInput): Promise<AutoPrResult> {
  const { cwd, execFn } = input;

  // 1. Verify gh is installed
  const ghCheck = await execFn('gh', ['--version'], { cwd });
  if (ghCheck.exitCode !== 0) {
    return {
      status: 'gh_missing',
      reason:
        'gh CLI not found. Install it (https://cli.github.com) and run `gh auth login`, ' +
        'then re-run with --auto-pr. Alternatively, omit --auto-pr and run ' +
        '`gh pr create --draft` manually after reviewing the diff.',
    };
  }

  // 2. Verify a remote is configured
  const remoteCheck = await execFn('git', ['remote', '-v'], { cwd });
  if (remoteCheck.exitCode !== 0 || !remoteCheck.stdout.trim()) {
    return {
      status: 'no_remote',
      reason:
        'no git remote configured for ' +
        cwd +
        '. Add one with `git remote add origin <url>` and re-run.',
    };
  }

  // 3. Check current branch is not protected (unless --yes)
  const branchCheck = await execFn('git', ['branch', '--show-current'], { cwd });
  const currentBranch = branchCheck.stdout.trim();
  if (!input.yes && PROTECTED_BRANCHES.includes(currentBranch)) {
    return {
      status: 'protected_branch',
      reason:
        `current branch is "${currentBranch}" which is in the protected list ` +
        `(${PROTECTED_BRANCHES.join(', ')}). ` +
        `Either checkout a feature branch first, or pass --yes to override.`,
    };
  }

  // 4. Generate branch name + checkout
  const branchName = generateBranchName(input.proposalName);
  const checkoutResult = await execFn('git', ['checkout', '-b', branchName], { cwd });
  if (checkoutResult.exitCode !== 0) {
    return {
      status: 'failed',
      reason: `git checkout -b ${branchName} failed: ${checkoutResult.stderr.trim() || '(no stderr)'}`,
    };
  }

  // 5. Stage only the agent's changed files (surgical, not `git add -A`)
  if (input.changedFiles.length > 0) {
    const addResult = await execFn('git', ['add', '--', ...input.changedFiles], { cwd });
    if (addResult.exitCode !== 0) {
      return {
        status: 'failed',
        reason: `git add failed: ${addResult.stderr.trim() || '(no stderr)'}`,
      };
    }
  }

  // 6. Commit
  const commitMessage = formatCommitMessage(input);
  const commitResult = await execFn('git', ['commit', '-m', commitMessage], { cwd });
  if (commitResult.exitCode !== 0) {
    // If there's nothing to commit, that's a "soft fail" with a useful message
    if (/nothing to commit/i.test(commitResult.stdout + commitResult.stderr)) {
      return {
        status: 'failed',
        reason:
          'no changes to commit. The agent may not have actually modified any files. ' +
          'Check `git status` and `git diff` to inspect.',
      };
    }
    return {
      status: 'failed',
      reason: `git commit failed: ${commitResult.stderr.trim() || '(no stderr)'}`,
    };
  }

  // 7. Capture commit SHA
  const shaResult = await execFn('git', ['rev-parse', 'HEAD'], { cwd });
  const sha = shaResult.stdout.trim();

  // 8. Push the branch
  const pushResult = await execFn('git', ['push', '-u', 'origin', branchName], { cwd });
  if (pushResult.exitCode !== 0) {
    return {
      status: 'failed',
      reason: `git push failed: ${pushResult.stderr.trim() || '(no stderr)'}`,
    };
  }

  // 9. Open the draft PR
  const prTitle = formatPrTitle(input.proposalName);
  const prBody = formatPrBody(input);
  const prResult = await execFn(
    'gh',
    ['pr', 'create', '--draft', '--title', prTitle, '--body', prBody],
    { cwd },
  );
  if (prResult.exitCode !== 0) {
    return {
      status: 'failed',
      reason:
        `gh pr create failed: ${prResult.stderr.trim() || '(no stderr)'}. ` +
        `The branch ${branchName} was pushed but no PR was opened — you can run ` +
        `\`gh pr create --draft\` manually to open it.`,
      branch: branchName,
      sha,
    };
  }

  // 10. Parse the PR URL from gh output
  const url = extractPrUrl(prResult.stdout);

  return {
    status: 'opened',
    branch: branchName,
    sha,
    ...(url ? { url } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Generate a filesystem/git-safe branch name from a proposal title.
 * Always prefixed `evolve/` so it never collides with the user's branches.
 * Includes a 6-char random suffix to avoid collisions across multiple evolves
 * of the same proposal.
 */
export function generateBranchName(proposalName: string): string {
  const slug = proposalName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 5)
    .join('-')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `evolve/${slug || 'proposal'}-${suffix}`;
}

export function formatPrTitle(proposalName: string): string {
  // Cap at 80 chars so it renders cleanly in tabbed PR lists
  const trimmed = proposalName.trim().slice(0, 70);
  return `[evolve] ${trimmed}`;
}

export function formatCommitMessage(input: AutoPrInput): string {
  const lines = [
    `evolve: ${input.proposalName.slice(0, 60)}`,
    ``,
    `Auto-generated by frqncy-harness evolve.`,
    ``,
    `Source reflection: ${input.reflectionPath}`,
    `Source thread: ${input.threadId}`,
    `Agent: ${input.model}`,
    `Iterations: ${input.iterations}`,
    `Cost: $${input.totalCostUsd.toFixed(4)}`,
    `Inoculation: active (per Anthropic Nov 2025, arXiv 2511.18397)`,
    `Gates passed: ${input.gatesPassed.join(', ') || '(none configured)'}`,
    `Tests: ${input.testsPassed ? 'passed' : 'skipped'}`,
    ``,
    `Provenance: agent`,
  ];
  return lines.join('\n');
}

export function formatPrBody(input: AutoPrInput): string {
  const lines: string[] = [
    `> **Auto-generated by \`frqncy-harness evolve\`.** Draft only — review the diff manually before promoting to "Ready for review."`,
    ``,
    `## Source`,
    ``,
    `- **Reflection:** \`${input.reflectionPath}\``,
    `- **Proposal:** ${input.proposalName}`,
    `- **Source thread:** \`${input.threadId}\``,
    ``,
    `## Provenance`,
    ``,
    `- **Agent model:** \`${input.model}\``,
    `- **Iterations:** ${input.iterations}`,
    `- **Total cost:** $${input.totalCostUsd.toFixed(4)}`,
    `- **Inoculation active:** ✓ (per Anthropic Nov 2025, [arXiv:2511.18397](https://arxiv.org/abs/2511.18397))`,
    `- **Provenance:** \`agent\``,
    ``,
    `## Pre-evolve gate`,
    ``,
  ];
  if (input.gatesPassed.length === 0) {
    lines.push(`- _(no gates configured — \`--skip-gate\` was set or no gates registered)_`);
  } else {
    for (const gate of input.gatesPassed) {
      lines.push(`- ✓ ${gate}`);
    }
  }
  lines.push(
    ``,
    `## Test gate`,
    ``,
    input.testsPassed ? `- ✓ \`npm test\` exited 0` : `- _(skipped via \`--skip-verify\`)_`,
    ``,
    `## The proposal`,
    ``,
    input.proposalMarkdown.trim(),
    ``,
    `## Files changed`,
    ``,
  );
  if (input.changedFiles.length === 0) {
    lines.push(`- _(none detected by git diff)_`);
  } else {
    for (const file of input.changedFiles) {
      lines.push(`- \`${file}\``);
    }
  }
  lines.push(
    ``,
    `## How to merge safely`,
    ``,
    `1. **Review the diff manually** — automated gates catch obvious failures, not subtle ones.`,
    `2. **Run \`npm test\` locally** to verify the test gate.`,
    `3. **Read the proposal again** — does the implementation actually solve the recurring failure mode it cites?`,
    `4. If everything looks good, mark this PR as Ready for review and merge.`,
    ``,
    `This PR is opened in draft mode and will not auto-merge.`,
  );
  return lines.join('\n');
}

export function extractPrUrl(ghOutput: string): string | undefined {
  // gh pr create prints the PR URL on a line by itself, e.g.
  // "https://github.com/owner/repo/pull/123"
  const match = ghOutput.match(/https?:\/\/[^\s]+\/pull\/\d+/);
  return match ? match[0] : undefined;
}
