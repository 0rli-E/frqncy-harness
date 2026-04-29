/**
 * x402 fetch wrapper — auto-pays 402 responses under a budget.
 *
 * Behavior:
 *   1. Call the upstream with the original request.
 *   2. If non-402, return as-is.
 *   3. If 402, parse PaymentRequiredBody, pick the cheapest acceptable
 *      requirement that fits the budget AND matches our network policy.
 *   4. Sign EIP-3009, base64-encode, retry with X-PAYMENT header.
 *   5. On success (200 with X-PAYMENT-RESPONSE), decode response, record
 *      spend, append a `payment` trace record, return response to caller.
 *   6. Anything else → throw a structured X402Error.
 *
 * This is the load-bearing entry point for outbound payments. Wrapped fetch
 * is what gets passed into `web_fetch`, MCP transports, the `pay` tool, etc.
 */
import {
  PaymentRequiredBodySchema,
  PaymentRequirementsSchema,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
  type PaymentRequirements,
  type SettleResponse,
  type X402Network,
} from './schemes.js';
import { SettleResponseSchema } from './schemes.js';
import { createPaymentPayload, encodePaymentHeader } from './sign.js';
import {
  checkBudget,
  createBudgetState,
  markWarned,
  recordSpend,
  type BudgetState,
} from './budget.js';
import type { Signer } from '../wallet/index.js';

// Node 20+ ships `fetch` as a global. We don't want to depend on the DOM lib
// in tsconfig, so we pull the relevant types out of the global `fetch`
// signature instead of importing `RequestInfo` / `HeadersInit` directly.
type FetchInput = Parameters<typeof fetch>[0];
type FetchHeaders = NonNullable<RequestInit['headers']>;

export class X402Error extends Error {
  constructor(
    message: string,
    public code:
      | 'no_acceptable_requirements'
      | 'budget_exceeded'
      | 'pre_payment_blocked'
      | 'sign_failed'
      | 'unexpected_response'
      | 'invalid_402_body',
    public details?: unknown,
  ) {
    super(message);
    this.name = 'X402Error';
  }
}

export interface PaymentTraceFn {
  (record: {
    direction: 'out';
    resource: string;
    requirements: PaymentRequirements;
    amountAtomic: string;
    asset: string;
    network: X402Network;
    txHash?: string;
    payer?: string;
    payee: string;
    settled: SettleResponse | null;
    facilitator: string;
    triggered: 'none' | 'soft' | 'hard';
    timestamp: string;
  }): void | Promise<void>;
}

export interface PrePaymentHook {
  (input: {
    resource: string;
    requirements: PaymentRequirements;
    spentSoFarAtomic: bigint;
  }): Promise<{ block?: boolean; reason?: string } | void> | { block?: boolean; reason?: string } | void;
}

export interface WrapFetchWithPaymentOptions {
  signer: Signer;
  /** Networks the harness will pay on. Defaults to the signer's network. */
  acceptedNetworks?: X402Network[];
  /** Maximum atomic-USDC amount to pay for a single 402 response. */
  maxPerCallAtomic?: bigint;
  /** Persistent budget across calls in this session. Constructed if absent. */
  budget?: BudgetState;
  /** Pre-payment hook — return `{ block: true }` to veto. */
  onPrePayment?: PrePaymentHook;
  /** Called after settle (success or fail) to record the trace. */
  onPayment?: PaymentTraceFn;
  /** Inject a fetch (for tests). Defaults to global. */
  baseFetch?: typeof fetch;
  /**
   * Default upstream-server-supplied facilitator URL — informational only;
   * the resource server is what actually settles in the v1 wire flow.
   */
  facilitatorHint?: string;
  /**
   * v0.9.2 — opt-in auto-trace + auto-hook integration.
   *
   * If `traceContext` is provided, every settled (and attempted) payment is
   * appended to the conversation's never-compacted JSONL trace as a
   * `payment`-type record. Chained AFTER any user-supplied `onPayment`.
   *
   * If `hookManager` is provided, the harness's `pre-payment` hook event
   * fires before each signature attempt; a hook returning `{ block: true }`
   * vetoes the payment with code `pre_payment_blocked`. Chained AFTER any
   * user-supplied `onPrePayment` so explicit vetoes take precedence over
   * declarative ones.
   *
   * Both fields are independent — set either, both, or neither.
   */
  traceContext?: {
    conversationId: string;
    startedAt?: Date;
    traceDir?: string;
    threadId?: string;
    projectId?: string;
    /** Starting step counter — caller increments per record so order is preserved. */
    step?: number;
  };
  hookManager?: {
    firePrePayment: (ctx: {
      event: 'pre-payment';
      conversationId: string;
      resource: string;
      amountAtomic: string;
      asset: string;
      network: string;
      payee: string;
      spentSoFarAtomic: string;
    }) => Promise<{ block: boolean; reason?: string }>;
  };
}

const DEFAULT_MAX_PER_CALL_ATOMIC = 100_000n; // 0.10 USDC — matches the reference SDK default

// `composePaymentCallbacks` and `composePrePaymentCallbacks` are defined below
// (after the wrapFetchWithPayment body) — they're hoisted at module init so we
// can reference them in the body without a forward declaration.

export function wrapFetchWithPayment(
  opts: WrapFetchWithPaymentOptions,
): typeof fetch {
  const baseFetch = opts.baseFetch ?? fetch;
  const budget = opts.budget ?? createBudgetState();
  const accepted = opts.acceptedNetworks ?? [opts.signer.network as X402Network];
  const maxPerCall = opts.maxPerCallAtomic ?? DEFAULT_MAX_PER_CALL_ATOMIC;

  // ── Auto-attach: trace writer + pre-payment hook gate ────────────────
  // Composed AFTER any user-supplied callbacks. This is opt-in via
  // `traceContext` / `hookManager` on the options — if neither is set, the
  // wrapper behaves exactly as before (no extra side-effects).
  const userOnPayment = opts.onPayment;
  const userOnPrePayment = opts.onPrePayment;
  const composedOnPayment: PaymentTraceFn | undefined = opts.traceContext
    ? composePaymentCallbacks(userOnPayment, opts.traceContext)
    : userOnPayment;
  const composedOnPrePayment: PrePaymentHook | undefined =
    opts.hookManager !== undefined
      ? composePrePaymentCallbacks(userOnPrePayment, opts.hookManager, opts.traceContext)
      : userOnPrePayment;

  // Returned function matches `fetch`'s signature
  const wrapped: typeof fetch = async (input, init) => {
    const firstResponse = await baseFetch(input as FetchInput, init);
    if (firstResponse.status !== 402) return firstResponse;

    // Parse the 402 body
    let parsed: ReturnType<typeof PaymentRequiredBodySchema.parse>;
    try {
      const text = await firstResponse.clone().text();
      parsed = PaymentRequiredBodySchema.parse(JSON.parse(text));
    } catch (err) {
      throw new X402Error(
        `cannot parse 402 body from ${requestUrl(input)}: ${(err as Error).message}`,
        'invalid_402_body',
        err,
      );
    }

    // Pick the cheapest acceptable requirement
    const candidates = parsed.accepts
      .filter((r) => accepted.includes(r.network))
      .filter((r) => BigInt(r.maxAmountRequired) <= maxPerCall)
      .sort((a, b) => Number(BigInt(a.maxAmountRequired) - BigInt(b.maxAmountRequired)));
    const requirements = candidates[0];
    if (!requirements) {
      throw new X402Error(
        `no acceptable PaymentRequirements found among ${parsed.accepts.length} options ` +
          `(networks=${accepted.join(',')}, maxPerCall=${maxPerCall})`,
        'no_acceptable_requirements',
        parsed,
      );
    }

    // Pre-payment hook (user callback chained with hookManager auto-attach)
    if (composedOnPrePayment) {
      const result = await composedOnPrePayment({
        resource: requestUrl(input),
        requirements,
        spentSoFarAtomic: budget.spentAtomic,
      });
      if (result && result.block) {
        throw new X402Error(
          `payment blocked by pre-payment hook: ${result.reason ?? '(no reason given)'}`,
          'pre_payment_blocked',
        );
      }
    }

    // Budget gate
    const amountAtomic = BigInt(requirements.maxAmountRequired);
    const check = checkBudget(budget, amountAtomic);
    if (!check.allowed) {
      throw new X402Error(check.message ?? 'budget exceeded', 'budget_exceeded', check);
    }
    if (check.triggered === 'soft') {
      markWarned(budget);
      // Soft warning is informational; we still proceed
      if (process.env.FRQNCY_QUIET !== '1') {
        process.stderr.write(`[x402] soft warning: ${check.message}\n`);
      }
    }

    // Sign
    let header: string;
    try {
      const payload = await createPaymentPayload({ signer: opts.signer, requirements });
      header = encodePaymentHeader(payload);
    } catch (err) {
      throw new X402Error(`failed to sign payment: ${(err as Error).message}`, 'sign_failed', err);
    }

    // Retry with X-PAYMENT header
    const retryInit: RequestInit = {
      ...(init ?? {}),
      headers: mergeHeaders(init?.headers, { [X402_REQUEST_HEADER]: header }),
    };
    const paidResponse = await baseFetch(input as FetchInput, retryInit);

    // Decode X-PAYMENT-RESPONSE
    let settled: SettleResponse | null = null;
    const responseHeader = paidResponse.headers.get(X402_RESPONSE_HEADER);
    if (responseHeader) {
      try {
        const json = JSON.parse(Buffer.from(responseHeader, 'base64').toString('utf-8'));
        settled = SettleResponseSchema.parse(json);
      } catch {
        // bad header — leave as null; we still recorded the attempt
      }
    }

    // Record spend on success
    if (paidResponse.ok && (!settled || settled.success)) {
      recordSpend(budget, amountAtomic);
    }

    // Trace (user callback chained with traceContext auto-attach)
    if (composedOnPayment) {
      await composedOnPayment({
        direction: 'out',
        resource: requestUrl(input),
        requirements,
        amountAtomic: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        txHash: settled?.transaction,
        payer: opts.signer.address,
        payee: requirements.payTo,
        settled,
        facilitator: opts.facilitatorHint ?? '(server-side)',
        triggered: check.triggered,
        timestamp: new Date().toISOString(),
      });
    }

    if (!paidResponse.ok) {
      throw new X402Error(
        `paid request returned non-OK status ${paidResponse.status}`,
        'unexpected_response',
        { status: paidResponse.status, url: requestUrl(input) },
      );
    }

    return paidResponse;
  };

  return wrapped;
}

/**
 * Compose a user `onPayment` callback with the auto-trace writer. Both fire
 * per call — user callback first (so its side-effects are already done by
 * the time the trace is appended; appending is the source-of-truth event).
 */
function composePaymentCallbacks(
  userCb: PaymentTraceFn | undefined,
  traceContext: NonNullable<WrapFetchWithPaymentOptions['traceContext']>,
): PaymentTraceFn {
  // Lazy-instantiate the writer once so step counters remain monotonic across
  // calls. Imported at runtime to avoid a circular `client.ts` ↔ `trace.ts`
  // dependency at module load.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cachedWriter: any | undefined;
  return async (record) => {
    if (userCb) await userCb(record);
    if (!cachedWriter) {
      const { createPaymentTraceWriter } = await import('./trace.js');
      cachedWriter = createPaymentTraceWriter({
        conversationId: traceContext.conversationId,
        ...(traceContext.startedAt ? { startedAt: traceContext.startedAt } : {}),
        ...(traceContext.traceDir ? { traceDir: traceContext.traceDir } : {}),
        ...(traceContext.threadId ? { threadId: traceContext.threadId } : {}),
        ...(traceContext.projectId ? { projectId: traceContext.projectId } : {}),
        ...(traceContext.step !== undefined ? { step: traceContext.step } : {}),
      });
    }
    await cachedWriter(record);
  };
}

/**
 * Compose a user `onPrePayment` with the HookManager veto. User callback wins
 * if it returns `{ block }` — declarative ops policies (the hook) only fire
 * when the user didn't explicitly veto first.
 */
function composePrePaymentCallbacks(
  userCb: PrePaymentHook | undefined,
  hookManager: NonNullable<WrapFetchWithPaymentOptions['hookManager']>,
  traceContext: WrapFetchWithPaymentOptions['traceContext'],
): PrePaymentHook {
  return async (input) => {
    if (userCb) {
      const userResult = await userCb(input);
      if (userResult && userResult.block) return userResult;
    }
    const decision = await hookManager.firePrePayment({
      event: 'pre-payment',
      conversationId: traceContext?.conversationId ?? 'unknown',
      resource: input.resource,
      amountAtomic: input.requirements.maxAmountRequired,
      asset: input.requirements.asset,
      network: input.requirements.network,
      payee: input.requirements.payTo,
      spentSoFarAtomic: input.spentSoFarAtomic.toString(),
    });
    if (decision.block) {
      return { block: true, ...(decision.reason ? { reason: decision.reason } : {}) };
    }
    return undefined;
  };
}

function requestUrl(input: FetchInput | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  // Request — `url` is a string property
  return (input as { url: string }).url;
}

function mergeHeaders(
  existing: FetchHeaders | undefined,
  add: Record<string, string>,
): FetchHeaders {
  const out = new Headers(existing);
  for (const [k, v] of Object.entries(add)) out.set(k, v);
  // Headers is a valid HeadersInit per the fetch spec
  return out as FetchHeaders;
}

// Re-exports
export { PaymentRequirementsSchema, PaymentRequiredBodySchema };
