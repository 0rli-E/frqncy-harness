---
name: defi-sui-aggregator
description: Sui DEX aggregator swap — routes across Cetus, KRIYAV3, Bluefin, DeepBookV3, FlowX, Aftermath, Turbos, and 4 other venues to find best execution. The only built-in DEX swap action in the Daydreams `defai` package. Use when the user mentions Sui, swapping on Sui, $SUI, $WAL, $CETUS, or specific Sui tokens.
keywords: [sui, cetus, kriya, kriyav3, bluefin, deepbook, flowx, aftermath, turbos, sui swap, sui aggregator, $sui, $cetus, $wal]
---

# Sui DEX aggregator swap

Mirrors `@daydreamsai/defai/sui` — the most full-featured chain in the
defai package. Routes across 11 Sui DEX venues for best execution.

## Setup

The user needs:
- A Sui address with a private key (Sui's ed25519 keypair format).
- Set `SUI_PRIVATE_KEY` env var or store via `frqncy-harness auth set sui-private-key`.
- Optional: `SUI_RPC_URL` (defaults to fullnode.mainnet.sui.io).

## Use the @mysten/sui SDK

The harness doesn't bundle Sui-specific helpers. Drive it via bash + the
@mysten/sui SDK (the user installs it on demand):

```bash
npm install @mysten/sui   # one-time, into the agent's working directory
```

Then a swap is:

```js
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
const keypair = Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);
const sender = keypair.toSuiAddress();

// Use a routing aggregator (e.g. 7K, Aftermath, Cetus aggregator) — query
// their REST API for the optimal route, then build the transaction:
const route = await fetch("https://api-sui.cetus.zone/v2/sui/swap/route?...").then(r => r.json());

const tx = new Transaction();
// ... apply the route's moveCall sequence ...
const result = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
console.log(result.digest);
```

For the cleanest path, **Cetus's Aggregator API** is the canonical choice:
- Endpoint: `https://api-sui.cetus.zone/v2/sui/swap/route`
- Params: `from`, `target`, `amount`, `by_amount_in`
- Returns a route plus the moveCall sequence to execute it.

## Common token addresses on Sui mainnet

| Token | Coin Type |
|---|---|
| SUI (native) | `0x2::sui::SUI` |
| USDC (Wormhole) | `0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN` |
| USDC (native, native bridge) | `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` |
| WAL (Walrus) | `0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL` |
| CETUS | `0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS` |

## Risk controls

- Always set a slippage tolerance (default 1% for high-volatility pairs,
  0.3% for stables).
- Cache the route quote and compare it against a fresh quote at execution
  time — DEX prices on Sui can move within seconds.
- Show the user the expected output amount and venue routing BEFORE
  signing.

## What you should NOT do

- Don't bypass the aggregator and route directly through a single venue
  unless the user asks — single-venue routes often miss 5-30bps of edge.
- Don't recycle nonces — Sui's transaction model is gas-object-based, not
  nonce-based, so each tx needs a fresh gas-coin reference.
- Don't execute swaps over $1000 notional without explicit per-tx approval
  from the user.
