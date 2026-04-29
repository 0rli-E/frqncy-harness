# proposals/AGENT-AS-SERVICE.md — `frqncy-harness serve`

**Status:** Accepted (auto, milestone scope). Lands in v0.13.6 / v0.14.0.

**Companion proposals:** `AGENT-COMMERCE.md` (the wallet + identity + x402 substrate).

---

## Why

The harness's commerce arc has three legs:

1. **Identity** — register the agent on ERC-8004, serve `/.well-known/agent-card.json`. ✅ shipped.
2. **Pay** — wallet + x402-aware fetch + `pay` tool + auto-pay everywhere. ✅ shipped.
3. **Sell** — turn the agent's capabilities into a paid endpoint another agent can hit. ❌ until now.

Without (3), the harness can pay other agents but other agents can't pay this one. That's a one-way commerce path. FRQNCY's positioning is bilateral — its agents both consume and produce — so the harness needs a one-line way to monetize what it ships.

The unit of capability in the harness is already a **skill pack** (`~/.frqncy-harness/skills/<name>/SKILL.md`, YAML frontmatter + markdown body). Skills are how FRQNCY ships its content + opinions today: editorial values, content schemas, how-to snippets. Making each skill a paid HTTP route turns FRQNCY's existing knowledge surface into an economic primitive — one ship, one sell.

## What ships

A single CLI command:

```bash
frqncy-harness serve --skill <name> --price <usd> [--port 3030] [--pay-to 0x...]
```

Flags:
- `--skill <name>` (repeatable) — expose this skill at `POST /skills/<name>`
- `--price <usd>` — price per call in USD, applies to all `--skill` flags after it (resets between flags)
- `--port <n>` — default 3030
- `--pay-to <0x…>` — receiver address; defaults to `signer.smartAccount ?? signer.address`
- `--network base|base-sepolia` — defaults to `FRQNCY_NETWORK`

Or via `~/.frqncy-harness/config.json`:

```json
{
  "serve": {
    "routes": [
      { "skill": "frqncy-editorial", "priceUsdCents": 5 },
      { "skill": "weekly-update", "priceUsdCents": 25 }
    ]
  }
}
```

Server boots with:

| Path | Method | Behavior |
|---|---|---|
| `/.well-known/agent-card.json` | GET | A2A AgentCard (existing) |
| `/.well-known/agent-registration.json` | GET | EIP-8004 registration proof (existing) |
| `/healthz` | GET | `{ status: "ok" }` |
| `/skills/<name>` | POST | x402-paid. Body = `{ input: string }`. Response = `{ output: string, model, conversationId, usage }` |

The 402 wire flow on `/skills/<name>`:

1. First request without `X-PAYMENT` → 402 + `accepts: [PaymentRequirements]`
2. Client signs EIP-3009 USDC `transferWithAuthorization`, retries with `X-PAYMENT`
3. Server calls `facilitator.verify` → `facilitator.settle`
4. Server runs `chat({ system: skill.body, messages: [{ role: 'user', content: input }] })`
5. Returns 200 with `X-PAYMENT-RESPONSE` (settled tx hash) + `{ output, model, conversationId, usage }`
6. `payment` trace record (direction: 'in') written via `createInboundPaymentTraceWriter`

Reuses everything already built:
- `paymentMiddleware` (server-side x402 gating)
- `createFacilitatorClient` (CDP facilitator default, configurable)
- `createInboundPaymentTraceWriter` (trace records)
- `serveAgentCard` (.well-known endpoints)
- `loadSkills` + skill body as system prompt
- `chat()` (existing LLM dispatch)

## Locked decisions

1. **Skills are the unit, not arbitrary HarnessTools.** Tools have side effects (bash, file write, etc.) — exposing them as paid endpoints would invite abuse. Skills are pure prompt-shaping; paid skills are bounded LLM calls.
2. **No streaming response in v1.** The 402 settle has to complete before the response body starts; SSE-on-402 is a v2 concern. v1 is request/response only.
3. **One skill = one route.** No skill composition at the HTTP layer; users compose by writing a new skill.
4. **Default `pay-to` to the smart account when present.** Smart account holds funds; that's where settled USDC should land. Falls back to EOA when no smart account.
5. **Free tier: zero price → free route.** If `priceUsdCents === 0` the route bypasses `paymentMiddleware`. Useful for agent demo / discovery / preview endpoints.
6. **Per-route model override (optional).** A skill route can pin a specific `model` so the operator's per-skill pricing is predictable.
7. **Cost-cap independence.** The serve command does NOT inherit the LLM cost cap from the user's config — incoming paid calls have a different economics; the price the operator charges is the budget. Operators set their own LLM costs in config; if the LLM call costs more than what the customer paid, that's a pricing-error operator concern, not a hard-abort.

## What we're NOT building (this pass)

- A2A wire protocol (full skill-discovery via JSON-RPC) — declared in the AgentCard already; the wire is a v2 add.
- Streaming responses behind 402.
- Per-customer rate limiting / DoS protection — operators put a real reverse proxy in front for that.
- TLS termination — same.
- Tool exposure (only skills are paid v1).
- Persistent state across calls — each request runs a fresh `chat()`.
- Auth other than x402 — no API keys, no OAuth.

## Module layout

```
src/serve/
  index.ts        # createAgentServer factory, public exports
  skill-route.ts  # build a paid POST handler from a LoadedSkill
  server.ts       # node:http server combining .well-known + skill routes
  config.ts       # ServeConfigSchema (Zod) — config.serve.routes block
src/commands/serve.ts   # CLI command
```

## Surface for FRQNCY

The harness ships; FRQNCY uses it like so:

```bash
# 1) Author skills as markdown packs (FRQNCY already does this for content tone/voice)
ls ~/.frqncy-harness/skills/
#   frqncy-editorial/SKILL.md
#   weekly-update/SKILL.md
#   content-schema-validator/SKILL.md

# 2) Spin up the agent service
frqncy-harness serve \
  --skill frqncy-editorial   --price 0.05 \
  --skill weekly-update      --price 0.25 \
  --skill content-schema-validator --price 0.01 \
  --port 8080

# 3) Other agents pay 5¢ to access FRQNCY editorial voice for one prompt,
#    25¢ to generate a weekly-update draft, 1¢ to validate against schema.
```

The harness's existing trace + gain + history surface this revenue automatically:

```bash
frqncy-harness pay history --direction in
# 2026-04-30T10:14Z  ← $0.05  base  settled tx=0xabc…  /skills/frqncy-editorial
# 2026-04-30T10:11Z  ← $0.25  base  settled tx=0xdef…  /skills/weekly-update

frqncy-harness gain --period 7d
# x402 spend
#   ← base       $4.20   168 settlements, 42 conv  (revenue!)
#   → base       $0.30     6 settlements,  3 conv  (cost)
#   net: $3.90
```

That's the integration loop closed at the FRQNCY layer.

## Open questions for v0.14

1. Should paid skill responses be VC-wrapped (Catena ACK pattern) so the customer can show proof of receipt elsewhere? Probably yes; defer to a follow-up.
2. Should the AgentCard auto-publish prices for served routes? Yes — `withPayments` already accepts a `resources` map; the serve command should populate it.
3. Should the harness sign the AgentCard's served prices to prevent post-hoc tampering? Maybe; ERC-8004 doesn't require it.
4. Should there be an upper bound on concurrent paid calls? Operators want this. v2.
