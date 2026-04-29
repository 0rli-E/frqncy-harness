# Daydreams Skill / Extension Catalog

A flat reference of every public Daydreams extension across the
[`daydreamsai/daydreams`](https://github.com/daydreamsai/daydreams) monorepo,
the [`@daydreamsai`](https://www.npmjs.com/org/daydreamsai) npm org, and the
sister
[`daydreamsai/lucid-agents`](https://github.com/daydreamsai/lucid-agents)
commerce SDK. Sources are cited inline; "automated wallet" / DeFi-relevant
extensions are tagged at the start of each section.

## Source inventory

- npm org `@daydreamsai` write-access list (full list of published packages):
  `core, create-agent, chromadb, defai, discord, twitter, hyperliquid,
telegram, mongodb, cli, mcp, supabase, genai, firebase, ai-sdk-provider,
synthetic, deploy, facilitator, saw` — from
  `https://registry.npmjs.org/-/org/daydreamsai/package`.
- `packages/` directories actually shipped on `main` of `daydreamsai/daydreams`
  (per GitHub contents API):
  `chroma, cli, core, create-agent, defai, discord, firebase, hyperliquid, mcp,
mongo, supabase, telegram, twitter` — i.e. the "v0.3" runtime extensions
  ([repo tree](https://github.com/daydreamsai/daydreams/tree/main/packages)).
- Lucid Agents (separate repo; the v2 commerce SDK) packages on `master`:
  `core, http, types, wallet, payments, analytics, identity, a2a, ap2, hono,
express, tanstack, cli, scheduler, api-sdk, catalog, examples, mpp,
eslint-config, prettier-config`
  ([lucid-agents tree](https://github.com/daydreamsai/lucid-agents/tree/master/packages)).
- The marketing site `daydreams.systems` and docs site `docs.dreams.fun` were
  unreachable from this network sandbox; their contents are referenced via
  community/Google snippets only where they confirm what is in the repo.

For an "automated wallet" use case the high-priority entries are: **defai,
hyperliquid, twitter, discord, telegram, mcp, genai, saw, facilitator,**
plus the lucid-agents **wallet, payments, identity, a2a, ap2** modules. Storage
extensions (chroma/firebase/mongo/supabase) and infra (deploy, synthetic, cli,
create-agent, ai-sdk-provider) are listed for completeness but are not
trading-surface skills.

---

## Trading / DeFi extensions

### `@daydreamsai/defai` — multi-chain DeFi connectors (HOT)

- **Purpose**: Implementations of the `IChain` interface from `@daydreamsai/core`
  for EVM, Solana, Sui, and Starknet. The package re-exports
  `./starknet, ./solana, ./evm, ./sui` from
  [`packages/defai/src/index.ts`](https://github.com/daydreamsai/daydreams/blob/main/packages/defai/src/index.ts)
  and depends on `ethers`, `@solana/web3.js`, `@mysten/sui`, `starknet`, and
  `@cetusprotocol/aggregator-sdk` (see
  [`package.json`](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/defai/package.json)).
- **Primary actions / capabilities** (per `IChain`): `read(call)`,
  `write(call)`, plus chain-specific helpers. `SuiChain` exposes `swapToken`
  using the Cetus aggregator across `KRIYAV3, CETUS, SCALLOP, KRIYA, BLUEFIN,
DEEPBOOKV3, FLOWXV3, BLUEMOVE, AFTERMATH, FLOWX, TURBOS`
  ([sui.ts](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/defai/src/sui.ts))
  plus `requestSui` for testnet faucet drips. `EvmChain` does generic
  `contract.functionName(...args)` reads/writes via an `ethers.Wallet` signer
  ([evm.ts](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/defai/src/evm.ts)).
  `SolanaChain` supports `getBalance`, `getAccountInfo`, `getBlockHeight` and
  `sendAndConfirmTransaction` of arbitrary instructions
  ([solana.ts](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/defai/src/solana.ts)).
  `StarknetChain` exposes RPC `callContract` and `account.execute` against an
  `Account`
  ([starknet.ts](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/defai/src/starknet.ts)).
- **Install snippet**: `pnpm add @daydreamsai/defai` (the package has no README
  in-repo; the npm name is `@daydreamsai/defai` per `package.json`).
- **System-prompt hints / example code**: The header docstrings provide the
  canonical usage:
  ```ts
  // EVM
  const evmChain = new EvmChain({
    chainName: "ethereum",
    rpcUrl: process.env.ETH_RPC_URL,
    privateKey: process.env.ETH_PRIVATE_KEY,
    chainId: 1,
  });
  // Sui
  const sui = new SuiChain({
    privateKey: process.env.SUI_PRIVATE_KEY,
    network: process.env.SUI_NETWORK,
  });
  // Starknet
  const starknet = new StarknetChain({
    rpcUrl: process.env.STARKNET_RPC_URL,
    address: process.env.STARKNET_ADDRESS,
    privateKey: process.env.STARKNET_PRIVATE_KEY,
  });
  ```
- **Required env vars / external accounts**: `ETH_RPC_URL`,
  `ETH_PRIVATE_KEY` (and chainId), `SUI_PRIVATE_KEY` (raw or `suiprivkey…`
  prefix) plus `SUI_NETWORK` (`mainnet|testnet|devnet|localnet`),
  `STARKNET_RPC_URL`, `STARKNET_ADDRESS`, `STARKNET_PRIVATE_KEY`, and a base58
  Solana secret key. There is no env enforcement in the package itself; it is
  passed to the constructor by the caller.
- **Surface**: chain-only. Talks to **Ethereum L1 + EVM L2s**, **Solana**,
  **Sui** (with Cetus DEX aggregator), and **Starknet**. No external SaaS API.

### `@daydreamsai/hyperliquid` — Hyperliquid perps trading client (HOT)

- **Purpose**: Wraps the npm `hyperliquid` SDK so a Daydreams agent can place
  perp orders, manage positions, and read book data on Hyperliquid
  ([source](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/hyperliquid/src/hyperliquid.ts)).
- **Primary actions / capabilities** (methods on `HyperliquidClient`):
  `placeLimitOrderInstantOrCancel`, `placeLimitOrderGoodTilCancel`,
  `placeMarketOrder`, `placeMarketOrderUSD`, `marketSellPosition(s)`,
  `cancelOrder`, `getAccountBalancesAndPositions`, `getOpenOrders`. All
  endpoints use the `-PERP` suffix and the perps clearinghouse
  (`info.perpetuals.getClearinghouseState`).
- **Install snippet**: `pnpm add @daydreamsai/hyperliquid` (package name from
  `packages/hyperliquid/package.json`; no README ships in-repo).
- **System-prompt hints / example**: not provided as agent code, but the
  client is constructed as
  `new HyperliquidClient({ mainAddress, walletAddress, privateKey }, LogLevel.INFO, testnet)`
  and `enableWs: true`, so prompts should expose perp tickers (`BTC`, `ETH`, …)
  and have the agent reason over `assetPositions` returned by
  `getAccountBalancesAndPositions`.
- **Required env vars** (Zod-validated at import time):
  `HYPERLIQUID_MAIN_ADDRESS`, `HYPERLIQUID_WALLET_ADDRESS`,
  `HYPERLIQUID_PRIVATE_KEY`, `WEBSOCKET_URL` (default
  `ws://localhost:8080`), `DRY_RUN` (default `true`).
- **Surface**: external API (Hyperliquid REST + WS) **plus** chain-signed
  orders against Hyperliquid's L1 (Arbitrum-settled). Single-venue, perps only.

### Lucid `@lucid-agents/wallet` + `@daydreamsai/saw` — agent wallet plumbing (HOT)

- **Purpose**: Two complementary wallet primitives. `@lucid-agents/wallet`
  exposes `createAgentWallet` plus the `wallets()` extension for the lucid
  runtime, with both local and thirdweb Engine connectors
  ([lucid README](https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/README.md)).
  `@daydreamsai/saw` is a Node-only Unix-socket client for the "Secure Agent
  Wallet" daemon — it signs EVM/Solana payloads (incl. EIP-2612 permits)
  without exposing the private key
  ([saw npm metadata](https://registry.npmjs.org/@daydreamsai/saw)).
- **Primary actions**:
  - lucid wallet: `connector.getWalletClient()` returns a viem wallet client
    capable of `writeContract` (the README example transfers 0.01 USDC by
    calling `transfer` on the USDC ERC-20).
  - SAW: `getAddress()`, `signEvmTx(payload)`, `signSolTx(payload)`,
    `signEip2612Permit(payload)`.
- **Install snippets**:
  ```bash
  # lucid wallet (only inside a lucid agent)
  bun add @lucid-agents/wallet
  # SAW
  npm install @daydreamsai/saw
  ```
- **System-prompt hints / example**:
  ```ts
  import { createSawClient } from "@daydreamsai/saw";
  const saw = createSawClient();
  const sig = await saw.signEip2612Permit({
    chain_id: 1,
    token: "0x1111…",
    spender: "0x2222…",
    value: "1000000",
    nonce: "0",
    deadline: "9999999999",
    name: "USD Coin",
    version: "2",
  });
  ```
- **Required env / accounts**: `AGENT_WALLET_PRIVATE_KEY` for the local
  connector, or `AGENT_WALLET_SECRET_KEY` + `AGENT_WALLET_CLIENT_ID` (chainId,
  `walletLabel`) for thirdweb. SAW honours `SAW_SOCKET` (default
  `~/.saw/saw.sock`) and `SAW_WALLET` (default `main`); the SAW daemon must be
  running locally. SAW has an `allowlist_addresses` policy controlling which
  `token` and `spender` are signable
  ([saw README](https://registry.npmjs.org/@daydreamsai/saw)).
- **Surface**: chain (EVM, Solana). SAW is local IPC only — it does not
  itself broadcast. lucid wallet pairs with `@lucid-agents/payments` so the
  agent has both a payer and a signer.

### Lucid `@lucid-agents/payments` + `@daydreamsai/facilitator` — x402 commerce (HOT)

- **Purpose**: x402 (HTTP-native USDC payments) infrastructure for agents that
  must pay or charge other agents. `@lucid-agents/payments` is the agent-side
  utility with bi-directional tracking, payment policies, and SQLite/Postgres
  persistence; `@daydreamsai/facilitator` is the server-side facilitator that
  verifies and settles x402 payments on EVM (Base, Ethereum, Sepolia) and
  Solana (mainnet/devnet) USDC
  ([lucid README](https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/README.md),
  [facilitator npm metadata](https://registry.npmjs.org/@daydreamsai/facilitator)).
- **Primary actions / capabilities**: `payments({ config, storage })`
  extension with `paymentsFromEnv()`, `policyGroups` (per-payment limits,
  windowed totals, allow/block lists, blocked sender domains). Facilitator
  exposes `./server, ./elysia, ./hono, ./express, ./middleware, ./signers,
./signers/cdp, ./client, ./networks, ./auth` subpath exports — i.e. drop-in
  paywall middleware for major Node frameworks plus a Coinbase CDP signer.
- **Install snippets**:
  ```bash
  bun add @lucid-agents/payments
  npm install @daydreamsai/facilitator
  ```
- **System-prompt hints / example**:
  ```ts
  agent.use(
    payments({
      config: {
        ...paymentsFromEnv(),
        policyGroups: [
          {
            name: "Daily Limits",
            outgoingLimits: {
              global: { maxTotalUsd: 100, windowMs: 86400000 },
            },
            incomingLimits: {
              global: { maxTotalUsd: 5000, windowMs: 86400000 },
            },
            blockedSenders: { domains: ["https://untrusted.example.com"] },
          },
        ],
      },
      storage: { type: "sqlite" },
    })
  );
  ```
- **Required env / accounts**: `PAYMENTS_RECEIVABLE_ADDRESS` (network is
  auto-detected: EVM 0x… vs Solana base58), `NETWORK`, `DEFAULT_PRICE` (the
  CLI flags, mirrored to env), and a wallet private key via
  `@lucid-agents/wallet` for outbound payments. Facilitator has optional peer
  deps `@coinbase/cdp-sdk` and `@solana/kit` and supports x402 starknet via
  `x402-starknet`.
- **Surface**: external HTTP (x402 protocol) + on-chain settlement on EVM and
  Solana. Pairs with `@lucid-agents/identity` and `@lucid-agents/a2a` for
  agent-to-agent commerce.

### Lucid `@lucid-agents/identity, a2a, ap2` — onchain ID + A2A protocols (relevant)

- **Purpose**: ERC-8004 onchain identity (`identity`), the
  [Agent-to-Agent](https://a2a-protocol.org/) client (`a2a`) used to discover
  and `invoke()` other agents, and the AP2 (Agent Payments Protocol) extension
  for Agent Cards (`ap2`)
  ([lucid README](https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/README.md)).
- **Primary actions**:
  - identity: `createAgentIdentity({ runtime, domain, autoRegister })`,
    `identity({ config: identityFromEnv() })` extension. Auto-registers
    onchain if not present.
  - a2a: `agent.a2a.client.invoke(url, skillId, { input })`, `client.stream`,
    `client.sendMessage`, plus task status/cancellation and `contextId`
    grouping for multi-turn conversations.
  - ap2: `ap2({ roles: ['merchant'] })` advertises commerce roles in the
    AgentCard.
- **Install**: `bun add @lucid-agents/identity @lucid-agents/a2a
  @lucid-agents/ap2`.
- **System-prompt hints**: AgentCards live at
  `/.well-known/agent-card.json`; the runtime auto-publishes manifests with
  pricing, skills, Open Graph tags, and trust metadata. Prompts should let the
  model name a `skillId` and a target URL or AgentCard.
- **Required env / accounts**: an EVM wallet for ERC-8004 registration
  (re-uses the `@lucid-agents/wallet` config), plus a public domain for
  AgentCard discovery.
- **Surface**: onchain (Ethereum/EVM via ERC-8004) + HTTP/A2A.

---

## Communication / channel extensions

### `@daydreamsai/twitter` — automated X.com client (HOT for distribution)

- **Purpose**: "Enhanced Twitter Client" that gives an agent search, social
  interactions, DMs, analytics, and proactive post generation
  ([README](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/twitter/README.md)).
- **Primary actions / outputs**: `twitter:tweet` (with optional poll),
  `twitter:thread`, `twitter:like`, `twitter:retweet`, `twitter:quote`,
  `twitter:follow`, `twitter:search`, `twitter:analytics`,
  `twitter:auto-engage`, `twitter:generate-post` (proactive). Underlying
  `EnhancedTwitterClient` exposes `sendEnhancedTweet`, `sendThread`,
  `searchTweets`, `searchProfiles`, `likeTweet`, `retweet`, `quoteTweet`,
  `followUser`, `getFollowers`, `getFollowing`, `sendDirectMessage`,
  `autoEngage`, `getEngagementMetrics`, `bulkFollow`. Auto-monitors
  mentions every 30s and trending topics every 5 min.
- **Install snippet**:
  ```bash
  npm install @daydreamsai/twitter
  ```
- **System-prompt hints / example**:
  ```ts
  import { enhancedTwitter } from "@daydreamsai/twitter";
  const agent = createAgent({ extensions: [enhancedTwitter] });

  await agent.output("twitter:tweet", { content: "Hello Twitter!" });
  await agent.output("twitter:thread", {
    tweets: ["🧵 Thread (1/3)", "...", "Final thought"],
    delay: 5,
  });
  ```
  The README explicitly calls out "mood-based posting" with rotating
  `informative | engaging | humorous | professional | casual` tones, fed via a
  `<post-prompt trigger=… mood=… maxLength=280>` input every
  `TWITTER_POST_INTERVAL_MINUTES` (default 120).
- **Required env vars**: `TWITTER_USERNAME`, `TWITTER_PASSWORD`,
  `TWITTER_EMAIL`, `DRY_RUN`, `TWITTER_AUTO_ENGAGE`,
  `TWITTER_RATE_LIMIT_DELAY` (ms), `TWITTER_POST_INTERVAL_MINUTES`. Auth is
  via username/password (i.e. scraped/account-based, not the official API).
- **Surface**: external API (X.com). No chain.

### `@daydreamsai/discord` — Discord bot extension (HOT for ops loops)

- **Purpose**: Drops a Discord bot into the agent with a `discord.channel`
  context per channel
  ([source](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/discord/src/discord.ts)).
- **Primary actions**: input `discord:message` (subscribes to
  `Events.MessageCreate`, with optional pre-fetched image buffers when
  `PROCESS_ATTACHMENTS=true`), outputs `discord:message` and
  `discord:message-with-attachments`. `DiscordClient.sendMessage` /
  `sendMessageWithAttachments` are the underlying calls.
- **Install snippet**:
  ```bash
  npm install @daydreamsai/discord
  ```
- **System-prompt hints / example**: outputs use Daydreams' XML output
  convention, e.g.
  ```xml
  <output type="discord:message">Hi!</output>
  <output type="discord:message-with-attachments">
    {"content": "Here's the image!", "attachments": [{"url": "...", "filename": "result.jpg"}]}
  </output>
  ```
- **Required env vars** (Zod-validated): `DISCORD_TOKEN`, `DISCORD_BOT_NAME`,
  optional `PROCESS_ATTACHMENTS` (`"true"` to pre-download image buffers for
  multimodal handoff to `@daydreamsai/genai`).
- **Surface**: external API (Discord WebSocket via `discord.js`). No chain.

### `@daydreamsai/telegram` — Telegram bot extension (HOT for ops loops)

- **Purpose**: Telegraf-backed Telegram extension with a `telegram:chat`
  context per chat ID
  ([source](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/telegram/src/telegram.ts)).
- **Primary actions**: input `telegram:message` (subscribes to all `message`
  updates from Telegraf), output `telegram:message` (Markdown, auto-chunked
  to 4096-char limits). The context surfaces a private-chat-aware description:
  ```
  You are in private telegram chat with <username> id: <id>
  ```
- **Install snippet**:
  ```bash
  npm install @daydreamsai/telegram
  ```
- **System-prompt hints / example**:
  ```xml
  <output type="telegram:message" userId="123456789">
    Hello! How can I assist you today?
  </output>
  ```
  The schema description tells the LLM to author content in Markdown.
- **Required env vars**: `TELEGRAM_TOKEN` (used unguarded in
  `new Telegraf(process.env.TELEGRAM_TOKEN!)`).
- **Surface**: external API (Telegram Bot API).

### `@daydreamsai/genai` — multimodal AI actions (HOT, pairs with chat extensions)

- **Purpose**: "DaydreamsAI SDK extension with general-purpose Generative AI
  capabilities and actions that can be easily added to any Daydream agent",
  channel-agnostic
  ([npm metadata + README](https://registry.npmjs.org/@daydreamsai/genai)).
- **Primary actions**: `analyzeImage(text, attachments[])` and
  `analyzeVideo(text, attachments[])`. Each accepts `{ url, filename?,
contentType?, data?: Buffer }`. The action constructs a multimodal prompt
  for the agent's main configured LLM (e.g. Gemini via
  `@ai-sdk/google`) and uses `generateText`.
- **Install snippet**:
  ```bash
  npm install @daydreamsai/genai
  ```
- **System-prompt hints / example** (verbatim from the npm README):
  ```ts
  import { createDreams } from "@daydreamsai/core";
  import { genai } from "@daydreamsai/genai";
  import { createGoogleGenerativeAI } from "@ai-sdk/google";

  const agent = createDreams({
    model: createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })(
      "gemini-2.5-flash-preview-04-17"
    ),
    extensions: [genai],
  });
  ```
- **Required env / accounts**: depends on the LLM provider you wire into
  `createDreams.model` — typically `GEMINI_API_KEY` or `OPENAI_API_KEY`. No
  Daydreams-specific env vars.
- **Surface**: external API (LLM provider). No chain.

### `@daydreamsai/mcp` — Model Context Protocol bridge (HOT)

- **Purpose**: Connect a Daydreams agent to any number of MCP servers
  simultaneously and expose their resources, prompts, and tools as agent
  actions
  ([README](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/mcp/README.md)).
- **Primary actions**: `mcp.listServers`, `mcp.listPrompts`, `mcp.getPrompt`,
  `mcp.listResources`, `mcp.readResource`, `mcp.callTool`. Each takes a
  `serverId` matching the configured MCP server.
- **Install snippet**:
  ```ts
  import { createMcpExtension } from "@daydreamsai/mcp";
  // package install: npm install @daydreamsai/mcp
  ```
- **System-prompt hints / example**:
  ```ts
  createMcpExtension([
    {
      id: "sqlite-explorer",
      name: "SQLite Explorer",
      transport: { type: "stdio", command: "node", args: ["server.js"] },
    },
    {
      id: "web-search",
      name: "Web Search Service",
      transport: { type: "sse", serverUrl: "http://localhost:3001" },
    },
  ]);
  ```
  Both `stdio` and SSE transports are supported (with optional
  `sseEndpoint`/`messageEndpoint`).
- **Required env / accounts**: none for the bridge itself; whatever the
  underlying MCP servers need.
- **Surface**: external API (any MCP server) — this is the obvious extension
  point for plugging FRQNCY's wallet/MCP into the same agent that already has
  defai/hyperliquid.

---

## Storage / memory extensions (not trading-relevant)

### `@daydreamsai/chroma` — ChromaDB vector store

- Persistent vector storage; KV+graph stay in-memory
  ([README](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/chroma/README.md)).
- Install: `pnpm add @daydreamsai/chroma chromadb`. Configure with
  `createChromaMemory({ path: "http://localhost:8000", collectionName })`. Env:
  `OPENAI_API_KEY` (for OpenAI embeddings), `CHROMA_URL`, `CHROMA_COLLECTION`,
  `CHROMA_TOKEN`. External API only.

### `@daydreamsai/firebase` — Firestore KV

- Persistent KV via Firebase Admin
  ([README](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/firebase/README.md)).
  TTL, batch ops, `keys("user:*")` glob patterns. Install:
  `pnpm add @daydreamsai/firebase firebase-admin`. Env:
  `GOOGLE_APPLICATION_CREDENTIALS` or
  `FIREBASE_PROJECT_ID`+`FIREBASE_CLIENT_EMAIL`+`FIREBASE_PRIVATE_KEY`.
  External API only.

### `@daydreamsai/supabase` — full Postgres + pgvector backend

- Persistent KV, vector (pgvector), and graph (nodes/edges) — the only
  Daydreams memory adapter that persists all three tiers
  ([README](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/supabase/README.md)).
  Install: `npm install @daydreamsai/supabase`. Env: `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`. Requires `pgvector` and an `execute_sql` Postgres
  function. External API only.

### `@daydreamsai/mongo` — MongoDB KV

- KV-only; vector and graph stay in-memory; keys are SHA-256 hashed
  ([README](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/mongo/README.md)).
  Install: `npm install @daydreamsai/mongo`. Env: `MONGODB_URI`. External API
  only.

---

## Tooling / infra (not trading-relevant)

- **`@daydreamsai/core`** — the runtime (`createDreams`, `extension`,
  `service`, `context`, `input`, `output`, `IChain`). All extensions above
  list it as `workspace:*`/peer.
- **`@daydreamsai/cli`** — interactive REPL/CLI; published from
  [`packages/cli`](https://github.com/daydreamsai/daydreams/tree/main/packages/cli).
- **`@daydreamsai/create-agent`** — `npm create @daydreamsai/agent` scaffolder
  ([packages/create-agent](https://github.com/daydreamsai/daydreams/tree/main/packages/create-agent)).
- **`@daydreamsai/ai-sdk-provider`** — Vercel AI SDK provider for daydreams
  models (npm org listing).
- **`@daydreamsai/synthetic`** — captures agent reasoning into JSONL training
  sets (instruction tuning, conversation, reasoning chains, action sequences,
  episodes, GRPO preference data) with quality scoring and PII redaction
  ([npm metadata](https://registry.npmjs.org/@daydreamsai/synthetic)). Install:
  `npm install @daydreamsai/synthetic`. Adds actions `synthetic.process`,
  `synthetic.configure`, `synthetic.analyze`, `synthetic.exportAllEpisodes`.
  No env required.
- **`@daydreamsai/deploy`** — `daydreams-deploy` CLI that builds a Docker
  image and ships it to Google Cloud Run with a wildcard subdomain on
  `*.agent.daydreams.systems`
  ([npm metadata](https://registry.npmjs.org/@daydreamsai/deploy)). Requires
  `gcloud auth application-default login`, billing enabled, and the
  `run.googleapis.com cloudbuild.googleapis.com containerregistry.googleapis.com
dns.googleapis.com` APIs.
- **Lucid `@lucid-agents/{core,http,types,hono,express,tanstack,cli,scheduler,api-sdk,catalog,mpp}`**
  — the "v2" runtime/adapters for monetized agents. The lucid CLI scaffolds
  with templates `blank | identity | trading-data-agent |
trading-recommendation-agent`, the latter two being canonical "merchant"
  and "shopper" patterns
  ([lucid README](https://raw.githubusercontent.com/daydreamsai/lucid-agents/master/README.md)).
  Trading agents in this stack would compose `payments`, `wallet`, `identity`,
  `a2a`, `ap2`, plus an HTTP adapter (`hono`/`express`/`tanstack`/`next`) and
  optionally `@lucid-agents/scheduler` for long-running tasks.

---

## Quick "automated wallet" composition pattern

For an automated trading/wallet agent, the canonical Daydreams stack is:

1. `@daydreamsai/core` for `createDreams`.
2. `@daydreamsai/defai` (EVM/Sui/Solana/Starknet) and/or
   `@daydreamsai/hyperliquid` (perps) for trading actions.
3. `@daydreamsai/saw` to keep keys out of the model context, or
   `@lucid-agents/wallet` for a viem-style wallet client.
4. `@daydreamsai/twitter` + `@daydreamsai/discord` + `@daydreamsai/telegram`
   for human-in-the-loop confirmation and posting.
5. `@daydreamsai/mcp` to bring in any external skill (FRQNCY's MCP server,
   risk feeds, etc.).
6. `@daydreamsai/genai` for image/video understanding when the channel
   delivers attachments.
7. Memory: `@daydreamsai/supabase` if you want one persistent backend for KV +
   vector + graph; otherwise `@daydreamsai/chroma` (vectors) plus
   `@daydreamsai/firebase`/`@daydreamsai/mongo` (KV).
8. For paid services or cross-agent commerce, layer in
   `@lucid-agents/payments` + `@daydreamsai/facilitator` and ERC-8004
   identity from `@lucid-agents/identity`.

Per the Hyperliquid extension, **the agent will load env vars eagerly at
import time** — the lib calls `envSchema.parse(process.env)` at module scope
([source](https://raw.githubusercontent.com/daydreamsai/daydreams/main/packages/hyperliquid/src/hyperliquid.ts)),
so missing vars crash the agent boot rather than the action call. Keep that in
mind when packaging this for FRQNCY's harness.
