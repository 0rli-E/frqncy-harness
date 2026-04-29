/**
 * `frqncy-harness evolve [--reflection <path>] [--proposal N] [--cwd <path>] [--model <m>] [--max-iterations N] [--yes] [--skip-verify] [--json]`
 *
 * Closes the self-improvement loop. Reads a reflection (produced by
 * `harness reflect`), picks one proposal, and wraps `harness ralph` with the
 * claude-sdk lane to actually implement the change. Verifies by running
 * `npm test` from outside ralph after completion — the agent cannot fake test
 * passing because evolve runs the verifier independently.
 *
 * Why this exists: ralph generates traces, reflect synthesizes patterns, codify
 * captures individual failures as tests. evolve is what acts. Without it, the
 * harness watches itself but never improves itself.
 *
 * v0.8 scope (intentionally narrow — the rest is v0.9):
 *   - Does NOT open a PR. Changes land on the current branch in the chosen cwd
 *     (refused if cwd is dirty without --yes); user runs `gh pr create --draft`
 *     when ready. Drafted-PR auto-creation is a v0.9 add.
 *   - Does NOT manage gtr worktrees in evolve itself; relies on ralph's iteration
 *     cap + cost cap + the user-controlled cwd. Worktree isolation is v0.9.
 *   - Default model is claude-sdk/<config-default> because that's the only lane
 *     that does in-process tool calling today. Override via --model to use a
 *     different SDK-aware lane; non-SDK lanes won't be able to write files.
 *
 * Safety floor (load-bearing):
 *   - Refuses to run on a dirty working tree unless --yes is passed
 *   - Inherits ralph's inoculation sentence + max-iterations + cost cap + kill-flag
 *   - External test verification AFTER ralph completes — agent cannot fake passing
 *   - Never auto-merges; never runs `gh pr create` automatically
 *
 * The deeper safety hooks (C.3 pre-evolve-gate, C.4 voice-anchor, C.5 rubric-anchor
 * per `proposals/SELF-IMPROVING-HARNESS.md`) are still TBD — they layer on top of
 * this v0.8 evolve in v0.9, gated by --enable-pre-evolve-gate or similar.
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { runRalphCommand, RALPH_SYSTEM_PROMPT, type RalphResult } from './ralph.js';
import { loadConfig } from '../config.js';
import { INOCULATION_SENTENCE } from './codify.js';
import {
  runPreEvolveGate,
  type ChangeSet,
  type PreEvolveGateResult,
  type VoiceAnchor,
} from './evolve-safety.js';
import { createPullRequest, type AutoPrResult } from './evolve-pr.js';
import { createGtrSandbox, isGtrAvailable } from '../sandbox/index.js';
import type { Sandbox } from '../sandbox/index.js';
import type { ModelString } from '../types.js';

const execFileAsync = promisify(execFile);

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const DEFAULT_MAX_ITERATIONS = 15;
const EVOLVE_COMPLETION_PROMISE = '<promise>EVOLVE COMPLETE</promise>';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type EvolveStatus =
  | 'completed'
  | 'pr_opened'
  | 'tests_failed'
  | 'ralph_failed'
  | 'dirty_tree'
  | 'no_reflection'
  | 'gate_blocked'
  | 'worktree_failed';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EvolveCommandOptions {
  /** Path to a reflection markdown file. If unset, picks the most recent `proposals/reflection-*.md`. */
  reflectionPath?: string;
  /** Which proposal to implement (1-indexed). Default: 1. */
  proposal?: number;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Model lane. Default: config.defaultModel, auto-upgraded to claude-sdk/* if it's an anthropic API model. */
  model?: string;
  /** Hard cap on inner ralph iterations. Default 15. */
  maxIterations?: number;
  /** Thread tag for the inner ralph run. Default: `evolve-<short>`. */
  threadId?: string;
  /** Bypass the dirty-tree refusal. Use with caution. */
  yes?: boolean;
  /** Skip the external `npm test` verification. */
  skipVerify?: boolean;
  /** Skip the pre-evolve gate (rubric-anchor + inoculation-audit + voice-anchor). NOT recommended. */
  skipGate?: boolean;
  /** Override the voice-anchor file path. */
  voiceAnchorPath?: string;
  /** Override the rubric anchors. */
  rubricAnchors?: readonly string[];
  /**
   * After all gates and tests pass, automatically commit the agent's changes,
   * push to a new branch, and open a draft PR via `gh pr create --draft`.
   * Requires the `gh` CLI installed and authenticated. Refuses on protected
   * branches (main/master/develop/production/release) unless `--yes` is also set.
   */
  autoPr?: boolean;
  /**
   * Run all evolve operations inside an isolated git worktree (via gtr).
   * The user's main checkout is never modified. Pairs naturally with --auto-pr:
   * the worktree is the file-isolation layer; auto-PR pushes the worktree's
   * changes to the remote without ever touching the user's working tree.
   * Refuses if `git gtr` is not installed or cwd is not a git repo.
   * Skips the dirty-tree check (worktrees are always fresh by construction).
   */
  worktree?: boolean;
  /**
   * When --worktree is set, keep the worktree on disk after evolve completes.
   * By default, the worktree is cleaned up on success and kept on failure
   * (so you can inspect what went wrong). Set to true to always keep.
   */
  keepWorktree?: boolean;
  /** Emit JSON summary instead of human-readable status. */
  json?: boolean;
  // Test seams ─────────────────────────────────────────────
  /** Override the inner ralph runner. */
  ralphFn?: typeof runRalphCommand;
  /** Override the shell exec used for git status / npm test. */
  execFn?: (cmd: string, args: string[], opts: { cwd: string }) => Promise<ExecResult>;
  /** Test seam — substitute the voice-anchor loader. */
  loadVoiceAnchorFn?: (path: string) => Promise<VoiceAnchor | null>;
  /** Test seam — substitute the worktree setup. */
  setupWorktreeFn?: (cwd: string, conversationId: string) => Promise<Sandbox | { error: string }>;
}

export interface ParsedProposal {
  /** 1-indexed position in the reflection. */
  index: number;
  /** The heading text after `### N. ` */
  name: string;
  /** The "Pattern:" line, if extractable. */
  pattern: string;
  /** The "Recommended fix:" line, if extractable. */
  recommendedFix: string;
  /** The fix category — a, b, c, d — if extractable. */
  fixCategory: 'a' | 'b' | 'c' | 'd' | 'unknown';
  /** Optional referenced trace id from "Example trace:". */
  exampleTrace?: string;
  /** The full Markdown body of this proposal section, useful for the implementation prompt. */
  rawSection: string;
}

export interface EvolveResult {
  status: EvolveStatus;
  reflectionPath: string;
  proposal: ParsedProposal | null;
  threadId: string;
  ralphResult?: RalphResult;
  gateResult?: PreEvolveGateResult;
  testResult?: { passed: boolean; stdout: string; stderr: string };
  /** Populated when --auto-pr is set. Contains either the opened PR's url+branch+sha, or a soft-fail reason. */
  prResult?: AutoPrResult;
  /** When --worktree is set, the absolute path to the isolated worktree. May be cleaned up by the time the caller reads this. */
  worktreePath?: string;
  changedFiles: string[];
  totalCostUsd: number;
}

// ────────────────────────────────────────────────────────────────────
// Main entry point
// ────────────────────────────────────────────────────────────────────

export async function runEvolveCommand(options: EvolveCommandOptions = {}): Promise<EvolveResult> {
  const config = await loadConfig();
  const userCwd = options.cwd ?? process.cwd();
  const ralphFn = options.ralphFn ?? runRalphCommand;
  const execFn = options.execFn ?? defaultExec;
  const setupWorktreeFn = options.setupWorktreeFn ?? defaultSetupWorktree;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const threadId = options.threadId ?? `evolve-${cryptoRandomShort()}`;

  const banner = (msg: string): void => {
    if (!options.json) process.stdout.write(msg);
  };

  // ── 1. Resolve reflection path ───────────────────────────
  // Always against the user's cwd — the reflection lives in the user's repo, not the worktree.
  const reflectionPath = options.reflectionPath
    ? resolveReflectionPath(options.reflectionPath, userCwd)
    : await findMostRecentReflection(userCwd);
  if (!reflectionPath) {
    const result: EvolveResult = {
      status: 'no_reflection',
      reflectionPath: '',
      proposal: null,
      threadId,
      changedFiles: [],
      totalCostUsd: 0,
    };
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stderr.write(
        `${ANSI.red}× no reflection found at proposals/reflection-*.md in ${userCwd}.${ANSI.reset}\n` +
          `Run \`frqncy-harness reflect\` first to generate a reflection, ` +
          `or pass --reflection <path> explicitly.\n`,
      );
    }
    return result;
  }

  // ── 2. Parse + pick a proposal ───────────────────────────
  const reflectionRaw = await fs.readFile(reflectionPath, 'utf-8');
  const proposals = parseProposalsFromMarkdown(reflectionRaw);
  if (proposals.length === 0) {
    throw new Error(
      `no proposals found in ${reflectionPath}. The reflection file should contain ` +
        `## Recurring failure modes followed by ### 1. ... ### 2. ... etc.`,
    );
  }
  const proposalIndex = options.proposal ?? 1;
  if (proposalIndex < 1 || proposalIndex > proposals.length) {
    throw new Error(
      `--proposal ${proposalIndex} out of range. Reflection has ${proposals.length} proposal(s).`,
    );
  }
  const chosen = proposals[proposalIndex - 1]!;

  banner(
    `${ANSI.bold}${ANSI.cyan}evolve${ANSI.reset} ` +
      `${ANSI.dim}reflection=${reflectionPath}${ANSI.reset}\n` +
      `${ANSI.dim}proposal ${proposalIndex}/${proposals.length}: ${chosen.name}${ANSI.reset}\n` +
      `${ANSI.dim}fix category: ${chosen.fixCategory}${ANSI.reset}\n` +
      `${ANSI.dim}thread: ${threadId}${ANSI.reset}\n\n`,
  );

  // ── 2.5. Worktree isolation (optional) ──────────────────
  // When --worktree is set, all subsequent operations run inside a fresh gtr
  // worktree. The user's main checkout is never modified.
  let workSandbox: Sandbox | null = null;
  let cwd = userCwd;
  if (options.worktree) {
    banner(`${ANSI.dim}── creating gtr worktree (file isolation) ──${ANSI.reset}\n`);
    const setup = await setupWorktreeFn(userCwd, threadId);
    if ('error' in setup) {
      const result: EvolveResult = {
        status: 'worktree_failed',
        reflectionPath,
        proposal: chosen,
        threadId,
        changedFiles: [],
        totalCostUsd: 0,
      };
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stderr.write(
          `${ANSI.red}× worktree setup failed: ${setup.error}${ANSI.reset}\n` +
            `Either install gtr (\`brew install git-gtr\`), make sure cwd is a git repo, ` +
            `or omit --worktree to run in your current cwd directly.\n`,
        );
      }
      return result;
    }
    workSandbox = setup;
    cwd = workSandbox.path;
    banner(
      `${ANSI.dim}  worktree path: ${cwd}${ANSI.reset}\n` +
        `${ANSI.dim}  user cwd unchanged: ${userCwd}${ANSI.reset}\n\n`,
    );
  }

  // ── 3. Refuse on dirty tree (unless --yes or --worktree) ─
  // Worktree mode skips this — the worktree is fresh by construction; the user's
  // main cwd doesn't matter because we never touch it.
  if (!options.yes && !options.worktree) {
    const dirty = await isWorkingTreeDirty(cwd, execFn);
    if (dirty) {
      const result: EvolveResult = {
        status: 'dirty_tree',
        reflectionPath,
        proposal: chosen,
        threadId,
        changedFiles: [],
        totalCostUsd: 0,
      };
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stderr.write(
          `${ANSI.red}× working tree at ${cwd} has uncommitted changes.${ANSI.reset}\n` +
            `Either commit/stash first, pass --yes to override (the agent will commit on top), ` +
            `or pass --worktree to run in an isolated gtr worktree.\n`,
        );
      }
      return result;
    }
  }

  // ── 4. Run inner ralph loop ──────────────────────────────
  const model = (options.model ?? config.defaultModel ?? 'anthropic/claude-sonnet-4-6') as ModelString;
  const ralphModel = upgradeToSdkLane(model);

  const implementationPrompt = buildImplementationPrompt({
    proposal: chosen,
    cwd,
    reflectionPath,
    completionPromise: EVOLVE_COMPLETION_PROMISE,
  });

  banner(`${ANSI.dim}── inner ralph loop starting (model=${ralphModel}, max-iter=${maxIterations}) ──${ANSI.reset}\n\n`);

  const ralphResult = await ralphFn(implementationPrompt, {
    until: EVOLVE_COMPLETION_PROMISE,
    maxIterations,
    cwd,
    model: ralphModel,
    threadId,
    json: options.json ?? false,
  });

  if (ralphResult.status !== 'completed') {
    const result: EvolveResult = {
      status: 'ralph_failed',
      reflectionPath,
      proposal: chosen,
      threadId,
      ralphResult,
      changedFiles: [],
      totalCostUsd: ralphResult.totalCostUsd,
    };
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stderr.write(
        `${ANSI.red}× inner ralph loop did not complete (status=${ralphResult.status}).${ANSI.reset}\n` +
          `Iterations: ${ralphResult.iterations.length}/${maxIterations}, ` +
          `cost: $${ralphResult.totalCostUsd.toFixed(4)}.\n` +
          `Run \`frqncy-harness reflect --thread ${threadId}\` to inspect what happened.\n`,
      );
    }
    return result;
  }

  // ── 5. Pre-evolve gate (rubric + inoculation + voice) ───
  // Runs BEFORE `npm test` because tests can be silent on:
  //   (a) anchor-file edits — agent could rewrite a rubric and have tests still pass
  //   (b) off-brand prose — tests rarely assert content tone
  //   (c) missing inoculation — tests don't audit the agent's own system prompt
  // The gate is the content-correctness layer; tests are the code-correctness layer.
  // Both are needed.
  const changedFiles = await listChangedFiles(cwd, execFn);

  let gateResult: PreEvolveGateResult | undefined;
  if (!options.skipGate) {
    banner(`${ANSI.dim}── pre-evolve gate (rubric + inoculation + voice) ──${ANSI.reset}\n`);
    const diffByPath = await loadDiffByPath(changedFiles, cwd, execFn);
    const changeSet: ChangeSet = {
      changedFiles,
      diffByPath,
      agentSystemPrompt: RALPH_SYSTEM_PROMPT,
    };
    gateResult = await runPreEvolveGate({
      changeSet,
      ...(options.voiceAnchorPath ? { voiceAnchorPath: options.voiceAnchorPath } : {}),
      ...(options.rubricAnchors ? { rubricAnchors: options.rubricAnchors } : {}),
      ...(options.loadVoiceAnchorFn ? { loadVoiceAnchorFn: options.loadVoiceAnchorFn } : {}),
    });
    if (!gateResult.passed) {
      const result: EvolveResult = {
        status: 'gate_blocked',
        reflectionPath,
        proposal: chosen,
        threadId,
        ralphResult,
        gateResult,
        changedFiles,
        totalCostUsd: ralphResult.totalCostUsd,
      };
      if (options.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        process.stderr.write(
          `\n${ANSI.red}× pre-evolve gate blocked the run${ANSI.reset}\n` +
            `${ANSI.dim}  failing gate: ${gateResult.details?.failingGate ?? 'unknown'}${ANSI.reset}\n` +
            `${ANSI.dim}  reason: ${gateResult.reason ?? '(no reason)'}${ANSI.reset}\n` +
            `Changes are still on disk; review with ${ANSI.bold}git diff${ANSI.reset} and either fix or revert.\n`,
        );
      }
      return result;
    }
  }

  // ── 6. External verify (npm test) ────────────────────────
  let testResult: EvolveResult['testResult'];
  if (!options.skipVerify) {
    banner(`${ANSI.dim}── verifying with \`npm test\` (external — agent cannot fake this) ──${ANSI.reset}\n`);
    try {
      const exec = await execFn('npm', ['test'], { cwd });
      testResult = {
        passed: exec.exitCode === 0,
        stdout: exec.stdout,
        stderr: exec.stderr,
      };
    } catch (err) {
      testResult = {
        passed: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const testsActuallyFailed = testResult ? !testResult.passed : false;
  const testsPassedOrSkipped = !testsActuallyFailed;

  // ── 7. Auto-PR (optional, only if all gates + tests passed) ──
  let prResult: AutoPrResult | undefined;
  if (options.autoPr && testsPassedOrSkipped) {
    banner(`${ANSI.dim}── auto-pr: committing, pushing, opening draft PR ──${ANSI.reset}\n`);
    const gatesPassed = gateResult ? gateResult.subResults.filter((r) => r.passed).map((r) => r.gate) : [];
    prResult = await createPullRequest({
      cwd,
      changedFiles,
      proposalName: chosen.name,
      proposalMarkdown: chosen.rawSection,
      reflectionPath,
      threadId,
      model: ralphModel,
      iterations: ralphResult.iterations.length,
      totalCostUsd: ralphResult.totalCostUsd,
      gatesPassed,
      testsPassed: testsPassedOrSkipped,
      yes: options.yes ?? false,
      execFn,
    });
    if (prResult.status === 'opened') {
      banner(
        `${ANSI.green}✓ draft PR opened${ANSI.reset} ${ANSI.dim}${prResult.url ?? ''}${ANSI.reset}\n` +
          `${ANSI.dim}  branch: ${prResult.branch}${ANSI.reset}\n` +
          `${ANSI.dim}  sha:    ${prResult.sha}${ANSI.reset}\n`,
      );
    } else {
      banner(
        `${ANSI.yellow}! auto-pr did not open the PR (status=${prResult.status})${ANSI.reset}\n` +
          `${ANSI.dim}  reason: ${prResult.reason ?? '(no reason)'}${ANSI.reset}\n` +
          `${ANSI.dim}  changes are still on disk; review and run \`gh pr create --draft\` manually${ANSI.reset}\n`,
      );
    }
  }

  // ── Status mapping ───────────────────────────────────────
  // tests failed → tests_failed (regardless of --auto-pr)
  // tests passed + --auto-pr + PR opened → pr_opened
  // tests passed + --auto-pr + PR soft-failed → completed (with prResult populated for inspection)
  // tests passed + no --auto-pr → completed
  const status: EvolveStatus = testsActuallyFailed
    ? 'tests_failed'
    : prResult && prResult.status === 'opened'
      ? 'pr_opened'
      : 'completed';

  const result: EvolveResult = {
    status,
    reflectionPath,
    proposal: chosen,
    threadId,
    ralphResult,
    ...(gateResult ? { gateResult } : {}),
    ...(testResult ? { testResult } : {}),
    ...(prResult ? { prResult } : {}),
    ...(workSandbox ? { worktreePath: workSandbox.path } : {}),
    changedFiles,
    totalCostUsd: ralphResult.totalCostUsd,
  };

  // ── Worktree cleanup ────────────────────────────────────
  // Default: clean up on success, keep on failure (so user can inspect).
  // --keep-worktree forces keep regardless.
  if (workSandbox) {
    const succeeded = status === 'completed' || status === 'pr_opened';
    const shouldClean = succeeded && !options.keepWorktree;
    if (shouldClean) {
      try {
        await workSandbox.cleanup();
        banner(`${ANSI.dim}  worktree cleaned up${ANSI.reset}\n`);
      } catch {
        // best-effort cleanup
      }
    } else {
      banner(
        `${ANSI.yellow}note:${ANSI.reset} worktree kept at ${ANSI.dim}${workSandbox.path}${ANSI.reset}\n` +
          (succeeded
            ? `${ANSI.dim}  (--keep-worktree was set; remove manually with \`git gtr clean\`)${ANSI.reset}\n`
            : `${ANSI.dim}  (kept for inspection because evolve did not fully succeed)${ANSI.reset}\n`),
      );
    }
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    if (status === 'pr_opened') {
      process.stdout.write(
        `\n${ANSI.green}✓ evolve complete — draft PR opened${ANSI.reset}\n` +
          `${ANSI.dim}  iterations: ${ralphResult.iterations.length}${ANSI.reset}\n` +
          `${ANSI.dim}  cost: $${ralphResult.totalCostUsd.toFixed(4)}${ANSI.reset}\n` +
          `${ANSI.dim}  branch: ${prResult?.branch ?? '?'}${ANSI.reset}\n` +
          `${ANSI.dim}  PR: ${prResult?.url ?? '?'}${ANSI.reset}\n` +
          `${ANSI.yellow}next:${ANSI.reset} review the diff, then mark the PR Ready for review when satisfied.\n`,
      );
    } else if (status === 'completed') {
      process.stdout.write(
        `\n${ANSI.green}✓ evolve complete${ANSI.reset}\n` +
          `${ANSI.dim}  iterations: ${ralphResult.iterations.length}${ANSI.reset}\n` +
          `${ANSI.dim}  cost: $${ralphResult.totalCostUsd.toFixed(4)}${ANSI.reset}\n` +
          `${ANSI.dim}  changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : '(none detected)'}${ANSI.reset}\n` +
          `${ANSI.yellow}note:${ANSI.reset} changes are on disk. Review with ${ANSI.bold}git diff${ANSI.reset}, ` +
          `then run ${ANSI.bold}gh pr create --draft${ANSI.reset} when ready ` +
          `(or pass ${ANSI.bold}--auto-pr${ANSI.reset} next time).\n`,
      );
    } else {
      process.stderr.write(
        `\n${ANSI.red}× evolve completed the loop but tests failed${ANSI.reset}\n` +
          `${ANSI.dim}  iterations: ${ralphResult.iterations.length}${ANSI.reset}\n` +
          `${ANSI.dim}  cost: $${ralphResult.totalCostUsd.toFixed(4)}${ANSI.reset}\n` +
          `${ANSI.dim}  changed files: ${changedFiles.join(', ') || '(none)'}${ANSI.reset}\n` +
          `Changes are still on disk; review and either fix or revert.\n`,
      );
      if (testResult?.stderr) {
        process.stderr.write(`\n${ANSI.dim}── npm test stderr ──${ANSI.reset}\n${testResult.stderr.slice(-2000)}\n`);
      }
    }
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

/**
 * Parse the proposals out of a reflection markdown file.
 *
 * The format is what `runReflectCommand` produces:
 *   ## Recurring failure modes
 *
 *   ### 1. <name>
 *   - **Frequency:** ...
 *   - **Pattern:** ...
 *   - **Example trace:** `<id>`
 *   - **Recommended fix:** `<a/b/c/d>` — ...
 *   - **Estimated complexity:** ...
 *
 *   ### 2. <name>
 *   ...
 *
 *   ## Synthesis
 *   ...
 */
export function parseProposalsFromMarkdown(md: string): ParsedProposal[] {
  // Split into section blocks at `### N. ...` boundaries within the recurring-failure-modes block.
  // We don't enforce strict structure — we extract what we can, leave the rest as rawSection.
  const proposals: ParsedProposal[] = [];

  // Find the recurring-failure-modes block.
  // No `m` flag: with `m`, `$` matches every newline, which collapses the capture to empty.
  // Without `m`, `$` is end-of-string and the lookahead is `\n##\s` for the next H2.
  const failureBlockMatch = md.match(/##\s+Recurring failure modes\n([\s\S]*?)(?=\n##\s|$)/);
  if (!failureBlockMatch) return proposals;

  const failureBlock = failureBlockMatch[1] ?? '';

  // Split on ### N. headings — same `m`-flag fix: use `\n###` for the lookahead.
  const sectionRegex = /###\s+(\d+)\.\s+([^\n]+)\n([\s\S]*?)(?=\n###\s+\d+\.|$)/g;
  let m: RegExpExecArray | null;
  while ((m = sectionRegex.exec(failureBlock)) !== null) {
    const idx = Number(m[1]);
    const name = (m[2] ?? '').trim();
    const body = m[3] ?? '';
    const rawSection = `### ${idx}. ${name}\n${body}`.trim();

    const pattern = extractListField(body, 'Pattern');
    const recommendedFix = extractListField(body, 'Recommended fix');
    const fixCategory = inferFixCategory(recommendedFix);
    const exampleTrace = extractInlineCode(body, 'Example trace');

    const proposal: ParsedProposal = {
      index: idx,
      name,
      pattern,
      recommendedFix,
      fixCategory,
      rawSection,
      ...(exampleTrace ? { exampleTrace } : {}),
    };
    proposals.push(proposal);
  }

  return proposals;
}

function extractListField(body: string, label: string): string {
  // Match either `- **<label>:** <value>` (bold; colon inside the asterisks) or
  // plain `- <label>: <value>`. The bold form is what `runReflectCommand` produces.
  const re = new RegExp(`^-\\s+\\*?\\*?${escapeRegex(label)}:\\*?\\*?\\s+(.+)$`, 'm');
  const m = body.match(re);
  return m && m[1] ? m[1].trim() : '';
}

function extractInlineCode(body: string, label: string): string | undefined {
  // Match `- **<label>:** \`<code>\`` (bold form) or `- <label>: \`<code>\`` (plain)
  const re = new RegExp(`^-\\s+\\*?\\*?${escapeRegex(label)}:\\*?\\*?\\s+\`([^\`]+)\``, 'm');
  const m = body.match(re);
  return m && m[1] ? m[1].trim() : undefined;
}

function inferFixCategory(recommendedFix: string): ParsedProposal['fixCategory'] {
  // Look for `\`a\`` / `\`b\`` / `\`c\`` / `\`d\`` at the start of the recommended-fix line
  const m = recommendedFix.match(/^`([abcd])`/);
  if (m && m[1]) return m[1] as 'a' | 'b' | 'c' | 'd';
  // Or a bare `(a)` / `(b)`
  const m2 = recommendedFix.match(/^\(([abcd])\)/);
  if (m2 && m2[1]) return m2[1] as 'a' | 'b' | 'c' | 'd';
  return 'unknown';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface BuildImplementationPromptArgs {
  proposal: ParsedProposal;
  cwd: string;
  reflectionPath: string;
  completionPromise: string;
}

export function buildImplementationPrompt(args: BuildImplementationPromptArgs): string {
  return [
    `# Implement one proposal from a reflection`,
    ``,
    `${INOCULATION_SENTENCE}`,
    ``,
    `## Source`,
    ``,
    `- Reflection file: \`${args.reflectionPath}\``,
    `- Working directory: \`${args.cwd}\``,
    `- Completion predicate: \`${args.completionPromise}\``,
    ``,
    `## The proposal you are implementing`,
    ``,
    args.proposal.rawSection,
    ``,
    `## Your task`,
    ``,
    `Implement EXACTLY the proposal above in the current working directory. The fix category is \`${args.proposal.fixCategory}\` (a=new hook, b=new skill, c=system-prompt amendment, d=regression test).`,
    ``,
    `Concrete steps:`,
    `1. Read existing repo conventions (\`AGENT.md\`, \`CLAUDE.md\`, \`package.json\`, \`README.md\`, neighboring files) before writing anything.`,
    `2. Make the smallest correct change that implements the proposal. Do not refactor unrelated code.`,
    `3. If the fix category is \`d\` (regression test), generate the test file under \`test/regression/\` matching the existing convention (see \`src/commands/codify.ts\` if you need a pointer). Default to \`describe.skip()\` so the suite stays green; the operator un-skips when ready.`,
    `4. Run \`npm run typecheck\` (via the bash tool) to verify your changes type-check.`,
    `5. Run \`npm test\` (via the bash tool) to verify the suite still passes.`,
    `6. Once both pass and the proposal is implemented, emit the completion predicate exactly: \`${args.completionPromise}\`.`,
    ``,
    `## Hard rules`,
    ``,
    `- Do NOT modify files outside the working directory.`,
    `- Do NOT push, merge, or open a PR — your job ends at "tests pass on a clean diff."`,
    `- Do NOT emit the completion predicate to escape a hard problem. If you cannot make the change, say so explicitly and stop without emitting the predicate.`,
    `- Do NOT modify \`rubrics/*.md\`, \`AGENT.md\`'s "Locked architectural decisions" section, or \`proposals/SELF-IMPROVING-HARNESS.md\` itself — those are anchored. If your proposal would require it, escalate by saying so.`,
    ``,
    `Begin.`,
  ].join('\n');
}

export function parseChangedFiles(gitDiffOutput: string): string[] {
  return gitDiffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function upgradeToSdkLane(model: string): ModelString {
  // If the user passed an anthropic API model, prefer the SDK lane (it does tool calling
  // automatically inside each iteration). Other lanes pass through unchanged.
  if (model.startsWith('anthropic/')) {
    return ('claude-sdk/' + model.slice('anthropic/'.length)) as ModelString;
  }
  return model as ModelString;
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function findMostRecentReflection(cwd: string): Promise<string | null> {
  const dir = join(cwd, 'proposals');
  try {
    const entries = await fs.readdir(dir);
    const matches = entries
      .filter((e) => /^reflection-\d{4}-\d{2}-\d{2}.*\.md$/.test(e))
      .sort()
      .reverse(); // YYYY-MM-DD lexical sort = chronological reverse
    if (matches.length === 0) return null;
    return join(dir, matches[0]!);
  } catch {
    return null;
  }
}

function resolveReflectionPath(p: string, cwd: string): string {
  if (p.startsWith('/')) return p;
  return join(cwd, p);
}

async function isWorkingTreeDirty(
  cwd: string,
  execFn: NonNullable<EvolveCommandOptions['execFn']>,
): Promise<boolean> {
  try {
    const result = await execFn('git', ['status', '--porcelain'], { cwd });
    return result.stdout.trim().length > 0;
  } catch {
    // If git isn't available or this isn't a git repo, treat as not-dirty —
    // the user explicitly asked to run evolve here, and there's no working
    // tree to be dirty.
    return false;
  }
}

async function listChangedFiles(
  cwd: string,
  execFn: NonNullable<EvolveCommandOptions['execFn']>,
): Promise<string[]> {
  try {
    const result = await execFn('git', ['diff', '--name-only', 'HEAD'], { cwd });
    return parseChangedFiles(result.stdout);
  } catch {
    return [];
  }
}

async function loadDiffByPath(
  changedFiles: string[],
  cwd: string,
  execFn: NonNullable<EvolveCommandOptions['execFn']>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const path of changedFiles) {
    try {
      // Use --no-color for robust regex matching in voice-anchor scanning.
      const result = await execFn('git', ['diff', '--no-color', 'HEAD', '--', path], { cwd });
      out[path] = result.stdout;
    } catch {
      out[path] = ''; // skip on error; gates fall through
    }
  }
  return out;
}

async function defaultExec(
  cmd: string,
  args: string[],
  opts: { cwd: string },
): Promise<ExecResult> {
  try {
    const result = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      maxBuffer: 50 * 1024 * 1024, // 50MB — npm test output can be large
    });
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
      exitCode: 0,
    };
  } catch (err) {
    const e = err as Record<string, unknown>;
    const stdoutRaw = e.stdout;
    const stderrRaw = e.stderr;
    const message = typeof e.message === 'string' ? e.message : '';
    return {
      stdout: typeof stdoutRaw === 'string' ? stdoutRaw : stdoutRaw != null ? String(stdoutRaw) : '',
      stderr:
        typeof stderrRaw === 'string'
          ? stderrRaw
          : stderrRaw != null
            ? String(stderrRaw)
            : message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

function cryptoRandomShort(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Default worktree setup: refuses to fall back to tempdir (evolve needs git
 * history for the auto-PR push, which tempdir cannot provide).
 */
async function defaultSetupWorktree(cwd: string, conversationId: string): Promise<Sandbox | { error: string }> {
  const ok = await isGtrAvailable(cwd);
  if (!ok) {
    return {
      error:
        'git gtr is not installed or cwd is not a git repo. ' +
        'Install with `brew install git-gtr` (and run from inside a git repo).',
    };
  }
  try {
    return await createGtrSandbox({ cwd, conversationId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `gtr worktree creation failed: ${msg}` };
  }
}
