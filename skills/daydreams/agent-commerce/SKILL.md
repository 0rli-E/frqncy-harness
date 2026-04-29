---
name: agent-commerce
description: ERC-8004 trustless agent identity + x402 micropayments + agent-as-a-service monetization. Use when the user wants to register an agent, pay another agent, monetize their own skills, look up counterparties, or audit revenue/spend.
keywords: [erc8004, erc-8004, x402, agent identity, agent payments, register agent, pay agent, settle, facilitator, reputation, agentcard, smart account, cdp, usdc, base mainnet, micropayment, monetize, agent-to-agent]
---

# Agent commerce — ERC-8004 + x402 + serve

The harness ships the full bilateral agent-commerce loop: discover → quote
→ pay → trace → settle → receipt → history → audit. Use this skill when the
user wants to engage in any of those.

## When to register

If the user wants discoverable identity (other agents finding them, on-chain
reputation, settlement-grade signatures on receipts):

```bash
# Register on-chain + bind smart account in one shot
frqncy-harness identity register \
  --domain api.frqncy.fun \
  --bind-smart-account
```

This:
1. Mints an agent NFT in the ERC-8004 IdentityRegistry on Base mainnet
2. Sets `agentURI = https://<domain>/.well-known/agent-registration.json`
3. Signs an EIP-712 SetAgentWallet authorization and binds the smart account
4. Reads the contract's `eip712Domain()` at runtime so the typed-data is
   correct for whatever IdentityRegistry deployment is canonical.

## When to pay

For one-off paid API calls (the user just wants to read a paywalled URL):

```bash
# Preview pricing first (safe dry-run, no signature)
frqncy-harness pay quote https://api.example.com/premium

# Pay
frqncy-harness pay test https://api.example.com/premium --max 100000
```

For agent runs where the LLM might want to pay endpoints autonomously:

```bash
frqncy-harness agent "research X then read https://api.example.com/data" --payments
# → installs `pay` and `discover_agents` tools + auto-pays via web_fetch
```

The `pay` tool is `propose-then-approve` — the LLM proposes, the user (or
yolo flag) approves. `web_fetch` auto-pays under the budget cap without an
explicit tool call.

## When to monetize

The user has a skill they want to sell (their `weekly-update` skill, their
`frqncy-editorial` voice, a content-validator):

```bash
frqncy-harness serve \
  --skill weekly-update --price 0.25 \
  --skill frqncy-editorial --price 0.05 \
  --port 8080
```

This boots:
- `GET /.well-known/agent-card.json` — A2A-compatible card with prices
- `GET /.well-known/agent-registration.json` — EIP-8004 registration proof
- `GET /healthz`
- `POST /skills/<name>` — paid via x402; settled USDC lands in the smart
  account; each settled call returns a Verifiable Settlement Receipt in the
  `X-RECEIPT` header (EIP-712-signed by the seller's agentWallet).

## When to look up counterparties

```bash
# Resolve agentId → metadata
frqncy-harness identity lookup 42

# Browse the facilitator's catalog of paid resources
frqncy-harness pay discover
```

`identity lookup` reads on-chain `tokenURI` + tries to fetch the registration
file at the registered URL. `pay discover` queries the active facilitator's
`/discovery/resources` for agents that have monetized endpoints.

## When to audit

```bash
# Tail recent payments (in or out)
frqncy-harness pay history --last 25 --direction in    # revenue
frqncy-harness pay history --last 25 --direction out   # spend

# Aggregated breakdown across recent conversations
frqncy-harness gain --period 7d
```

`gain` shows x402 spend buckets by network + asset + direction with bigint
precision and a net total.

## Reputation feedback

If the user opted into `payments.autoFeedback.enabled` in
`~/.frqncy-harness/config.json`, every settled outbound payment will write
ERC-8004 ReputationRegistry feedback for the recipient. Off by default
(it's gas — and on viem-private-key signers, the user pays ETH for it).
For one-off feedback during a `pay test` call, use `--feedback-agent <id>`.

## What you can do as the LLM

1. Suggest the right CLI shortcut for what the user wants.
2. Use `pay`, `discover_agents`, `web_fetch` (auto-pay) tools when they're
   in your toolset (`agent --payments`).
3. Propose monetization moves: "you've called this skill 200 times this
   week, consider serving it at $0.05/call to recoup costs."
4. Cross-reference the user's `pay history` against `gain` to spot anomalies.

## What you should NOT do

- Don't expose wallet keys, CDP secrets, or facilitator JWTs in your output.
- Don't propose payment to unknown counterparties without quoting first.
- Don't auto-write feedback (it's gas + on-chain noise) unless the user
  opted in via config.
