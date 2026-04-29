# `skills/daydreams/` — Daydreams skill bundle for the FRQNCY automated wallet

A drop-in bundle of skill packs that mirror the Daydreams extension catalog
(`@daydreamsai/discord`, `@daydreamsai/hyperliquid`, `@daydreamsai/defai`, etc.)
plus the Lucid Agents (`@lucid-agents/a2a`, `@lucid-agents/ap2`,
`@lucid-agents/synthetic`) surface, packaged as harness skills.

Each skill is a markdown pack with YAML frontmatter; the harness's
`loadSkills` + `matchSkills` auto-injects the relevant body into the system
prompt when the user's prompt matches the keywords. Skills don't *execute*
code — they orient the LLM toward the right harness tools (bash, web_fetch,
pay, MCP, daydreams-router) and the wallet primitives shipped in
`src/wallet/`, `src/identity/`, `src/payments/`, `src/serve/`, `src/bridges/`.

## Install

Copy or symlink everything in this folder into `~/.frqncy-harness/skills/`:

```bash
# Copy
cp -r skills/daydreams/*/  ~/.frqncy-harness/skills/

# OR symlink (so skill updates land via `git pull`)
for d in skills/daydreams/*/; do
  ln -snf "$(pwd)/$d" "$HOME/.frqncy-harness/skills/$(basename "$d")"
done
```

Or use the bundled CLI:

```bash
frqncy-harness skills install daydreams         # copies everything
frqncy-harness skills install daydreams --force # overwrites existing
```

Verify:

```bash
frqncy-harness skills list      # confirm the 19 daydreams skills appear
frqncy-harness skills match "swap usdc to weth on base"
# → should match defi-evm-actions
```

## What's in the bundle

| Skill | Purpose | Maps to |
|---|---|---|
| `frqncy-network-wallet` | Master skill, always-on for FRQNCY users — orients the LLM to the wallet + identity + payment surface | (FRQNCY) |
| `agent-commerce` | Register on ERC-8004, pay other agents via x402, monetize own skills | `@frqncy-network/harness/{identity,payments,serve}` |
| `defi-evm-actions` | Read balances, transfer ERC-20, swap on Uniswap/Aerodrome on Base + Ethereum | `@daydreamsai/defai` (EVM) |
| `defi-sui-aggregator` | DEX aggregator swaps across 11 venues on Sui (Cetus, Bluefin, etc.) | `@daydreamsai/defai` (Sui) |
| `defi-solana-actions` | SPL transfer + Jupiter swap on Solana | `@daydreamsai/defai` (Solana) |
| `defi-starknet-actions` | StarkNet read + write actions | `@daydreamsai/defai` (StarkNet) |
| `hyperliquid-trading` | Perp trading, market data, account state on Hyperliquid | `@daydreamsai/hyperliquid` |
| `twitter-post` | Post tweets, search, reply via scraped X client | `@daydreamsai/twitter` |
| `discord-post` | Post to Discord channels via bot token | `@daydreamsai/discord` |
| `telegram-post` | Post to Telegram chats via bot token | `@daydreamsai/telegram` |
| `genai-media` | Generate images / video via Daydreams Router (`fal:flux-2-pro`, `fal:kling-1.5`) | `@daydreamsai/genai` |
| `mcp-orchestration` | Connect, list, invoke tools on MCP servers | `@daydreamsai/mcp` |
| `vector-chroma` | Vector search via Chroma | `@daydreamsai/chroma` |
| `store-firebase` | Persist agent state in Firebase Firestore | `@daydreamsai/firebase` |
| `store-mongo` | Persist agent state in MongoDB | `@daydreamsai/mongo` |
| `store-supabase` | Persist agent state in Supabase Postgres | `@daydreamsai/supabase` |
| `lucid-a2a` | Agent-to-agent JSON-RPC skill invocation | `@lucid-agents/a2a` |
| `lucid-ap2` | Agent Payments Protocol — merchant/shopper/verifier roles | `@lucid-agents/ap2` |
| `synthetic-training` | Capture agent reasoning for training-data generation | `@daydreamsai/synthetic` |

## Philosophy

These skill packs are **opinionated prompts** that point the LLM at the
right tools. They are NOT TypeScript that imports `@daydreamsai/*` packages.
The bridge module (`src/bridges/daydreams.ts`) already lets you wrap a real
Daydreams `Action` as a `HarnessTool` and vice versa — these skills tell
the LLM how to compose the harness's existing primitives to achieve the
same outcomes without booting up a parallel Daydreams runtime.

For the cases where you actually want the Daydreams runtime (e.g. their
context+memory system, their agent-loop scheduler), pair these skills with
`createDaydreamsExtension({ tools, toolContext })` from
`@frqncy-network/harness/bridges` and pass the resulting `Extension` into
your `createDreams({ extensions: [...] })` call.

## Updating

Skills are versioned with the harness package. After `git pull`, re-run
`frqncy-harness skills install daydreams --force` (or rely on the symlink
approach above and skip the install).

## Aligned with FRQNCY

The master skill `frqncy-network-wallet` is `always: true` so it injects
on every prompt. It tells the LLM:

  - the user is on `frqncy.network`
  - they have a wallet (CDP smart account or viem private key)
  - the agent has an ERC-8004 identity
  - x402 paying is wired everywhere (fetch, MCP, daydreams-router)
  - the agent should prefer harness primitives over rolling its own

Drop your own customizations in `~/.frqncy-harness/skills/frqncy-network-custom/`
and they'll layer on top of these defaults.
