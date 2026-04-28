# Proposal: The harness as the LLM substrate beneath the FRQNCY OS Phase 2 org

**Status:** Draft — operator review
**Author:** harness-side
**Date:** 2026-04-28
**Related:**
- FRQNCY WEBSITE / `frqncy-phase2-plan.html` v0.3 (2026-04-24)
- FRQNCY WEBSITE / `proposals/EXECUTION-PLAN-90D.md` (locked 2026-04-27)
- harness `AGENT.md` decision 11 (Hermes Agent as the daemon shell)
- harness `hermes-skill.md` (the existing Hermes skill packaging)

---

## The reconciliation gap

FRQNCY currently has two stacked architectures that were designed in parallel and don't talk to each other yet.

**Layer 1 — The harness (`@frqncy/harness` v0.7.0-alpha.1+).** TypeScript provider-indifferent library + CLI. Nine provider lanes after today's perplexity + claude-sdk additions. Tools: bash + file primitives + web + MCP. Trace store at `~/.frqncy-harness/traces/`, never compacted, mirror-able to a private GitHub repo. Cost guardrails, lethal-trifecta gate, hooks, thread/project tagging, sandbox. 204 tests green.

**Layer 2 — The Phase 2 OS (`frqncy-phase2-plan.html`).** The agent org living on the Hostinger VPS. n8n routes Telegram messages through FRQNCY (the routing brain) to the CEO, the seven-spirit Council, the C-Suite, the 19 Workers, and the meta-tier Learning Agent. Three memory layers underneath: n8n native (working) + Supabase pgvector (long-term) + Graphiti/FalkorDB (context graph, deferred to Month 2+).

The gap: **Phase 2 currently calls for n8n's AI Agent nodes to talk to Groq + OpenRouter directly, bypassing the harness entirely.** This was a reasonable design at the time of writing (2026-04-24, before today's harness additions), but it leaves Phase 2 without trace integrity, without the cost guardrails, without the lethal-trifecta gate, without MCP, and without the new `claude-sdk` and `perplexity` lanes that ship today.

This proposal formalizes how to wire Layer 1 underneath Layer 2 so the org gets the harness's properties without throwing away the n8n+Telegram+Supabase Phase 2 design.

## What the integration looks like at the runtime level

The split is clean:

- **n8n owns:** workflow orchestration, Telegram webhook in/out, Supabase reads/writes, scheduling/cron, the Approve/Revise UI loop, the assignment of work to personas
- **The harness owns:** the actual LLM calls, provider routing, tool execution, trace logging, cost guardrails, MCP server hosting, lethal-trifecta enforcement
- **Hermes is the bridge** (per `hermes-skill.md` + `AGENT.md` decision 11): a long-running daemon on the same VPS that n8n's HTTP Request nodes call into; Hermes invokes the harness CLI; results return to n8n via the same HTTP cycle

The data path for one user message:

```
Telegram → n8n webhook (Phase 2 plan §05 approval loop)
        → n8n FRQNCY-Interface workflow assigns work to a persona
        → n8n HTTP Request node → Hermes daemon (gateway URL)
        → Hermes invokes the frqncy-harness skill
        → harness chat() / agent() runs the appropriate provider lane
        → trace appended to ~/.frqncy-harness/traces/<date>/<convo-id>.jsonl
        → harness returns the response to Hermes
        → Hermes returns to n8n
        → n8n writes to Supabase agent_outputs (status: pending)
        → n8n sends Telegram message with Approve/Revise buttons
```

The **return path** on Approve/Revise:

```
Telegram button tap → n8n webhook
                   → n8n updates approvals table
                   → if Revise: n8n triggers Learning Agent workflow
                   → Learning Agent reads ~/.frqncy-harness/traces/INDEX.jsonl
                     (NOT a separate agent_memory table — the trace IS the memory)
                   → Learning Agent invokes harness chat() to diagnose the rejection
                   → diagnosis written to agent_learnings + embedded into agent_memory (pgvector)
```

## Persona-to-lane mapping

Each FRQNCY persona has a default harness lane. These are starting recommendations, configurable per agent in n8n's persona config:

| Persona | Default lane | Reason |
|---|---|---|
| **FRQNCY** (router/Jarvis) | `claude-sdk/claude-sonnet-4-6` | Needs structured tool use + MCP to dispatch to subordinates. Real per-token cost in trace. |
| **CEO** | `claude-sdk/claude-opus-4-6` | Operational top-of-org decisions deserve top model. Tool-using, MCP-aware. |
| **Council — Krishna, Kali, Merlin, Saraswati, Sai Maa, G. Spivey, K. Trudeau** | `anthropic/claude-opus-4-6` (direct API) | Spiritually-set prompts, no tools needed (pure voice). Direct API for prompt caching since the long Council prompts get reused every call (~10x cost reduction over uncached). |
| **Council research moments** (Merlin doing timing reads, Trudeau citing source) | `perplexity/sonar-pro` | When a Council member needs grounded current-world information. Returns structured `sources` for the trace. |
| **Learning Agent** | `claude-sdk/claude-sonnet-4-6` | Reads the trace store directly (which is what the harness produces). MCP can wrap the trace queries. |
| **C-Suite operational** (CMO drafts, CFO calculations, CTO tasks) | `anthropic/claude-sonnet-4-6` | Tier-1 quality, prompt caching for repeated context (brand voice, financial models, codebase context). |
| **Workers — high-volume specialized** | `chutes/deepseek-ai/deepseek-r1` or `openrouter/nousresearch/hermes-4-405b` | Cheap, specialized, high throughput. The 19 workers do a lot of repetitive specialized work — this is where cost matters. |
| **Worker emergencies / niche models** | `openrouter/<long-tail>` | When a specific model is the only right answer. |
| **Daily chat (operator's personal use)** | `claude-code/sonnet` | Free via Max subscription, no traceable cost on the org budget. |

**Constraint from the Phase 2 plan that the mapping respects:** the seven Council prompts are spiritually-set and never learning-evolved. The Learning Agent must skip them entirely. This is enforced at the persona-config level in n8n, not at the harness lane level.

## The memory layer reconciliation

This is the most architecturally interesting question and deserves a clear decision.

The Phase 2 plan calls for five Supabase tables: `agent_outputs`, `approvals`, `agent_memory` (pgvector), `agent_learnings`, `agent_versions`, plus an `audit_log`. The harness already produces a structured per-call trace at `~/.frqncy-harness/traces/<date>/<convo-id>.jsonl` with an `INDEX.jsonl` summary. There is real overlap.

**Decision: the harness trace is the source of truth. Supabase tables AUGMENT the trace, they do not duplicate it.**

Concretely:

- **`agent_outputs`** (Phase 2 plan): keep as a Supabase table for the Telegram approval loop's UI needs (need a quick lookup by `telegram_msg_id`, status, agent_name). But every row in `agent_outputs` should carry a `trace_conversation_id` field pointing back to the harness trace. The trace JSONL has the full content; Supabase just has the lookup row.
- **`approvals`** (Phase 2 plan): keep as Supabase — it's the canonical record of human decisions, and humans are not a harness concept. Joins `agent_outputs.id`.
- **`agent_memory`** (pgvector, Phase 2 plan): keep, but populate by **embedding lessons extracted from the trace**, not from a separate write path. The trace is the raw substrate; pgvector is the searchable view. The Learning Agent's role becomes: read trace, extract lessons, write to `agent_memory` pgvector for future agents to recall via semantic search.
- **`agent_learnings`** (Phase 2 plan): keep as Supabase — structured Lesson Records are the Learning Agent's output schema, not the harness's. Each row references one trace conversation as the source.
- **`agent_versions`** (Phase 2 plan): keep — versioned system prompts are an n8n persona-config concern, orthogonal to the harness.
- **`audit_log`** (Phase 2 plan): **drop or repurpose.** The harness trace already is the append-only audit log. If Supabase needs a query-friendly subset, write a periodic syncer that pulls trace summaries into a read-optimized table, but don't dual-write.

**Graphiti (Phase 2 plan §07, deferred to Month 2+):** stays deferred, but the trigger to deploy it gets sharper. Per `proposals/HARNESS-TOOLS-INVESTIGATION.md` §4 (in the website repo), the migration triggers from JSONL to Graphiti are: (1) trace store >500MB, (2) need a query JSONL grep can't answer, (3) two+ agents need shared episodic memory, (4) progress.md is failing as the cross-session bridge. Phase 2D's "wait for 30+ days of approval activity" criterion is compatible — wait for both the calendar trigger AND at least two of the size/query/memory triggers.

When Graphiti deploys, it sits **on top of** the trace as an indexed view, not as a replacement. The trace remains sacred (harness AGENT.md decision 7 + decision 8: never compacted, never summarized away). Graphiti gets fed by a periodic ingestor that reads new trace records and writes the extracted entities + edges to FalkorDB.

## What changes in the Phase 2 plan

The Phase 2 plan is structurally sound. The changes are surgical:

1. **Phase 2A (pgvector long-term memory) — unchanged.** Still ships now (~1 hour).
2. **Phase 2B (Telegram approval loop) — adjusted.** Replace the n8n AI Agent node calls to Groq/OpenRouter with HTTP Request nodes that call the Hermes gateway. Hermes runs the harness skill. ~1 extra hour vs. the original Phase 2B estimate (~6 hours total instead of ~5).
3. **Phase 2C (Learning Agent) — adjusted.** Learning Agent reads from `~/.frqncy-harness/traces/INDEX.jsonl` directly (or via the harness's own trace API exposed as an MCP tool — see follow-up below) rather than from Supabase `agent_outputs`. Supabase still stores the structured Lesson Records the Learning Agent produces.
4. **Phase 2D (Graphiti context graph) — unchanged in timing.** Sharpened in trigger criteria per the four-pronged condition above. Graphiti as augmentation layer, not replacement.

## Implementation sprint outline (post-Phase 2A)

Pre-work (operator-only, ~30 minutes):
- [ ] Install Hermes Agent on the Hostinger VPS per `hermes-skill.md` setup
- [ ] Drop the harness's `hermes-skill.md` into `~/.hermes/skills/frqncy-harness/SKILL.md` (with the path-fix flagged in `proposals/TELEGRAM-DAEMON-SETUP.md`)
- [ ] Set provider keys via `frqncy-harness auth set anthropic <key>`, etc.
- [ ] Run `hermes gateway` and verify a test Telegram message round-trips through the harness

Phase 2B' (post Phase 2A, ~6 hrs):
- [ ] In n8n, replace each persona's AI Agent node with an HTTP Request node calling the Hermes gateway
- [ ] HTTP Request node config: POST to `http://localhost:HERMES_PORT/skill/frqncy-harness`, body includes `{ persona, model, system_prompt, user_message, conversation_id }`
- [ ] Hermes skill (`hermes-skill.md`) shells out to `frqncy-harness chat ...` with the right `--model` per persona
- [ ] Response comes back as JSON, n8n writes to `agent_outputs` Supabase table with the `trace_conversation_id` field
- [ ] Test end-to-end: Telegram → CEO persona → claude-sdk lane → trace logged → response to Telegram

Phase 2C' (post 2B', ~6 hrs):
- [ ] Build a tiny MCP server `frqncy-harness-traces` that exposes the trace store as queryable tools (`get_recent_rejections`, `get_trace_for_conversation`, `summarize_lessons_for_agent`)
- [ ] Wire it into the harness via `frqncy-harness mcp add`
- [ ] Learning Agent persona gets the MCP server attached, can read traces directly
- [ ] Real-time path: when Approve/Revise flips a row in Supabase `approvals`, n8n triggers Learning Agent workflow → writes Lesson Record to Supabase `agent_learnings` + embeds to `agent_memory` pgvector

## Follow-up items

These don't block the integration but are worth flagging:

1. **`hermes-skill.md` path fix.** The skill currently references `~/.hermes-agent/skills/` but Hermes's current layout is `~/.hermes/skills/<skill-name>/SKILL.md`. Already noted in `proposals/TELEGRAM-DAEMON-SETUP.md` (FRQNCY WEBSITE side); make the fix a small harness-side commit.
2. **Bridging `HarnessTool[]` into the `claude-sdk` lane.** Currently the SDK lane uses its own internal tool registry (a system trace records the gap). Bridging would let n8n configure a custom tool set per persona. v0.8 follow-up per the SDK lane's own docstring.
3. **Per-day / per-month cost aggregates** in `frqncy-harness costs`. Phase 2's "approval fatigue" risk and the org's cost discipline both want this. `EXECUTION-PLAN-90D.md` Phase 4 Week 8 already has it on the slate.
4. **Sub-agents proposal** (`proposals/SUB-AGENTS.md`, shipped today). Block stays in place. Re-evaluate only if a specific Phase 2 workflow demonstrably needs sub-agents to work (e.g., Council member needs to spawn a research sub-agent for a long-context lookup).
5. **Reconcile the Phase 2 HTML doc with this proposal.** Either update `frqncy-phase2-plan.html` v0.4 to reference this proposal as the substrate decision, or keep this proposal as the canonical and let the HTML stay as the persona/UX/memory plan it already is. Recommend the latter — Phase 2 plan is for the FRQNCY org architecture; this proposal is for the FRQNCY harness integration; they live in different repos and serve different audiences.

## Why this is the right shape

Three reasons.

**Trace integrity stays the moat.** The Phase 2 plan's `agent_outputs` table by itself would create a parallel record that drifts from the harness's trace. By making the trace the source of truth and Supabase an indexed view, the trace remains sacred (harness decision 7) and Supabase serves the UI without duplicating reality.

**Hermes does the work it was designed to do.** The harness's daemon question (decision 11) was already answered: don't build a daemon, package as a Hermes skill, let Hermes own the long-running gateway surface. Phase 2 needs Telegram + scheduling + multi-platform — that's exactly the problem Hermes solves. Wiring Hermes between n8n and the harness (rather than letting n8n call providers directly) collapses two daemon concerns into one.

**Provider lanes finally have a real consumer.** The harness has nine provider lanes with distinct trade-offs (claude-sdk for tool use, perplexity for grounded research, claude-code for free chat, chutes for cheap workers, anthropic direct for prompt-cached Council voices). Without an agent org consuming them, those lanes are just developer ergonomics. With the Phase 2 org consuming them per persona, the lanes become operational levers — the CMO uses one model, the CFO another, the Council a third — and the trace can show which lane choices produced the best outputs over time, feeding back into the persona configs.

## Recommendation

Accept this proposal. Apply the Phase 2 plan adjustments above. Pre-work happens whenever the operator next has 30 minutes on the VPS. Phase 2B' and 2C' replace 2B and 2C in the FRQNCY OS execution sequence; Phase 2A and 2D remain unchanged.

If accepted, follow-up: edit `frqncy-phase2-plan.html` v0.4 to reference this proposal as the substrate decision (one-paragraph note; preserves the rest of the doc).
