/**
 * Bundled hooks shipped with the harness.
 *
 * Reference these from config.json by name with the prefix:
 *   "frqncy-harness-bundled:auto-commit-traces"
 *   "frqncy-harness-bundled:macos-notification"
 *   "frqncy-harness-bundled:editorial-lint"
 *
 * v0.5 defaults (per Orlando's picks):
 *   - auto-commit-traces: ENABLED on post-agent
 *   - macos-notification: ENABLED on post-agent
 *   - editorial-lint:     BUILT but NOT enabled by default — opt in via config
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, basename } from 'node:path';
import type { HookContext, HookResult } from './index.js';

const exec = promisify(execFile);

// ────────────────────────────────────────────────────────────────────
// 1. Auto-commit traces (PostAgent) — wires up the autoPushTraces flag
// ────────────────────────────────────────────────────────────────────

export async function bundledAutoCommitTraces(ctx: HookContext): Promise<HookResult> {
  const startMs = Date.now();
  if (ctx.event !== 'post-agent') {
    return {
      hookName: 'frqncy-harness-bundled:auto-commit-traces',
      durationMs: Date.now() - startMs,
      success: false,
      error: 'auto-commit-traces only fires on post-agent (got: ' + ctx.event + ')',
    };
  }

  // The trace dir is the parent of the traceFilePath's parent
  // (traces/<date>/<id>.jsonl → traces/)
  const dateFolder = dirname(ctx.traceFilePath);
  const traceDir = dirname(dateFolder);

  try {
    // Only act if it's actually a git repo
    await exec('git', ['-C', traceDir, 'rev-parse', '--is-inside-work-tree'], { timeout: 3000 });
  } catch {
    return {
      hookName: 'frqncy-harness-bundled:auto-commit-traces',
      durationMs: Date.now() - startMs,
      success: true,
      warning: `Skipped: ${traceDir} is not a git repo. Initialize it once with 'cd ${traceDir} && git init && git remote add origin <url>'.`,
    };
  }

  try {
    // Stage everything
    await exec('git', ['-C', traceDir, 'add', '-A'], { timeout: 5000 });

    // Check if there's anything to commit
    const { stdout: status } = await exec('git', ['-C', traceDir, 'status', '--porcelain'], { timeout: 3000 });
    if (!status.trim()) {
      return {
        hookName: 'frqncy-harness-bundled:auto-commit-traces',
        durationMs: Date.now() - startMs,
        success: true,
        warning: '(nothing to commit — trace already committed)',
      };
    }

    const message = `trace: ${ctx.conversationId} (${ctx.status})`;
    await exec('git', ['-C', traceDir, 'commit', '-m', message, '--no-verify'], { timeout: 5000 });

    // Try to push if there's an origin remote — best-effort
    try {
      await exec('git', ['-C', traceDir, 'remote', 'get-url', 'origin'], { timeout: 3000 });
      await exec('git', ['-C', traceDir, 'push', 'origin', 'HEAD'], { timeout: 30_000 });
    } catch {
      // No remote configured, or push failed — commit still succeeded locally
      return {
        hookName: 'frqncy-harness-bundled:auto-commit-traces',
        durationMs: Date.now() - startMs,
        success: true,
        warning: 'Committed locally; push failed (check git remote / network).',
      };
    }

    return {
      hookName: 'frqncy-harness-bundled:auto-commit-traces',
      durationMs: Date.now() - startMs,
      success: true,
    };
  } catch (err) {
    return {
      hookName: 'frqncy-harness-bundled:auto-commit-traces',
      durationMs: Date.now() - startMs,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// 2. macOS notification (PostAgent) — wires up the notifications.enabled flag
// ────────────────────────────────────────────────────────────────────

export async function bundledMacosNotification(ctx: HookContext): Promise<HookResult> {
  const startMs = Date.now();
  if (ctx.event !== 'post-agent') {
    return {
      hookName: 'frqncy-harness-bundled:macos-notification',
      durationMs: Date.now() - startMs,
      success: false,
      error: 'macos-notification only fires on post-agent (got: ' + ctx.event + ')',
    };
  }

  // Only on macOS
  if (process.platform !== 'darwin') {
    return {
      hookName: 'frqncy-harness-bundled:macos-notification',
      durationMs: Date.now() - startMs,
      success: true,
      warning: `Skipped: not on macOS (platform=${process.platform})`,
    };
  }

  const title = ctx.status === 'completed' ? 'Agent done ✓' : `Agent ${ctx.status} ✗`;
  const promptSnippet = ctx.prompt.slice(0, 80).replace(/[\\"]/g, ' ');
  const tokens = `${ctx.usage.inputTokens}→${ctx.usage.outputTokens} tokens`;
  const subtitle = `${tokens} · ${ctx.model.split('/').pop()}`;
  const body = promptSnippet;

  // Construct AppleScript safely (we already stripped quotes from prompt)
  const script =
    `display notification "${escapeForApplescript(body)}" ` +
    `with title "${escapeForApplescript(title)}" ` +
    `subtitle "${escapeForApplescript(subtitle)}" ` +
    `sound name "Pop"`;

  return new Promise<HookResult>((resolve) => {
    const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill(), 5_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({
          hookName: 'frqncy-harness-bundled:macos-notification',
          durationMs: Date.now() - startMs,
          success: true,
        });
      } else {
        resolve({
          hookName: 'frqncy-harness-bundled:macos-notification',
          durationMs: Date.now() - startMs,
          success: false,
          error: stderr.trim() || `osascript exited ${code}`,
        });
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        hookName: 'frqncy-harness-bundled:macos-notification',
        durationMs: Date.now() - startMs,
        success: false,
        error: err.message,
      });
    });
  });
}

function escapeForApplescript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ────────────────────────────────────────────────────────────────────
// 3. Editorial-values lint (PostToolUse on Write) — built but inactive by default
// ────────────────────────────────────────────────────────────────────

/**
 * Patterns that violate FRQNCY's editorial values per CLAUDE.md.
 * Each pattern: a regex + a human-readable explanation.
 *
 * Easy to extend — new entries here become enforced immediately when the hook is active.
 */
const FORBIDDEN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\bleader[\s-]?board\b/i,
    reason: 'FRQNCY does not use leaderboards (cooperation over competition).',
  },
  {
    re: /\b(top|best)\s+\d+\s+(people|practitioners|users)\b/i,
    reason: 'Avoid ranking people. Conviction as self-expression is OK; ranking *people* is not.',
  },
  {
    re: /\brank(ed|ing)?\b\s+(by|of)\s+(user|practitioner|person|people)/i,
    reason: 'Avoid ranking people.',
  },
  {
    re: /\b(beat|defeat|crush|outperform)\s+(the\s+)?(competition|other|others)\b/i,
    reason: 'FRQNCY values cooperation over competition framing.',
  },
];

/** Tools whose input.contents we should scan. */
const SCAN_TOOLS = new Set(['write']);

export async function bundledEditorialLint(ctx: HookContext): Promise<HookResult> {
  const startMs = Date.now();
  if (ctx.event !== 'post-tool-use') {
    return {
      hookName: 'frqncy-harness-bundled:editorial-lint',
      durationMs: Date.now() - startMs,
      success: false,
      error: 'editorial-lint only fires on post-tool-use (got: ' + ctx.event + ')',
    };
  }

  if (!SCAN_TOOLS.has(ctx.toolName)) {
    return {
      hookName: 'frqncy-harness-bundled:editorial-lint',
      durationMs: Date.now() - startMs,
      success: true,
    };
  }

  // Pull the content out of the tool input. The write tool's input shape is
  // { path, contents, mode? }
  const input = ctx.input as { contents?: unknown; path?: unknown };
  const contents = typeof input.contents === 'string' ? input.contents : null;
  const filePath = typeof input.path === 'string' ? input.path : '<unknown>';
  if (!contents) {
    return {
      hookName: 'frqncy-harness-bundled:editorial-lint',
      durationMs: Date.now() - startMs,
      success: true,
    };
  }

  const violations: string[] = [];
  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    const match = contents.match(re);
    if (match) {
      violations.push(`  - "${match[0]}" — ${reason}`);
    }
  }

  if (violations.length === 0) {
    return {
      hookName: 'frqncy-harness-bundled:editorial-lint',
      durationMs: Date.now() - startMs,
      success: true,
    };
  }

  const warning =
    `Editorial values lint found ${violations.length} issue(s) in ${basename(filePath)}:\n` +
    violations.join('\n') +
    `\n  (See CLAUDE.md for FRQNCY editorial values. Non-blocking warning in v0.5.)`;

  // Print to stderr so the user sees it immediately
  process.stderr.write('\n[editorial-lint] ' + warning + '\n');

  return {
    hookName: 'frqncy-harness-bundled:editorial-lint',
    durationMs: Date.now() - startMs,
    success: true,
    warning,
  };
}

// ────────────────────────────────────────────────────────────────────
// 4. Cost-cap monitor (PostAgent) — surfaces guardrails.cost* triggers
// ────────────────────────────────────────────────────────────────────
//
// Lives as a hook so users can replace it (Slack ping, PagerDuty alert, etc.)
// without forking the harness. The actual *enforcement* (hard abort) still
// happens inside stream() because hooks are observers in v0.5/v0.7.
// This hook reports — and could escalate via custom user hooks.

export async function bundledCostCapMonitor(ctx: HookContext): Promise<HookResult> {
  const startMs = Date.now();
  if (ctx.event !== 'post-agent') {
    return {
      hookName: 'frqncy-harness-bundled:cost-cap-monitor',
      durationMs: Date.now() - startMs,
      success: false,
      error: 'cost-cap-monitor only fires on post-agent (got: ' + ctx.event + ')',
    };
  }

  const guardrails = ctx.guardrails;
  if (!guardrails || (!guardrails.costSoftWarn && !guardrails.costHardAbort)) {
    return {
      hookName: 'frqncy-harness-bundled:cost-cap-monitor',
      durationMs: Date.now() - startMs,
      success: true,
    };
  }

  const cost = guardrails.cumulativeCostUsd.toFixed(4);
  const note = guardrails.costHardAbort
    ? `[cost-cap] HARD ABORT at $${cost} — conversation ${ctx.conversationId.slice(0, 8)} stopped.`
    : `[cost-cap] soft warn at $${cost} — conversation ${ctx.conversationId.slice(0, 8)} continued.`;
  process.stderr.write(note + '\n');

  return {
    hookName: 'frqncy-harness-bundled:cost-cap-monitor',
    durationMs: Date.now() - startMs,
    success: true,
    warning: note,
  };
}

// ────────────────────────────────────────────────────────────────────
// 5. Trifecta monitor (PostAgent) — surfaces guardrails.trifectaWarn
// ────────────────────────────────────────────────────────────────────

export async function bundledTrifectaMonitor(ctx: HookContext): Promise<HookResult> {
  const startMs = Date.now();
  if (ctx.event !== 'post-agent') {
    return {
      hookName: 'frqncy-harness-bundled:trifecta-monitor',
      durationMs: Date.now() - startMs,
      success: false,
      error: 'trifecta-monitor only fires on post-agent (got: ' + ctx.event + ')',
    };
  }

  if (!ctx.guardrails || !ctx.guardrails.trifectaWarn) {
    return {
      hookName: 'frqncy-harness-bundled:trifecta-monitor',
      durationMs: Date.now() - startMs,
      success: true,
    };
  }

  const note =
    `[trifecta] private-data + untrusted-content + outbound-network were all available in conversation ` +
    `${ctx.conversationId.slice(0, 8)}. Review the trace if untrusted input was processed.`;
  process.stderr.write(note + '\n');

  return {
    hookName: 'frqncy-harness-bundled:trifecta-monitor',
    durationMs: Date.now() - startMs,
    success: true,
    warning: note,
  };
}
