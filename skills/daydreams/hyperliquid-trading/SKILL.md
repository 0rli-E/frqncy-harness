---
name: hyperliquid-trading
description: Hyperliquid perpetual-futures trading — open / close positions, place market or limit orders, query account state, mid prices, funding rates, and historical fills. Use when the user mentions perps, hyperliquid, longing/shorting, leverage, or specific assets like BTC-PERP, ETH-PERP, SOL-PERP.
keywords: [hyperliquid, hl, perp, perpetual, perps, long, short, leverage, margin, liquidation, funding rate, mid price, order book, market order, limit order, btc-perp, eth-perp, sol-perp]
---

# Hyperliquid perp trading

Mirrors `@daydreamsai/hyperliquid`. Hyperliquid is a high-throughput perp
DEX on its own L1; the harness talks to it via the public REST + WebSocket
API. No chain bridging required.

## Setup (one-time)

The user needs:
- A Hyperliquid account (deposit USDC via the Arbitrum bridge UI)
- The account's API wallet private key — set as `HYPERLIQUID_PRIVATE_KEY`
  env var. This is a SEPARATE key from the deposit wallet; create it at
  app.hyperliquid.xyz/api.

Suggest:

```bash
frqncy-harness auth set hyperliquid-private-key
# Or env: export HYPERLIQUID_PRIVATE_KEY=0x...
```

Optional:
```bash
export HYPERLIQUID_API_URL=https://api.hyperliquid.xyz   # mainnet (default)
# or https://api.hyperliquid-testnet.xyz                 # testnet
```

## Reading state (no auth needed)

```bash
# Mid prices for all markets
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' \
  -d '{"type":"allMids"}' | jq

# Account state (fills, open positions, margin)
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"clearinghouseState\",\"user\":\"${USER_ADDRESS}\"}" | jq

# Funding rates
curl -s -X POST https://api.hyperliquid.xyz/info \
  -H 'Content-Type: application/json' \
  -d '{"type":"metaAndAssetCtxs"}' | jq
```

Use the bash tool for any of these — they're plain HTTP, no signing.

## Placing orders (signed)

Hyperliquid uses EIP-712 typed-data signed by the API wallet. The action
struct is `{type: "order", orders: [...], grouping: "na"}`. Sign over the
struct + a nonce (timestamp ms), POST to `/exchange`.

For a market buy of 0.01 BTC at any price (slippage handled via aggressive
price):

```js
// Sketch — fill in the typed-data per Hyperliquid's docs
const action = {
  type: "order",
  orders: [{
    a: 0,                    // asset index for BTC-PERP
    b: true,                 // is buy
    p: "999999",             // limit price (high = market behavior)
    s: "0.01",               // size in BTC
    r: false,                // reduce-only
    t: { limit: { tif: "Ioc" } },  // immediate-or-cancel
  }],
  grouping: "na",
};
const nonce = Date.now();
const signature = await signAction(action, nonce);  // EIP-712 sign with API key
const res = await fetch("https://api.hyperliquid.xyz/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, nonce, signature, vaultAddress: null }),
});
```

For limit orders, replace `tif: "Ioc"` with `"Gtc"` (good-till-cancelled)
and use the actual price.

## Asset index lookup

Hyperliquid uses numeric indices for perps, not tickers. Cache the
`metaAndAssetCtxs` response and look up by `name` to find `a`. ETH-PERP is
typically `1`, SOL-PERP `5`, but verify.

## Risk controls

Always:
- Show the user notional + leverage + margin impact before signing.
- Cap individual order size at a config-driven limit (suggest:
  `payments.budget.hardAbortUsd / 10` so you can survive 10 max-size
  losses).
- Require explicit user confirmation for orders that would push margin
  utilization above 50%.
- Surface unrealized PnL on every account-state read.

## What you should NOT do

- Don't open positions on the deposit wallet — always use the dedicated API
  wallet (lower blast radius if the key leaks).
- Don't run a market-maker loop autonomously without explicit user buy-in.
- Don't infer leverage from ambiguous prompts — confirm exact size.
- Don't claim a fill until you see the response's `status: "ok"` AND the
  `clearinghouseState` reflects the position.
