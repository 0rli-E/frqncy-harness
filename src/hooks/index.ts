/**
 * Hooks primitive — fire user-defined functions at agent lifecycle points.
 *
 * Inspired by Claude Code's hooks system. Three lifecycle events in v0.5:
 *
 *   pre-agent     — fires once before the agent loop starts (only if tools are present)
 *   post-tool-use — fires after each tool call returns (with input + output)
 *   post-agent    — fires once after the agent loop completes (success or error)
 *
 * A hook entry can be:
 *   - A shell command string: harness pipes JSON context via stdin, captures stdout
 *   - A path to a .js or .ts file: harness dynamically imports and calls the default export
 *   - A bundled hook reference like "frqncy-harness-bundled:auto-commit-traces"
 *
 * v0.5 hooks are observers + side-effect-runners. They cannot block the agent.
 * Hook failures (timeout, crash, non-zero exit) are logged but never propagate.
 *
 * Future v0.6+ will add:
 *   - pre-tool-use (block / modify input)
 *   - user-prompt-submit (transform / validate)
 *   - blocking semantics for pre- hooks
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import {
  bundledAutoCommitTraces,
  bundledMacosNotification,
  bundledEditorialLint,
  bundledCostCapMonitor,
  bundledTrifectaMonitor,
} from './bundled.js';
import type { Usage } from '../types.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type HookEvent = 'pre-agent' | 'post-tool-use' | 'post-agent' | 'pre-payment';

export interface PreAgentContext {
  event: 'pre-agent';
  conversationId: string;
  model: string;
  prompt: string;
  toolNames: string[];
  sandboxPath?: string;
}

export interface PostToolUseContext {
  event: 'post-tool-use';
  conversationId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  durationMs: number;
}

export interface GuardrailEvents {
  /** True if the cost soft-warn threshold was crossed during the conversation */
  costSoftWarn: boolean;
  /** True if the cost hard-abort threshold was crossed (status will be 'aborted_cost_cap') */
  costHardAbort: boolean;
  /** True if the lethal-trifecta gate emitted a warning at agent start */
  trifectaWarn: boolean;
  /** Cumulative cost in USD at end-of-conversation (for monitor hooks) */
  cumulativeCostUsd: number;
}

/**
 * Pre-payment hook context (v0.9). Fires once per outbound x402 payment
 * attempt, before the EIP-3009/2612 signature is produced. A bash hook can
 * `echo '{"block": true, "reason": "blocked by ops policy"}'` to stdout to
 * veto the payment; non-blocking hooks just observe and exit cleanly.
 *
 * Per AGENT-COMMERCE decision 10 — keep ops/regulators in the loop with a
 * cheap, audit-friendly seam.
 */
export interface PrePaymentContext {
  event: 'pre-payment';
  conversationId: string;
  resource: string;
  amountAtomic: string;
  asset: string;
  network: string;
  payee: string;
  spentSoFarAtomic: string;
}

export interface PostAgentContext {
  event: 'post-agent';
  conversationId: string;
  model: string;
  prompt: string;
  text: string;
  status: 'completed' | 'aborted_cost_cap' | 'aborted_error' | 'aborted_user' | 'aborted_window_full';
  usage: Usage;
  sandboxPath?: string;
  traceFilePath: string;
  /** Snapshot of any guardrail triggers that fired during the run (v0.7+) */
  guardrails?: GuardrailEvents;
}

export type HookContext =
  | PreAgentContext
  | PostToolUseContext
  | PostAgentContext
  | PrePaymentContext;

export interface HookResult {
  hookName: string;
  durationMs: number;
  success: boolean;
  warning?: string;
  error?: string;
  /** v0.9 — pre-payment hooks may veto by writing `{"block":true,"reason":"..."}` to stdout. */
  block?: boolean;
  blockReason?: string;
}

// ────────────────────────────────────────────────────────────────────
// Config schema (used by src/config.ts)
// ────────────────────────────────────────────────────────────────────

export const HookEntrySchema = z.union([
  z.string().min(1),
  z.object({
    command: z.string().min(1),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(300_000).optional(),
  }),
]);
export type HookEntry = z.infer<typeof HookEntrySchema>;

export const HooksConfigSchema = z
  .object({
    'pre-agent': z.array(HookEntrySchema).optional(),
    'post-tool-use': z.array(HookEntrySchema).optional(),
    'post-agent': z.array(HookEntrySchema).optional(),
    /** v0.9 — fires before each outbound x402 payment is signed. May veto. */
    'pre-payment': z.array(HookEntrySchema).optional(),
  })
  .optional();
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

/**
 * Result of a pre-payment hook decision after consulting all registered
 * hooks. `block: true` if any single hook returned `{ block: true }` —
 * vetoes are first-mover-wins.
 */
export interface PrePaymentDecision {
  block: boolean;
  reason?: string;
  results: HookResult[];
}

// ────────────────────────────────────────────────────────────────────
// Default hooks (per Orlando's v0.5 picks)
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_HOOKS: NonNullable<HooksConfig> = {
  'post-agent': [
    'frqncy-harness-bundled:auto-commit-traces',
    'frqncy-harness-bundled:macos-notification',
  ],
};

// editorial-lint is BUILT but inactive by default (Orlando's choice).
// User opts in by adding "frqncy-harness-bundled:editorial-lint" to their
// post-tool-use array in config.json.

// ────────────────────────────────────────────────────────────────────
// Bundled hook dispatch
// ────────────────────────────────────────────────────────────────────

const BUNDLED_PREFIX = 'frqncy-harness-bundled:';

const BUNDLED_HOOKS: Record<string, (ctx: HookContext) => Promise<HookResult>> = {
  'auto-commit-traces': async (ctx) => bundledAutoCommitTraces(ctx),
  'macos-notification': async (ctx) => bundledMacosNotification(ctx),
  'editorial-lint': async (ctx) => bundledEditorialLint(ctx),
  'cost-cap-monitor': async (ctx) => bundledCostCapMonitor(ctx),
  'trifecta-monitor': async (ctx) => bundledTrifectaMonitor(ctx),
};

// ────────────────────────────────────────────────────────────────────
// HookManager
// ────────────────────────────────────────────────────────────────────

export class HookManager {
  /** Resolved hook config — falls back to DEFAULT_HOOKS when user provided nothing */
  private resolved: NonNullable<HooksConfig>;

  constructor(userConfig: HooksConfig | undefined) {
    // Defaults apply ONLY when no config was given at all (undefined).
    // Passing any object (even `{}`) is interpreted as "I'm taking explicit control, use exactly what I provide".
    // This matches what most users want: an empty config means no hooks, not "give me defaults I didn't ask for."
    if (userConfig === undefined) {
      this.resolved = DEFAULT_HOOKS;
    } else {
      this.resolved = userConfig;
    }
  }

  /**
   * Fire all hooks registered for an event. Sequential, never blocking the caller.
   * Returns results for inspection but the caller should NOT make decisions on them
   * in v0.5 (hooks are observers).
   */
  async fire(context: HookContext): Promise<HookResult[]> {
    const entries = this.resolved[context.event] ?? [];
    if (entries.length === 0) return [];

    const results: HookResult[] = [];
    for (const entry of entries) {
      const enabled = typeof entry === 'object' ? entry.enabled !== false : true;
      if (!enabled) continue;

      const command = typeof entry === 'string' ? entry : entry.command;
      const timeoutMs = typeof entry === 'object' ? entry.timeoutMs : undefined;

      try {
        const result = await this.runOne(command, context, timeoutMs);
        results.push(result);
      } catch (err) {
        results.push({
          hookName: command,
          durationMs: 0,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * v0.9 — fire all `pre-payment` hooks and return a structured veto/allow
   * decision. First-mover-wins on `block: true`. Hook failures (non-zero
   * exits, timeouts) do NOT block the payment by default — that's a
   * deliberate choice so a broken hook doesn't strand the agent. If you
   * want fail-closed behavior, write the hook to deny on uncertainty.
   */
  async firePrePayment(context: PrePaymentContext): Promise<PrePaymentDecision> {
    const results = await this.fire(context);
    const blocking = results.find((r) => r.block === true);
    if (blocking) {
      const decision: PrePaymentDecision = { block: true, results };
      if (blocking.blockReason) decision.reason = blocking.blockReason;
      return decision;
    }
    return { block: false, results };
  }

  private async runOne(
    command: string,
    context: HookContext,
    timeoutMs?: number,
  ): Promise<HookResult> {
    if (command.startsWith(BUNDLED_PREFIX)) {
      const bundledName = command.slice(BUNDLED_PREFIX.length);
      const fn = BUNDLED_HOOKS[bundledName];
      if (!fn) {
        return {
          hookName: command,
          durationMs: 0,
          success: false,
          error: `Unknown bundled hook: ${bundledName}. Known: ${Object.keys(BUNDLED_HOOKS).join(', ')}`,
        };
      }
      return fn(context);
    }

    if (command.endsWith('.js') || command.endsWith('.mjs') || command.endsWith('.ts')) {
      return runFunctionHook(command, context, timeoutMs ?? 30_000);
    }

    return runShellHook(command, context, timeoutMs ?? 30_000);
  }
}

// ────────────────────────────────────────────────────────────────────
// Shell hook runner
// ────────────────────────────────────────────────────────────────────

async function runShellHook(
  command: string,
  context: HookContext,
  timeoutMs: number,
): Promise<HookResult> {
  const startMs = Date.now();
  return new Promise<HookResult>((resolve) => {
    const child = spawn('bash', ['-c', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1000).unref();
    }, timeoutMs);
    timer.unref();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Pipe context as JSON to stdin
    child.stdin.write(JSON.stringify(context));
    child.stdin.end();

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startMs;

      // Try to parse stdout as a structured response
      let warning: string | undefined;
      let block: boolean | undefined;
      let blockReason: string | undefined;
      const trimmed = stdout.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed === 'object' && parsed !== null) {
            if (typeof parsed.warning === 'string') warning = parsed.warning;
            if (parsed.block === true) {
              block = true;
              if (typeof parsed.reason === 'string') blockReason = parsed.reason;
            }
          }
        } catch {
          // Plain text output; treat any non-empty stdout from a non-zero-exit
          // as warning content. Otherwise ignore (it's just logging).
        }
      }

      if (exitCode !== 0) {
        return resolve({
          hookName: command,
          durationMs,
          success: false,
          error: (stderr || stdout || `exit code ${exitCode}`).trim().slice(0, 500),
        });
      }

      const out: HookResult = { hookName: command, durationMs, success: true };
      if (warning) out.warning = warning;
      if (block) out.block = true;
      if (blockReason) out.blockReason = blockReason;
      resolve(out);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        hookName: command,
        durationMs: Date.now() - startMs,
        success: false,
        error: err.message,
      });
    });
  });
}

// ────────────────────────────────────────────────────────────────────
// Function hook runner (dynamic import)
// ────────────────────────────────────────────────────────────────────

async function runFunctionHook(
  filePath: string,
  context: HookContext,
  timeoutMs: number,
): Promise<HookResult> {
  const startMs = Date.now();
  try {
    // Resolve to file:// URL for dynamic import
    const url = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    const mod = (await Promise.race([
      import(url),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`hook import timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ])) as { default?: (ctx: HookContext) => unknown | Promise<unknown> };

    if (typeof mod.default !== 'function') {
      return {
        hookName: filePath,
        durationMs: Date.now() - startMs,
        success: false,
        error: 'Hook file must export a default function',
      };
    }

    const result = await Promise.race([
      Promise.resolve(mod.default(context)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`hook execution timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    let warning: string | undefined;
    let block: boolean | undefined;
    let blockReason: string | undefined;
    if (typeof result === 'object' && result !== null) {
      const r = result as { warning?: unknown; block?: unknown; reason?: unknown };
      if (typeof r.warning === 'string') warning = r.warning;
      if (r.block === true) {
        block = true;
        if (typeof r.reason === 'string') blockReason = r.reason;
      }
    }

    const out: HookResult = {
      hookName: filePath,
      durationMs: Date.now() - startMs,
      success: true,
    };
    if (warning) out.warning = warning;
    if (block) out.block = true;
    if (blockReason) out.blockReason = blockReason;
    return out;
  } catch (err) {
    return {
      hookName: filePath,
      durationMs: Date.now() - startMs,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-export the bundled hooks so users can import + reference them in code
export {
  bundledAutoCommitTraces,
  bundledMacosNotification,
  bundledEditorialLint,
  bundledCostCapMonitor,
  bundledTrifectaMonitor,
} from './bundled.js';
