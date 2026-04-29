/**
 * Wire x402 payments into the harness's never-compacted trace + hook system.
 *
 * The `wrapFetchWithPayment` and `paymentMiddleware` modules accept generic
 * `onPayment` / `onPrePayment` callbacks to keep them decoupled from harness
 * internals. This module provides the stock implementations:
 *
 *   - `createPaymentTraceWriter(...)` — returns an `onPayment` callback that
 *     appends a `payment`-type record to the conversation's JSONL trace via
 *     `appendTraceRecord`. Append-only, never compacted, validated against
 *     PaymentTraceBodySchema before write.
 *
 *   - `createPrePaymentHookGate(...)` — returns an `onPrePayment` callback
 *     that calls `HookManager.firePrePayment(...)` and returns
 *     `{ block: true, reason }` if any hook vetoed.
 *
 * Callers compose these with `wrapFetchWithPayment` / `paymentMiddleware`:
 *
 *   ```ts
 *   const wrapped = wrapFetchWithPayment({
 *     signer,
 *     onPrePayment: createPrePaymentHookGate({ hookManager, conversationId }),
 *     onPayment: createPaymentTraceWriter({ conversationId, traceFilePath, step: 0 }),
 *   });
 *   ```
 *
 * Per AGENT-COMMERCE decisions 9 + 10.
 */
import { randomUUID } from 'node:crypto';
import {
  appendTraceRecord,
  getTraceFilePath,
} from '../trace.js';
import {
  TRACE_SCHEMA_VERSION,
  PaymentTraceBodySchema,
  type PaymentTraceBody,
} from '../types.js';
import type { HookManager, PrePaymentContext } from '../hooks/index.js';
import type { PaymentTraceFn, PrePaymentHook } from './client.js';
import type { PaymentMiddlewareOptions } from './server.js';

// ────────────────────────────────────────────────────────────────────
// Trace writer
// ────────────────────────────────────────────────────────────────────

export interface CreatePaymentTraceWriterOptions {
  /** Conversation id this payment happens under. Required for append. */
  conversationId: string;
  /** When the conversation started (drives the date-partitioned dir). */
  startedAt?: Date;
  /** Override the trace dir; defaults to ~/.frqncy-harness/traces/. */
  traceDir?: string;
  /** Step counter — caller increments per record so order is preserved. */
  step?: number;
  /** Thread id — copied onto the trace record. */
  threadId?: string;
  /** Project id — copied onto the trace record. */
  projectId?: string;
}

/**
 * Build an `onPayment` writer for `wrapFetchWithPayment`. Returns a closure
 * that increments its step counter on every call so successive payments in
 * the same conversation get monotonic step numbers.
 */
export function createPaymentTraceWriter(
  opts: CreatePaymentTraceWriterOptions,
): PaymentTraceFn {
  let step = opts.step ?? 0;
  const traceFile = getTraceFilePath(
    opts.conversationId,
    opts.startedAt ?? new Date(),
    opts.traceDir,
  );

  return async (record) => {
    const body: PaymentTraceBody = PaymentTraceBodySchema.parse({
      direction: record.direction,
      resource: record.resource,
      amountAtomic: record.amountAtomic,
      asset: record.asset,
      network: record.network,
      ...(record.txHash ? { txHash: record.txHash } : {}),
      ...(record.payer ? { payer: record.payer } : {}),
      payee: record.payee,
      facilitator: record.facilitator,
      triggered: record.triggered,
      settled: !!record.settled?.success,
      ...(record.settled?.errorReason ? { errorReason: record.settled.errorReason } : {}),
      scheme: 'exact',
    });

    await appendTraceRecord(traceFile, {
      ts: record.timestamp,
      conversation_id: opts.conversationId,
      step: step++,
      type: 'payment',
      content: body,
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
      ...(opts.projectId ? { project_id: opts.projectId } : {}),
      schema_version: TRACE_SCHEMA_VERSION,
    } as Parameters<typeof appendTraceRecord>[1]);
  };
}

/**
 * Inbound-payment trace writer for `paymentMiddleware`. Same record shape,
 * different callback signature — the middleware emits `direction: 'in'`
 * payments after settle.
 */
export function createInboundPaymentTraceWriter(
  opts: CreatePaymentTraceWriterOptions,
): NonNullable<PaymentMiddlewareOptions['onPayment']> {
  let step = opts.step ?? 0;
  const traceFile = getTraceFilePath(
    opts.conversationId,
    opts.startedAt ?? new Date(),
    opts.traceDir,
  );

  return async (record) => {
    const body: PaymentTraceBody = PaymentTraceBodySchema.parse({
      direction: record.direction,
      resource: record.path,
      amountAtomic: record.amountAtomic,
      asset: record.asset,
      network: record.network,
      ...(record.txHash ? { txHash: record.txHash } : {}),
      ...(record.payer ? { payer: record.payer } : {}),
      payee: record.payee,
      settled: true,
      scheme: 'exact',
    });

    await appendTraceRecord(traceFile, {
      ts: record.timestamp,
      conversation_id: opts.conversationId,
      step: step++,
      type: 'payment',
      content: body,
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
      ...(opts.projectId ? { project_id: opts.projectId } : {}),
      schema_version: TRACE_SCHEMA_VERSION,
    } as Parameters<typeof appendTraceRecord>[1]);
  };
}

// ────────────────────────────────────────────────────────────────────
// Pre-payment hook gate
// ────────────────────────────────────────────────────────────────────

export interface CreatePrePaymentHookGateOptions {
  hookManager: HookManager;
  /** Conversation id passed to hooks. Auto-uuid'd if not provided. */
  conversationId?: string;
}

export function createPrePaymentHookGate(
  opts: CreatePrePaymentHookGateOptions,
): PrePaymentHook {
  const conversationId = opts.conversationId ?? randomUUID();
  return async ({ resource, requirements, spentSoFarAtomic }) => {
    const ctx: PrePaymentContext = {
      event: 'pre-payment',
      conversationId,
      resource,
      amountAtomic: requirements.maxAmountRequired,
      asset: requirements.asset,
      network: requirements.network,
      payee: requirements.payTo,
      spentSoFarAtomic: spentSoFarAtomic.toString(),
    };
    const decision = await opts.hookManager.firePrePayment(ctx);
    if (decision.block) {
      return { block: true, ...(decision.reason ? { reason: decision.reason } : {}) };
    }
  };
}
