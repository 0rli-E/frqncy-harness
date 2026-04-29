/**
 * Daydreams ↔ Harness bridge.
 *
 * Two-way interop with `@daydreamsai/core`:
 *
 *   1. `harnessToolToDaydreamsAction(tool)` — wrap a HarnessTool as a
 *      Daydreams `Action` so a `createDreams({ actions: [...] })` agent can
 *      invoke harness primitives (bash, file, web_fetch, pay, etc.) inside
 *      its loop. The HarnessTool's permission tier (auto vs propose-then-
 *      approve) is honored: propose-then-approve actions get an `enabled`
 *      gate that throws unless an approval callback was provided.
 *
 *   2. `daydreamsActionToHarnessTool(action)` — the inverse. Wrap a Daydreams
 *      Action as a HarnessTool so OUR agent loop can call it. Used to lift
 *      domain-specific Daydreams extensions (e.g. their hyperliquid /
 *      starknet plugins) into the harness without rewriting them.
 *
 *   3. `createDaydreamsExtension({ harness })` — bundles a list of harness
 *      tools into a Daydreams `Extension`. Returns `{ name, actions }` shaped
 *      to match `Pick<Config, 'inputs'|'outputs'|'actions'|'services'|'events'>
 *      & { name, install?, contexts?, inputs }` per the upstream type.
 *
 * `@daydreamsai/core` is a peer dependency — lazy-imported, optional,
 * so bridge users install it only if they want this surface.
 *
 * S4mmy validation: this bridge is exactly the "service integration" that he
 * frames as the bottleneck — a typed seam from harness primitives into the
 * Daydreams runtime so the LLM's action surface is *one* set of verbs. Our
 * existing `flags: { privateData, untrustedContent, outboundNetwork }` and
 * lethal-trifecta gate carry through (we do not unwrap them).
 */
import type { z } from 'zod';
import type { HarnessTool, ToolContext } from '../tools/index.js';
import type { ApprovalCallback } from '../approval.js';

// ────────────────────────────────────────────────────────────────────
// Type bridges (structural — the actual `@daydreamsai/core` types are not
// imported at compile time so peer-dep absence doesn't break the build)
// ────────────────────────────────────────────────────────────────────

/**
 * Minimal structural shape of a Daydreams Action we need to produce/consume.
 * Real type lives in `@daydreamsai/core/types`. We re-declare the loadbearing
 * surface so the bridge typechecks without the peer dep installed.
 */
export interface DaydreamsActionLike<TInput = unknown, TResult = unknown> {
  name: string;
  description?: string;
  instructions?: string;
  schema: unknown; // zod schema or AnyShape — opaque from our side
  handler: (
    args: TInput,
    ctx: unknown,
    agent: unknown,
  ) => Promise<TResult> | TResult;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  enabled?: (ctx: any) => boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  retry?: boolean | number | ((failureCount: number, error: unknown) => boolean);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  format?: (result: TResult) => string | string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (err: unknown, ctx: any, agent: any) => unknown;
  callFormat?: 'json' | 'xml';
  examples?: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** Minimal structural shape of a Daydreams Extension. */
export interface DaydreamsExtensionLike {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actions?: DaydreamsActionLike<any, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contexts?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  services?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputs?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputs?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events?: any;
  install?: (agent: unknown) => Promise<void> | void;
}

// ────────────────────────────────────────────────────────────────────
// HarnessTool → Daydreams Action
// ────────────────────────────────────────────────────────────────────

export interface HarnessToolToActionOptions {
  /** ToolContext to pass through to the harness tool. Required — the HarnessTool execute() needs it. */
  toolContext: ToolContext;
  /** If the tool's permission is `propose-then-approve`, this callback is consulted before each call. */
  approval?: ApprovalCallback;
  /**
   * Override the action's `name`. Defaults to the harness tool's name. Useful
   * when bundling several harness tools into one Daydreams extension and
   * wanting a namespace prefix (e.g. `harness.bash`, `harness.pay`).
   */
  name?: string;
  /**
   * Override `description`. Defaults to the tool's description with a
   * one-line note about the permission tier.
   */
  description?: string;
}

/**
 * Wrap a HarnessTool as a Daydreams Action. The tool's Zod schema becomes the
 * action's schema; permission gating is honored; tool errors are surfaced as
 * structured returns (not exceptions) so the Daydreams loop stays alive.
 */
export function harnessToolToDaydreamsAction<TInput, TOutput>(
  tool: HarnessTool<TInput, TOutput>,
  opts: HarnessToolToActionOptions,
): DaydreamsActionLike<TInput, TOutput | { error: string; message: string }> {
  const name = opts.name ?? tool.name;
  const description =
    opts.description ??
    `${tool.description}${
      tool.permission === 'propose-then-approve'
        ? ' (requires user approval)'
        : ''
    }`;

  return {
    name,
    description,
    schema: tool.inputSchema,
    async handler(args: TInput): Promise<TOutput | { error: string; message: string }> {
      // Validate at the seam — the upstream Daydreams agent typically validates
      // before calling, but we trust nothing.
      const validated = tool.inputSchema.safeParse(args);
      if (!validated.success) {
        return {
          error: 'invalid_input',
          message: `Input validation failed: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        };
      }

      // Permission gate — same logic as `toAiSdkTool` so behavior is identical
      // whether the tool is reached via the AI SDK or the Daydreams loop.
      if (tool.permission === 'propose-then-approve') {
        if (!opts.approval) {
          return {
            error: 'permission_required',
            message: `Tool '${tool.name}' requires approval but no approval callback was wired into the bridge.`,
          };
        }
        const approved = await opts.approval({
          toolName: tool.name,
          input: validated.data,
          permission: tool.permission,
          flags: tool.flags,
        });
        if (!approved) {
          return {
            error: 'permission_denied',
            message: `User denied tool call to '${tool.name}'.`,
          };
        }
      }

      try {
        return await tool.execute(validated.data, opts.toolContext);
      } catch (err) {
        return {
          error: 'execution_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Daydreams Action → HarnessTool
// ────────────────────────────────────────────────────────────────────

export interface ActionToHarnessToolOptions {
  /**
   * Tool flags for the lethal-trifecta gate. Daydreams Actions don't carry
   * these explicitly, so the bridger must declare them. Default is the
   * conservative `{ outboundNetwork: true }` (same as `web_fetch`).
   */
  flags?: HarnessTool['flags'];
  permission?: HarnessTool['permission'];
}

/**
 * Wrap a Daydreams Action as a HarnessTool.
 *
 * The Daydreams Action's schema must be a Zod schema (the harness validates
 * via `safeParse`). Plain object schemas (raw shapes) are also accepted and
 * coerced via `z.object(shape)`.
 */
export function daydreamsActionToHarnessTool<TInput = unknown, TOutput = unknown>(
  action: DaydreamsActionLike<TInput, TOutput>,
  opts: ActionToHarnessToolOptions = {},
): HarnessTool<TInput, TOutput | { error: string; message: string }> {
  const inputSchema = coerceSchema<TInput>(action.schema);
  return {
    name: action.name,
    description: action.description ?? `Daydreams action ${action.name}`,
    inputSchema,
    flags: opts.flags ?? { outboundNetwork: true },
    permission: opts.permission ?? 'auto',
    async execute(input: TInput): Promise<TOutput | { error: string; message: string }> {
      try {
        // Daydreams handlers expect (args, ctx, agent). We don't have either —
        // the harness's tool ctx isn't shaped like Daydreams', and there's no
        // agent in scope. Pass empty objects; well-behaved Daydreams actions
        // tolerate this for stateless calls.
        return await action.handler(input, {}, {});
      } catch (err) {
        return {
          error: 'execution_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function coerceSchema<T>(schema: unknown): z.ZodType<T> {
  // Three accepted shapes:
  //   1. a Zod schema (.parse exists) — pass through
  //   2. a raw shape object (z.object()-able)
  //   3. anything else — accept as a passthrough z.any()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = schema as any;
  if (s && typeof s === 'object' && typeof s.parse === 'function' && typeof s.safeParse === 'function') {
    return s;
  }
  if (s && typeof s === 'object' && Object.values(s).every((v) => v && typeof v === 'object' && '_def' in (v as object))) {
    // Raw shape — wrap in z.object lazily
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const z = require('zod') as typeof import('zod');
    return z.object(s) as unknown as z.ZodType<T>;
  }
  // Fallback — opaque schema; treat as z.any() so safeParse never fails.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const z = require('zod') as typeof import('zod');
  return z.any() as unknown as z.ZodType<T>;
}

// ────────────────────────────────────────────────────────────────────
// Bundle: harness tools → Daydreams Extension
// ────────────────────────────────────────────────────────────────────

export interface CreateDaydreamsExtensionOptions {
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: HarnessTool<any, any>[];
  toolContext: ToolContext;
  approval?: ApprovalCallback;
  /** Optional namespace prefix applied to every action name (e.g. "harness."). */
  prefix?: string;
}

/**
 * Bundle a list of HarnessTools into a Daydreams `Extension` so users can
 * `createDreams({ extensions: [createDaydreamsExtension({...})] })` and
 * inherit the entire harness primitive surface in one line.
 */
export function createDaydreamsExtension(
  opts: CreateDaydreamsExtensionOptions,
): DaydreamsExtensionLike {
  return {
    name: opts.name ?? 'frqncy-harness',
    actions: opts.tools.map((tool) =>
      harnessToolToDaydreamsAction(tool, {
        toolContext: opts.toolContext,
        ...(opts.approval ? { approval: opts.approval } : {}),
        ...(opts.prefix ? { name: `${opts.prefix}${tool.name}` } : {}),
      }),
    ),
  };
}

// ────────────────────────────────────────────────────────────────────
// Bundle: Daydreams Extension → HarnessTool[]
// ────────────────────────────────────────────────────────────────────

export interface ExtensionToHarnessToolsOptions {
  /** Per-action overrides for flags + permission. Keyed by action.name. */
  overrides?: Record<string, ActionToHarnessToolOptions>;
  /** Default options applied to every action when no override exists. */
  defaults?: ActionToHarnessToolOptions;
}

/**
 * Lift every action from a Daydreams Extension into a HarnessTool array. Use
 * this to consume Daydreams plugins (hyperliquid, starknet, telegram, etc.)
 * from the harness loop without writing TypeScript glue per plugin.
 */
export function daydreamsExtensionToHarnessTools(
  extension: DaydreamsExtensionLike,
  opts: ExtensionToHarnessToolsOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): HarnessTool<any, any>[] {
  const actions = extension.actions ?? [];
  return actions.map((action) =>
    daydreamsActionToHarnessTool(action, opts.overrides?.[action.name] ?? opts.defaults ?? {}),
  );
}
