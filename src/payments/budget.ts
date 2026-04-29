/**
 * Per-conversation x402 spend tracker.
 *
 * Independent of the LLM cost cap. Defaults: $0.50 soft warn / $5.00 hard
 * abort. Configurable via the `payments.budget` block in
 * ~/.frqncy-harness/config.json.
 *
 * Tracks atomic-USDC totals (no float rounding); thresholds are stored as
 * atomic-USDC too (e.g. $5.00 → 5000000 with 6-decimal USDC).
 */

export interface BudgetState {
  /** Total atomic units spent, summed across all settled outbound payments. */
  spentAtomic: bigint;
  /** Atomic-units soft-warn threshold. */
  softWarnAtomic: bigint;
  /** Atomic-units hard-abort threshold. */
  hardAbortAtomic: bigint;
  /** Has the soft warning been emitted this conversation? */
  warned: boolean;
}

export interface BudgetCheck {
  allowed: boolean;
  triggered: 'none' | 'soft' | 'hard';
  spentAfterAtomic: bigint;
  message?: string;
}

export const DEFAULT_SOFT_WARN_USD_CENTS = 50; // $0.50
export const DEFAULT_HARD_ABORT_USD_CENTS = 500; // $5.00

/** Convert a USD cents amount into atomic USDC (USDC has 6 decimals). */
export function usdCentsToUsdcAtomic(cents: number): bigint {
  // 1 cent = 0.01 USD = 10000 atomic USDC (6 decimals)
  return BigInt(cents) * BigInt(10000);
}

export function createBudgetState(opts?: {
  softWarnUsdCents?: number;
  hardAbortUsdCents?: number;
}): BudgetState {
  return {
    spentAtomic: 0n,
    softWarnAtomic: usdCentsToUsdcAtomic(opts?.softWarnUsdCents ?? DEFAULT_SOFT_WARN_USD_CENTS),
    hardAbortAtomic: usdCentsToUsdcAtomic(opts?.hardAbortUsdCents ?? DEFAULT_HARD_ABORT_USD_CENTS),
    warned: false,
  };
}

/**
 * Check whether a payment of `amountAtomic` is allowed under this budget.
 * Pure — does NOT mutate the state. Mutate via `recordSpend` after the
 * payment actually settled (so we don't count failed verifies).
 */
export function checkBudget(state: BudgetState, amountAtomic: bigint): BudgetCheck {
  const spentAfter = state.spentAtomic + amountAtomic;
  if (spentAfter > state.hardAbortAtomic) {
    return {
      allowed: false,
      triggered: 'hard',
      spentAfterAtomic: spentAfter,
      message: `payment would exceed hard cap (would be ${formatAtomicUsdc(spentAfter)} of ${formatAtomicUsdc(state.hardAbortAtomic)} cap)`,
    };
  }
  if (!state.warned && spentAfter > state.softWarnAtomic) {
    return {
      allowed: true,
      triggered: 'soft',
      spentAfterAtomic: spentAfter,
      message: `crossing soft warning threshold (${formatAtomicUsdc(state.softWarnAtomic)})`,
    };
  }
  return { allowed: true, triggered: 'none', spentAfterAtomic: spentAfter };
}

export function recordSpend(state: BudgetState, amountAtomic: bigint): void {
  state.spentAtomic += amountAtomic;
}

export function markWarned(state: BudgetState): void {
  state.warned = true;
}

export function formatAtomicUsdc(atomic: bigint): string {
  // 6 decimals
  const sign = atomic < 0n ? '-' : '';
  const a = atomic < 0n ? -atomic : atomic;
  const whole = a / 1000000n;
  const frac = a % 1000000n;
  return `$${sign}${whole}.${frac.toString().padStart(6, '0').slice(0, 2)}`;
}
