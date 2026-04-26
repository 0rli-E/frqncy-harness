/**
 * Provider abstraction.
 *
 * Maps a `<provider>/<model-name>` string to an AI SDK LanguageModel instance.
 * Providers are loaded lazily — only the ones you actually use get imported.
 *
 * Architectural principle (decision 3 in HARNESS-PLAN.md):
 *   Direct SDKs for tier-1 (Anthropic, OpenAI, Google) so we keep prompt caching,
 *   computer use, Responses API, etc. OpenRouter for the long tail (Hermes, Llama,
 *   DeepSeek, Qwen, anything experimental).
 *
 *   NEVER route 100% through OpenRouter. We lose ~30-40% of tier-1 capability,
 *   most importantly Anthropic prompt caching.
 */
import type { LanguageModel } from 'ai';
import { ModelStringSchema, PROVIDERS, type ModelString, type Provider } from '../types.js';

export interface ProviderResult {
  model: LanguageModel;
  provider: Provider;
  modelId: string;
}

/**
 * Parse a model string into provider + model name.
 * Examples:
 *   "anthropic/claude-sonnet-4-6" → { provider: "anthropic", modelId: "claude-sonnet-4-6" }
 *   "openrouter/nousresearch/hermes-4-405b" → { provider: "openrouter", modelId: "nousresearch/hermes-4-405b" }
 */
export function parseModelString(model: ModelString): { provider: Provider; modelId: string } {
  ModelStringSchema.parse(model);
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid model string: ${model}. Expected <provider>/<model-name>.`);
  }
  const providerStr = model.slice(0, slashIndex);
  const modelId = model.slice(slashIndex + 1);

  if (!(PROVIDERS as readonly string[]).includes(providerStr)) {
    throw new Error(
      `Unknown provider: ${providerStr}. Supported: ${PROVIDERS.join(', ')}.`,
    );
  }
  return { provider: providerStr as Provider, modelId };
}

/**
 * Resolve a model string to an AI SDK LanguageModel.
 * Lazily imports the provider package only when needed.
 */
export async function getProvider(model: ModelString): Promise<ProviderResult> {
  const { provider, modelId } = parseModelString(model);

  switch (provider) {
    case 'anthropic': {
      const { anthropic } = await import('@ai-sdk/anthropic');
      return { model: anthropic(modelId), provider, modelId };
    }
    case 'openai': {
      const { openai } = await import('@ai-sdk/openai');
      return { model: openai(modelId), provider, modelId };
    }
    case 'google': {
      const { google } = await import('@ai-sdk/google');
      return { model: google(modelId), provider, modelId };
    }
    case 'openrouter': {
      // OpenRouter is OpenAI-compatible; use the openai-compatible adapter.
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      const apiKey = process.env['OPENROUTER_API_KEY'];
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY environment variable is required for OpenRouter models.');
      }
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/0rli-E/frqncy-harness',
          'X-Title': '@frqncy/harness',
        },
      });
      return { model: openrouter(modelId), provider, modelId };
    }
    case 'claude-code':
    case 'codex':
      throw new Error(
        `Provider '${provider}' is a subscription provider — it doesn't return an AI SDK LanguageModel. ` +
          `Subscription providers run via subprocess (src/providers/subprocess.ts) and are routed separately ` +
          `inside stream()/chat(). If you reached this code path, it's a bug — getProvider() should not have been called.`,
      );
  }
}

/**
 * Compute the cost in USD for a call.
 * Wraps src/pricing.ts so chat() / stream() don't need to know about the rate table.
 */
export { computeCost as computeCostUsd } from '../pricing.js';
