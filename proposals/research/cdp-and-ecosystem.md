# CDP Server Wallets v2 + ERC-8004 / x402 Ecosystem — Research Report

_Last verified: April 2026. Target: TypeScript LLM harness implementing agent payments (x402) + agent identity (ERC-8004) on Base mainnet, using Coinbase CDP smart wallets._

---

## 1. Coinbase CDP Server Wallet v2 — TypeScript SDK

### Package & install

The TypeScript SDK is published as **`@coinbase/cdp-sdk`** on npm. The repo lives at [`coinbase/cdp-sdk`](https://github.com/coinbase/cdp-sdk) (the TS package source is under `typescript/src/`). For the React/browser embedded-wallet bindings there is a separate package, **`@coinbase/cdp-core`** (used with `getCurrentUser()` and `toViemAccount()` for end-user / passkey wallets in the browser). For server-side agent backends use `@coinbase/cdp-sdk` directly.

```bash
npm install @coinbase/cdp-sdk
```

### Authentication & client init

CDP issues three credentials in the CDP Portal:

- `CDP_API_KEY_ID` — UUID of the API key
- `CDP_API_KEY_SECRET` — Ed25519 (or ECDSA) private key string
- `CDP_WALLET_SECRET` — required to sign anything that moves funds

The SDK signs every request with a short-lived JWT derived from the API key/secret (you don't have to mint the JWT yourself; the SDK's HTTP client wraps Axios and does it transparently). Three init styles:

```ts
import { CdpClient } from "@coinbase/cdp-sdk";
import "dotenv/config";

// 1. Read all three from env (CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET)
const cdp = new CdpClient();

// 2. Pass explicitly
const cdp = new CdpClient({
  apiKeyId: process.env.CDP_API_KEY_ID!,
  apiKeySecret: process.env.CDP_API_KEY_SECRET!,
  walletSecret: process.env.CDP_WALLET_SECRET!,
});
```

The CDP docs explicitly call out: _"The CDP client wraps an HTTP client (Axios) and should be created once and reused throughout your application's lifecycle."_ Don't re-instantiate per request.

### Creating an EVM smart account

CDP smart accounts are ERC-4337 account-abstraction accounts. They currently support **Base Sepolia and Base Mainnet** (good — that's our target). Pattern:

```ts
// Create the EOA owner first (a CDP server wallet EOA)
const owner = await cdp.evm.createAccount();

// Then create a smart account whose owner is that EOA
const smartAccount = await cdp.evm.createSmartAccount({ owner });
```

Two important Base-specific features:

1. **Gas sponsorship via CDP Paymaster.** When you scope a smart account to Base or Base Sepolia, gas is sponsored automatically.
2. **`useNetwork()` hoisting.** Avoid passing `network` on every call by hoisting once:

   ```ts
   const baseSmartAccount = await smartAccount.useNetwork("base");
   // Now: baseSmartAccount.transfer(...), .sendUserOperation(...) etc. don't need a network arg
   ```

### Sending USDC (high level)

```ts
const tx = await baseSmartAccount.transfer({
  to: "0xRecipient...",
  amount: 1_000_000n,   // 1 USDC, 6 decimals (use bigint base units)
  token: "usdc",        // shortcut; you can also pass the contract address directly
});
```

The SDK accepts either the symbol `"usdc"` or a raw token contract address, and uses CDP Paymaster on Base so the smart account doesn't need ETH for gas.

### Signing EIP-712 typed data (the part you need for x402 / EIP-3009)

Both regular CDP EVM accounts and CDP smart accounts expose `signTypedData({ domain, types, primaryType, message })`. The shape matches `viem`'s typed-data API exactly:

```ts
const signature = await account.signTypedData({
  domain,        // { name, version, chainId, verifyingContract }
  types,         // { TransferWithAuthorization: [...] }
  primaryType,   // "TransferWithAuthorization"
  message,       // the actual payload
});
```

The CDP docs page on EIP-712 confirms: _"`signTypedData` … implements EIP-712 signing: `sign(keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message)))`"_ — i.e., it produces a 65-byte signature compatible with `ecrecover`.

**Important caveat for smart accounts:** an ERC-4337 smart account's "signature" is interpreted via ERC-1271 (`isValidSignature`), not raw `ecrecover`. USDC's `transferWithAuthorization` does a plain `ecrecover`-style check on the EOA `from` parameter — so for EIP-3009 you must sign with the **owner EOA**, not with the smart-account address. The smart account is useful as the receiving wallet (and for batched on-chain ops) but when you're acting as the x402 _payer_ on Base, sign EIP-3009 with the underlying CDP EVM account whose private key the smart account owns.

### Using a CDP account as a viem custom account (the `toAccount` pattern)

This is the integration point that matters most for an x402 harness — viem-based libraries (including most x402 client SDKs) expect a viem `Account` (something with `signMessage`, `signTypedData`, `signTransaction`, plus an `address`). CDP gives you two ways in:

#### A. Browser / embedded wallet (passkey-backed) — `@coinbase/cdp-core`

```ts
import { toViemAccount, getCurrentUser } from "@coinbase/cdp-core";
import { createWalletClient, http } from "viem";
import { base } from "viem/chains";

const user = await getCurrentUser();
const evmAddress = user.evmAccountObjects[0]?.address;
const viemAccount = toViemAccount(evmAddress);

const wallet = createWalletClient({
  account: viemAccount,
  transport: http(),
  chain: base,
});
```

`toViemAccount(address)` returns a viem-compatible `LocalAccount`-like object whose `signMessage` / `signTypedData` / `signTransaction` calls round-trip through the CDP backend (or the local passkey TEE). It's a **drop-in replacement for any library that takes a viem `account`**.

#### B. Server-side — wrap a `cdp.evm` account with viem's `toAccount`

`@coinbase/cdp-sdk` does **not** ship a server-side `toViemAccount` helper today (the helper is part of `@coinbase/cdp-core`, which is the embedded-wallet React bindings). On the server you assemble it yourself with viem's own `toAccount`:

```ts
import { toAccount } from "viem/accounts";
import { hashMessage, hashTypedData } from "viem";

const cdpAccount = await cdp.evm.getAccount({ name: "my-agent" });

const viemAccount = toAccount({
  address: cdpAccount.address as `0x${string}`,
  async signMessage({ message }) {
    return cdpAccount.signMessage({ message: typeof message === "string" ? message : message.raw });
  },
  async signTypedData(typedData) {
    return cdpAccount.signTypedData(typedData);
  },
  async signTransaction(tx) {
    return cdpAccount.signTransaction(tx);
  },
});
```

That `viemAccount` can then be plugged into any x402 client (Coinbase's `@x402/evm`, ChaosChain's `@chaoschain/x402-client`, etc.) that expects a standard viem signer. **This is the load-bearing pattern for the harness** — every x402 implementation we surveyed accepts a viem `Account`.

### Other useful surface area

- **EVM signing helpers:** `signMessage`, `signTypedData`, `signTransaction`, `signHash` directly on accounts.
- **EIP-7702 delegation:** the SDK exposes `signTransaction` with `authorizationList` and a dedicated EIP-7702 flow if you want a single EOA that "becomes" a smart account.
- **Policies:** server-side spend limits, allowlists, per-end-user policies. Worth using for an autonomous agent — cap daily USDC outflow at the CDP layer.
- **Webhooks:** subscribe to incoming transfers / USDC receipts (`cdp.webhooks.createSubscription`).
- **Faucet:** `cdp.evm.requestFaucet({ address, network: "base-sepolia", token: "usdc" })` for testnet.

---

## 2. EIP-3009 `transferWithAuthorization` on Base mainnet USDC

This is the on-the-wire payload your harness has to produce when acting as an x402 payer on Base.

### Canonical Base mainnet USDC

| Field | Value |
|---|---|
| Token name | USD Coin |
| Symbol | USDC |
| Address | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Decimals | `6` |
| Chain | Base mainnet (chain id `8453`) |
| Issuer | Circle (native, _not_ the bridged USDbC) |

This is the **native Circle USDC** on Base. Do not confuse it with USDbC (`0xd9aA…1A`), the legacy bridged token — x402 facilitators settle the native one.

### EIP-712 domain separator

The domain that USDC on Base hashes into its separator:

```ts
const domain = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;
```

(Circle bumped to `version: "2"` when they shipped the EIP-3009 / EIP-2612 upgrade. Always read it on-chain via `eip712Domain()` if you want belt-and-braces.)

### `TransferWithAuthorization` typed-data struct

```ts
const types = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;
```

### Full message + signing example with viem + CDP

```ts
import { encodeFunctionData, parseAbi } from "viem";
import { randomBytes } from "node:crypto";

const validAfter  = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min window
const nonce       = `0x${Buffer.from(randomBytes(32)).toString("hex")}` as `0x${string}`;

const message = {
  from:        viemAccount.address,
  to:          merchantAddress,
  value:       1_000_000n,           // 1.00 USDC
  validAfter,
  validBefore,
  nonce,
};

const signature = await viemAccount.signTypedData({
  domain,
  types,
  primaryType: "TransferWithAuthorization",
  message,
});
```

That `signature` is what you base64-stuff into the x402 `PAYMENT-SIGNATURE` header. The facilitator (Coinbase's `https://x402.org/facilitator`, ChaosChain's `https://facilitator.chaoscha.in`, or your own) decomposes it into `(v, r, s)` and submits `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` on-chain — meaning the **payer pays zero gas** and never needs to pre-`approve()`. ChaosChain's README states this plainly: _"EIP-3009 gasless — Payers don't need ETH, facilitator sponsors gas… No approvals needed: Single EIP-3009 signature."_

### x402 envelope shape (Coinbase v1, for reference)

The 402 response carries a `PAYMENT-REQUIRED` header (base64 JSON) listing accepted `(scheme, network)` pairs; the client retries with `PAYMENT-SIGNATURE` carrying the signed authorization. On Base mainnet the canonical entry is:

```json
{
  "scheme":  "exact",
  "network": "base-mainnet",
  "asset":   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "maxAmountRequired": "1000000",
  "payTo":   "0xMerchant...",
  "resource": "/your/endpoint"
}
```

PayAI's Solana fork has moved to **x402 v2** (CAIP-2 networks, `accepted` field, `x402Version: 2`); Coinbase's reference is still v1 on EVM at the time of writing. The `chaoschain-x402` facilitator and Coinbase's `https://x402.org/facilitator` both speak v1.

---

## 3. Other ERC-8004 + x402 Projects to Lift Patterns From

### erc-8004/erc-8004-contracts — canonical contracts repo

- **GitHub:** https://github.com/erc-8004/erc-8004-contracts
- **Ships:** Upgradeable Solidity contracts (`IdentityRegistryUpgradeable.sol`, `ReputationRegistryUpgradeable.sol`, `ValidationRegistryUpgradeable.sol`), ABIs, Hardhat ignition modules. License **CC0**. Co-authored by Marco De Rossi (MetaMask), Davide Crapis (EF), Jordan Ellis (Google), Erik Reppel (Coinbase).
- **TypeScript packages:** none directly — but the `abis/` folder is what every TS integration imports.
- **Key addresses (deterministic across many chains, including Base mainnet):**
  - `IdentityRegistry`:  `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
  - `ReputationRegistry`: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
  - On Base Sepolia: `IdentityRegistry` = `0x8004A818BFB912233c491871b3d84c89A494BD9e`, `ReputationRegistry` = `0x8004B663056A597Dffe9eCcC1965A193B7388713`.
- **Patterns to lift:**
  1. **`agentWallet` reserved metadata key** — set on registration, cleared on transfer, updatable only with EIP-712/ERC-1271 proof of new wallet. This is exactly the bridge between the ERC-721 agent identity and your CDP smart wallet — the agentWallet is what gets paid via x402, and the registry guarantees the linkage is owner-attested.
  2. **Agent registration JSON** (`agentURI`-resolved): include `services` (A2A card URL, MCP endpoint, OASF), `registrations: [{ agentRegistry, agentId }]`, and `supportedTrust: ["reputation", "tee-attestation", "crypto-economic"]`. Treat this as the discovery doc your harness publishes.

### ChaosChain — reference implementation + commercial SDK + decentralized facilitator

- **GitHubs:**
  - https://github.com/ChaosChain/trustless-agents-erc-ri (Foundry, **Jan 2026 spec v1.2**)
  - https://github.com/ChaosChain/chaoschain-sdk-ts (`@chaoschain/sdk` on npm — TS SDK)
  - https://github.com/ChaosChain/chaoschain-x402 (decentralized x402 facilitator on Chainlink CRE; `@chaoschain/x402-client` TS package)
  - https://github.com/ChaosChain/chaoschain-genesis-studio (end-to-end commercial demo)
- **Ships:** Triple-Verified Stack (Google AP2 Intent + Process Integrity + Adjudication), agent registration with ChaosAgent, VerifierAgent, "Engineering Studio Sessions" with automatic Evidence DAG construction, pluggable storage (IPFS, Pinata, Irys, 0G), **a managed x402 facilitator at `https://facilitator.chaoscha.in`** that returns `{ amount: { human, base, symbol, decimals }, fee: { bps: 100 }, net }` and uses EIP-3009 settlement with 1% protocol fee.
- **TS packages:** `@chaoschain/sdk` (init: `new ChaosChainSDK({ facilitatorUrl, agentId: '8004#123' })`), `@chaoschain/x402-client`.
- **Patterns to lift:**
  1. **Quote shape.** Always return both `human` (display) and `base` (settlement) units in API responses and never let them drift. Saves you a class of off-by-six-decimals bugs.
  2. **Reputation linkage.** Their facilitator automatically writes to ERC-8004 ReputationRegistry on each settlement. Worth replicating: every successful x402 settlement = one feedback row tied to `agentId`. The registry uses `int128 value` + `uint8 valueDecimals`, so you can encode percentages (`9977, 2 → 99.77%`), revenues (`560, 0 → $560`), or response times directly.
  3. **`8004#<tokenId>` naming convention** for agentIds passed across systems — short, indexer-friendly, ChaosChain-popularized.

### Catena Labs — Agent Commerce Kit (ACK)

- **GitHubs:**
  - https://github.com/agentcommercekit/ack (monorepo: `@agentcommercekit/ack-id`, `@agentcommercekit/ack-pay`)
  - https://github.com/catena-labs/ack-lab-sdk (`@ack-lab/sdk` on npm — managed Developer Preview)
- **Ships:** ACK-ID (W3C DIDs + Verifiable Credentials for agent identity, agent-to-agent handshakes) + ACK-Pay (paywalls, payment receipts as Verifiable Credentials, A2A `payment-required` flow). Supports x402 as one of several payment rails.
- **TS packages:** `agentcommercekit` core, `@ack-lab/sdk`.
- **Patterns to lift:**
  1. **Verifiable Receipt pattern.** ACK-Pay returns a `PaymentReceiptCredential` (a signed VC) after settlement. This is a strictly better artifact than a raw tx hash — the receipt embeds the request ID, payer DID, payee DID, and amount, so consumers can verify "this payment satisfied that exact paywall" without trusting an indexer.
  2. **`createAgentCaller(url, inputSchema, outputSchema)` + `createRequestHandler(schema, handler)` symmetry.** Their handshake-then-call API is the cleanest agent-to-agent RPC pattern around — each side wraps a JWT-based auth handshake into one function call. Worth mirroring even if you don't adopt the full DID stack.

### PayAI — x402 marketplace (Solana-leaning, but the v2 pattern matters)

- **GitHub org:** https://github.com/PayAINetwork
- **Main repo:** https://github.com/PayAINetwork/x402-solana (npm: `x402-solana`, also `@payai/x402-solana-react`)
- **Ships:** Framework-agnostic x402 v2 client + server for Solana, drop-in React components, hosted facilitator at `https://facilitator.payai.network`. Demonstrates **x402 v2** (CAIP-2 networks like `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`, `PAYMENT-SIGNATURE` header, `accepted` field in payload).
- **Patterns to lift:**
  1. **`X402PaymentHandler` server class.** Their server-side surface is `extractPayment(headers)` → `createPaymentRequirements(routeConfig, resourceUrl)` → `verifyPayment` → run business logic → `settlePayment`. Cleanly separated steps, easy to wrap in middleware. Better factoring than Coinbase's monolithic `paymentMiddleware`.
  2. **`customFetch` proxy escape hatch** for browser CORS — they let you swap the facilitator HTTP client. We need the same when the harness runs from a sandboxed environment that can't punch through to arbitrary 402 endpoints.

### Phala-Network/erc-8004-tee-agent — TEE-attested ERC-8004 agent

- **GitHub:** https://github.com/Phala-Network/erc-8004-tee-agent
- **Ships:** Python (FastAPI) reference agent that runs inside Intel TDX on Phala Cloud, uses TEE-derived keys for signing, exposes `/agent.json` + `/.well-known/agent-card.json` + `/.well-known/agent-registration.json`, registers on the ERC-8004 IdentityRegistry, and ships `/api/tee/attestation` to return an Intel TDX quote.
- **TS packages:** none (Python).
- **Patterns to lift:**
  1. **The three well-known endpoints** (`/agent.json`, `/.well-known/agent-card.json`, `/.well-known/agent-registration.json`). These are how A2A discovery actually works in the wild — copy them verbatim in TypeScript.
  2. **`AGENT_SALT` → TEE-derived key** pattern. Even if you're not in a TEE, modeling your agent's signing key as deterministic-from-some-secret (so it survives container restarts without persisting plaintext keys) is the right shape. With CDP you get a managed-secret equivalent for free.

### sudeepb02/awesome-erc8004 — curated list

- **GitHub:** https://github.com/sudeepb02/awesome-erc8004
- **Ships:** Curated index of ERC-8004 builders, contracts, explorer tools, related standards (ERC-721, A2A, OASF). Best entry point when ChaosChain or the canonical repo evolves and you need to find the latest reference impl.
- **Patterns to lift:** Use it as a discovery feed; nothing executable.

### x402.org Bazaar — discovery layer

- **Endpoint:** `https://x402.org/facilitator/discovery/resources` (the x402.org-operated index)
- **CDP-hosted equivalent:** `GET /v2/x402/discovery/resources` (paginated catalog) and `GET /v2/x402/discovery/search` (semantic search) under https://docs.cdp.coinbase.com/x402/bazaar.
- **Ships:** A registry of payable HTTP endpoints. **No registration step required** — the CDP facilitator catalogs an endpoint the first time it settles a payment for it. So if you ship paid endpoints behind the Coinbase facilitator, you're auto-listed.
- **Patterns to lift:**
  1. The harness should hit `/v2/x402/discovery/search?q=...` to find services rather than relying on the LLM's training data.
  2. Treat the agent's own `agentURI` JSON file as the canonical registration; let the Bazaar index it via your settlement footprint.

### Hyperware (formerly Kinode) — peer-to-peer agent runtime

- **GitHub org:** https://github.com/hyperware-ai (also `https://github.com/kinode-dao`, the older identity)
- **Main repo:** https://github.com/hyperware-ai/hyperdrive (the runtime, in Rust); desktop wrapper at https://github.com/hyperware-ai/hyperdrive-desktop.
- **Ships:** A peer-to-peer "agent operating system" — apps run as WASM processes inside Hyperdrive, addressed by `process@node` identifiers. Not directly an x402 / ERC-8004 project, but the addressing model is the most mature alternative to ERC-8004's ERC-721 identities for agents that primarily talk to each other (rather than to HTTP servers). No first-party TypeScript SDK — it's Rust-first.
- **Patterns to lift:** Mostly a sanity check on identity — Hyperware is the steel-man for "you don't need on-chain identity for agents," and reading their addressing scheme makes it clearer when ERC-8004 _is_ the right pick (cross-org discovery + transferable reputation; it isn't for tight-loop intra-network calls).

### Skyfire — managed agent payments platform

- **GitHub org:** https://github.com/skyfire-xyz
- **Ships:** A hosted "agent accounts" platform, Skyfire MCP server (so agents can call payment tools via Model Context Protocol), funded buyer wallets, KYB-backed seller accounts. Closer to ACK-Lab in positioning. Their public docs are at https://docs.skyfire.xyz.
- **TS packages:** A Skyfire MCP server and an OpenAI-Agents-SDK integration (via Composio) — both wrap the Skyfire REST API; not a generic on-chain SDK.
- **Patterns to lift:**
  1. **MCP-first surface.** Exposing `skyfire_pay`, `skyfire_balance`, `skyfire_history` as MCP tools means any LLM harness gets payments with zero custom plumbing. We should ship our CDP+x402 layer behind a small MCP server with the same tool ergonomics; the LLM doesn't need to know whether settlement is x402, ACK-Pay, or Skyfire.
  2. Skyfire is a useful **fallback rail** if a counterparty doesn't speak x402 / ERC-8004 — worth supporting as a payment scheme alongside `exact`/EIP-3009.

---

## TL;DR for the harness implementation

1. **Wallet model:** create a CDP EVM account (the EOA owner), then a CDP smart account on Base mainnet; hoist the network with `useNetwork("base")`. Use the smart account for receiving payments (gas-sponsored ops); use the underlying EOA's `signTypedData` for EIP-3009 signatures when paying.
2. **viem bridge:** wrap the CDP account in viem's `toAccount({ address, signMessage, signTypedData, signTransaction })` so any x402 SDK accepts it.
3. **Pay over x402:** sign `TransferWithAuthorization` against domain `{ name: "USD Coin", version: "2", chainId: 8453, verifyingContract: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 }`; submit base64'd in `PAYMENT-SIGNATURE`. Start with the Coinbase facilitator (`https://x402.org/facilitator`), keep the ChaosChain one (`https://facilitator.chaoscha.in`) as a hot swap for the decentralization story.
4. **Identity:** register the agent on ERC-8004 IdentityRegistry on Base mainnet (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`); set `agentWallet` to the CDP smart-account address with an EIP-712 proof; publish a `services + registrations + supportedTrust` JSON at the `agentURI` URL with the same three well-known endpoints Phala uses.
5. **Reputation:** after each x402 settlement, write a feedback row to ReputationRegistry (`int128 value`, `uint8 valueDecimals`) tagged with the resource URI. Use the `8004#<tokenId>` agentId convention from ChaosChain.
6. **Surface to the LLM:** wrap pay / discover / receive / register as MCP tools (Skyfire-style). The LLM never touches private keys.

---

## Sources

- [CDP SDK GitHub repo (coinbase/cdp-sdk)](https://github.com/coinbase/cdp-sdk)
- [CDP SDK TypeScript reference (coinbase.github.io/cdp-sdk/typescript)](https://coinbase.github.io/cdp-sdk/typescript/)
- [CDP Server Wallets v2 docs](https://docs.cdp.coinbase.com/server-wallets/v2/introduction/welcome)
- [CDP Smart Accounts (Server Wallets v2)](https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/smart-accounts)
- [CDP Managed Mode (network hoisting + Paymaster)](https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/managed-mode)
- [CDP EIP-712 Signing docs](https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/eip-712-signing)
- [CDP x402 Bazaar / Discovery](https://docs.cdp.coinbase.com/x402/bazaar)
- [CDP x402 Network Support](https://docs.cdp.coinbase.com/x402/network-support)
- [@coinbase/cdp-sdk on npm](https://www.npmjs.com/package/@coinbase/cdp-sdk)
- [@coinbase/cdp-core on npm (toViemAccount)](https://www.npmjs.com/package/@coinbase/cdp-core)
- [viem `toAccount` docs](https://viem.sh/docs/accounts/local/toAccount)
- [viem `signTypedData` (Local Account)](https://viem.sh/docs/accounts/local/signTypedData)
- [USDC on Base on Basescan (`0x833589fc…02913`)](https://basescan.org/token/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913)
- [EIP-3009 spec discussion](https://github.com/ethereum/EIPs/issues/3010)
- [x402 protocol repo (x402-foundation/x402)](https://github.com/x402-foundation/x402)
- [Coinbase x402 fork](https://github.com/coinbase/x402)
- [ERC-8004 contracts repo (erc-8004/erc-8004-contracts)](https://github.com/erc-8004/erc-8004-contracts)
- [ChaosChain reference implementation (trustless-agents-erc-ri)](https://github.com/ChaosChain/trustless-agents-erc-ri)
- [ChaosChain TypeScript SDK (chaoschain-sdk-ts)](https://github.com/ChaosChain/chaoschain-sdk-ts)
- [ChaosChain x402 facilitator](https://github.com/ChaosChain/chaoschain-x402)
- [ChaosChain Genesis Studio](https://github.com/ChaosChain/chaoschain-genesis-studio)
- [Catena Labs Agent Commerce Kit](https://github.com/agentcommercekit/ack)
- [Catena Labs ACK-Lab SDK](https://github.com/catena-labs/ack-lab-sdk)
- [PayAI x402-solana](https://github.com/PayAINetwork/x402-solana)
- [Phala ERC-8004 TEE agent](https://github.com/Phala-Network/erc-8004-tee-agent)
- [awesome-erc8004 (sudeepb02)](https://github.com/sudeepb02/awesome-erc8004)
- [awesome-x402 (xpaysh)](https://github.com/xpaysh/awesome-x402)
- [Hyperware Hyperdrive runtime](https://github.com/hyperware-ai/hyperdrive)
- [Hyperware GitHub org](https://github.com/hyperware-ai)
- [Skyfire GitHub org](https://github.com/skyfire-xyz)
- [Skyfire developer docs](https://docs.skyfire.xyz/docs/developer-documentation)
