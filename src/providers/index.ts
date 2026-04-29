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
          'X-Title': '@frqncy-network/harness',
        },
      });
      return { model: openrouter(modelId), provider, modelId };
    }
    case 'chutes': {
      // Chutes is OpenAI-compatible at https://chutes.ai/v1 — decentralized inference (Bittensor).
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      const apiKey = process.env['CHUTES_API_KEY'];
      if (!apiKey) {
        throw new Error('CHUTES_API_KEY environment variable is required for Chutes models.');
      }
      const chutes = createOpenAICompatible({
        name: 'chutes',
        baseURL: 'https://chutes.ai/v1',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return { model: chutes(modelId), provider, modelId };
    }
    case 'daydreams-router': {
      // Daydreams Router (ai.xgate.run) is OpenAI-compatible but auth is an
      // ERC-2612 USDC permit, not an API key. We build a `fetch` wrapper via
      // createDaydreamsRouterFetch — it does the 402 → permit → retry handshake
      // and reuses sessions via X-Upto-Session — and pass that as the
      // openai-compatible adapter's `fetch`. Wallet creds resolve from the
      // harness's auth store (CDP creds preferred, viem private key fallback).
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      const { createSigner } = await import('../wallet/index.js');
      const { createDaydreamsRouterFetch, DEFAULT_DAYDREAMS_ROUTER_URL } = await import(
        '../bridges/daydreams-router.js'
      );

      const signer = await createSigner();
      // Override permit cap + deadline via env, in atomic USDC and seconds:
      const capStr = process.env['FRQNCY_DAYDREAMS_PERMIT_CAP_ATOMIC'];
      const deadlineStr = process.env['FRQNCY_DAYDREAMS_PERMIT_DEADLINE_SEC'];
      const baseUrl = process.env['FRQNCY_DAYDREAMS_ROUTER_URL'] ?? DEFAULT_DAYDREAMS_ROUTER_URL;

      const wrappedFetch = createDaydreamsRouterFetch({
        signer,
        baseUrl,
        ...(capStr ? { permitCapAtomic: BigInt(capStr) } : {}),
        ...(deadlineStr ? { permitDeadlineSeconds: Number(deadlineStr) } : {}),
      });

      const router = createOpenAICompatible({
        name: 'daydreams-router',
        baseURL: `${baseUrl.replace(/\/+$/, '')}/v1`,
        // The OpenAI-compatible adapter forwards `fetch` to the SDK's HTTP layer
        // when provided — viable per Vercel AI SDK v6.
        fetch: wrappedFetch as unknown as typeof fetch,
      });
      return { model: router(modelId), provider, modelId };
    }
    case 'perplexity': {
      // First-party @ai-sdk/perplexity adapter. We use this rather than the OpenAI-compatible
      // baseURL approach because Perplexity's value-add is the structured `sources` array
      // returned alongside text — losing that would gut the trace integrity for grounded
      // queries (sources would only live inside the assistant text body).
      const { perplexity } = await import('@ai-sdk/perplexity');
      // The provider reads PERPLEXITY_API_KEY from env automatically; auth/hydrateApiKeysIntoEnv()
      // copies the stored key into env at CLI startup, so no explicit apiKey arg needed here.
      if (!process.env['PERPLEXITY_API_KEY']) {
        throw new Error(
          'PERPLEXITY_API_KEY environment variable is required for Perplexity models. ' +
            "Get a key at https://www.perplexity.ai/account/api/keys (Pro/Max subscriptions include monthly API credit), " +
            "then set via env or `frqncy-harness auth set perplexity <key>`.",
        );
      }
      return { model: perplexity(modelId), provider, modelId };
    }
    case 'claude-code':
    case 'codex':
      throw new Error(
        `Provider '${provider}' is a subscription provider — it doesn't return an AI SDK LanguageModel. ` +
          `Subscription providers run via subprocess (src/providers/subprocess.ts) and are routed separately ` +
          `inside stream()/chat(). If you reached this code path, it's a bug — getProvider() should not have been called.`,
      );
    case 'claude-sdk':
      throw new Error(
        `Provider 'claude-sdk' is an SDK provider — it doesn't return an AI SDK LanguageModel. ` +
          `SDK providers run their own agent loop (src/providers/sdk.ts) and are routed separately ` +
          `inside stream()/chat(). If you reached this code path, it's a bug — getProvider() should not have been called.`,
      );
  }
}

/**
 * Compute the cost in USD for a call.
 * Wraps src/pricing.ts so chat() / stream() don't need to know about the rate table.
 */
export { computeCost as computeCostUsd } from '../pricing.js';
