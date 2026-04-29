# Daydreams + Lucid Agents: ERC-8004 / x402 / AP2 / A2A Patterns

> Research dossier for the frqncy harness. Verbatim TypeScript excerpts wherever possible.
> Sources fetched 2026-04-29: `daydreamsai/lucid-agents` (`master`) and `daydreamsai/daydreams` (`main`).

---

## 1. Lucid Agents — top-level architecture

Lucid Agents is a **TypeScript monorepo** with a three-layer architecture:

> - **Layer 1: Core** — Protocol-agnostic agent runtime with extension system (`@lucid-agents/core`) — no protocol-specific code
> - **Layer 2: Extensions** — Optional capabilities added via composition: `http()` (HTTP protocol), `payments()` (x402), `wallets()` (wallet management), `identity()` (ERC-8004), `a2a()` (agent-to-agent), `ap2()` (Agent Payments Protocol)
> - **Layer 3: Adapters** — Framework integrations (hono, tanstack, express, next) that use the HTTP extension

### Packages (verbatim from README)

- `@lucid-agents/types` — Shared type definitions used across all packages
- `@lucid-agents/core` — Protocol-agnostic agent runtime with extension system
- `@lucid-agents/http` — HTTP extension for request/response handling, streaming, and SSE
- `@lucid-agents/wallet` — Wallet SDK for agent and developer wallet management
- `@lucid-agents/payments` — x402 payment utilities with bi-directional tracking, payment policies, and persistent storage (SQLite, In-Memory, Postgres)
- `@lucid-agents/analytics` — Payment analytics and reporting with CSV/JSON export for accounting system integration
- `@lucid-agents/identity` — ERC-8004 identity toolkit for onchain agent identity
- `@lucid-agents/a2a` — A2A Protocol client for agent-to-agent communication
- `@lucid-agents/ap2` — AP2 (Agent Payments Protocol) extension for Agent Cards
- `@lucid-agents/hono` / `@lucid-agents/express` / `@lucid-agents/tanstack` / `@lucid-agents/cli`

### Public API surface — `@lucid-agents/core/src/index.ts` (verbatim)

```typescript
export { AgentCore, createAgentCore } from './core/agent';
export { AgentBuilder } from './extensions/builder';
export { createAgent } from './runtime';
export * from './utils';
export { validateAgentMetadata } from './validation';
export type {
  EntrypointDef,
  EntrypointHandler,
  EntrypointStreamHandler,
} from '@lucid-agents/types/core';
export type { AgentConfig } from '@lucid-agents/types/core';
export type {
  StreamEnvelope,
  StreamPushEnvelope,
  StreamResult,
  ContextStateApi<TContext> {
} from '@lucid-agents/types/http';
```

So in lucid-agents the *primary* primitives are **`createAgent`**, **a builder**, **entrypoints**, and **extensions**. Note the deliberate split between Lucid Agents (monetization/commerce SDK) and the Daydreams core agent framework — they are sibling repos. The README explicitly says:

> Check out the lucid-agents repo: https://github.com/daydreamsai/lucid-agents
> We recommend the Pi agent harness for building agents and incorporating lucid-agents in it.

i.e. the recommended pattern is **harness for the LLM loop + lucid-agents for the commerce/identity rails**, not "build everything inside one framework". This is directly relevant to your harness work — they treat the LLM loop and the payments/identity/A2A surface as orthogonal concerns.

### Core terminology in lucid-agents

> **Entrypoints**: Typed API endpoints that define your agent's capabilities. Each entrypoint has:
> - Input/output schemas (Zod)
> - Optional pricing (x402)
> - Handler (synchronous) or stream handler (SSE)

> **Adapters**: Runtime frameworks that expose your entrypoints as HTTP routes.
> `hono` | `tanstack` | `express` | `next`

> **Manifests**: Auto-generated AgentCard (`.well-known/agent-card.json`) that describes your agent's capabilities, pricing, and identity for discovery tools and A2A protocols. Built using immutable composition pattern.

The fluent-builder shape:

```typescript
import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { z } from 'zod';

const agent = await createAgent({
  name: 'my-agent',
  version: '1.0.0',
  description: 'My first agent',
})
  .use(http())
  .build();

agent.entrypoints.add({
  key: 'greet',
  input: z.object({ name: z.string() }),
  async handler({ input }) {
    return { output: { message: `Hello, ${input.name}!` } };
  },
});
```

Key lift for your harness: **builder.use(extension)** + **`.build()`** + **`agent.entrypoints.add(...)`**. The extension hook surface (from `@lucid-agents/types/core`) shows up clearly in extension implementations:

```typescript
return {
  name: 'identity',
  build(): { ... },                            // synchronous build-time addons
  async onBuild(runtime: AgentRuntime),        // post-build, has runtime
  onEntrypointAdded(entrypoint, runtime),      // payments hooks here
  onManifestBuild(card, runtime),              // mutate the AgentCard
};
```

That is the actual `Extension` surface — verified across `identity/extension.ts`, `ap2/extension.ts`, `payments/extension.ts`. **`onManifestBuild` returning a new immutable card is the central mechanism.** Each extension can rewrite the AgentCard.

---

## 2. x402 — verbatim implementation

### Server (Daydreams nanoservice example, `examples/x402/nanoservice/server.ts`)

```typescript
import { config } from "dotenv";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { paymentMiddleware, type Network } from "x402-hono";
import { createDreams, context, LogLevel } from "@daydreamsai/core";

import * as z from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { createDreamsRouterAuth } from "@daydreamsai/ai-sdk-provider";

config();

// Authenticated Dreams router used as the model provider.
const { dreamsRouter } = await createDreamsRouterAuth(
  privateKeyToAccount(Bun.env.PRIVATE_KEY as `0x${string}`),
  {
    baseURL: "http://localhost:8080/v1",
    payments: {
      amount: "100000", // $0.10 USDC to access the router
      network: "base-sepolia",
    },
  }
);

// x402 facilitator and payment parameters
const facilitatorUrl = "https://facilitator.x402.rs";
const payTo =
  (process.env.ADDRESS as `0x${string}`) ||
  "0xb308ed39d67D0d4BAe5BC2FAEF60c66BBb6AE429";
const network = (process.env.NETWORK as Network) || "base-sepolia";
```

Then they declare a `context` with per-session memory, an agent via `createDreams(...)`, and finally:

```typescript
// Payment guard: charge $0.01 for /assistant; other routes are free
app.use(
  paymentMiddleware(
    payTo,
    {
      "/assistant": {
        price: "$0.01", // 1 cent per request
        network,
      },
    },
    {
      url: facilitatorUrl,
    }
  )
);

app.post("/assistant", async (c) => {
  const body = await c.req.json();
  const { query, sessionId = "default" } = body;
  const contextState = await agent.getContext({
    context: assistantContext,
    args: { sessionId },
  });
  contextState.memory.requestCount++;
  contextState.memory.lastQuery = query;
  const result = await agent.send({
    context: assistantContext,
    args: { sessionId },
    input: { type: "text", data: query },
  });
  // ...
});
```

The `payTo` default `0xb308ed39d67D0d4BAe5BC2FAEF60c66BBb6AE429` and the `facilitator.x402.rs` facilitator URL are baked into the example. **Network defaults to `base-sepolia`.**

### Client (`examples/x402/nanoservice/client.ts`)

```typescript
import { decodeXPaymentResponse, wrapFetchWithPayment } from "x402-fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(PRIVATE_KEY);
const fetchWithPayment = wrapFetchWithPayment(fetch, account);

// ...
const response = await fetchFn(url, { method, headers, body });
// Decode and show payment info
const paymentHeader = response.headers.get("x-payment-response");
if (paymentHeader) {
  const paymentResponse = decodeXPaymentResponse(paymentHeader);
  console.log("💳 Payment Info:", {
    success: paymentResponse.success,
    transaction: paymentResponse.transaction,
    network: paymentResponse.network,
    payer: paymentResponse.payer,
  });
}
```

So the **packages are**: `x402-hono` (server middleware), `x402-fetch` (client fetch wrapper), and `viem`. The integration with the agent loop is dead simple — Hono's middleware chain runs first, blocks/charges before the route handler, and only then does the route handler call `agent.send(...)`. **Payments do not appear as a tool to the LLM** in this example; they are an HTTP middleware concern that gates entire entrypoints.

### Lucid Agents x402 — `@lucid-agents/payments`

Their own x402 client wrapper (`packages/payments/src/x402.ts`) — verbatim:

```typescript
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';

const SUPPORTED_EVM_NETWORKS: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  ethereum: 'eip155:1',
  sepolia: 'eip155:11155111',
};

export const createX402Fetch = ({
  account,
  fetchImpl,
  networks,
}: CreateX402FetchOptions): WrappedFetch => {
  const signer = toClientEvmSigner(account);
  const client = new x402Client();
  const networksToRegister = networks ?? Object.keys(SUPPORTED_EVM_NETWORKS);
  for (const network of networksToRegister) {
    const caip2Id = SUPPORTED_EVM_NETWORKS[network];
    if (caip2Id) {
      client.register(caip2Id as `${string}:${string}`, new ExactEvmScheme(signer));
    }
  }
  const paymentFetch = wrapFetchWithPayment(fetchImpl ?? fetch, client);
  // ... wraps with logging, returns
};
```

Note: lucid-agents uses **`@x402/fetch`** + **`@x402/evm`** (the new modular x402 packages with CAIP-2 chain identifiers and pluggable schemes), while the daydreams example uses the older monolithic **`x402-fetch`** + **`x402-hono`**. The lucid-agents path is more extensible — if you add Solana later you'd register a different scheme on the same client. The exported surface in `payments/src/index.ts` is:

```typescript
export { resolvePrice } from './pricing';
export { createAgentCardWithPayments } from './manifest';
export {
  entrypointHasExplicitPrice,
  evaluatePaymentRequirement,
  resolveActivePayments,
  resolvePaymentRequirement,
  paymentRequiredResponse,
  createPaymentsRuntime,
  entrypointHasSIWx,
} from './payments';
export {
  paymentsFromEnv,
  createFacilitatorAuthHeaders,
  encodePaymentRequiredHeader,
  decodePaymentRequiredHeader,
  extractSenderDomain, extractPayerAddress, parsePriceAmount,
} from './utils';
export { resolvePayTo } from './payto-resolver';
export { createX402Fetch, accountFromPrivateKey } from './x402';
export { payments } from './extension';
export { createPaymentTracker } from './payment-tracker';
export type { PaymentStorage } from './payment-storage';
export {
  createSQLitePaymentStorage,
  createInMemoryPaymentStorage,
  createPostgresPaymentStorage,
} from './...';
export { createRateLimiter } from './rate-limiter';
export {
  evaluatePolicyGroups,
  evaluateIncomingPolicyGroups,
  evaluateRecipient, evaluateSender, evaluateRateLimit,
  evaluateOutgoingLimits, evaluateIncomingLimits,
} from './policy';
export { wrapBaseFetchWithPolicy } from './policy-wrapper';
// SIWx (Sign-In With X / wallet auth)
export {
  parseSIWxHeader, verifySIWxPayload, buildSIWxExtensionDeclaration,
  buildSIWxMessage, enrichResponseWithSIWxChallenge,
} from './siwx-verify';
export { wrapFetchWithSIWx, parseSIWxExtension, buildSIWxHeaderValue } from './siwx-client';
```

Several things worth noting:

1. They expose **`encodePaymentRequiredHeader` / `decodePaymentRequiredHeader`** as primitives — useful when you need to construct 402 challenges yourself.
2. Three storage backends for payment ledgering: **SQLite, in-memory, Postgres**.
3. **Bi-directional tracking** + **policy enforcement**: outgoing & incoming limits, per-target / per-endpoint, allow/block lists, rate limiter, all enforced by `wrapBaseFetchWithPolicy`. The agent's outbound paid `fetch` is wrapped so policies fire *before* x402 challenges are accepted — this is what they mean by "agents that can spend safely".
4. **SIWx** (Sign-In With X — generalized SIWE) is bundled into payments. Same fetch-wrapping pattern: `wrapFetchWithSIWx`.

The `payments()` extension itself is small — verbatim:

```typescript
export function payments(options?: {
  config?: PaymentsConfig | false;
  policies?: string;
  agentId?: string;
  storageFactory?: PaymentStorageFactory;
}): Extension<{ payments?: PaymentsRuntime }> {
  let paymentsRuntime: PaymentsRuntime | undefined;
  return {
    name: 'payments',
    build(ctx: BuildContext): { payments?: PaymentsRuntime } {
      let config = options?.config;
      if (config !== false && config !== undefined && options?.policies) {
        const policyGroups = policiesFromConfig(options.policies);
        if (policyGroups) config = { ...config, policyGroups };
      }
      paymentsRuntime = createPaymentsRuntime(config, options?.agentId, options?.storageFactory);
      return { payments: paymentsRuntime };
    },
    onEntrypointAdded(entrypoint: EntrypointDef, runtime: AgentRuntime) {
      if (paymentsRuntime && !paymentsRuntime.isActive && paymentsRuntime.config) {
        if (entrypointHasExplicitPrice(entrypoint) || entrypoint.siwx?.authOnly) {
          paymentsRuntime.activate(entrypoint);
        }
      }
    },
    onManifestBuild(card, runtime): AgentCardWithEntrypoints {
      if (paymentsRuntime?.config) {
        return createAgentCardWithPayments(card, paymentsRuntime.config, runtime.entrypoints.snapshot());
      }
      return card;
    },
  };
}
```

The pattern: lazy `activate()` on first paid entrypoint, manifest enrichment to advertise prices, no integration with the LLM at all — payments are an **HTTP-layer concern**.

---

## 3. ERC-8004 implementation

The `@lucid-agents/identity` package is the most polished part of the SDK. The `index.ts`:

```typescript
export * from './config';
export { identityFromEnv } from './env';
export { identity, type IdentityConfig } from './extension';
export * from './init';
export { createAgentCardWithIdentity } from './manifest';
export * from './registries';
export * from './utils';
export * from './validation';
```

### Registration flow — `createAgentIdentity` (verbatim, abridged)

```typescript
export type CreateAgentIdentityOptions = {
  runtime?: AgentRuntime;
  walletHandle?: AgentWalletHandle | DeveloperWalletHandle;
  domain?: string;             // falls back to AGENT_DOMAIN env
  autoRegister?: boolean;      // defaults true
  chainId?: number;            // falls back to CHAIN_ID env, defaults Base Sepolia 84532
  registryAddress?: `0x${string}`;
  rpcUrl?: string;             // falls back to RPC_URL env
  trustModels?: string[];      // defaults ["feedback", "inference-validation"]
  trustOverrides?: { validationRequestsUri?, validationResponsesUri?, feedbackDataUri? };
  registration?: AgentRegistrationOptions;
  agentURI?: string;           // defaults `https://{domain}/.well-known/agent-registration.json`
  env?: Record<string, string | undefined>;
  logger?: { info?, warn? };
};

export async function createAgentIdentity(
  options: CreateAgentIdentityOptions
): Promise<AgentIdentity> {
  validateIdentityConfig(options, options.env);

  // Prefer explicit walletHandle, then developer wallet, then agent wallet
  const walletHandle =
    explicitWalletHandle ??
    runtime?.wallets?.developer ??
    runtime?.wallets?.agent;

  const viemFactory = await makeViemClientsFromWallet({ env, rpcUrl, walletHandle });
  const resolvedChainId = resolveRequiredChainId(chainId, env);
  const resolvedRegistryAddress =
    registryAddress ??
    env?.IDENTITY_REGISTRY_ADDRESS ??
    getRegistryAddresses(resolvedChainId).IDENTITY_REGISTRY;

  const result = await bootstrapIdentity({
    domain, chainId: resolvedChainId, registryAddress: resolvedRegistryAddress,
    rpcUrl, env, logger,
    makeClients: viemFactory,
    registerIfMissing: autoRegister,
    agentURI,
    trustOverrides: { trustModels, ...trustOverrides },
  });

  // Status messages exactly as written:
  //   "Successfully registered agent in ERC-8004 registry"
  //   "Successfully registered agent in ERC-8004 registry (with domain proof signature)"
  //   "Found existing registration in ERC-8004 registry"
  //   "ERC-8004 identity configured"
  //   "No ERC-8004 identity - agent will run without on-chain identity"
  // ...

  // Build registry clients (publicClient + walletClient) for identity & reputation registries
  clients = {
    identity: createIdentityRegistryClient({ ... }),
    reputation: createReputationRegistryClient({ ... }),
    // Validation Registry is deprecated and not created by default
  };
  return { ...result, status, domain, isNewRegistration, clients };
}
```

### Signer abstraction

The identity layer never holds a private key directly. It walks: **`explicitWalletHandle` → `runtime.wallets.developer` → `runtime.wallets.agent`**, and from the wallet handle constructs a viem `publicClient`+`walletClient` pair via `makeViemClientsFromWallet`. The wallet package supports `local` (private key) and `thirdweb` (Engine / server-wallet) connectors interchangeably:

```typescript
.use(wallets({
  config: {
    agent: {
      type: 'thirdweb',
      secretKey: process.env.AGENT_WALLET_SECRET_KEY!,
      clientId: process.env.AGENT_WALLET_CLIENT_ID,
      walletLabel: 'agent-wallet',
      chainId: 84532, // Base Sepolia
    },
  },
}))
```

### Trust model defaults & opinions

> `trustModels = ['feedback', 'inference-validation']`

> **Validation Registry is deprecated and not created by default — under active development and will be revised in a follow-up spec update later this year.**

So Lucid currently ships **two of the three ERC-8004 registries**: identity + reputation. They explicitly defer validation. Reputation client exposes `giveFeedback({ toAgentId, value, valueDecimals, tag1, tag2, endpoint })`.

### Agent Card serving

The identity extension builds the agent's `.well-known/agent-card.json` enrichment via `createAgentCardWithIdentity` — **immutable composition pattern, verbatim**:

```typescript
export function createAgentCardWithIdentity(
  card: AgentCardWithEntrypoints,
  trustConfig: TrustConfig
): AgentCardWithEntrypoints {
  const enhanced: AgentCardWithEntrypoints = { ...card };
  if (trustConfig.registrations)  enhanced.registrations = trustConfig.registrations;
  if (trustConfig.trustModels)    enhanced.trustModels = Array.from(new Set(trustConfig.trustModels));
  if (trustConfig.validationRequestsUri)  enhanced.ValidationRequestsURI  = trustConfig.validationRequestsUri;
  if (trustConfig.validationResponsesUri) enhanced.ValidationResponsesURI = trustConfig.validationResponsesUri;
  if (trustConfig.feedbackDataUri)        enhanced.FeedbackDataURI        = trustConfig.feedbackDataUri;
  return enhanced;
}
```

The identity extension itself wires this in:

```typescript
export function identity(options?: { config?: IdentityConfig }): Extension<{ trust?: TrustConfig; ... }> {
  const config = options?.config;
  let trustConfig: TrustConfig | undefined = config?.trust;
  let identityResult: Awaited<ReturnType<typeof createAgentIdentity>> | undefined;

  return {
    name: 'identity',
    build(): { ... } {
      const registration = config?.registration;
      return { trust: trustConfig, identity: registration ? { registration } : undefined };
    },
    async onBuild(runtime: AgentRuntime): Promise<void> {
      if (trustConfig || !runtime.wallets?.agent) return;
      if (config?.domain || config?.autoRegister !== undefined) {
        identityResult = await createAgentIdentity({
          runtime, domain: config.domain, autoRegister: config.autoRegister,
          rpcUrl: config.rpcUrl, chainId: config.chainId, registration: config.registration,
        });
        trustConfig = getTrustConfig(identityResult);
      }
    },
    onManifestBuild(card, _runtime): AgentCardWithEntrypoints {
      if (trustConfig) return createAgentCardWithIdentity(card, trustConfig);
      return card;
    },
  };
}
```

So registration kicks off in `onBuild` (after wallets are available), then trust config bleeds into the AgentCard. There is also **OASF (Open Agentic Schema Framework) record generation** alongside the AgentCard at `/.well-known/oasf-record.json`, with skills derived from the agent's entrypoints — `derivedSkills = entrypoints.map(entry => entry.key)`.

### Registration JSON

Hosted at `/.well-known/agent-registration.json`. Verbatim type:

```typescript
const REGISTRATION_TYPE_V1 = 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' as const;
const DEFAULT_A2A_VERSION = '0.3.0';

const registration: AgentRegistration = {
  type: REGISTRATION_TYPE_V1,
  name, description, domain,
  image?, url?,
  services?: [
    // built by buildRegistrationServices: A2A, web, OASF, twitter, email
  ],
  x402Support?: boolean,
  active?: boolean,
  owner?: identity.record.owner,
  registrations?: trust.registrations,
  supportedTrust?: trust.trustModels,
};
```

The `services` array always includes an **A2A entry** by default with endpoint `${origin}/.well-known/agent-card.json` and `version: '0.3.0'`. **Service `name`s are exactly the strings: `'A2A'`, `'web'`, `'OASF'`, `'twitter'`, `'email'`.**

---

## 4. AP2 + A2A layering

### A2A — `@lucid-agents/a2a`

```typescript
import { a2a } from '@lucid-agents/a2a';
const agent = await createAgent({ name: 'my-agent', version: '1.0.0' })
  .use(http())
  .use(a2a())
  .build();

// Access A2A client via agent.a2a
const result = await agent.a2a.client.invoke(
  'https://other-agent.com',
  'skillId',
  { input: 'data' }
);
```

The README describes the A2A surface as:

> - **Direct Invocation**: Synchronous calls via `client.invoke()` or `client.stream()`
> - **Task-Based Operations**: Long-running tasks with `sendMessage()`, status tracking, and cancellation
> - **Multi-Turn Conversations**: Group related tasks with `contextId` for conversational agents
> - **Agent Composition**: Agents can act as both clients and servers, enabling complex supply chains

A2A discovery happens through the AgentCard at `.well-known/agent-card.json` — every agent is its own discovery endpoint.

### AP2 — `@lucid-agents/ap2` (verbatim extension)

```typescript
import type { AgentCardWithEntrypoints, AgentCapabilities } from '@lucid-agents/types/a2a';
import type { AP2Config, AP2ExtensionDescriptor, AP2Role } from '@lucid-agents/types/ap2';
import { AP2_EXTENSION_URI } from './types';

export function createAgentCardWithAP2(
  card: AgentCardWithEntrypoints,
  ap2Config: AP2Config
): AgentCardWithEntrypoints {
  if (!ap2Config.roles?.length) return card;

  const [firstRole, ...restRoles] = ap2Config.roles;
  const roles: [AP2Role, ...AP2Role[]] = [firstRole, ...restRoles];
  const extension: AP2ExtensionDescriptor = {
    uri: AP2_EXTENSION_URI,
    description: ap2Config.description ?? 'Agent Payments Protocol (AP2)',
    required: ap2Config.required ?? roles.includes('merchant'),
    params: { roles },
  };

  const existing = card.capabilities?.extensions ?? [];
  const withoutAp2 = existing.filter(
    ext => !('uri' in ext && ext.uri === AP2_EXTENSION_URI)
  );

  const capabilities: AgentCapabilities = {
    ...card.capabilities,
    extensions: [...withoutAp2, extension],
  };
  return { ...card, capabilities };
}
```

**Critical insight**: AP2 in lucid-agents is *purely an AgentCard advertisement*. It writes one entry into `card.capabilities.extensions` declaring `{ uri: AP2_EXTENSION_URI, params: { roles: ['merchant', ...] } }`. It does not implement the AP2 wire protocol — it advertises that this agent participates in AP2 with given roles.

```typescript
.use(ap2({ roles: ['merchant'] }))
```

When `roles` includes `'merchant'`, `required` defaults to `true`. So **AP2 is a manifest concern**; A2A is the wire protocol; x402 is the payment rail. Stack:

```
A2A (transport, AgentCard discovery)
  ├─ ERC-8004 trust metadata (registrations[], trustModels[])
  ├─ AP2 capability declaration (capabilities.extensions[])
  └─ x402 pricing per-entrypoint (payments manifest enrichment)
```

All three extensions converge on **`onManifestBuild(card, runtime) => card`** as the integration point.

---

## 5. Daydreams framework primitives — verbatim type signatures

These come from `@daydreamsai/core/src/types.ts` (verbatim).

### `action`

```typescript
export type ActionSchema = ZodRawShape | z.ZodObject | Schema<any> | undefined;

export interface Action<
  Schema extends ActionSchema = ActionSchema,
  Result = any,
  TError = unknown,
  TContext extends AnyContext = AnyContext,
  TAgent extends AnyAgent = AnyAgent,
  TState extends ActionState = ActionState
> {
  name: string;
  description?: string;
  instructions?: string;
  schema: Schema;
  attributes?: ActionSchema;
  actionState?: TState;

  install?: (agent: TAgent) => Promise<void> | void;
  enabled?: (ctx: ActionContext<TContext, InferAgentContext<TAgent>, TState>) => boolean;

  handler: ActionHandler<Schema, Result, TContext, TAgent, TState>;

  returns?: ActionSchema;
  format?: (result: ActionResult<Result>) => string | string[];
  context?: TContext;

  onSuccess?: (result, ctx, agent) => Promise<void> | void;
  retry?: boolean | number | ((failureCount: number, error: TError) => boolean);
  onError?: (err, ctx, agent) => MaybePromise<any>;
  queueKey?: string | ((ctx) => string);
  examples?: string[];
  parser?: (ref: ActionCall) => InferActionArguments<Schema>;
  callFormat?: "json" | "xml";
  templateResolver?: boolean | ((key, path, ctx) => MaybePromise<string>);
}
```

The handler signature flips depending on whether a schema is present:

```typescript
export type ActionHandler<...> = Schema extends undefined
  ? (ctx, agent) => MaybePromise<Result>
  : (args: InferActionArguments<Schema>, ctx, agent) => MaybePromise<Result>;
```

### `context`

```typescript
export interface Context<
  TMemory = any,
  Schema extends z.ZodTypeAny | ZodRawShape = z.ZodTypeAny,
  Ctx = any,
  Actions extends AnyAction[] = AnyAction[],
  Events extends Record<string, z.ZodTypeAny | ZodRawShape> = Record<string, z.ZodTypeAny | ZodRawShape>
> extends ContextConfigApi<TMemory, Schema, Ctx, Actions, Events> {
  type: string;
  schema?: Schema;
  key?: (args: InferSchemaArguments<Schema>) => string;
  setup?: (args, settings, agent: AnyAgent) => Promise<Ctx> | Ctx;
  create?: (params: { id, key?, args, options: Ctx, settings }, agent) => TMemory | Promise<TMemory>;
  instructions?: Resolver<Instruction, ContextState<this>>;
  description?: Resolver<string | string[], ContextState<this>>;
  load?: (id, params: { options, settings }) => Promise<TMemory | null>;
  save?: (state: ContextState<this>) => Promise<void>;
  render?: (state: ContextState<this>) => string | string[] | XMLElement | XMLElement[] | (string | XMLElement)[];
  model?: LanguageModel;
  modelSettings?: { temperature?, maxTokens?, topP?, topK?, stopSequences?, providerOptions? };
  onRun?:  (ctx, agent) => Promise<void>;
  onStep?: (ctx, agent) => Promise<void>;
  shouldContinue?: (ctx) => boolean;
  onError?: (error, ctx, agent) => Promise<void>;
  loader?: (state, agent) => Promise<void>;
  maxSteps?: number;
  maxWorkingMemorySize?: number;
  episodeHooks?: EpisodeHooks<this>;
  actions?: Resolver<Action[], ContextState<this>>;
  events?:  Resolver<Events, ContextState<this>>;
  inputs?:  Resolver<Record<string, InputConfig<any, any, AnyAgent>>, ContextState<this>>;
  outputs?: Resolver<Record<string, Omit<Output<any, any, AnyContext, any>, "name">>, ContextState<this>>;
  retrieval?: Resolver<RetrievalPolicy, ContextState<this>>;
  __composers?: BaseContextComposer<this>[];
  __templateResolvers?: Record<string, TemplateResolver<...>>;
}
```

The fluent API for composing contexts:

```typescript
interface ContextConfigApi<...> {
  setActions<TActions>(actions: TActions): Context<...>;
  setInputs<TSchemas>(inputs: ...): Context<...>;
  setOutputs<TSchemas>(outputs: ...): Context<...>;
  use<Refs extends AnyContext[]>(
    composer: ContextComposer<Context<...>, Refs>
  ): Context<...>;
}
```

`.use(state => [...refs])` takes a *function of state* returning child context refs — that's how they do conditional composition on premium tier.

### `extension`

```typescript
export type Extension<
  TContext extends AnyContext = AnyContext,
  Contexts extends Record<string, AnyContext> = Record<string, AnyContext>,
  Inputs extends Record<string, InputConfig<any, any>> = Record<string, InputConfig<any, any>>
> = Pick<
  Config<TContext>,
  "inputs" | "outputs" | "actions" | "services" | "events"
> & {
  name: string;
  install?: (agent: AnyAgent) => Promise<void> | void;
  contexts?: Contexts;
  inputs: Inputs;
};
```

So a Daydreams `Extension` is essentially a typed *bundle* of `inputs/outputs/actions/services/events/contexts` with a `name` and an `install` hook — fundamentally a different shape from a Lucid Agents `Extension`, which is build/onBuild/onEntrypointAdded/onManifestBuild lifecycle hooks. The two repos use the same word for different things; **don't confuse them**.

### `Agent` (key methods)

```typescript
export interface Agent<TContext extends AnyContext = AnyContext> extends AgentDef<TContext> {
  registry: Registry;
  prompt: PromptBuilder;
  response: ResponseAdapter;
  isBooted(): boolean;
  run: <TContext, SubContextRefs>(opts: {
    context, args, model?, modelSettings?, contexts?, outputs?, actions?,
    handlers?, abortSignal?, chain?, priority?
  }) => Promise<AnyRef[]>;
  send: <SContext, SubContextRefs>(opts: {
    context, args, input: { type: string; data: any },
    model?, contexts?, outputs?, actions?, handlers?, abortSignal?, chain?
  }) => Promise<AnyRef[]>;
  start(args?): Promise<this>;
  stop(): Promise<void>;
  getContext<TContext>(params: { context, args }): Promise<ContextState<TContext>>;
  saveContext(state, workingMemory?): Promise<boolean>;
  getWorkingMemory(contextId: string): Promise<WorkingMemory>;
  subscribeContext(contextId, handler: (log: AnyRef, done: boolean) => void): () => void;
}
```

`Log = InputRef | OutputRef | ThoughtRef | ActionCall | ActionResult | EventRef`. Each ref has `id, ref, timestamp, processed`. The whole loop is materialized as a stream of these refs. The agent has both **working memory** (the per-run log chain) and **context memory** (persistent, defined by `create()`).

---

## 6. Patterns worth lifting

### 6a. The "60-second bootstrap" CLI

Both repos have one. Daydreams: `npx create-daydreams-agent my-agent`. Lucid Agents:

```bash
bunx @lucid-agents/cli my-agent \
  --adapter=hono \
  --template=identity \
  --AGENT_NAME="My AI Agent" \
  --AGENT_DESCRIPTION="AI-powered assistant" \
  --PAYMENTS_RECEIVABLE_ADDRESS=0xYourAddress \
  --NETWORK=ethereum \
  --DEFAULT_PRICE=1000
```

Key takeaways for your harness CLI:
- **Adapter selector**: `hono` | `tanstack-ui` | `tanstack-headless` | `express` | `next` (the framework, not the language).
- **Template selector**: `blank` | `identity` | `trading-data-agent` | `trading-recommendation-agent` (use case archetypes; "merchant" vs "shopper").
- **Inline configuration via `--ENV_VAR=...`** flags that are written into `.env`. `--non-interactive` skips prompts.
- **`bun install`** is run automatically.
- Templates pre-wire `.use(http()).use(payments(...)).use(identity(...))` so a user gets a paid, registered agent on first `bun run dev`.

### 6b. Adapter pattern — same agent, multiple frameworks

The agent core is framework-free. Each adapter wraps it:

```typescript
// Hono
const { app, addEntrypoint } = await createAgentApp(agent);
export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };

// TanStack
export const { runtime: tanStackRuntime, handlers } = await createTanStackRuntime(agent);
```

**`agent` is built once with `.use(...)` extensions**, then handed to a thin adapter that mounts the entrypoints as routes. Recommend mirroring this in your harness — `createHarness({ ... })` then `mount(harness, hono)` or `mount(harness, express)`.

### 6c. Env conventions

Lucid Agents uses a flat `process.env` schema with prefixes per package — discovered from the source:

| Env var | Owner | Purpose |
|---|---|---|
| `AGENT_NAME`, `AGENT_DESCRIPTION`, `AGENT_DOMAIN` | core | Manifest |
| `PRIVATE_KEY` | wallet/x402 | Local-key signer |
| `AGENT_WALLET_PRIVATE_KEY`, `AGENT_WALLET_SECRET_KEY`, `AGENT_WALLET_CLIENT_ID` | wallet | thirdweb Engine |
| `PAYMENTS_RECEIVABLE_ADDRESS` | payments | Where money goes (auto-detects EVM vs Solana from format) |
| `NETWORK` | payments | `base` / `base-sepolia` / `ethereum` / `sepolia` (or Solana variants) |
| `DEFAULT_PRICE` | payments | Default in micro-USD (e.g. `1000` = $0.01) |
| `CHAIN_ID` | identity | Defaults to `84532` (Base Sepolia) |
| `RPC_URL` | identity | Required for ERC-8004 reads |
| `IDENTITY_REGISTRY_ADDRESS` | identity | Override default per-chain |

Each package ships a `*FromEnv()` helper: `walletsFromEnv()`, `paymentsFromEnv()`, `identityFromEnv()`. **The pattern is: deep config object in code OR shallow env. Always exit-codify through one helper.**

### 6d. Payments are HTTP middleware, not LLM tools

In **both** the daydreams x402 example and lucid-agents, payments do not appear as a tool the LLM can call. They are an **HTTP-layer gate** that runs before the LLM ever sees the request. The LLM doesn't decide to charge — the framework does, based on the entrypoint definition. The LLM also doesn't decide to *spend* in any of the served-up examples; the agent's outbound paid `fetch` is wrapped with `createX402Fetch(...)` and policy-enforced via `wrapBaseFetchWithPolicy(...)`. Spend decisions are bounded by **policy groups** (per-target, per-endpoint, per-time-window), not by the LLM directly.

> "Auto-detects EVM vs Solana from PAYMENTS_RECEIVABLE_ADDRESS format. Automatically tracks outgoing and incoming payments."

If you want the LLM to make spend decisions, the right shape is to expose a tool that wraps `wrapBaseFetchWithPolicy(createX402Fetch({ account }))` and let the policy engine enforce the limits transparently. The LLM gets a `fetch(url)` tool; the policy engine 402's or blocks it if the spend is over-budget.

### 6e. Immutable AgentCard composition

Every extension `onManifestBuild(card, runtime) => newCard` returns a fresh card. They're explicit about this:

> "Built using immutable composition pattern."

Lift this for your harness: define **one canonical AgentCard type** + a chain of `(card, ctx) => card` enrichers. Each capability adds to `capabilities.extensions[]` (AP2-style URI advertisement) or to top-level fields (`registrations[]`, `trustModels[]`).

### 6f. Storage-pluggable payment ledger

Three drivers in the box: `createInMemoryPaymentStorage`, `createSQLitePaymentStorage`, `createPostgresPaymentStorage`, all behind a `PaymentStorage` interface. Same trio for SIWx storage. Default to in-memory for dev, SQLite for single-node prod, Postgres for distributed. Worth replicating verbatim.

---

## 7. Opinions / decisions they document

Pulled directly from source comments and README:

1. **Default chain: Base Sepolia (84532)** — `chainId ?? 84532` in identity, `network ?? 'base-sepolia'` in payment examples. Base is treated as the canonical network.
2. **Default trust models: `['feedback', 'inference-validation']`** — they advertise reputation + inference validation by default.
3. **Validation Registry deferred** — explicit comment: *"Validation Registry is under active development and will be revised in a follow-up spec update later this year. It is excluded from default client creation."*
4. **OASF strict mode** — they refuse string-form OASF inputs: `if (typeof oasf === 'string') { throw new Error(OASF_STRICT_MODE_ERROR); }`. OASF must be structured.
5. **Default A2A version: `'0.3.0'`** — bound as `DEFAULT_A2A_VERSION` constant.
6. **Registration type URI hardcoded**: `'https://eips.ethereum.org/EIPS/eip-8004#registration-v1'`.
7. **Walletless mode is allowed**: if no wallet handle is found, `bootstrapIdentity` returns a "No ERC-8004 identity" status — *agent runs without onchain identity* rather than crashing.
8. **Wallet preference order**: `explicitWalletHandle → runtime.wallets.developer → runtime.wallets.agent`. The "developer" wallet is preferred for identity ops over the agent's own wallet — they treat identity registration as a developer/owner action, not an agent runtime action.
9. **Bun is the recommended runtime**, Node 20.9+ supported. `bun install`, `bun test`, `bun run build:packages`.
10. **CDP server wallets are NOT used in the documented examples** — they show **viem `privateKeyToAccount`** + **thirdweb Engine** as the two server-wallet options. Coinbase Developer Platform doesn't appear in the source. (You asked specifically; the answer is they don't take an opinion on CDP.)
11. **x402 packages chosen**: lucid-agents uses the modular **`@x402/fetch` + `@x402/evm`** (CAIP-2 chain IDs, pluggable schemes via `ExactEvmScheme`). The older daydreams example uses the monolithic **`x402-hono` / `x402-fetch`**. The modular split is the future direction.
12. **Facilitator URL in examples**: `https://facilitator.x402.rs` — they use the public x402.rs facilitator, not a self-hosted one.
13. **AP2 is advertisement-only** — they don't implement the AP2 wire format, just declare it in `capabilities.extensions[]`. The intent is *interoperability* with AP2-aware buyer agents, not implementing a full AP2 server.
14. **`siwx` as an alternative to x402** — the payments package treats SIWx (signed-message auth) as a peer concept to x402: `entrypointHasExplicitPrice(entrypoint) || entrypoint.siwx?.authOnly`. So you can have a paid-but-no-money entrypoint that just requires a wallet signature for access. This is a useful pattern: identity-gated free endpoints.

---

## TL;DR for the harness

If you take only three things from Lucid Agents:

1. **Three extension lifecycle hooks**: `build()` (eager additions), `onBuild(runtime)` (post-wire), `onManifestBuild(card)` (immutable rewrite of AgentCard). This is the integration spine.
2. **Payments live at HTTP, not LLM**. Wrap inbound with `paymentMiddleware`, wrap the LLM's outbound `fetch` with `createX402Fetch + wrapBaseFetchWithPolicy`. Don't expose "pay" as a tool unless you really mean it.
3. **AgentCard is the universal join key**. ERC-8004 stamps trust onto it. AP2 stamps a capability descriptor into `capabilities.extensions[]`. x402 stamps prices onto entrypoints. A2A consumes it as the discovery doc. Ship `.well-known/agent-card.json` first, layer everything else into it.

From Daydreams core, lift the **typed `Log` ref union** (`InputRef | OutputRef | ThoughtRef | ActionCall | ActionResult | EventRef | StepRef | RunRef`) — every step of the loop is a typed, persistable, replayable ref. This is what enables `subscribeContext(id, handler)` and the SSE streaming endpoints.

---

## Source files referenced (all absolute, fetched 2026-04-29)

- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/README.md`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/core/src/index.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/identity/src/index.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/identity/src/extension.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/identity/src/init.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/identity/src/manifest.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/payments/src/index.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/payments/src/extension.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/payments/src/x402.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/payments/src/env.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/ap2/src/extension.ts`
- `https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/packages/ap2/src/manifest.ts`
- `https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/core/src/types.ts`
- `https://raw.githubusercontent.com/daydreamsai/daydreams/main/examples/x402/nanoservice/server.ts`
- `https://raw.githubusercontent.com/daydreamsai/daydreams/main/examples/x402/nanoservice/client.ts`
- `https://docs.dreams.fun/docs/router/quickstart` (referenced in README; site itself didn't resolve from the fetch sandbox)

`https://github.com/daydreamsai/lucid-agents` — repo at `master` branch (the README points at `main` in places but actual default branch is `master`; this is why `raw.githubusercontent.com/.../main/...` returned 404 while `.../master/...` worked).
