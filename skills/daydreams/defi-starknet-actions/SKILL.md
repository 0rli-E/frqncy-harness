---
name: defi-starknet-actions
description: StarkNet read + write actions — call view methods, invoke transactions on StarkNet contracts, check ETH/STRK/USDC balances on StarkNet. Use when the user mentions StarkNet, Cairo, $STRK, MyStarkID, or StarkNet-specific dapps like Ekubo / 10kSwap / JediSwap / mySwap.
keywords: [starknet, stark, cairo, strk, $strk, ekubo, 10kswap, jediswap, myswap, argent, braavos]
---

# StarkNet actions

Mirrors `@daydreamsai/defai/starknet`. Drive via `starknet.js`.

## Setup

```bash
# Store the user's StarkNet account address + private key
frqncy-harness auth set starknet-account
frqncy-harness auth set starknet-private-key

# RPC — use a provider that supports JSON-RPC (Alchemy, Infura,
# starknet.api.onfinality.io for free tier)
export STARKNET_RPC_URL=https://starknet-mainnet.public.blastapi.io
```

## Driving via starknet.js

```js
import { RpcProvider, Account, Contract, Call, cairo } from "starknet";

const provider = new RpcProvider({ nodeUrl: process.env.STARKNET_RPC_URL });
const account = new Account(provider, ACCOUNT_ADDR, PRIVATE_KEY);

// Read: ERC-20 balanceOf
const erc20 = new Contract(ERC20_ABI, USDC_ON_STARKNET, provider);
const balance = await erc20.balance_of(account.address);

// Write: transfer
const call: Call = {
  contractAddress: USDC_ON_STARKNET,
  entrypoint: "transfer",
  calldata: [RECIPIENT, cairo.uint256("1000000")], // 1 USDC (6 decimals)
};
const tx = await account.execute(call);
console.log(tx.transaction_hash);
await provider.waitForTransaction(tx.transaction_hash);
```

## Common token addresses on StarkNet mainnet

| Token | Address |
|---|---|
| ETH | `0x049D36570D4E46f48E99674bd3FCC8463D6C4DEc06EE83c8b8E66cd4e8d4D9D6` (canonical wrapper) |
| STRK | `0x04718f5A0Fc34cC1AF16A1cdee98fFB20C31f5cD61D6Ab07201858f4287c938D` |
| USDC | `0x053C91253BC9682C04929cA02ED00b3E423f6710D2ee7e0D5EBB06F3eCF368A8` |
| USDT | `0x068F5C6a61780768455de69077E07e89787839bf8166dECfBf92B645209c0fb8` |

## Swapping on Ekubo

Ekubo is the most liquid StarkNet AMM (concentrated liquidity, high
capital efficiency).
- Router: `0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e`
- Use the multicall pattern: build a `swap` call + a `clear` call (Ekubo
  uses a settle pattern requiring claiming output tokens after the swap).

For most cases use the **Avnu aggregator** instead — it routes across
Ekubo + 10kSwap + JediSwap + mySwap and abstracts the settle pattern:

```bash
curl "https://starknet.api.avnu.fi/swap/v2/quotes?sellTokenAddress=...&buyTokenAddress=...&sellAmount=..."
# Returns a quote + a calls[] you can pass to account.execute()
```

## Risk controls

- StarkNet fees are paid in STRK or ETH (the user picks at account creation)
  — confirm the chosen fee token has enough balance before submitting.
- Set a max fee multiplier of 1.5x the estimated fee.
- Confirm `execution_status: "SUCCEEDED"` after `waitForTransaction` —
  StarkNet can have `REVERTED` finalized transactions.

## What you should NOT do

- Don't construct calldata manually for complex contracts — use the
  `Contract` abstraction with the ABI; manual felt-encoding is error-prone.
- Don't assume Cairo 1 calldata layout matches Cairo 0 — check the contract
  version.
- Don't sign a multicall without showing the user every contract +
  entrypoint that will be invoked.
