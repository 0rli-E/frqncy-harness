/**
 * Reputation auto-write — feedback on settled outbound payments.
 *
 * Pattern lifted from ChaosChain's facilitator (their facilitator
 * automatically writes to ERC-8004 ReputationRegistry on each settlement).
 * The harness's variant is *operator-controlled* — no implicit chain scans;
 * the caller supplies a `lookupAgentId(address) → number | null` function so
 * you decide which counterparties to score.
 *
 * Off by default per AGENT-COMMERCE decision 11. Toggle on via:
 *   - the `payments.autoFeedback.enabled` config field, or
 *   - explicitly via createSettleFeedbackWriter() in library use.
 *
 * SECURITY NOTE: writing feedback costs gas. With CDP smart accounts on Base
 * gas is sponsored via Paymaster, but viem-private-key signers will pay ETH
 * out of pocket. Either way, the failure of the feedback call MUST NOT
 * propagate up — payment already settled successfully and the caller is
 * waiting on the response. Failures are logged + swallowed.
 */
import { z } from 'zod';
import type { Signer, Address, Hex } from '../wallet/index.js';
import type { PaymentTraceFn } from './client.js';
import { giveFeedback } from '../identity/registry.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/**
 * Lookup function: given a payee address, return the ERC-8004 agentId to
 * score (or null to skip). Operator-controlled — common implementations:
 *
 *   1. Static map: `(addr) => MY_VENDORS[addr.toLowerCase()] ?? null`
 *   2. Indexer: query an external indexer (TheGraph, Dune, etc.) for the
 *      agentId matching this address's bound `agentWallet` metadata key
 *   3. On-chain scan: walk MetadataSet events on IdentityRegistry filtering
 *      to `agentWallet=<addr>`. Slow. Cache aggressively.
 *
 * Return null when the recipient isn't a registered ERC-8004 agent.
 */
export type LookupAgentId = (
  payeeAddress: Address,
) => Promise<number | null> | number | null;

export interface CreateSettleFeedbackWriterOptions {
  /** Signer that will sign the feedback transaction (the *client* address — the agent giving feedback). */
  signer: Signer;
  /** Look up the recipient's agentId from their on-chain payee address. Return null to skip. */
  lookupAgentId: LookupAgentId;
  /**
   * Default feedback value. Real-valued: `value / 10**defaultDecimals` is what
   * lands on-chain. Default: 1.0 (i.e. value=100 with decimals=2 → 1.00).
   *
   * Per EIP-8004: int128, 0–18 decimals. Negative values allowed (criticism).
   */
  defaultValue?: number;
  /** Default decimal precision. Default: 2 (cents-precision rating). */
  defaultDecimals?: number;
  /** Default tag1 — recommended values per EIP-8004: starred, reachable, ownerVerified, uptime, successRate, responseTime, blocktimeFreshness, revenues, tradingYield. */
  defaultTag1?: string;
  /** Default tag2 — free-form sub-tag. */
  defaultTag2?: string;
  /** Optional override of the next callback in the chain (called after feedback). */
  next?: PaymentTraceFn;
  /** Optional structured logger. Defaults to stderr. */
  log?: (event: { level: 'info' | 'warn' | 'error'; message: string; data?: unknown }) => void;
}

// ────────────────────────────────────────────────────────────────────
// Config schema (used by src/config.ts to extend `payments.autoFeedback`)
// ────────────────────────────────────────────────────────────────────

export const AutoFeedbackConfigSchema = z.object({
  /** Whether auto-feedback fires on settled outbound payments. Default false. */
  enabled: z.boolean().default(false),
  /** Default value to score (real-valued). Default 1.0. */
  defaultValue: z.number().default(1.0),
  /** Default decimal precision (0-18). Default 2 (cents). */
  defaultDecimals: z.number().int().min(0).max(18).default(2),
  /** Default tag1 — categorical label. */
  defaultTag1: z.string().optional(),
  /** Default tag2 — free-form sub-tag. */
  defaultTag2: z.string().optional(),
});
export type AutoFeedbackConfig = z.infer<typeof AutoFeedbackConfigSchema>;

// ────────────────────────────────────────────────────────────────────
// Public: factory
// ────────────────────────────────────────────────────────────────────

/**
 * Build a payment-trace `onPayment` callback that writes ERC-8004 feedback
 * for every successfully settled OUTBOUND payment whose payee address
 * resolves via `lookupAgentId`.
 *
 * Returns the callback. Compose with other writers (trace, user log) by
 * passing `next` — that's chained AFTER feedback fires, so the feedback tx
 * hash is observable to downstream observers.
 */
export function createSettleFeedbackWriter(
  opts: CreateSettleFeedbackWriterOptions,
): PaymentTraceFn {
  const log =
    opts.log ??
    ((evt) => {
      if (evt.level === 'error') process.stderr.write(`[feedback] ${evt.message}\n`);
      else if (evt.level === 'warn') process.stderr.write(`[feedback] warn: ${evt.message}\n`);
      // skip info logs by default — they'd be noisy on every settlement
    });

  return async (record) => {
    // Decide whether to attempt feedback, then always run `next` exactly once
    // at the end. Splitting the logic this way avoids the previous bug where
    // an early-return + finally would fire `next` twice.
    let feedbackTx: Hex | undefined;
    try {
      const isFeedbackCandidate =
        record.direction === 'out' &&
        record.settled !== null &&
        record.settled.success === true;

      if (isFeedbackCandidate) {
        const agentId = await opts.lookupAgentId(record.payee as Address);
        if (agentId === null) {
          log({
            level: 'info',
            message: `payee ${record.payee} did not resolve to an agentId; skipping feedback`,
          });
        } else {
          const value = opts.defaultValue ?? 1.0;
          const decimals = opts.defaultDecimals ?? 2;
          feedbackTx = await giveFeedback({
            signer: opts.signer,
            agentId,
            value,
            valueDecimals: decimals,
            ...(opts.defaultTag1 ? { tag1: opts.defaultTag1 } : {}),
            ...(opts.defaultTag2 ? { tag2: opts.defaultTag2 } : {}),
            ...(record.txHash ? { endpoint: record.txHash } : {}),
          });
          log({
            level: 'info',
            message: `wrote feedback ${value} (decimals=${decimals}) to agent ${agentId}: ${feedbackTx}`,
            data: { agentId, value, decimals, feedbackTx },
          });
        }
      }
    } catch (err) {
      // Per the security note above: feedback failures must NEVER propagate.
      // Payment already settled; the caller is waiting on the resource response.
      log({
        level: 'warn',
        message: `auto-feedback failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { err },
      });
    }
    // Always forward to the next callback in the chain — exactly once.
    await opts.next?.(record);
  };
}
