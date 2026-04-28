# Proposal: Sub-agents in the harness

**Status:** Draft — recommend AGAINST without further evidence
**Author:** harness-side
**Date:** 2026-04-28
**Related:** AGENT.md decisions 6, 11; HARNESS-PLAN.md (Cognition "Don't Build Multi-Agents" stance)

---

## Context

`v0.7` adds the `claude-sdk/*` provider lane (`@anthropic-ai/claude-agent-sdk`'s `query()` in-process). The SDK ships with an internal **Agent** tool that lets the running agent spawn child agents with their own tool registry, system prompt, and conversation. That tool is part of the SDK's default registry — meaning the moment someone runs:

```
frqncy-harness chat "..." --model claude-sdk/claude-sonnet-4-6
```

…the agent *can* spawn sub-agents, whether or not the harness intentionally exposed that capability. This proposal is about whether to:

1. Embrace it — wire the SDK's sub-agent shape into the trace schema and CLI surface so it works first-class
2. Block it — pass `disallowedTools: ['Agent']` (or equivalent) when constructing SDK options on the `claude-sdk` lane
3. Let it through but unstructured — accept that sub-agent calls will appear as opaque tool calls in the trace, with no parent/child linkage

## What this conflicts with

**AGENT.md decision 6:** "Tool surface: bash + file primitives + web + MCP client (no other built-in tools)." The Agent tool is a built-in tool that the SDK provides; if we let it through unmodified we've expanded the documented tool surface without proposal.

**AGENT.md decision 11 / Cognition's "Don't Build Multi-Agents":** the harness is intentionally one-linear-agent. The cited reasoning: multi-agent systems split context and lose coherence; one agent with a long shared trace beats N agents with summaries between them.

## What would have to change to embrace it

1. **Trace schema bump (`TRACE_SCHEMA_VERSION` → `0.2.0`)** with a migration. Every record needs an optional `parent_conversation_id` field; sub-agent runs get their own `conversation_id` linked back to the parent. INDEX.jsonl needs a `parent_conversation_id` field too. Without this, a trace reader can't distinguish "the agent called bash 50 times" from "the agent spawned a sub-agent that itself called bash 50 times" — and that distinction is the entire point of the sub-agent pattern.
2. **Cost rollup logic** — `frqncy-harness costs` would need to roll child costs into the parent for "true cost of one user query." Currently it sums per-conversation; the rollup is straightforward but new.
3. **CLI affordances** — `thread show` and `traces` would need to render the tree, not the flat list.
4. **Trifecta gate re-evaluation** — currently checked once at the parent agent boundary. Sub-agents can have their own tool sets; the gate has to apply per-sub-agent or be explicitly waived.
5. **Hook semantics** — `pre-agent` and `post-agent` fire once per agent run today. Do they fire per sub-agent? Probably yes. New event needed: `pre-sub-agent` / `post-sub-agent`? Or fold into existing events with a `parent_conversation_id` field on the context?

That's roughly 1.5–2 sprints of work, gated behind a schema-version bump.

## Argument for embracing it

Cognition's "Don't Build Multi-Agents" was published in mid-2025 against the multi-agent frameworks of that era (CrewAI, AutoGen, etc.) — frameworks that hardcoded supervisor patterns and suffered from context loss between hops. The Claude Agent SDK's sub-agent pattern is **different in kind**: the parent stays alive throughout, child results return as structured tool_result blocks the parent reads in full context, and the parent decides what to do with them. It's closer to "delegated subroutine call" than "handoff to autonomous peer."

The empirical data Anthropic has published (2025-2026) on Claude Code's own use of the Agent tool suggests it materially improves on tasks where the parent's context would otherwise blow up reading raw outputs (large file scans, codebase searches). That's a real signal.

## Argument against — the recommendation

Three things:

1. **Trace integrity is the moat.** The harness's value vs. running Claude Code directly is: every decision is in a structured, queryable trace. Sub-agents *without* the schema bump means trace integrity quietly degrades — an opaque tool call hides 5,000 child decisions. With the schema bump it's coherent but it's still 1.5–2 sprints of work for a feature whose payoff in the FRQNCY-content authoring use case is unclear.
2. **The use case isn't proven for the harness's actual workloads.** The harness's primary user (you) is mostly running single-shot agentic edits on FRQNCY content + occasional code work. For content authoring, sub-agents add no value — the parent has plenty of context budget and the work is linear by nature. For code work, the SDK's sub-agents are useful for "scan the codebase and report" tasks, but the harness has never been bottlenecked by parent context blowing up on a code-scan — bash + grep handle it.
3. **The default-blocked-can-unblock-later design is reversible; the default-allowed-then-trace-is-broken design is not.** If we block the Agent tool at the SDK lane and someone hits a real ceiling because of it, we revisit with evidence. If we let it through and traces start losing meaningful resolution, we have to do the schema bump retroactively — and the historical traces are unfixable.

## Recommendation

**Block the Agent tool on the `claude-sdk` lane in v0.7.** Add `disallowedTools: ['Agent']` to the SDK options in `src/providers/sdk.ts`. Document the block in the lane's docstring with a pointer back to this proposal.

**Revisit if and only if:** there's a concrete agent run that fails because of the block (e.g., parent context blew the limit on a large-codebase task) AND the failure is reproducible AND the schema-bump cost is justified by the frequency of the use case.

## Open questions for review

- Is there a use case in the FRQNCY content workflow where sub-agents would meaningfully help? (My guess: no, but I haven't seen everything.)
- Does the Capacitor app (v3 deferred per AGENT.md) plan ever assume sub-agents in the harness? If yes, we should bring that decision forward.
- Is the cost of running the SDK lane *with* sub-agents materially different from running parallel `chat()` calls from the host program? If host-program-orchestration matches the goal, that path doesn't need a schema bump.
