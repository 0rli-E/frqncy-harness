---
name: defi-evm-actions
description: EVM DeFi actions — read ERC-20 balances, transfer tokens, approve allowances, swap on Uniswap V3 / Aerodrome / Sushi, deposit to Aave / Compound, on Base mainnet, Ethereum mainnet, or any EVM chain the user's signer knows about. Use when the user mentions tokens, swaps, transfers, lending, yield, USDC/USDT/WETH/DAI/etc.
keywords: [swap, transfer, approve, allowance, balance, balanceof, erc20, erc-20, uniswap, aerodrome, sushi, aave, compound, lend, borrow, yield, usdc, usdt, weth, dai, base mainnet, ethereum, evm]
---

# DeFi on EVM (Base / Ethereum / etc.)

Mirrors the `@daydreamsai/defai` EVM surface. The harness's `Signer`
abstraction (CDP smart account preferred, viem fallback) is what signs;
viem (peer dep) is what builds calldata and submits transactions.

## Reading

For balance / allowance / token metadata, use the bash tool to drive viem
or directly call `pay balance` for the agent's own USDC:

```bash
# Quick path for the agent's own USDC balance
frqncy-harness pay balance
```

For arbitrary ERC-20 reads, use bash + a tiny inline node script (the
sandbox has viem available because the harness pulls it in as a peer dep):

```bash
node -e '
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const pc = createPublicClient({ chain: base, transport: http() });
const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
console.log(await pc.readContract({
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  abi, functionName: "balanceOf", args: ["0xWALLET..."]
}));
'
```

## Transferring

For ERC-20 transfers FROM the agent's smart account, the cleanest path is
the CDP smart-account `transfer()` method. Suggest the user run:

```bash
# Inside the harness REPL with --payments enabled, or via a custom script
frqncy-harness repl --agent --payments
> /yolo
> "transfer 5 USDC from my smart account to 0xRECIPIENT on base"
```

Then the LLM can construct the transfer using the wallet's `_smart` handle
(the underlying CDP smart account exposes `transfer({ to, amount, token })`).

For viem-private-key signers, the LLM can build + sign + broadcast:

```bash
node -e '
import { createWalletClient, http, parseUnits, encodeFunctionData, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
const account = privateKeyToAccount(process.env.FRQNCY_AGENT_PRIVATE_KEY);
const wc = createWalletClient({ account, chain: base, transport: http() });
const abi = parseAbi(["function transfer(address,uint256)"]);
const tx = await wc.writeContract({
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", abi,
  functionName: "transfer",
  args: ["0xRECIPIENT", parseUnits("5", 6)],
});
console.log(tx);
'
```

## Swapping

On Base mainnet, the cheapest + most liquid venue is **Aerodrome** (forked
Velodrome). Uniswap V3 is also deeply liquid for major pairs.

For Aerodrome:
- Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`
- Method: `swapExactTokensForTokens(amountIn, amountOutMin, routes[], to, deadline)`

For Uniswap V3:
- SwapRouter02: `0x2626664c2603336E57B271c5C0b26F421741e481` (Base)
- Method: `exactInputSingle({ tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96 })`

The agent should:
1. Compute the input amount (parseUnits for the source token's decimals)
2. Get a quote (Aerodrome `getAmountsOut`, Uniswap quoter)
3. Set a slippage tolerance (default 0.5%)
4. Approve the router (one-time per token per amount)
5. Submit the swap

Always show the user the expected output + slippage BEFORE submitting.

## Aave V3 on Base

Pool: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`
Methods: `supply(asset, amount, onBehalfOf, referralCode)`, `withdraw`,
`borrow`, `repay`.

Same pattern: approve, then call.

## What you should NOT do

- Don't sign anything without showing the user the human-readable summary
  (token in, token out, amount, recipient, gas estimate).
- Don't bypass `payments.budget.hardAbortUsd` if the swap value would
  exceed it.
- Don't broadcast on a chain the user's `FRQNCY_NETWORK` env doesn't pin
  — switch with `--network base|base-sepolia` or fail.
- Don't store intermediate signatures in memory / logs / traces — use
  ephemeral variables only.
