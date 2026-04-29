---
name: defi-solana-actions
description: Solana actions — read SOL/SPL balances, transfer SPL tokens, swap on Jupiter aggregator, stake on Marinade or Jito. Use when the user mentions Solana, $SOL, $USDC on Solana, Jupiter, Raydium, Orca, Marinade, Jito, or specific SPL tokens.
keywords: [solana, sol, spl, jupiter, raydium, orca, marinade, jito, $sol, $jup, $bonk, solana swap, jupiter swap]
---

# Solana actions

Mirrors `@daydreamsai/defai/solana`. Drive via `@solana/web3.js` and
Jupiter's quote+swap API.

## Setup

```bash
# Store the user's Solana private key (base58 or 64-byte array)
frqncy-harness auth set solana-private-key

# RPC — use a paid provider for production (Helius, Triton, QuickNode);
# the public mainnet RPC is heavily rate-limited.
export SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
```

## Reading

```js
import { Connection, PublicKey } from "@solana/web3.js";
const conn = new Connection(process.env.SOLANA_RPC_URL);
const owner = new PublicKey("...");

// SOL balance (lamports → SOL by /1e9)
const lamports = await conn.getBalance(owner);

// SPL token balances
const tokenAccounts = await conn.getParsedTokenAccountsByOwner(owner, {
  programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
});
```

## Swapping via Jupiter

Jupiter is the canonical Solana DEX aggregator. Two-step flow:

```js
// 1. Get a quote
const quote = await fetch(
  `https://quote-api.jup.ag/v6/quote?inputMint=${IN}&outputMint=${OUT}&amount=${LAMPORTS}&slippageBps=50`
).then(r => r.json());

// 2. Get a serialized transaction
const swap = await fetch("https://quote-api.jup.ag/v6/swap", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    quoteResponse: quote,
    userPublicKey: owner.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  }),
}).then(r => r.json());

// 3. Sign + send
import { VersionedTransaction } from "@solana/web3.js";
const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, "base64"));
tx.sign([keypair]);
const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
console.log(sig);
```

## Common SPL token mints

| Token | Mint |
|---|---|
| SOL (native, wrapped as `So11...112`) | `So11111111111111111111111111111111111111112` |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |

## Risk controls

- Always verify the destination is on the correct mint (not a fake "USDC"
  scam token).
- Set `slippageBps: 50` (0.5%) for major pairs; raise for low-liquidity.
- Use `getRecentPrioritizationFees` to set a competitive priority fee
  during high congestion — otherwise transactions can sit unconfirmed.
- Confirm the swap by polling `getSignatureStatuses` until `confirmationStatus = 'confirmed'`.

## What you should NOT do

- Don't use the public mainnet RPC for production — rate limits will fail
  signed transactions silently.
- Don't trust `swap.simulationError` — Jupiter quotes can succeed but the
  signed tx can still fail at execution.
- Don't sign multiple swaps without a delay — bundling without compute-
  unit-limit awareness will get them rejected.
