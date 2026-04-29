# x402 Protocol — Verbatim Distillation for TypeScript LLM Harness

This is a verbatim research distillation. All field names, header names, type
shapes, error code strings, network identifiers, package names, and code
fragments are quoted exactly as they appear in the official sources. Where the
spec has been revised, both versions are presented because both are still
deployed in the wild.

Sources (all fetched live from `github.com/coinbase/x402` `main`, plus npm
registry tarballs):

- `specs/x402-specification-v1.md`
- `specs/x402-specification-v2.md`
- `specs/transports-v2/http.md`
- `specs/schemes/exact/scheme_exact_evm.md`
- `typescript/packages/legacy/x402/src/types/verify/x402Specs.ts`
- `typescript/packages/legacy/x402/src/types/verify/facilitator.ts`
- `typescript/packages/legacy/x402/src/types/shared/network.ts`
- `typescript/packages/legacy/x402/src/types/shared/evm/eip3009.ts`
- `typescript/packages/legacy/x402/src/schemes/exact/evm/sign.ts`
- `typescript/packages/legacy/x402/src/schemes/exact/evm/client.ts`
- `typescript/packages/legacy/x402/src/verify/useFacilitator.ts`
- READMEs for `x402-fetch`, `x402-axios`, `x402-express` (legacy v1)
- npm tarball of `@coinbase/x402@0.7.3` (`dist/cjs/index.js`)
- Coinbase docs `docs.cdp.coinbase.com/x402/welcome` (text content)

---

## 0. Two Coexisting Versions

There are two on-the-wire protocol versions in active use:

- **v1** (`x402Version: 1`) — uses HTTP header **`X-PAYMENT`** for the request
  payload and **`X-PAYMENT-RESPONSE`** for the settlement response. The
  402 body is JSON. `network` is a string like `"base"`, `"base-sepolia"`. The
  `PaymentRequirements` field for amount is `maxAmountRequired`. **All NPM
  packages currently shipping (`x402-fetch@1.x`, `x402-axios`, `x402-express`,
  `x402-hono`, `x402-next`, `@coinbase/x402@0.7.x`) implement v1.**
- **v2** (`x402Version: 2`) — uses **`PAYMENT-REQUIRED`** /
  **`PAYMENT-SIGNATURE`** / **`PAYMENT-RESPONSE`** headers (all base64). 402
  body is empty. `network` uses CAIP-2 (`eip155:8453`). Renames
  `maxAmountRequired` → `amount`. `resource`/`description`/`mimeType` move into
  a `resource: ResourceInfo` sub-object. NPM packages `@x402/core`,
  `@x402/evm`, `@x402/svm`, `@x402/fetch`, `@x402/axios`, `@x402/express`,
  `@x402/hono`, `@x402/next`, `@x402/fastify`, `@x402/paywall`,
  `@x402/extensions`, `@x402/stellar` exist as the v2 ports.

Implement v1 first (production deployments today), keep types parameterized so
v2 can drop in.

---

## 1. HTTP Wire Format

### 1.1 v1 wire format (currently deployed)

> Source: `x402-axios` README, `x402-express` README, x402 v1 spec

The 402 response from a resource server is JSON in the body, with no special
header for requirements:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "maxAmountRequired": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "resource": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json",
      "outputSchema": null,
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDC", "version": "2" }
    }
  ]
}
```

Client retries the original request with one new header:

- Request header: **`X-PAYMENT`**: base64-encoded JSON of the `PaymentPayload`.

On success the resource server returns 200 with the resource body and a
response header containing the settlement result:

- Response header: **`X-PAYMENT-RESPONSE`**: base64-encoded JSON of the
  `SettleResponse`.

The legacy SDK README confirms: *"Expose the X-PAYMENT-RESPONSE header in the
final response"* (`x402-axios` README).

### 1.2 v2 wire format (revised header names)

> Source: `specs/transports-v2/http.md` (Header Summary)

| Header | Direction | Description |
| ------ | --------- | ----------- |
| `PAYMENT-REQUIRED` | Server → Client | Base64-encoded `PaymentRequired` object |
| `PAYMENT-SIGNATURE` | Client → Server | Base64-encoded `PaymentPayload` object |
| `PAYMENT-RESPONSE` | Server → Client | Base64-encoded `SettlementResponse` object |

> "**Mechanism**: HTTP 402 status code with `PAYMENT-REQUIRED` header
> **Data Format**: Base64-encoded `PaymentRequired` schema in header"

> "Response bodies are a server implementation concern. All x402 protocol
> information is communicated through headers (`PAYMENT-REQUIRED`,
> `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`)."

HTTP error mapping (v2 transport spec):

| x402 Error       | HTTP Status |
| ---------------- | ----------- |
| Payment Required | 402         |
| Invalid Payment  | 400         |
| Payment Failed   | 402         |
| Server Error     | 500         |
| Success          | 200         |

---

## 2. PaymentRequirements

### 2.1 v1 shape (verbatim from `x402Specs.ts`)

```typescript
export const PaymentRequirementsSchema = z.object({
  scheme: z.enum(schemes),                          // ["exact"]
  network: NetworkSchema,
  maxAmountRequired: z.string().refine(isInteger),
  resource: z.string().url(),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.any()).optional(),
  payTo: EvmOrSvmAddress,
  maxTimeoutSeconds: z.number().int(),
  asset: mixedAddressOrSvmAddress,
  extra: z.record(z.any()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;
```

Per-scheme `extra` for `exact` on EVM (USDC):

```json
{ "name": "USDC", "version": "2" }
```

These are the EIP-712 domain `name` and `version` for `transferWithAuthorization`.

### 2.2 v2 shape (verbatim from spec section 5.1.2)

| Field Name          | Type     | Required | Description                                                                   |
| ------------------- | -------- | -------- | ----------------------------------------------------------------------------- |
| `scheme`            | `string` | Required | Payment scheme identifier (e.g., "exact")                                     |
| `network`           | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., "eip155:84532")         |
| `amount`            | `string` | Required | Required payment amount in atomic token units                                 |
| `asset`             | `string` | Required | Token contract address or ISO 4217 currency code for fiat                     |
| `payTo`             | `string` | Required | Recipient wallet address or role constant (e.g., "merchant")                  |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion                                   |
| `extra`             | `object` | Optional | Scheme-specific additional information                                        |

`resource` / `description` / `mimeType` move into a top-level `ResourceInfo`:

```typescript
{ url: string; description?: string; mimeType?: string }
```

### 2.3 Per-scheme variants

The repo currently only ships `exact`. The `upto` scheme is mentioned only as
an "envisioned" example in the README:

> "`exact`, the first scheme shipping as part of the protocol, would have
> different behavior than `upto`. `exact` transfers a specific amount (ex: pay
> $1 to read an article), while a theoretical `upto` would transfer up to an
> amount, based on the resources consumed during a request (ex: generating
> tokens from an LLM)."

The v2 spec note for `/settle` hints how `upto` would diverge:

> "in the `upto` scheme, the `amount` field in `paymentRequirements`
> represents the maximum authorized amount at verification time, but the
> actual amount to settle at settlement time."

Within `exact` on EVM, the v2 EVM scheme spec defines three asset transfer
methods, distinguished by `extra.assetTransferMethod`:

- `"eip3009"` (default; recommended for USDC) — payload contains `signature` +
  `authorization`.
- `"permit2"` — payload contains `signature` + `permit2Authorization`
  (`permitted`, `from`, `spender`, `nonce`, `deadline`, `witness:{to, validAfter}`).
  Spender is the canonical `x402ExactPermit2Proxy` at
  `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`.
- `"erc7710"` — payload contains `delegationManager`, `permissionContext`,
  `delegator`. Verified by simulating
  `delegationManager.redeemDelegations(...)`.

For your harness, default to `eip3009` and only branch if `extra.assetTransferMethod`
is set.

---

## 3. PaymentPayload

### 3.1 v1 shape (verbatim from `x402Specs.ts`)

```typescript
export const ExactEvmPayloadAuthorizationSchema = z.object({
  from: z.string().regex(EvmAddressRegex),
  to: z.string().regex(EvmAddressRegex),
  value: z.string().refine(isInteger).refine(hasMaxLength(EvmMaxAtomicUnits)), // EvmMaxAtomicUnits = 18
  validAfter: z.string().refine(isInteger),
  validBefore: z.string().refine(isInteger),
  nonce: z.string().regex(HexEncoded64ByteRegex), // /^0x[0-9a-fA-F]{64}$/
});

export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(EvmSignatureRegex), // /^0x[0-9a-fA-F]+$/
  authorization: ExactEvmPayloadAuthorizationSchema,
});

export const ExactSvmPayloadSchema = z.object({
  transaction: z.string().regex(Base64EncodedRegex),
});

export const PaymentPayloadSchema = z.object({
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  scheme: z.enum(schemes),
  network: NetworkSchema,
  payload: z.union([ExactEvmPayloadSchema, ExactSvmPayloadSchema]),
});
```

So a v1 EVM `PaymentPayload`, base64-decoded from `X-PAYMENT`, looks exactly
like:

```json
{
  "x402Version": 1,
  "scheme": "exact",
  "network": "base-sepolia",
  "payload": {
    "signature": "0x...65 bytes hex...",
    "authorization": {
      "from":  "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to":    "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "10000",
      "validAfter":  "1740672089",
      "validBefore": "1740672154",
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
    }
  }
}
```

All `value`/`validAfter`/`validBefore` are decimal strings (not numbers) of
`uint256`. `nonce` is a 0x-prefixed 32-byte hex string.

### 3.2 v2 shape (verbatim from spec 5.2)

```json
{
  "x402Version": 2,
  "resource": { "url": "...", "description": "...", "mimeType": "..." },
  "accepted": { /* PaymentRequirements object the client picked */ },
  "payload": {
    "signature": "0x...",
    "authorization": { "from": "...", "to": "...", "value": "...",
                       "validAfter": "...", "validBefore": "...", "nonce": "0x..." }
  },
  "extensions": {}
}
```

Key v2 differences vs v1: top-level `scheme`/`network` are gone; instead the
chosen `PaymentRequirements` is embedded as `accepted`. A `resource`
`ResourceInfo` and an `extensions` map are added.

---

## 4. EIP-3009 `transferWithAuthorization` Signing

### 4.1 Type definition (verbatim from `types/shared/evm/eip3009.ts`)

```typescript
export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export const authorizationPrimaryType = "TransferWithAuthorization";
```

### 4.2 Domain & message construction (verbatim from `schemes/exact/evm/sign.ts`)

```typescript
const data = {
  types: authorizationTypes,
  domain: {
    name,                              // from paymentRequirements.extra.name e.g. "USDC"
    version,                           // from paymentRequirements.extra.version e.g. "2"
    chainId,                           // getNetworkId(network) — see network table
    verifyingContract: getAddress(asset), // the ERC-20 token address
  },
  primaryType: "TransferWithAuthorization" as const,
  message: {
    from: getAddress(from),
    to:   getAddress(to),
    value,
    validAfter,
    validBefore,
    nonce,
  },
};
```

This is signed via `walletClient.signTypedData(data)` (viem) — i.e. an EIP-712
typed-data signature. Resulting signature is a 65-byte `0x...` hex string.

Verifier rebuilds the exact same EIP-712 domain + message and recovers the
signer; it must equal `authorization.from`.

### 4.3 Nonce, validAfter, validBefore (verbatim from `client.ts`)

```typescript
const nonce = createNonce();   // 32 random bytes via crypto.getRandomValues, toHex'd

const validAfter = BigInt(
  Math.floor(Date.now() / 1000) - 600,                 // 10 minutes before "now"
).toString();
const validBefore = BigInt(
  Math.floor(Date.now() / 1000 + paymentRequirements.maxTimeoutSeconds),
).toString();
```

```typescript
export function createNonce(): Hex {
  const cryptoObj =
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.getRandomValues === "function"
      ? globalThis.crypto
      : require("crypto").webcrypto;
  return toHex(cryptoObj.getRandomValues(new Uint8Array(32)));
}
```

Semantics:

- `validAfter` (uint256, unix seconds): authorization is invalid until this
  time. Set to `now - 600` to allow for clock skew (10 minute leeway).
- `validBefore` (uint256, unix seconds): authorization expires at this time.
  Set to `now + maxTimeoutSeconds` (60s default).
- `nonce` (bytes32): random per authorization. Reuse-protected at the
  ERC-20 contract level (EIP-3009 stores per-address nonce bitmap).

Replay protection (v1 spec 10.1): "EIP-3009 contracts inherently prevent nonce
reuse at the smart contract level."

---

## 5. Facilitator Endpoints

> Source: `useFacilitator.ts`, v1 spec §7, v2 spec §7.

### 5.1 POST `/verify`

Request body (v1, exactly what `useFacilitator.verify` posts):

```json
{
  "x402Version": 1,
  "paymentPayload": { /* PaymentPayload */ },
  "paymentRequirements": { /* PaymentRequirements */ }
}
```

Response (success):

```json
{ "isValid": true, "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66" }
```

Response (failure):

```json
{
  "isValid": false,
  "invalidReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

VerifyResponse type:

```typescript
export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.enum(ErrorReasons).optional(),
  payer: EvmOrSvmAddress.optional(),
});
```

### 5.2 POST `/settle`

Request body: identical structure to `/verify`.

Response (success):

```json
{
  "success": true,
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "0x1234...cdef",
  "network": "base-sepolia"
}
```

Response (failure):

```json
{
  "success": false,
  "errorReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "",
  "network": "base-sepolia"
}
```

SettleResponse type:

```typescript
export const SettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.enum(ErrorReasons).optional(),
  payer: EvmOrSvmAddress.optional(),
  transaction: z.string().regex(MixedAddressRegex),
  network: NetworkSchema,
});
```

The legacy SDK base64-encodes this exact JSON to produce the `X-PAYMENT-RESPONSE`
header value (`facilitator.ts` `settleResponseHeader`).

### 5.3 GET `/supported`

v1 response:

```json
{
  "kinds": [
    { "x402Version": 1, "scheme": "exact", "network": "base-sepolia" },
    { "x402Version": 1, "scheme": "exact", "network": "base" },
    { "x402Version": 1, "scheme": "exact", "network": "avalanche-fuji" },
    { "x402Version": 1, "scheme": "exact", "network": "avalanche" },
    { "x402Version": 1, "scheme": "exact", "network": "iotex" }
  ]
}
```

v2 response adds `extensions: []` and a `signers` map of CAIP-2 patterns to
signer addresses:

```json
{
  "kinds": [ /* { x402Version, scheme, network } objects */ ],
  "extensions": [],
  "signers": {
    "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"],
    "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
  }
}
```

### 5.4 GET `/discovery/resources` (Bazaar)

Query params: `type` (e.g. `"http"`), `limit` (1–100, default 20), `offset`
(default 0).

Response (v1):

```json
{
  "x402Version": 1,
  "items": [
    {
      "resource": "https://api.example.com/premium-data",
      "type": "http",
      "x402Version": 1,
      "accepts": [ /* PaymentRequirements[] */ ],
      "lastUpdated": 1703123456,
      "metadata": { "category": "finance", "provider": "Example Corp" }
    }
  ],
  "pagination": { "limit": 10, "offset": 0, "total": 1 }
}
```

> v2 spec adds the same query interface: `GET /discovery/resources?type=http&limit=10`.

`useFacilitator` fires off this request as `GET ${url}/discovery/resources?${qs}`.

### 5.5 Default facilitator URL (legacy SDK)

```typescript
const DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator";
```

This is the URL the legacy `useFacilitator()` falls back to if no
`FacilitatorConfig.url` is provided. It supports `base-sepolia` only — for
mainnet you must use the Coinbase facilitator below.

---

## 6. Coinbase Facilitator URL & Supported Networks

### 6.1 Coinbase-hosted (CDP) facilitator

From `@coinbase/x402@0.7.3`'s `dist/cjs/index.js` (verbatim):

```javascript
var COINBASE_FACILITATOR_BASE_URL = "https://api.cdp.coinbase.com";
var COINBASE_FACILITATOR_V2_ROUTE = "/platform/v2/x402";
```

Therefore the full facilitator base URL is:

> **`https://api.cdp.coinbase.com/platform/v2/x402`**

Endpoints become:

- `POST https://api.cdp.coinbase.com/platform/v2/x402/verify`
- `POST https://api.cdp.coinbase.com/platform/v2/x402/settle`
- `GET  https://api.cdp.coinbase.com/platform/v2/x402/supported`
- `GET  https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`

The package exports `createFacilitatorConfig(apiKeyId?, apiKeySecret?)` and a
default `facilitator` instance:

```javascript
function createFacilitatorConfig(apiKeyId, apiKeySecret) {
  return {
    url: `${COINBASE_FACILITATOR_BASE_URL}${COINBASE_FACILITATOR_V2_ROUTE}`,
    createAuthHeaders: createCdpAuthHeaders(apiKeyId, apiKeySecret),
  };
}
var facilitator = createFacilitatorConfig();
```

The auth headers function generates a per-request CDP JWT
(`generateJwt({ apiKeyId, apiKeySecret, requestMethod, requestHost, requestPath })`)
and attaches:

- `Authorization: Bearer <jwt>`
- `Correlation-Context: sdk_version=...,sdk_language=typescript,source=x402,source_version=...`

API keys come from `process.env.CDP_API_KEY_ID` and
`process.env.CDP_API_KEY_SECRET` if not passed explicitly.

For mainnet payments, the resource server (or your harness) is expected to
configure:

```typescript
import { facilitator } from "@coinbase/x402";
import { paymentMiddleware } from "x402-express";
app.use(paymentMiddleware(payTo, routes, facilitator));
```

### 6.2 Supported networks (verbatim from `network.ts`)

```typescript
export const NetworkSchema = z.enum([
  "abstract", "abstract-testnet",
  "base-sepolia", "base",
  "avalanche-fuji", "avalanche",
  "iotex",
  "solana-devnet", "solana",
  "sei", "sei-testnet",
  "polygon", "polygon-amoy",
  "peaq", "story", "educhain",
  "skale-base-sepolia",
]);

export const EvmNetworkToChainId = new Map<Network, number>([
  ["abstract", 2741],
  ["abstract-testnet", 11124],
  ["base-sepolia", 84532],
  ["base", 8453],
  ["avalanche-fuji", 43113],
  ["avalanche", 43114],
  ["iotex", 4689],
  ["sei", 1329],
  ["sei-testnet", 1328],
  ["polygon", 137],
  ["polygon-amoy", 80002],
  ["peaq", 3338],
  ["story", 1514],
  ["educhain", 41923],
  ["skale-base-sepolia", 324705682],
]);

export const SupportedSVMNetworks: Network[] = ["solana-devnet", "solana"];
export const SvmNetworkToChainId = new Map<Network, number>([
  ["solana-devnet", 103],
  ["solana", 101],
]);
```

The Coinbase docs page confirms the CDP-hosted facilitator:

> "The Coinbase Developer Platform (CDP) offers a Coinbase-hosted facilitator
> service that processes ERC-20 payments on Base, Polygon, Arbitrum, World,
> and Solana with a generous free tier of 1,000 transactions per month."

Note: `arbitrum` and `world` (World Chain) are not yet in the legacy-v1 zod
enum. They are likely accepted at the CDP facilitator API level (server-side
validation only); if you target Arbitrum / World Chain through CDP, expect to
extend the type union locally or to use raw strings.

---

## 7. Network Identifier Strings

**For v1 (the version you'll wire up first):**

- Base mainnet: `"base"` (NOT `"base-mainnet"`, NOT a chainId)
- Base Sepolia: `"base-sepolia"`
- Polygon: `"polygon"`
- Polygon Amoy testnet: `"polygon-amoy"`
- Avalanche: `"avalanche"`
- Avalanche Fuji: `"avalanche-fuji"`
- Solana: `"solana"`
- Solana devnet: `"solana-devnet"`
- IoTeX: `"iotex"`
- Sei / Sei testnet: `"sei"` / `"sei-testnet"`
- Abstract / Abstract testnet: `"abstract"` / `"abstract-testnet"`
- Peaq, Story, Educhain, Skale Base Sepolia: `"peaq"`, `"story"`, `"educhain"`, `"skale-base-sepolia"`

**For v2:** CAIP-2 strings.

> "Networks in x402 v2 use CAIP-2 (Chain Agnostic Improvement Proposal) format:
> `namespace:reference`. Format: `{namespace}:{reference}` (e.g., `eip155:8453`
> for Base mainnet)"

- Base mainnet: `"eip155:8453"`
- Base Sepolia: `"eip155:84532"`
- Avalanche Fuji: `"eip155:43113"`
- Avalanche mainnet: `"eip155:43114"`
- Solana mainnet: `"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"`
- Solana devnet: `"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"`

---

## 8. TypeScript SDK Packages

### 8.1 Legacy v1 packages (deployed today)

| npm package | Purpose | Primary export |
| ----------- | ------- | -------------- |
| `x402` | Core types, EIP-3009 signer, facilitator client | `useFacilitator`, `createPayment`, `signAuthorization`, schemas |
| `x402-fetch` | Wraps native `fetch` to auto-handle 402 | `wrapFetchWithPayment(fetch, walletClient, maxValue?, paymentRequirementsSelector?)` |
| `x402-axios` | Axios interceptor | `withPaymentInterceptor(axiosClient, walletClient)` |
| `x402-express` | Express middleware | `paymentMiddleware(payTo, routes, facilitator?, paywall?)` |
| `x402-hono` | Hono middleware | `paymentMiddleware(...)` (parallel signature) |
| `x402-next` | Next.js App Router middleware | `paymentMiddleware(...)` |
| `@coinbase/x402` | CDP-hosted facilitator config helper | `createFacilitatorConfig`, `facilitator`, `createCdpAuthHeaders` |

USDC contract addresses on testnets (from spec examples):
- Base Sepolia USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`

### 8.2 v2 packages (preview / next major)

From the GitHub repo README install snippet:

```shell
npm install @x402/core \
  @x402/evm @x402/svm @x402/stellar @x402/svm \
  @x402/axios @x402/fastify @x402/fetch @x402/express @x402/hono @x402/next @x402/paywall @x402/extensions
```

Minimal client install: `@x402/core @x402/evm @x402/svm @x402/fetch`.
Minimal server install: `@x402/core @x402/evm @x402/svm @x402/express`.

### 8.3 Minimal usage examples (v1, verbatim from package READMEs)

**`x402-fetch` client:**

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount("0xYourPrivateKey");
const client = createWalletClient({ account, transport: http(), chain: baseSepolia });

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPay("https://api.example.com/paid-endpoint", { method: "GET" });
const data = await response.json();
```

`maxValue` defaults to `0.1 USDC` (i.e. `100000` atomic units). Pass a larger
bigint to allow more.

**`x402-axios` client:**

```typescript
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withPaymentInterceptor } from "x402-axios";
import axios from "axios";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount("0xYourPrivateKey");
const client = createWalletClient({ account, transport: http(), chain: baseSepolia });

const api = withPaymentInterceptor(axios.create({ baseURL: "https://api.example.com" }), client);
const response = await api.get("/paid-endpoint");
```

**`x402-express` server middleware:**

```typescript
import express from "express";
import { paymentMiddleware, Network } from "x402-express";

const app = express();
app.use(paymentMiddleware(
  "0xYourAddress",
  {
    "/protected-route": {
      price: "$0.10",
      network: "base-sepolia",
      config: { description: "Access to premium content" }
    }
  }
));
app.get("/protected-route", (req, res) => res.json({ message: "behind paywall" }));
app.listen(3000);
```

`paymentMiddleware` config types:

```typescript
type RoutesConfig = Record<string, Price | RouteConfig>;
interface RouteConfig {
  price: Price;
  network: Network;       // "base" | "base-sepolia" | ...
  config?: PaymentMiddlewareConfig;
}
interface PaymentMiddlewareConfig {
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;     // default 60
  outputSchema?: Record<string, any>;
  customPaywallHtml?: string;
  resource?: string;
}
type FacilitatorConfig = {
  url: string;
  createAuthHeaders?: CreateHeaders;
};
```

**Mainnet (CDP) wiring:**

```typescript
import { paymentMiddleware } from "x402-express";
import { facilitator } from "@coinbase/x402";    // exports a pre-built FacilitatorConfig pointing at CDP
app.use(paymentMiddleware(payTo, routes, facilitator));
```

**Direct facilitator client (`x402` package):**

```typescript
import { useFacilitator } from "x402/verify";  // path varies; see useFacilitator.ts

const { verify, settle, supported, list } = useFacilitator({
  url: "https://api.cdp.coinbase.com/platform/v2/x402",
  createAuthHeaders: /* CDP JWT generator */,
});

const v = await verify(paymentPayload, paymentRequirements); // -> VerifyResponse
const s = await settle(paymentPayload, paymentRequirements); // -> SettleResponse
const k = await supported();                                  // -> SupportedPaymentKindsResponse
const items = await list({ type: "http", limit: 20 });        // -> ListDiscoveryResourcesResponse
```

The `useFacilitator` posts request bodies of shape:

```json
{
  "x402Version": <payload.x402Version>,
  "paymentPayload": <toJsonSafe(payload)>,
  "paymentRequirements": <toJsonSafe(paymentRequirements)>
}
```

with `Content-Type: application/json`, then merges in any auth headers
returned by `createAuthHeaders().{verify|settle|supported|list}`.

---

## 9. Discovery Resource (Bazaar) Type

```typescript
export const DiscoveredResourceSchema = z.object({
  resource: z.string(),
  type: z.enum(["http"]),
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  accepts: z.array(PaymentRequirementsSchema),
  lastUpdated: z.date(),
  metadata: z.record(z.any()).optional(),
});
```

`GET /discovery/resources?type=http&limit=20&offset=0` returns
`ListDiscoveryResourcesResponse` (paginated list of `DiscoveredResource`).

The Bazaar concept is described as a marketplace where resources can be
discovered by category, provider, or payment requirements; metadata is freeform
key-value.

---

## 10. EVM vs SVM Scheme Differences

> Source: `specs/x402-specification-v1.md` §6.2 & v2 §6.2.

EVM `exact` payload (as in §3 above): a signed EIP-3009
`TransferWithAuthorization` blob.

SVM `exact` payload: `{ "transaction": "<base64 SPL Token transaction>" }` —
i.e. the client builds and signs the entire Solana transaction client-side and
hands it to the facilitator to broadcast.

```typescript
export const ExactSvmPayloadSchema = z.object({
  transaction: z.string().regex(Base64EncodedRegex),
});
```

Verification rules on Solana (verbatim from spec §6.2):

- "Enforcing a strict instruction layout (Compute Unit Limit, Compute Unit
  Price, optional ATA Create, TransferChecked)"
- "Ensuring the facilitator fee payer does not appear in any instruction
  accounts and is not the transfer `authority` or `source`"
- "Bounding compute unit price to mitigate gas abuse"
- "Verifying the destination ATA matches the `payTo`/`asset` PDA and account
  existence rules"
- "Requiring the transfer `amount` to exactly equal `maxAmountRequired`"

Token support:

- EVM: ERC-20 implementing EIP-3009 (USDC primary).
- SVM: any SPL token, plus Token2022 program tokens.

Error codes specific to SVM (from `ErrorReasons` in `x402Specs.ts`):

```
invalid_exact_svm_payload_transaction
invalid_exact_svm_payload_transaction_amount_mismatch
invalid_exact_svm_payload_transaction_create_ata_instruction
invalid_exact_svm_payload_transaction_create_ata_instruction_incorrect_payee
invalid_exact_svm_payload_transaction_create_ata_instruction_incorrect_asset
invalid_exact_svm_payload_transaction_instructions
invalid_exact_svm_payload_transaction_instructions_length
invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction
invalid_exact_svm_payload_transaction_instructions_compute_price_instruction
invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high
invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked
invalid_exact_svm_payload_transaction_instruction_not_token_2022_transfer_checked
invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts
invalid_exact_svm_payload_transaction_fee_payer_transferring_funds
invalid_exact_svm_payload_transaction_not_a_transfer_instruction
invalid_exact_svm_payload_transaction_receiver_ata_not_found
invalid_exact_svm_payload_transaction_sender_ata_not_found
invalid_exact_svm_payload_transaction_simulation_failed
invalid_exact_svm_payload_transaction_transfer_to_incorrect_ata
settle_exact_svm_block_height_exceeded
settle_exact_svm_transaction_confirmation_timed_out
```

---

## 11. Full Error-Reasons Enum (verbatim, v1)

```typescript
export const ErrorReasons = [
  "insufficient_funds",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_value",
  "invalid_exact_evm_payload_signature",
  "invalid_exact_evm_payload_undeployed_smart_wallet",
  "invalid_exact_evm_payload_recipient_mismatch",
  /* ...SVM error codes (see §10)... */
  "invalid_network",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_scheme",
  "invalid_payment",
  "payment_expired",
  "unsupported_scheme",
  "invalid_x402_version",
  "invalid_transaction_state",
  "unexpected_settle_error",
  "unexpected_verify_error",
  "duplicate_settlement",
] as const;
```

Note v2 adds `invalid_exact_evm_payload_authorization_value_mismatch` (replaces
`..._value`) reflecting the move from "amount must >= required" (v1) to
"amount must == required exactly" (v2).

---

## 12. End-to-end Flow Recap

From the repo README (verbatim, condensed):

1. Client makes HTTP request to resource server.
2. Server responds `402 Payment Required` with a `PaymentRequired` object —
   v1: in JSON body; v2: as `PAYMENT-REQUIRED` base64 header.
3. Client picks one of `accepts`/`accepted` and constructs a `PaymentPayload`
   for that `(scheme, network)`.
4. Client retries with the payload —
   v1: as `X-PAYMENT` header (base64 JSON);
   v2: as `PAYMENT-SIGNATURE` header (base64 JSON).
5. Resource server verifies via `POST /verify` to facilitator (or locally).
6. If valid, server fulfils the request, then settles via `POST /settle`.
7. Server returns `200 OK` with the resource and a settlement header —
   v1: `X-PAYMENT-RESPONSE`;
   v2: `PAYMENT-RESPONSE`.

---

## 13. Implementation Recommendations for the Harness

- Target `x402Version: 1` first; mainnet uses CDP at
  `https://api.cdp.coinbase.com/platform/v2/x402` (the `/platform/v2/x402`
  path is the Coinbase route, NOT the protocol version).
- Use `network: "base"` for Base mainnet, `network: "base-sepolia"` for
  testing. Use string identifiers; v1 SDKs do not accept CAIP-2.
- Default asset for testing: USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
  on `base-sepolia`. `extra` must be `{ "name": "USDC", "version": "2" }` for
  the EIP-712 domain.
- Sign with viem's `signTypedData` and the exact `authorizationTypes` shown
  in §4.1; primary type `"TransferWithAuthorization"`; domain
  `verifyingContract = asset` (the USDC contract); chainId from
  `EvmNetworkToChainId`.
- Set `validAfter = floor(now/1000) - 600`, `validBefore = floor(now/1000) + maxTimeoutSeconds`,
  `nonce = 0x` + 32 random bytes.
- Wire format: base64 the JSON `PaymentPayload`, send as `X-PAYMENT`
  request header. On 200, base64-decode `X-PAYMENT-RESPONSE` for the
  `SettleResponse` (transaction hash).
- Cap auto-pay via a `maxValue` (legacy default: `0.1 USDC` = `100000`
  atomic units). Reject 402s with `accepts[i].maxAmountRequired` greater
  than the cap.
- Validate every `PaymentRequirements` against `PaymentRequirementsSchema`
  (zod) to short-circuit malformed servers before signing anything.
- For discovery / Bazaar lookups, hit
  `GET ${facilitator.url}/discovery/resources?type=http&limit=...&offset=...`.
