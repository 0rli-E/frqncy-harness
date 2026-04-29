# s4mmy + Daydreams Router — research for the FRQNCY harness

Two parallel investigations: (1) what S4mmyEth — a public crypto/AI-agent commentator — is actually saying that's specific enough to encode into harness behaviour, and (2) the verbatim API surface of `router.daydreams.systems` so we can wire it as a new provider lane (`daydreams-router/*`) paid via x402.

Date: 2026-04-29.

---

## Task 1 — s4mmy / @S4mmyEth

### Who he is, briefly

S4mmy (handle `@S4mmyEth`, also `0xSammy`) is a crypto-Twitter analyst, host of *The Modern Market Show*, and works inside Mocaverse. He came out of fintech audit/advisory, got into BTC/LTC early, then NFTs in 2021, and has converged on "crypto x AI agents" as his beat since the late-2024 agent supercycle. The IQ.wiki bio frames it like this: he "experienced the inefficiencies of centralized systems and outdated technology, particularly in industries like insurance, [and] recognized blockchain as a solution to persistent issues in data reconciliation and system integration."

That auditor frame matters — it shapes a lot of what he says, which leans toward *measurable*, *settlement-grade* claims, not vibes.

### His thesis vs. what's in the water

Most crypto-AI commentary is one of two things: (a) agent-tokens-go-up cheerleading, or (b) protocol explainers that just rephrase ERC-8004 / x402 specs. S4mmy occupies a third lane that's actually contrarian against both:

1. **Mindshare without "smart engagement" is noise.** The mainstream metric is just attention volume. He explicitly separates raw mindshare from *Smart Interaction* — engagement coming from accounts with financial influence — and treats the latter as the real leading indicator. From his own framework write-ups: "Smart Interaction (interaction from accounts with financial influence) may be more indicative of market potential." His Cookie.fun dashboards expose three primary surfaces: 12h/24h/48h Momentum Scores, Weekly Market Cap and Smart Engagement Comparison, and a Market Cap and Mindshare Scatter Plot.

2. **The mindshare-to-marketcap delta is alpha, not alignment.** He repeatedly flags cases where mindshare and market cap are out of sync as the interesting signal — e.g. "0xzerebro leads in mindshare but has only half the market cap of GOAT, despite its mindshare being 2.8 times higher." This frames misalignment as opportunity, not a sign that the market is broken.

3. **Concentration of attention is real and tradeable.** His Dec-2024 thread quantified: "Half of all Crypto Twitter (CT) mindshare is on the AI segment. The top 10 AI Agent tokens constitute ~62% of this crypto AI attention; that's ~31% of the entirety of CT. It's no wonder the combined Market Cap of these 10 projects is $5.8bn." This is a market-map-as-tweet — he runs these on a recurring weekly cadence (*The Agentic Future: AI Agent Weekly Analysis*).

4. **Buy from the AI-native side, not the crypto-native side.** Curating @TaikiMaeda2 in his Jan-2025 thread: "In the AI Omegacycle, you should be buying tokens launched by AI devs, not crypto devs." He surfaces this approvingly. The implication for our harness: privilege agent stacks coming from teams with real ML/inference chops over teams that bolted "agent" on top of an existing token.

5. **Niche leadership and cash flows beat mindshare alone.** The Modern Market Show framing: "focus on agents with niche leadership or established cash flows to predict potential price appreciation, with factors like user engagement quality, existing holder conviction, and endorsement provenance influencing valuations." Read: *real revenue per agent and verifiable provenance of who's endorsing you* — both directly addressable by ERC-8004's reputation registry and x402's per-request settlement.

6. **The ARC/Ryzome thread is his clearest "what builders should do" artifact.** From the verbatim thread (`x.com/S4mmyEth/status/1898123615763415182`): "The ARC Litepaper was just published 30 minutes ago and the $ARC token is up 5% already. It looks like a new App Store (Ryzome) will be created for both web2 & web3 users. Here's the key takeaways: 1) The Problem: AI agents are gaining autonomy to plan and execute real-world…" — and the unpacking continues:

   - **Problem framing:** "AI agents are gaining autonomy to plan and execute real-world tasks" but "struggle with service integration and payments." He treats *service integration + payments* as the bottleneck, not model capability. This matches our harness thesis (model is commodity; rails are not).
   - **Stack he highlights:** Rig (Rust framework for high-performance agents), Playgrounds (commercial incubation engine), and the Arc Token. He's praising the *layered* approach — runtime / commercial layer / settlement token — not a monolith.
   - **The interop bet:** "a universal marketplace using Anthropic's MCP to connect agents with Web2/Web3 services, enabling end-to-end tasks with persistent context and human approval for sensitive actions." Note the specific human-in-the-loop carve-out — he calls it out, not glosses it.
   - **Economic split he flagged:** "Arc token transactions split among 85% to providers, 10% to Arc, and 5% to operations." That 85/10/5 figure is concrete enough to be a reference point when designing the harness's own revenue-share model.

7. **Bankless calls his account a top-tier source for AI-agent alpha** (in their roundup of "top X accounts to follow for AI agent updates"), specifically because he ships *daily AI agent analysis and Twitter Spaces content surrounding key developments in the AI agents space.* Cadence is part of the value — daily, not episodic.

8. **DeFi-as-substrate-for-autonomy, not DeFi-with-bots-bolted-on.** Per the IQ.wiki summary of his recent posts: "He noted Binance's report, emphasizing the significant potential for AI and crypto integration, particularly in using decentralized finance (DeFi) to enable autonomous AI agents." He treats DeFi rails as the *substrate that makes agent autonomy economically real* — not as a separate vertical that agents happen to touch.

### Actionable takeaways for the harness

Distilled, with the verbatim quote each leans on:

- **(a) Track Smart-Engagement, not raw mindshare, when scoring agent counterparties.** > "Smart Interaction (interaction from accounts with financial influence) may be more indicative of market potential." → For ERC-8004 reputation lookups, weight signals by the *financial* influence of the attesting agent identity, not by raw count of attestations.

- **(b) Mindshare-to-marketcap divergence is the trade.** > "0xzerebro leads in mindshare but has only half the market cap of GOAT, despite its mindshare being 2.8 times higher." → If we ever ship an agent-discovery surface, surface *delta* between attention and capitalization, not absolute attention.

- **(c) Service integration + payments is the bottleneck — not model quality.** > "AI agents are gaining autonomy to plan and execute real-world tasks" but "struggle with service integration and payments." → x402 + ERC-8004 wiring is the differentiator; the harness should *not* over-invest in marginal model selection logic at the expense of payment-rail breadth.

- **(d) Encode human approval for sensitive actions explicitly.** > "enabling end-to-end tasks with persistent context and human approval for sensitive actions." → The harness should classify actions by sensitivity (e.g. spend over $X, on-chain write to non-allowlisted contract) and route through a human-in-the-loop hook, not assume all agent calls are fire-and-forget.

- **(e) Privilege AI-native counterparty stacks.** > "In the AI Omegacycle, you should be buying tokens launched by AI devs, not crypto devs." → When bridging to Daydreams or any other framework, prefer wiring to teams with real inference/ML provenance over teams whose agent layer is a marketing skin.

- **(f) Provenance of endorsement matters.** > "user engagement quality, existing holder conviction, and endorsement provenance influencing valuations." → ERC-8004 attestation graph queries should expose *who* attested, not just *that* an attestation exists. Build the reputation lookup around endorser identity.

- **(g) 85/10/5 is a reference revenue split.** > "Arc token transactions split among 85% to providers, 10% to Arc, and 5% to operations." → Use this as a pricing landmark when designing harness fee logic — providers (i.e. inference providers, tool sellers, agent counterparties) should net the dominant share.

- **(h) Cadence is part of the alpha.** > "S4mmyEth puts out daily AI agent analysis and Twitter Spaces content." → If we expose any reporting surface (e.g. harness usage telemetry), default to a daily cadence — not weekly digests — for the audience that lives in this market.

### Project lists / market maps he maintains

- *AI Agent Mindshare vs Market Cap* — recurring (multiple snapshots: `1869696761507287280`, `1876493604895461662`, `1909176946514162055`, `1912800829825859785`).
- *The Agentic Future: AI Agent Weekly Analysis* — cadenced, e.g. `1896992355841921291`.
- Cookie.fun dashboards (Momentum Scores 12h/24h/48h, Smart Engagement Comparison, Mindshare scatter plot).
- *The Modern Market Show* podcast (Apple Podcasts id `1735389207`, Spotify show `09xq94M5Y3id7l9MLiPJGE`), co-hosted with Legendary and BCheque.

---

## Task 2 — Daydreams Router (`router.daydreams.systems`)

The router landing page at `https://router.daydreams.systems/` is explicit: *"x402 router - pay-per-inference proxy for agents. OpenAI-compatible. x402 payments. < 5ms overhead."* The "one curl to onboard your agent" is real and points at a SKILL.md, which is itself the canonical machine-readable spec.

### Base URL, endpoints, auth — verbatim from `https://ai.xgate.run/SKILL.md`

> **Base URL** — `https://ai.xgate.run`
>
> **Authentication** — Use x402 permit auth: `PAYMENT-SIGNATURE: <base64 permit payload>`

So the canonical hostname for requests is **`ai.xgate.run`**, *not* `router.daydreams.systems` (which is the marketing/catalog UI). The harness should treat `ai.xgate.run` as the OpenAI-compatible base URL and `router.daydreams.systems` as a discovery surface only.

Endpoints, verbatim:

```
GET  /v1/config
POST /v1/estimate
GET  /v1/errors
GET  /v1/models
POST /v1/chat/completions
POST /v1/messages
POST /v1/responses
POST /v1/images/generations
POST /v1/embeddings
POST /v1/audio/transcriptions
POST /v1/audio/speech
POST /v1/video/generations
```

Note: alongside OpenAI-style `/v1/chat/completions` they support Anthropic-style `/v1/messages` and OpenAI Responses API `/v1/responses`. So the harness can plug *either* an OpenAI SDK or an Anthropic SDK at the same base URL.

OpenAPI / interactive docs: `https://ai.xgate.run/openapi.json` and `https://ai.xgate.run/docs`. Catalog UI: `https://router.daydreams.systems/catalog`.

### The "one curl" example, verbatim

```bash
curl -X POST https://ai.xgate.run/v1/chat/completions \
  -H "PAYMENT-SIGNATURE: $PERMIT" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic:claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

### Model naming convention

Verbatim: *"Use `provider:model` for explicit routing"*, with examples:

```
openai:gpt-4
anthropic:claude-sonnet-4-20250514
fal:flux-schnell
bedrock:anthropic.claude-3-sonnet-20240229-v1:0
vertex:gemini-1.5-pro
```

If the request `model` is `auto` (or another configured auto alias) and no explicit provider is set, the router runs *smart routing*. If you send `openai:gpt-4.1`, smart routing is bypassed.

The live `/v1/models` response confirms providers in production today include `anthropic`, `openai`, `openrouter`, `moonshot`, `fal` — covering Claude Opus 4.5/4.6, Sonnet 4.6, GPT-5/5-mini/5-nano/5-pro/5.2-codex/5.3-codex, Kimi K2.5, Flux 2 Pro/Flex, and Kling video. Pricing lives on each model object as `pricing.input_per_1m`, `pricing.output_per_1m`, plus `cache_read_per_1m` / `cache_write_per_1m` where supported.

### Pricing model — per-token, charged per-request, settled async

The pricing is **per-token** (input and output tokens per million), exposed per-model in `/v1/models`. The *payment* is per-permit-session, not per-request. From `https://router.daydreams.systems/how-it-works`, verbatim flow:

```
01 Client signs an ERC-2612 permit with a spend cap and expiry.
02 Request includes PAYMENT-SIGNATURE with the permit payload.
03 The router verifies the permit and opens or joins an upto session.
04 The request is forwarded to the selected provider and streams back.
05 Cost tracking happens asynchronously and the facilitator settles
   on cap or idle timeout.
```

Their term for the multi-request session is *"upto"* — bundles spend caps with signatures so multiple requests accumulate under one session without blocking streaming responses. Headers involved: `PAYMENT-SIGNATURE` (required), `X-Upto-Session` (server-assigned session id), and on responses: `X-Router-Routed`, `X-Router-Selected-Model`, `X-Router-Tier`, `X-Router-Reason-Codes`.

### Auth/payment mode: x402-only

The SKILL.md explicitly describes the x402 permit-retry handshake and does **not** mention an API-key alternative for paid endpoints. The flow:

```
1. Send request without payment headers to a paid endpoint.
2. Receive 402 Payment Required and a PAYMENT-REQUIRED response header.
3. Parse permit parameters from PAYMENT-REQUIRED (network, asset, max amount).
4. Sign an ERC-2612 permit for USDC on Base with enough allowance.
5. Retry with PAYMENT-SIGNATURE header.
6. Router serves response immediately and settles spend asynchronously.
```

Network: USDC on Base, ERC-2612 permits. So for the harness this is a hybrid that we should treat as *x402-native* — there's no API-key-only lane. (Marketing copy from third-party coverage describes "dual authentication options (API keys or x402)" — that may apply to V1 or non-paid endpoints; the SKILL.md, which is the live machine spec, is x402-only and that's what the harness should target.)

### Smart routing details (only when `model: auto`)

Verbatim from the how-it-works page:

- Classifier version `rules-v1`. Collects text from messages + prompt/input/instructions. Estimated tokens ≈ characters / 4.
- Tiers: `SIMPLE`, `MEDIUM`, `COMPLEX`, `REASONING`.
- Token thresholds: MEDIUM above 220, COMPLEX above 700.
- Reasoning tier activates with multiple reasoning markers.
- Agentic guardrail: tool calls (`tools`) mark requests as agentic; agentic text can also be detected from action keywords; agentic requests are forced *up to at least COMPLEX* by default. Ambiguous prompts default to COMPLEX. Non-chat endpoints start from COMPLEX before tier enforcement.

The selected tier maps to configured models (simple/medium/complex/reasoning). The chosen model must exist in the catalog or the router *fails fast with a routing error*. For routed JSON responses, a `routing` object is also injected into the body.

### Data handling

> "The router does not store prompts or responses. Requests are passed through to the provider you select, and that provider may keep data according to its own retention policies. Router logs and metrics are operational only and exclude user payloads."

Material for our privacy posture and any compliance copy.

---

### Daydreams framework primitives — verbatim from `@daydreamsai/core`

Source: `https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/core/README.md` and `packages/core/src/types.ts`.

Self-description: *"The core framework for building stateful AI agents with type-safe contexts, persistent memory, and extensible actions."*

Public package list (`packages/`): `chroma`, `cli`, `core`, `create-agent`, `defai`, `discord`, `firebase`, `hyperliquid`, `mcp`, `mongo`, `supabase`, `telegram`, `twitter`. **No `genai` directory in the monorepo** — `@daydreamsai/genai` is published independently as a vision/GenAI extension (`analyzeImage` action, separate from `core`).

#### `createDreams` (the agent constructor)

Quick-start usage, verbatim:

```typescript
import { createDreams, context, action } from "@daydreamsai/core";
import { openai } from "@ai-sdk/openai";
import * as z from "zod";

const agent = createDreams({
  model: openai("gpt-4"),
  contexts: [chatContext],
  actions: [searchAction],
});

await agent.start();

const response = await agent.send({
  context: chatContext,
  args: { userId: "user123" },
  input: { type: "text", data: "Search for AI news" },
});
```

The `Config<TContext>` type (from `types.ts`):

```typescript
export type Config<TContext extends AnyContext = AnyContext> = Partial<
  AgentDef<TContext>
> & {
  model?: Agent["model"];
  modelSettings?: { temperature?, maxTokens?, topP?, topK?, stopSequences?, providerOptions?, [key: string]: any };
  logLevel?: LogLevel;
  contexts?: AnyContext[];
  services?: ServiceProvider[];
  extensions?: Extension<TContext>[];
  exportTrainingData?: boolean;
  trainingDataPath?: string;
  streaming?: boolean;
  tasks?: TaskConfiguration;
  prompt?: PromptBuilder;
  response?: ResponseAdapter;
};
```

The `Agent` interface exposes `run`, `send`, `start`, `stop`, `getContext`, `getContextId`, `loadContext`, `saveContext`, `getContextById`, `getWorkingMemory`, `deleteContext`, `subscribeContext`, `__subscribeChunk`, plus `registry`, `prompt`, `response`, `exports`. `model` is typed as `LanguageModel` from `ai` (i.e. AI SDK), so any AI SDK provider works — including a custom OpenAI-compatible one pointed at `https://ai.xgate.run/v1`.

#### `context` (stateful environment)

```typescript
const chatContext = context({
  type: "chat",
  schema: z.object({ userId: z.string() }),
});
```

Full `Context<TMemory, Schema, Ctx, Actions, Events>` interface highlights:

- `type: string` — unique type id
- `schema?: Schema` — zod schema for args
- `key?: (args) => string` — unique key derivation
- `setup?`, `create?`, `load?`, `save?`, `render?` — lifecycle
- `instructions?`, `description?` — resolvers (static or `(ctx) => value`)
- `model?`, `modelSettings?` — *per-context* model override
- `onRun?`, `onStep?`, `shouldContinue?`, `onError?`, `loader?`
- `maxSteps?`, `maxWorkingMemorySize?`
- `episodeHooks?: EpisodeHooks<this>`
- `actions?`, `events?`, `inputs?`, `outputs?` — all `Resolver<T, ContextState<this>>`
- `retrieval?: Resolver<RetrievalPolicy, ContextState<this>>` — with `topK`, `minScore`, `groupBy`, `dedupeBy`, `weighting: { salience?, recencyHalfLifeMs? }`, `scope: 'context' | 'global' | 'all'`, `namespaces?: string[]`
- Composition: `setActions(actions)`, `setInputs(inputs)`, `setOutputs(outputs)`, `use(composer)` — all return a *new* typed context.

#### `action` (typed, validated function)

```typescript
const searchAction = action({
  name: "search",
  description: "Search the web",
  schema: z.object({ query: z.string() }),
  handler: async ({ call }) => {
    return { results: ["result1", "result2"] };
  },
});
```

The `Action<Schema, Result, TError, TContext, TAgent, TState>` interface has: `name`, `description?`, `instructions?`, `schema`, `attributes?`, `actionState?`, `install?`, `enabled?(ctx)`, `handler`, `returns?`, `format?`, `context?`, `onSuccess?`, `retry? boolean | number | ((failureCount, error) => boolean)`, `onError?`, `queueKey? string | ((ctx) => string)`, `examples?`, `parser?`, `callFormat?: "json" | "xml"`, `templateResolver?`. The `ActionHandler` type splits cleanly between schema-less (`(ctx, agent) => ...`) and schema-having (`(args, ctx, agent) => ...`).

#### `extension` (plugin)

```typescript
const extension = createExtension({
  name: "weather",
  actions: [getWeatherAction],
  contexts: [weatherContext],
});
```

Extension type:

```typescript
export type Extension<TContext, Contexts, Inputs> = Pick<
  Config<TContext>,
  "inputs" | "outputs" | "actions" | "services" | "events"
> & {
  name: string;
  install?: (agent: AnyAgent) => Promise<void> | void;
  contexts?: Contexts;
  inputs: Inputs;
};
```

#### `createMcpExtension` (from `@daydreamsai/mcp`)

Verbatim from the MCP package README:

```typescript
import { createDreams } from "@daydreamsai/core";
import { createMcpExtension } from "@daydreamsai/mcp";

const agent = createDreams({
  extensions: [
    createMcpExtension([
      {
        id: "sqlite-explorer",
        name: "SQLite Explorer",
        transport: { type: "stdio", command: "node", args: ["path/to/server.js"] },
      },
      {
        id: "web-search",
        name: "Web Search Service",
        transport: { type: "sse", serverUrl: "http://localhost:3001" },
      },
    ]),
  ],
});
```

The extension adds these actions to the agent: `mcp.listServers`, `mcp.listPrompts`, `mcp.getPrompt`, `mcp.listResources`, `mcp.readResource`, `mcp.callTool`. Transports supported: `stdio` (local subprocess) and `sse` (Server-Sent Events; `serverUrl` plus optional `sseEndpoint` defaulting to `/sse` and `messageEndpoint` defaulting to `/messages`). All actions return `{ result, error? }` shape.

#### `@daydreamsai/genai`

Per the npm listing: a "DaydreamsAI SDK extension with general-purpose Generative AI (GenAI) capabilities and actions that can be easily added to any Daydream agent. The primary goal of this package is to encapsulate reusable AI functionalities, making them independent of specific communication channels (like Discord, Telegram, Web UI, etc.)." Currently exposes an `analyzeImage` action — text + image attachments → textual response. It is **a wrapper / extension layer**, not a separate inference layer; it sits next to `@daydreamsai/core`, not under it. For our harness, this means *the actual inference plug point is `model:` on `createDreams` (an AI SDK `LanguageModel`)* — we don't go through `@daydreamsai/genai` to swap providers.

---

## What we should actually wire into the harness

Synthesising both threads:

1. **New provider lane: `daydreams-router/*`.** Concretely, a model string like `daydreams-router/anthropic:claude-sonnet-4-6` resolves to:
   - base URL `https://ai.xgate.run`
   - endpoint `/v1/chat/completions` (or `/v1/messages` if the caller wants Anthropic shape)
   - auth header `PAYMENT-SIGNATURE: <base64 ERC-2612 permit on USDC/Base>`
   - body model id stripped to `anthropic:claude-sonnet-4-6` (drop the lane prefix).

2. **402-aware retry.** First request omits `PAYMENT-SIGNATURE`; on 402, parse `PAYMENT-REQUIRED`, sign the permit (cap + expiry), retry. Re-use the permit across requests within session — track `X-Upto-Session`. Settle async.

3. **OpenAI SDK pointing at the router.** Any OpenAI-compatible TS SDK works once you set `baseURL = "https://ai.xgate.run"` and inject the `PAYMENT-SIGNATURE` header. The harness already supports custom base URLs per provider, so this is mostly a header injector + permit signer.

4. **Daydreams bridge package.** Expose a `createDreamsAdapter(harness)` that returns:
   - a `LanguageModel` (AI SDK shape) backed by the harness so any `createDreams({ model: harnessModel(...) })` works,
   - a passthrough `createMcpExtension`-compatible config so harness MCP servers light up inside Daydreams,
   - shared memory/context glue so Daydreams `context.create/load/save` can use harness storage.

5. **Encode the s4mmy heuristics where they fit.** Reputation lookups should weight *who* attests (point f). Action sensitivity classification + human-in-the-loop hook (point d). Surface attention-vs-cap delta in any agent-discovery UI (point b). Default fee-share when we resell anything: 85/10/5 (point g).

---

## Sources

- [s4mmy — ARC Litepaper takeaways thread](https://x.com/S4mmyEth/status/1898123615763415182)
- [s4mmy — AI Agent Market Analysis: Mindshare (April 2025)](https://x.com/S4mmyEth/status/1912800829825859785)
- [s4mmy — Mindshare vs Market Cap Jan 7 2025 thread](https://x.com/S4mmyEth/status/1876493604895461662)
- [s4mmy — CT mindshare AI segment thread](https://x.com/S4mmyEth/status/1869696761507287280)
- [s4mmy — AI Agent Market Analysis (April 7 2025)](https://x.com/S4mmyEth/status/1909176946514162055)
- [s4mmy — The Agentic Future weekly analysis 3.4.25](https://x.com/S4mmyEth/status/1896992355841921291)
- [S4mmy bio — IQ.wiki](https://iq.wiki/wiki/s4mmyeth)
- [The Modern Market Show — Apple Podcasts](https://podcasts.apple.com/us/podcast/the-modern-market-show/id1735389207)
- [The Modern Market Show — Spotify](https://open.spotify.com/show/09xq94M5Y3id7l9MLiPJGE)
- [Why AI Agents Are Crypto's Biggest Opportunity w/ s4mmy — chaindesk transcript](https://www.chaindesk.ai/tools/youtube-summarizer/why-ai-agents-are-crypto-s-biggest-opportunity-w-s4mmy-fBF4O-NbzNo)
- [Top X Accounts for Crypto AI Agent Alpha — Bankless](https://www.bankless.com/read/top-x-accounts-to-follow-for-ai-agent-updates)
- [Daydreams Router landing](https://router.daydreams.systems/)
- [Daydreams Router — How it works](https://router.daydreams.systems/how-it-works)
- [Daydreams Router — Catalog](https://router.daydreams.systems/catalog)
- [Daydreams Router SKILL.md (machine spec)](https://ai.xgate.run/SKILL.md)
- [Daydreams Router — live model catalog JSON](https://ai.xgate.run/v1/models)
- [Daydreams Router — interactive docs](https://ai.xgate.run/docs)
- [Daydreams Router — OpenAPI](https://ai.xgate.run/openapi.json)
- [@daydreamsai/core — npm](https://www.npmjs.com/package/@daydreamsai/core)
- [@daydreamsai/core README — raw GitHub](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/core/README.md)
- [@daydreamsai/core src/types.ts](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/core/src/types.ts)
- [@daydreamsai/mcp README — createMcpExtension](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/mcp/README.md)
- [@daydreamsai/genai — npm](https://www.npmjs.com/package/@daydreamsai/genai)
- [Daydreams monorepo packages directory](https://github.com/daydreamsai/daydreams/tree/main/packages)
- [Daydreams Lucid Agents Commerce SDK](https://github.com/daydreamsai/lucid-agents)
- [Daydreams.Systems X account — V2 router announcement](https://x.com/daydreamsagents/status/2019202022776664395)
- [Daydreams Facilitator (Solana + Base) announcement](https://x.com/daydreamsagents/status/1975518552477270453)
- [Not a Lucid Web3 Dream Anymore: x402, ERC-8004, A2A, and The Next Wave of AI Commerce — HackerNoon](https://hackernoon.com/not-a-lucid-web3-dream-anymore-x402-erc-8004-a2a-and-the-next-wave-of-ai-commerce)
