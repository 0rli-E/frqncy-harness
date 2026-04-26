/**
 * Per-model pricing table.
 *
 * Rates are USD per 1 million tokens. Cached input is the discounted rate
 * Anthropic charges for prompt-cached input tokens (~10% of regular input).
 *
 * These are estimates as of April 2026 and may not match your actual billing.
 * Override per-model rates via config: `~/.frqncy-harness/config.json#pricing`.
 *
 * If we don't have a rate for a model, computeCost() returns undefined.
 * The trace still records token counts — you can compute cost retroactively
 * once you fill in the rate.
 */
import type { Provider } from './types.js';

export interface ModelRate {
  /** USD per 1M input tokens */
  inputUsdPerM: number;
  /** USD per 1M output tokens */
  outputUsdPerM: number;
  /** USD per 1M cached input tokens (Anthropic prompt caching, OpenAI/Gemini auto-caching) */
  cachedInputUsdPerM?: number;
  /** Notes on the rate (when last verified, what tier, etc.) */
  notes?: string;
}

/**
 * Static rate table. Keys are `<provider>/<modelId>` exactly as returned
 * by parseModelString().
 */
export const DEFAULT_RATES: Record<string, ModelRate> = {
  // ── Anthropic Claude (rates as of April 2026) ───────────────────
  'anthropic/claude-sonnet-4-6': {
    inputUsdPerM: 3.0,
    outputUsdPerM: 15.0,
    cachedInputUsdPerM: 0.3,
    notes: 'Sonnet 4.6 — cached input is 10% of regular',
  },
  'anthropic/claude-opus-4-6': {
    inputUsdPerM: 15.0,
    outputUsdPerM: 75.0,
    cachedInputUsdPerM: 1.5,
    notes: 'Opus 4.6',
  },
  'anthropic/claude-haiku-4-5-20251001': {
    inputUsdPerM: 0.8,
    outputUsdPerM: 4.0,
    cachedInputUsdPerM: 0.08,
    notes: 'Haiku 4.5',
  },

  // ── OpenAI GPT (rates as of April 2026, ESTIMATED) ──────────────
  'openai/gpt-5': {
    inputUsdPerM: 2.5,
    outputUsdPerM: 10.0,
    cachedInputUsdPerM: 0.625,
    notes: 'GPT-5 standard tier — estimated',
  },
  'openai/gpt-5-mini': {
    inputUsdPerM: 0.25,
    outputUsdPerM: 1.25,
    cachedInputUsdPerM: 0.0625,
    notes: 'GPT-5 mini — estimated',
  },

  // ── Google Gemini (rates as of April 2026) ──────────────────────
  'google/gemini-2.5-pro': {
    inputUsdPerM: 1.25,
    outputUsdPerM: 5.0,
    cachedInputUsdPerM: 0.3125,
    notes: 'Gemini 2.5 Pro under 200K context — over 200K input is 2.5/M',
  },
  'google/gemini-2.5-flash': {
    inputUsdPerM: 0.15,
    outputUsdPerM: 0.6,
    cachedInputUsdPerM: 0.0375,
    notes: 'Gemini 2.5 Flash',
  },

  // ── OpenRouter (variable; rates approximate, prefer model card) ──
  'openrouter/nousresearch/hermes-4-405b': {
    inputUsdPerM: 1.0,
    outputUsdPerM: 3.0,
    notes: 'Hermes 4 405B via OpenRouter',
  },
  'openrouter/nousresearch/hermes-4-70b': {
    inputUsdPerM: 0.18,
    outputUsdPerM: 0.6,
    notes: 'Hermes 4 70B via OpenRouter',
  },
};

/**
 * Look up the rate for a specific model.
 * Returns undefined if we don't have a rate on file.
 */
export function getModelRate(provider: Provider, modelId: string): ModelRate | undefined {
  const key = `${provider}/${modelId}`;
  return DEFAULT_RATES[key];
}

/**
 * Compute the USD cost of a call given token usage.
 * Returns undefined if we don't have a rate for the model.
 */
export function computeCost(args: {
  provider: Provider;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}): number | undefined {
  const rate = getModelRate(args.provider, args.modelId);
  if (!rate) return undefined;

  const regularInputTokens = Math.max(0, args.inputTokens - args.cachedInputTokens);
  const regularInputCost = (regularInputTokens / 1_000_000) * rate.inputUsdPerM;
  const cachedInputCost = rate.cachedInputUsdPerM
    ? (args.cachedInputTokens / 1_000_000) * rate.cachedInputUsdPerM
    : (args.cachedInputTokens / 1_000_000) * rate.inputUsdPerM; // fall back to regular rate
  const outputCost = (args.outputTokens / 1_000_000) * rate.outputUsdPerM;

  return regularInputCost + cachedInputCost + outputCost;
}
