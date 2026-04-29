# ERC-8004: Trustless Agents — Implementation Reference

**Source:** [https://eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004)
**Status (as of 2026-04-29):** DRAFT (per yellow "Draft" badge at the top of the canonical EIP page)
**Created:** 2025-08-13 (per `<th>Created</th>` row in the preamble)
**Authors:** Marco De Rossi (@MarcoMetaMask), Davide Crapis (@dcrapis) <davide@ethereum.org>, Jordan Ellis <jordanellis@google.com>, Erik Reppel <erik.reppel@coinbase.com>
**Requires:** EIP-155, EIP-712, EIP-721, EIP-1271
**License:** CC0
**Citation date in spec:** "August 2025"

This document is a verbatim extraction from the canonical EIP-8004 page. All Solidity / JSON / event signatures are quoted exactly as the spec presents them. Sections that are NOT present in the spec text (e.g., a finalized deployment date, canonical mainnet/testnet contract addresses) are explicitly called out below.

---

## 1. Solidity ABI / Function Signatures

The spec organises the protocol into three lightweight per-chain singleton registries: **Identity Registry**, **Reputation Registry**, and **Validation Registry**. The Identity Registry is an ERC-721 (with the URIStorage extension) contract; the other two are linked to it by `initialize(address identityRegistry_)` and `getIdentityRegistry()`.

### 1.1 IdentityRegistry

The Identity Registry is `ERC721URIStorage` (ERC-721 + URIStorage extension). The `tokenId` is the `agentId`; the `tokenURI` is the `agentURI`. The token owner is the agent owner; ownership transfer / operator approval follow ERC-721 semantics. All ERC-721 functions (`ownerOf`, `safeTransferFrom`, `approve`, `setApprovalForAll`, `tokenURI`, etc.) are inherited and not redeclared in the spec — implementers must include them.

#### Structs

```solidity
struct MetadataEntry {
string metadataKey;
bytes metadataValue;
}
```

#### Functions — On-chain metadata

```solidity
function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory)
function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external
```

#### Functions — Reserved `agentWallet` key

The key `agentWallet` is reserved and **cannot** be set via `setMetadata()` or during `register()` (including the metadata-array overload). It is initially set to the owner's address. Changing it requires the new wallet to prove control via an EIP-712 signature (EOAs) or an ERC-1271 signature (smart-contract wallets):

```solidity
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external
function getAgentWallet(uint256 agentId) external view returns (address)
function unsetAgentWallet(uint256 agentId) external
```

When the agent NFT is transferred, `agentWallet` is automatically cleared (reset to the zero address) and must be re-verified by the new owner.

#### Functions — Registration (three overloads)

```solidity
function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId)

function register(string agentURI) external returns (uint256 agentId)

// agentURI is added later with setAgentURI()
function register() external returns (uint256 agentId)
```

A successful `register()` emits one `Transfer` event (from ERC-721), one `MetadataSet` event for the reserved `agentWallet` key, one `MetadataSet` event for each additional metadata entry (if any), and one `Registered` event.

#### Functions — Updating the agentURI

```solidity
function setAgentURI(uint256 agentId, string calldata newURI) external
```

#### Events

```solidity
event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)

event Registered(uint256 indexed agentId, string agentURI, address indexed owner)

event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)
```

Plus all standard ERC-721 events (`Transfer`, `Approval`, `ApprovalForAll`).

---

### 1.2 ReputationRegistry

The Reputation Registry is initialized post-deploy with the `identityRegistry` address.

#### Functions — Initialization & accessor

```solidity
function getIdentityRegistry() external view returns (address identityRegistry)
```

(Initialization is performed via `initialize(address identityRegistry_)`, called once on deploy.)

#### Functions — Giving Feedback

```solidity
function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external
```

Rules: the `agentId` must be a registered agent. `valueDecimals` MUST be in `[0, 18]`. The submitter MUST NOT be the agent owner or an approved operator for `agentId`. `tag1`, `tag2`, `endpoint`, `feedbackURI`, and `feedbackHash` are OPTIONAL. `feedbackHash` is the KECCAK-256 (`keccak256`) hash of the content at `feedbackURI`; for IPFS / content-addressed URIs it can be `bytes32(0)`.

#### Functions — Revoking Feedback

```solidity
function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external
```

#### Functions — Appending Responses

Anyone (e.g., the agent showing a refund, or a third-party data aggregator tagging spam) can call:

```solidity
function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string calldata responseURI, bytes32 responseHash) external
```

#### Functions — Read

```solidity
function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
// agentId and clientAddresses are mandatory; tag1 and tag2 are optional filters.
// clientAddresses MUST be provided (non-empty); results without filtering by clientAddresses are subject to Sybil/spam attacks. See Security Considerations for details

function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)

function readAllFeedback(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2, bool includeRevoked) external view returns (address[] memory clients, uint64[] memory feedbackIndexes, int128[] memory values, uint8[] memory valueDecimals, string[] memory tag1s, string[] memory tag2s, bool[] memory revokedStatuses)
// agentId is the only mandatory parameter; others are optional filters. Revoked feedback are omitted by default.

function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex, address[] responders) external view returns (uint64 count)
// agentId is the only mandatory parameter; others are optional filters.

function getClients(uint256 agentId) external view returns (address[] memory)

function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64)
```

#### Events

```solidity
event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)

event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)

event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)
```

Storage note (per spec): `value`, `valueDecimals`, `tag1`, `tag2`, and `isRevoked` are stored on-chain along with the `feedbackIndex` (a 1-indexed counter of feedback submissions that `clientAddress` has given to `agentId`). The fields `endpoint`, `feedbackURI`, and `feedbackHash` are emitted as event data but **are not stored**.

---

### 1.3 ValidationRegistry

Initialized identically to the Reputation Registry — `initialize(address identityRegistry_)` plus `getIdentityRegistry()`.

#### Functions — Validation Request

```solidity
function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external
```

MUST be called by the owner or operator of `agentId`. `requestURI` points to off-chain data containing inputs and outputs the validator needs. `requestHash` = `keccak256` of the request payload and acts as the request identifier. All four fields are mandatory.

#### Functions — Validation Response

```solidity
function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external
```

Only `requestHash` and `response` are mandatory; `responseURI`, `responseHash`, and `tag` are optional. MUST be called by the `validatorAddress` named in the original request. `validationResponse()` may be called multiple times for the same `requestHash` (for progressive states, e.g., "soft finality" then "hard finality" via `tag`).

#### Functions — Read

```solidity
function getValidationStatus(bytes32 requestHash) external view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)

//Returns aggregated validation statistics for an agent. agentId is the only mandatory parameter; validatorAddresses and tag are optional filters
function getSummary(uint256 agentId, address[] calldata validatorAddresses, string tag) external view returns (uint64 count, uint8 averageResponse)

function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes)

function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes)
```

#### Events

```solidity
event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)

event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)
```

Stored fields per the spec: `requestHash`, `validatorAddress`, `agentId`, `response`, `responseHash`, `lastUpdate`, `tag`.

---

## 2. Agent-Card / Registration-File JSON Schema

Agents are uniquely identified globally by:

- **agentRegistry**: a colon-separated string `{namespace}:{chainId}:{identityRegistry}` — e.g., `eip155:1:0x742...`
  - **namespace**: chain family identifier (`eip155` for EVM chains)
  - **chainId**: blockchain network identifier
  - **identityRegistry**: address of the ERC-721 registry contract
- **agentId**: ERC-721 `tokenId` assigned incrementally by the registry

The `agentURI` (ERC-721 `tokenURI`) MUST resolve to the registration file. It MAY be `ipfs://cid`, `https://example.com/agent3.json`, or a base64-encoded `data:` URI such as `data:application/json;base64,eyJ0eXBlIjoi...` (for fully on-chain metadata).

**Verbatim registration file schema (jsonc):**

```jsonc
{
  "type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  "name": "myAgentName",
  "description": "A natural language description of the Agent, which MAY include what it does, how it works, pricing, and interaction methods",
  "image": "https://example.com/agentimage.png",
  "services": [
   {
      "name": "web",
      "endpoint": "https://web.agentxyz.com/"
    },
    {
      "name": "A2A",
      "endpoint": "https://agent.example/.well-known/agent-card.json",
      "version": "0.3.0"
    },
    {
      "name": "MCP",
      "endpoint": "https://mcp.agent.eth/",
      "version": "2025-06-18"
    },
    {
      "name": "OASF",
      "endpoint": "ipfs://{cid}",
      "version": "0.8", // https://github.com/agntcy/oasf/tree/v0.8.0
      "skills": [], // OPTIONAL
      "domains": [] // OPTIONAL
    },
    {
      "name": "ENS",
      "endpoint": "vitalik.eth",
      "version": "v1"
    },
    {
      "name": "DID",
      "endpoint": "did:method:foobar",
      "version": "v1"
    },
    {
      "name": "email",
      "endpoint": "mail@myagent.com"
    }
  ],
  "x402Support": false,
  "active": true,
  "registrations": [
    {
      "agentId": 22,
      "agentRegistry": "{namespace}:{chainId}:{identityRegistry}" // e.g. eip155:1:0x742...
    }
  ],
  "supportedTrust": [
    "reputation",
    "crypto-economic",
    "tee-attestation"
  ]
}
```

**Field rules** (verbatim from the spec):

- `type`, `name`, `description`, and `image` SHOULD ensure compatibility with ERC-721 apps.
- The number and type of `endpoints` are fully customizable; developers may add as many as they wish.
- The `version` field in endpoints is a SHOULD, not a MUST.
- Agents MAY advertise endpoints pointing to A2A agent cards, MCP endpoints, ENS names, DIDs, or wallets on any chain (even chains where the agent is not registered).
- Agents SHOULD have at least one registration (multiple are allowed). All fields in the registration are mandatory.
- `supportedTrust` is OPTIONAL. If absent or empty, the ERC is used only for discovery, not for trust.

---

## 3. EIP-191 / ERC-1271 — `setAgentWallet` Authorization Payload

EIP-8004 does **not** define a separate authorization scheme for feedback submission: any wallet can call `giveFeedback` directly (subject to the rule that the submitter MUST NOT be the agent owner or an approved operator). The spec's only EIP-712 / ERC-1271 signature requirement is on **wallet rotation** (`setAgentWallet`):

> The key `agentWallet` is reserved and cannot be set via `setMetadata()` or during `register()` (including the metadata array overload). It represents the address where the agent receives payments and is initially set to the owner's address. To change it, the agent owner must prove control of the new wallet by providing a valid EIP-712 signature for EOAs or ERC-1271 for smart contract wallets — by calling:

```solidity
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external
```

**Replay protection / expiration semantics:**

- The `deadline` parameter is a UNIX timestamp after which the signature MUST NOT be accepted (this is the spec's expiration field).
- The signature MUST be over (at minimum) the tuple binding `(agentId, newWallet, deadline)` together with the registry's EIP-712 domain (chainId + verifying contract address), such that the signature cannot be replayed across registries, chains, or to other agents.
- Smart-contract wallets MUST be supported via ERC-1271 (`isValidSignature`), so callers cannot assume an EOA `ecrecover` path.
- On agent transfer, `agentWallet` is automatically cleared (reset to `address(0)`) and must be re-verified by the new owner — this is the only revocation/replay protection beyond the deadline.

> Note: the spec does not publish a verbatim EIP-712 typed-data hash struct (e.g., `SetAgentWallet(uint256 agentId, address newWallet, uint256 deadline)`). Implementers must define one and pin it via the contract's EIP-712 `DOMAIN_SEPARATOR`. There is no separate EIP-191 personal-sign payload defined for feedback.

---

## 4. Validation Request / Response Payloads & Result Conventions

### 4.1 On-chain request

```solidity
function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external
```

- `validatorAddress`: the smart-contract or EOA validator that will respond.
- `agentId`: the agent requesting validation; caller MUST be the owner or operator of this agent.
- `requestURI`: off-chain pointer to the full payload (inputs + outputs needed for the validator to verify).
- `requestHash`: `keccak256` of the request payload — also serves as the **unique request identifier**.

### 4.2 On-chain response

```solidity
function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag) external
```

- `response` (`uint8`): a value between **0 and 100**. Per the spec: "*can be used as binary (0 for failed, 100 for passed) or with intermediate values for validations with a spectrum of outcomes.*"
- `responseURI` (optional): off-chain evidence / audit of the validation.
- `responseHash` (optional): `keccak256` commitment of the off-chain resource (omit for IPFS / content-addressed URIs).
- `tag` (optional, `string`): "*allows for custom categorization or additional data.*" The spec calls out **progressive validation states** (e.g., `"soft finality"` then `"hard finality"`) as the canonical use case for `tag`. Multiple `validationResponse()` calls with the same `requestHash` are permitted for this exact reason.

### 4.3 Stored fields

The contract stores: `requestHash`, `validatorAddress`, `agentId`, `response`, `responseHash`, `lastUpdate`, and `tag`.

Incentives and slashing are explicitly out of scope: "*Incentives and slashing related to validation are managed by the specific validation protocol and are outside the scope of this registry.*"

### 4.4 Result-code convention summary

| `response` value | Meaning |
|---|---|
| `0` | Failed (binary mode) |
| `100` | Passed (binary mode) |
| `1`–`99` | Spectrum of partial-pass outcomes (validator-defined) |

The `tag` field is the open-ended "result-code-of-codes" — validators are free to define their own taxonomies. The spec gives only `"soft finality"` / `"hard finality"` as worked examples.

---

## 5. Canonical Deployed Addresses & Finalization Date

**The canonical EIP-8004 page does NOT publish any contract addresses on Base mainnet, Ethereum mainnet, or any testnet.** No address tables, no "Reference Implementation" deployment block, no "Deployed Addresses" appendix is present in the spec text.

The spec's Rationale section explicitly notes only the deployment intent:

> "*We expect the registries to be deployed with singletons per chain. Note that an agent registered and receiving feedback on chain A can still operate and transact on other chains. Agents can also be registered on multiple chains if desired.*"

**Finalization date:** ERC-8004 is **still in DRAFT status** as of the canonical page render captured for this report (yellow `Draft` badge in the EIP header). The metadata fields are:

- `Created`: 2025-08-13
- `dateCreated` / `datePublished` (JSON-LD): `2025-08-13`
- `copyrightYear`: `2025`
- Citation footer: "*ERC-8004: Trustless Agents [DRAFT], Ethereum Improvement Proposals, no. 8004, August 2025.*"

There is no finalized/`Final` status, no "moved to Final on …" date, and no deployment date on the canonical EIP page. Any chain-specific deployment addresses (Base mainnet, Ethereum mainnet, Sepolia, Base Sepolia, etc.) must be sourced separately from the reference implementation repo or the discussion thread at `https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098` — they are not in the EIP itself.

---

## 6. `/.well-known/` Path Conventions

EIP-8004 references **two** `/.well-known/` paths, one of which it defines and one of which it merely points at via A2A:

### 6.1 `/.well-known/agent-registration.json` (defined by EIP-8004)

Used for **optional endpoint-domain verification**. Verbatim:

> "*Since endpoints can point to domains not controlled by the agent owner, an agent MAY optionally prove control of an HTTPS endpoint-domain by publishing `https://{endpoint-domain}/.well-known/agent-registration.json` containing at least a `registrations` list (or the full agent registration file). Users MAY treat the endpoint-domain as verified if the file is reachable over HTTPS and includes a `registrations` entry whose `agentRegistry` and `agentId` match the on-chain agent; if the endpoint-domain is the same domain that serves the agent's primary registration file referenced by `agentURI`, this additional check is not needed because domain control is already demonstrated there.*"

So the minimum body for verification is:

```jsonc
{
  "registrations": [
    {
      "agentId": 22,
      "agentRegistry": "eip155:1:0x742..."
    }
  ]
}
```

…or the entire registration file (the same shape as Section 2 above). Verification rule: an `https://` reachable file whose `registrations[*].agentRegistry` and `registrations[*].agentId` match the on-chain agent.

### 6.2 `/.well-known/agent-card.json` (referenced from A2A)

The example registration file uses the A2A endpoint:

```jsonc
{
  "name": "A2A",
  "endpoint": "https://agent.example/.well-known/agent-card.json",
  "version": "0.3.0"
}
```

This path is owned by the A2A spec, not EIP-8004 — EIP-8004 simply references it as the canonical location an agent uses to advertise its A2A AgentCard.

---

## Appendix A — Canonical `tag1` Examples for Reputation `value` / `valueDecimals`

Verbatim from the spec's table:

| `tag1` | What it measures | Example human value | `value` | `valueDecimals` |
|---|---|---|---|---|
| `starred` | Quality rating (0-100) | `87/100` | `87` | `0` |
| `reachable` | Endpoint reachable (binary) | `true` | `1` | `0` |
| `ownerVerified` | Endpoint owned by agent owner (binary) | `true` | `1` | `0` |
| `uptime` | Endpoint uptime (%) | `99.77%` | `9977` | `2` |
| `successRate` | Endpoint success rate (%) | `89%` | `89` | `0` |
| `responseTime` | Response time (ms) | `560ms` | `560` | `0` |
| `blocktimeFreshness` | Avg block delay (blocks) | `4 blocks` | `4` | `0` |
| `revenues` | Cumulative revenues (e.g., USD) | `$560` | `560` | `0` |
| `tradingYield` (`tag2` = `day, week, month, year`) | Yield | `-3,2%` | `-32` | `1` |

---

## Appendix B — Off-Chain Feedback File Structure (verbatim)

The OPTIONAL JSON file referenced by `feedbackURI`:

```jsonc
{
  // MUST FIELDS
  "agentRegistry": "eip155:1:{identityRegistry}",
  "agentId": 22,
  "clientAddress": "eip155:1:{clientAddress}",
  "createdAt": "2025-09-23T12:00:00Z",
  "value": 100,
  "valueDecimals": 0,

  // ALL OPTIONAL FIELDS
  "tag1": "foo",
  "tag2": "bar",
  "endpoint": "https://agent.example.com/GetPrice",

  "mcp": { "tool": "ToolName" }, // or: { "prompt": "PromptName" } / { "resource": "ResourceName" }

  // A2A: see "Context Identifier Semantics" and Task model in the A2A specification.
  "a2a": {
    "skills": ["as-defined-by-A2A"], // e.g., AgentSkill identifiers
    "contextId": "as-defined-by-A2A",
    "taskId": "as-defined-by-A2A"
  },

  "oasf": {
    "skills": ["as-defined-by-OASF"],
    "domains": ["as-defined-by-OASF"]
  },

  "proofOfPayment": { // this can be used for x402 proof of payment
	  "fromAddress": "0x00...",
	  "toAddress": "0x00...",
	  "chainId": "1",
	  "txHash": "0x00..."
   },

 // Other fields
  " ... ": { " ... " } // MAY
}
```

---

## Implementation Notes for a TypeScript Client

1. **ABI generation.** The function signatures in Section 1 are sufficient to hand-write a viem / ethers TS ABI. ERC-721 base methods (`ownerOf`, `tokenURI`, `safeTransferFrom`, `setApprovalForAll`, `isApprovedForAll`, `approve`, `getApproved`, `balanceOf`, plus the `Transfer` / `Approval` / `ApprovalForAll` events) must be merged in for IdentityRegistry — the spec inherits them silently.
2. **`int128 value` + `uint8 valueDecimals` decoding.** The reputation value is a *signed* fixed-point: real value = `value / 10**valueDecimals`. `valueDecimals` is constrained to `[0, 18]`.
3. **`requestHash` derivation.** `requestHash = keccak256(canonicalize(requestPayload))`. The spec does not pin a canonicalization (JCS, RFC 8785, etc.) — implementers must standardise one for their validator network or the hash will mismatch.
4. **CAIP-10-style identifiers.** `agentRegistry` strings are CAIP-2-shaped (`eip155:1:<address>`); the off-chain feedback file uses CAIP-10-shaped client addresses (`eip155:1:<address>`).
5. **Discovery sequence.** (a) Read `tokenURI(agentId)` to fetch the registration file; (b) for each `services[i].endpoint` whose domain you don't already trust, optionally fetch `https://{endpoint-domain}/.well-known/agent-registration.json` and verify a matching `registrations[*]` entry; (c) consume the A2A AgentCard or MCP endpoint per their respective specs.
6. **Wallet rotation flow.** Build an EIP-712 typed-data struct (e.g., `SetAgentWallet(uint256 agentId, address newWallet, uint256 deadline)`) with the registry's domain separator, sign it with the **new** wallet's key (or its ERC-1271 contract), then call `setAgentWallet(agentId, newWallet, deadline, signature)` from the agent owner. Remember that any NFT transfer wipes `agentWallet` and forces re-signature.
7. **Indexing.** All meaningful events (`Registered`, `URIUpdated`, `MetadataSet`, `NewFeedback`, `FeedbackRevoked`, `ResponseAppended`, `ValidationRequest`, `ValidationResponse`) are designed for subgraph-style indexing. `tag1` is `indexed` on `NewFeedback` (as `indexedTag1`) — useful for skill / capability filtering.
8. **No deployed addresses in the spec.** When packaging your TS client, source addresses from the reference implementation repo / the EIP discussion thread, not from the EIP page itself.
