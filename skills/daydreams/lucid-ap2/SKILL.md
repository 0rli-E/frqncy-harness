---
name: lucid-ap2
description: Agent Payments Protocol (AP2) — Google's open protocol for autonomous agent commerce with merchant / shopper / verifier / auditor roles. Mirrors `@lucid-agents/ap2`. Use when the user wants to declare AP2 capability, broker a multi-party transaction, or build an audit trail for agent commerce.
keywords: [ap2, agent payments protocol, merchant, shopper, verifier, auditor, agentic commerce, google ap2]
---

# Agent Payments Protocol (AP2)

AP2 is Google's open protocol for autonomous agent commerce. It defines
four roles (merchant, shopper, verifier, auditor) and a flow for multi-
party transactions where the shopper agent authorizes spending, the
merchant agent provides goods/services, the verifier checks the
transaction, and the auditor logs it for compliance.

## Declaring AP2 capability

The harness's AgentCard composer already supports it via `withA2A`:

```js
import { AgentCardSchema, withA2A } from "@frqncy-network/harness/identity";
let card = AgentCardSchema.parse({ name: "frqncy", description: "..." });
card = withA2A(card, { ap2Roles: ["merchant"] });
// now card.capabilities.extensions[].uri === "https://github.com/google-agentic-commerce/AP2"
```

Then `frqncy-harness identity card --out agent-card.json` writes the card
with the AP2 declaration so other agents can see what AP2 roles you
support before initiating a flow.

## When to act as merchant

The seller in an AP2 flow. The harness's `serve` command already does
this for paid skills — extend with AP2's structured `mandate` /
`receipt` envelopes by adding a new route handler that wraps the existing
skill response in an AP2-shaped JSON object.

## When to act as shopper

The buyer. The harness's `pay` tool + `web_fetch` auto-pay handle the
mechanics; AP2 adds a "shopping mandate" the user signs off-line that
authorizes the agent to spend up to $X with merchant Y on resource Z.

## When to act as verifier / auditor

These roles inspect transactions for compliance. The harness's never-
compacted trace + Verifiable Settlement Receipts already provide the raw
evidence; an AP2 verifier wraps them in a `verification credential` the
auditor reads.

## v1 status

Full AP2 wire protocol is NOT implemented in v0.14 — only the capability
declaration. Roadmap: v0.16 ships AP2 mandate signing + verification.

## What you should NOT do

- Don't claim AP2 compliance (full mandate flow) until v0.16. Today the
  harness only declares capability.
- Don't broker a multi-party AP2 flow without explicit user authorization
  for each role you're assuming.
