# proposals/AGENT-COMMERCE.md — ERC-8004 + x402 in `@frqncy-network/harness`

**Status:** Accepted (2026-04-29). User-approved scope: Base mainnet, Coinbase CDP smart wallets, full role surface (pay + receive + discoverable + validate), full production wire-up.

**Companion research (in `proposals/research/`):**
- `erc8004-spec.md` — verbatim distillation of EIP-8004 ABI + registration JSON
- `x402-spec.md` — verbatim distillation of x402 v1 wire format + EIP-3009 signing + facilitator API
- `daydreams-patterns.md` — what to lift from `daydreamsai/lucid-agents`
- `cdp-and-ecosystem.md` — CDP SDK, USDC on Base, ChaosChain / Catena / PayAI / Phala / Skyfire patterns

---

## Why now

The 2026 consensus (Sequoia, Bessemer, Anthropic, Coinbase, MetaMask, Google, EF) is converging fast: **trustless agent identity (ERC-8004) + native HTTP payments (x402)** are the agentic-commerce primitives. Daydreams already shipped `lucid-agents` — exactly the surface we need — *as a separate SDK that they recommend pairing with a harness*. Their public guidance: "We recommend the Pi agent harness for building agents and incorporating lucid-agents in it." We do the same. Pair pattern: harness owns the LLM loop + traces; commerce module owns identity + payments. Don't fuse them.

This proposal does not bundle Lucid Agents. It implements the same protocol surface natively, in a shape consistent with our locked decisions (provider-indifferent, trace-first, never compacted, one-exported-responsibility-per-file, Zod at every boundary).

## Locked decisions (this proposal)

1. **Network: Base mainnet by default**, `base-sepolia` via `FRQNCY_NETWORK=base-sepolia`. All addresses (USDC, IdentityRegistry, ReputationRegistry, facilitator URL) keyed off the network constant. One env var swaps everything.
2. **Wallet: Coinbase CDP smart accounts** for the agent's funds (gas-sponsored on Base via CDP Paymaster), with the **owner EOA** signing EIP-3009 typed-data for x402 (USDC `transferWithAuthorization` is `ecrecover`-checked, not ERC-1271, so the smart account itself can't sign x402 outbound). CDP credentials live in the existing `auth` store (new `cdp-api-key-id` / `cdp-api-key-secret` / `cdp-wallet-secret` slots, mode 0600).
3. **Pluggable signer.** A `Signer` interface (`address`, `signTypedData`, `signMessage`, `signTransaction`) — CDP is the default adapter, viem `privateKeyToAccount` is the fallback for CI / testnet smoke / users who don't want CDP. Lifted directly from Lucid's wallet-handle preference order.
4. **AgentCard is the universal join key.** One canonical `AgentCard` type, three composer functions (`withIdentity`, `withPayments`, `withA2A`). Pattern lifted from Lucid Agents' `onManifestBuild(card, runtime) => card`. Served at `/.well-known/agent-card.json`. Domain proof at `/.well-known/agent-registration.json`. OASF record at `/.well-known/oasf-record.json` (deferred).
5. **x402 v1 wire today, types parameterized for v2.** Ship `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers and `network: "base"` / `"base-sepolia"`; keep schemas factored so v2 (`PAYMENT-SIGNATURE`, CAIP-2) drops in.
6. **Coinbase CDP facilitator default**, with `FRQNCY_X402_FACILITATOR_URL` override (`https://facilitator.chaoscha.in`, `https://facilitator.payai.network`, self-hosted). 1,000 free verifications/month is the default budget guardrail.
7. **Payments at HTTP first, tools second** (Daydreams' opinion, validated). Three surfaces in priority order:
   - `x402Fetch` — fetch wrapper for the harness's outbound calls (web_fetch, MCP, custom). Auto-pays under a budget.
   - `x402Server` — Hono middleware to monetize endpoints the harness serves.
   - `payTool` — explicit `HarnessTool` the LLM can invoke. Default OFF; opt-in via `--enable-pay-tool` because giving the LLM a "spend money" verb deserves friction. When ON, gated by per-call approval like other propose-then-approve tools.
8. **Budget guardrails consistent with the existing cost-cap pattern.** Defaults: `$0.50 soft warn` / `$5.00 hard abort` per conversation for x402 spend, configurable in `~/.frqncy-harness/config.json` under `payments.budget`. Independent of the LLM cost cap.
9. **Trace schema extended additively** (per AGENT.md "trace schema is sacred" rule). New record type `payment` carries `{ direction: 'out' | 'in', resource, amount, asset, network, txHash, payer, payee, facilitator }`. Append-only, never compacted, mirrored to the trace repo.
10. **Pre-payment hook.** A `pre-payment` hook event (additive to the existing 3 lifecycle events) lets users veto a payment from a script. Cheap, audit-friendly.
11. **Reputation auto-write OFF by default.** Writing feedback after every settlement is conceptually clean (ChaosChain pattern) but spends gas + writes on-chain noise. Opt-in via `payments.autoFeedback: true`; off by default.
12. **Validation Registry deferred** — Lucid explicitly defers it ("under active development, will be revised") and the EIP-8004 page is still DRAFT for it. Stub the read methods only; `requestValidation` is a no-op until the spec firms up.

## Module layout

```
src/identity/                 # ERC-8004 — discover, register, prove
  index.ts                    # public exports
  registry.ts                 # IdentityRegistry / ReputationRegistry viem clients
  agent-card.ts               # AgentCard type + composers (withIdentity, withPayments, ...)
  serve.ts                    # tiny Hono server for the three .well-known endpoints
  abi.ts                      # ABI fragments (auto-generated from erc-8004-contracts)
  addresses.ts                # per-chain registry addresses (Base, Base Sepolia, Eth mainnet)

src/payments/                 # x402 — pay, receive, settle
  index.ts                    # public exports
  schemes.ts                  # Zod schemas (PaymentRequirements, PaymentPayload, SettleResponse)
  sign.ts                     # EIP-3009 typed-data signer (USDC TransferWithAuthorization)
  client.ts                   # x402Fetch — fetch wrapper that auto-pays 402s
  server.ts                   # paymentMiddleware — Hono middleware to monetize endpoints
  facilitator.ts              # verify/settle/discovery/supported HTTP client
  budget.ts                   # per-conversation spend tracker + soft/hard caps
  tool.ts                     # payTool — opt-in HarnessTool (LLM-callable)

src/wallet/                   # Pluggable signer — CDP default, viem fallback
  index.ts                    # Signer interface + factory
  cdp.ts                      # @coinbase/cdp-sdk → Signer adapter
  viem.ts                     # privateKeyToAccount → Signer adapter
  config.ts                   # network + chain mapping

src/commands/identity.ts      # CLI: register, whoami, card, serve, lookup
src/commands/pay.ts           # CLI: balance, history, faucet, x402-test
```

## Data flow

### Outbound payment (agent calls a paid resource)

1. LLM (or harness internals) calls `fetch(url)` via the wrapped client.
2. Resource server returns `402 Payment Required` with `accepts: PaymentRequirements[]` JSON.
3. `x402Fetch` selects the cheapest acceptable requirement that fits the budget.
4. `pre-payment` hook fires; if any hook returns `{ block: true }`, abort with a structured error.
5. `Signer.signTypedData(...)` produces the EIP-3009 signature — for CDP smart accounts, this signs from the **owner EOA**, not the smart-account address (USDC checks `ecrecover` on `from`).
6. Build `PaymentPayload`, base64-encode, retry with `X-PAYMENT` header.
7. On 200 with `X-PAYMENT-RESPONSE`: decode, append a `payment` trace record (out), return response to caller.
8. On 402 again or 4xx: classify, append failed-payment trace record, surface structured error.

### Inbound payment (other agent pays our endpoint)

1. Hono middleware sees request without `X-PAYMENT` → returns 402 + accepts list.
2. Client retries with header. Middleware decodes, calls `facilitator.verify(payload, requirements)`.
3. If valid: pass to handler. After handler: `facilitator.settle(...)`, set `X-PAYMENT-RESPONSE` header on the response, append a `payment` trace record (in).

### Identity registration (one-shot, idempotent)

1. `frqncy-harness identity register --domain api.frqncy.fun` reads the env / auth store.
2. Build `AgentCard` from registered name/description + entrypoints + payments config + identity registrations.
3. Upload `agent-registration.json` to `https://{domain}/.well-known/...` (manual or via `--upload`).
4. Call `IdentityRegistry.register(agentURI, [{ key: 'agentWallet', value: ownerEoa }])` — emits `Registered(agentId, agentURI, owner)`.
5. After receipt, call `setAgentWallet(agentId, smartAccount, deadline, eip712Sig)` to bind the smart account.
6. Print `agentId` + `agentRegistry` (CAIP-style: `eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`).

## Tool surface for the LLM

Two new HarnessTools, both opt-in:

- `discover_agents` — query ERC-8004 IdentityRegistry + read agent cards. `flags: { outboundNetwork: true }`. Auto-permission.
- `pay` — explicit micropayment. `flags: { privateData: true, outboundNetwork: true }`. `permission: 'propose-then-approve'`. Per-call approval; budget-capped.

The pay tool intentionally doesn't read web content (no `untrustedContent`) so it can't single-handedly form a lethal trifecta. Combine it with `web_fetch` and you'd hit the existing trifecta gate (warn by default, configurable to block).

## CLI surface

```
frqncy-harness identity register [--domain <d>] [--network base|base-sepolia] [--upload]
frqncy-harness identity whoami                            # print agentId, owner, smart account
frqncy-harness identity card [--out agent-card.json]      # render AgentCard
frqncy-harness identity serve [--port 3030]               # Hono server for .well-known/*
frqncy-harness identity lookup <agentId>|<domain>         # read another agent's card

frqncy-harness pay test <url>                             # one-shot: hit a 402'd URL, pay it
frqncy-harness pay balance                                # USDC balance on smart account + EOA
frqncy-harness pay history [--last 10]                    # recent payment trace records
frqncy-harness pay budget [show|set <usd>]                # spend cap per conversation

frqncy-harness doctor                                     # extended: CDP creds, registry, balance
```

## Security & guardrails

- **Wallet keys never enter the LLM context.** The harness signs internally; the LLM sees only the result.
- **Default budget cap of $5/conversation** applies independently of the LLM cost cap.
- **Lethal-trifecta gate** is unchanged; `pay` doesn't carry `untrustedContent` so adding it doesn't auto-block.
- **EIP-3009 nonce + validity windows** are the on-chain replay protection. We add a per-conversation in-memory nonce dedupe to fail fast before signing.
- **Pre-payment hook** lets ops scripts / regulators veto in-flight.
- **Inbound 402** rejects requests that don't pay; we don't accept off-chain claims of payment.

## Test plan

Vitest, fully offline:
- Mock viem `PublicClient` for registry reads.
- Mock x402 facilitator with a tiny in-process server.
- Mock CDP SDK with a stub that returns a deterministic viem-`toAccount`-shaped object.
- One `*.skip.ts` test that hits Base mainnet for real, gated on `FRQNCY_E2E=1`.

Coverage targets:
- EIP-3009 typed-data assembly: golden vector (signature matches a known good).
- Budget cap: configurable; soft warn does not block; hard abort blocks; both append trace records.
- AgentCard serialization round-trips the EIP-8004 schema bit-for-bit.
- 402 flow end-to-end with a fake facilitator: pay, receive, settle.

## What we are NOT building (this pass)

- AP2 wire protocol — we'll declare the capability in `card.capabilities.extensions[]` (Lucid pattern), not implement the protocol.
- A2A full transport — we'll serve the AgentCard at the canonical path; we won't proxy A2A messages.
- Validation Registry writes — read-only stubs until the spec firms up.
- Permit2 / ERC-7710 — `extra.assetTransferMethod = 'eip3009'` only, for USDC.
- Solana — supported networks list will accept the strings, but no SVM scheme implementation.
- TEE attestations — Phala pattern is interesting; deferred.
- DSPy / GEPA-style pricing optimization — deferred.

## Open questions to revisit at v0.10

1. Do we issue a Verifiable Credential receipt (Catena ACK pattern) on settlement? Cleaner than tx hash, larger surface.
2. Auto-write feedback after each successful settlement? Toggle-on by default after we have a reputation track record?
3. Self-host facilitator? Coinbase free tier handles 1,000/month; beyond that, ChaosChain or roll our own.
4. Expose `pay` as an MCP tool (Skyfire pattern) so any LLM harness — not just ours — gets the same ergonomics?
