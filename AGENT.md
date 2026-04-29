# AGENT.md — instructions for any agent (including Claude itself) editing this repo

This file is the harness's own self-instructions. When you (an agent) work on `@frqncy-network/harness`, read this first.

## What this project is

`@frqncy-network/harness` is a plug-and-play LLM harness for FRQNCY. It is a thin TypeScript library + CLI that wraps the Vercel AI SDK v5 with a provider-indifferent API, a never-compacted trace store, and an opinionated agent loop.

It is NOT a framework. It is NOT a chatbot. It is the *harness layer* — the engineering scaffolding that sits between any LLM and any application. See `harness.md` in the parent FRQNCY WEBSITE repo for the four-essay corpus that motivates the design.

## Locked architectural decisions

These are NOT up for re-debate during normal work. If you think one is wrong, write a proposal in `proposals/` first.

1. **Standalone TS package + CLI** — not embedded in any host runtime
2. **TypeScript-first** — Node 20+ and Cloudflare Workers compatible
3. **Direct provider SDKs (Anthropic, OpenAI, Gemini) + OpenRouter** for the long tail. Never route 100% through OpenRouter — costs ~30-40% of tier-1 capability, especially Anthropic prompt caching
4. **OAuth via Claude Max** for Anthropic auth, with `ANTHROPIC_API_KEY` fallback
5. **gtr worktree per agent run** for bash sandboxing
6. **Tool surface: bash + file primitives + web + MCP client** (no other built-in tools)
7. **Trace storage: local JSONL + private GitHub repo, NEVER COMPACTED**
8. **No in-context summarization** that loses detail. When the window fills, halt and resume via `progress.md`
9. **Full Anthropic external-artifacts pattern** in `agent` mode (`init.sh` + `progress.md` + `tasks.json` + baseline git)
10. **Cost guardrails:** $5 soft warn / $25 hard abort per conversation, configurable
11. **Hermes Agent as the daemon shell** — the harness is packaged as a Hermes skill for multi-platform deployment, NOT built as a daemon itself
12. **Agent commerce: ERC-8004 + x402 on Base mainnet, CDP smart wallets default** (v0.9). Pluggable Signer interface (`cdp` adapter primary, `viem` private-key fallback). x402 v1 wire format with types parameterized for v2. Payments live at HTTP first (fetch wrapper + server middleware); the LLM-callable `pay` tool is opt-in and `propose-then-approve`. Validation Registry deferred. AP2 declared as a capability in `card.capabilities.extensions[]`, not implemented as wire protocol. Full design in `proposals/AGENT-COMMERCE.md`.
13. **Daydreams interop is a bridge, not a fusion** (v0.9.1). `src/bridges/daydreams.ts` provides bidirectional adapters: `harnessToolToDaydreamsAction` lifts harness tools (with permission gating intact) into Daydreams agents, `daydreamsActionToHarnessTool` lifts Daydreams plugins into harness loops. We do NOT bundle `@daydreamsai/core` — it's a peer dep. `src/bridges/daydreams-router.ts` adds the Daydreams Router (`ai.xgate.run`) as a paid OpenAI-compatible inference lane via ERC-2612 USDC permits. Per s4mmy's framing: "service integration + payments is the bottleneck, not model quality" — so privilege payment-rail breadth over marginal model selection logic. Full research in `proposals/research/s4mmy-and-daydreams-router.md`.

Full plan: `../proposals/HARNESS-PLAN.md`. Full defaults review: `../proposals/HARNESS-DEFAULTS-REVIEW.md`.

## Code conventions

- **Strict TypeScript.** `strict: true`, `noUncheckedIndexedAccess: true`. No `any` without a comment justifying it.
- **Zod for runtime validation.** Every external boundary (config files, trace records, tool inputs/outputs) has a Zod schema.
- **ESM only.** No CommonJS. Use `import` everywhere.
- **AsyncIterator for streaming.** Never callbacks, never EventEmitter for the public API.
- **Pure functions where possible.** Side effects (filesystem writes, network calls) live in dedicated modules.
- **One exported responsibility per file.** Don't bundle unrelated functions.
- **Tests live in `test/`.** Unit tests use Vitest. Provider tests use `MockLanguageModel` from the AI SDK so they run offline.

## Trace schema is sacred

The decision trace JSONL is the moat. Treat it as append-only, never modify past records, never throw away detail. The schema is versioned (`schema_version` field) — if you must evolve it, bump the version and write a migration in `src/trace/migrations/`.

## What NOT to do

- **Don't add compaction** that loses information. The user explicitly rejected this. (Decision 8.)
- **Don't add a built-in summarizer.** Same reason.
- **Don't route 100% through OpenRouter** for "uniformity." Costs ~30-40% of tier-1 capability. (Decision 3.)
- **Don't build a daemon.** Hermes Agent is the daemon shell. (Decision 11.)
- **Don't bake retrieval into the harness.** Retrieval lives in MCP servers. (Section F.)
- **Don't add framework-style abstractions** (chains, supervisors, multi-agent orchestrators). One linear agent + one shared trace + one bundled compression model when needed. (Per Cognition's "Don't Build Multi-Agents.")
- **Don't expose `pay` as an auto-permission tool.** The LLM having a "spend money" verb deserves friction; `pay` is `propose-then-approve` and opt-in. Same logic for `pre-payment` hook — keep ops/regulators in the loop. (Per AGENT-COMMERCE decision 7.)
- **Don't put wallet keys in the LLM context.** Ever. The harness signs internally and surfaces only the result.
- **Don't auto-write reputation feedback** after every settlement. ChaosChain does it; we don't, by default. Toggle-on after we have a track record. (Per AGENT-COMMERCE decision 11.)

## When you finish a task

1. Run `npm test` and confirm green
2. Run `npm run typecheck` and confirm green
3. Append your work to `progress.md` if working in agent mode
4. Update `tasks.json` if working in agent mode
5. Commit with a descriptive message; never `git add -A` blindly

## Building from this scaffold

**Current state: v0.6.0-alpha.1.** 155 tests passing, fully working end-to-end.

What's built:
- Seven provider lanes: anthropic, openai, google, openrouter, chutes (API path with full feature support — tools, prompt caching where available) + claude-code, codex (subscription subprocess path — uses Max/Pro quota, no tools)
- Tools: bash (with gtr/tempdir sandbox), read/write/grep/glob, web_fetch, web_search (Tavily/Brave dual-provider)
- MCP client (Claude Desktop schema-compatible mcp.json + `_harness` extensions)
- CLI: chat, repl, agent, doctor, config, costs, mcp, auth, thread
- External-artifacts pattern in agent mode (init.sh + progress.md + tasks.json + git baseline)
- AGENT.md / CLAUDE.md auto-load in chat + repl + agent (was agent-only)
- Cost guardrails (default $5 soft warn / $25 hard abort, configurable)
- Lethal-trifecta gate (warn by default, configurable to block)
- Trace storage: `~/.frqncy-harness/traces/<date>/<id>.jsonl` + `INDEX.jsonl`, append-only never-compacted, mirrored to private `github.com/0rli-E/frqncy-harness-traces`
- **Thread + project tagging (v0.5):** every trace record + index entry can carry `thread_id` and `project_id`; active thread auto-attaches via `~/.frqncy-harness/threads.json`; managed via `frqncy-harness thread {list|new|use|none|rename|delete}`; per-call override via `--thread <id>` / `--project <id>`
- **Hooks system (v0.5):** three lifecycle events (pre-agent / post-tool-use / post-agent), supports shell / JS / TS / bundled refs; bundled hooks ship for auto-commit-traces, macos-notification, editorial-lint
- Hermes Agent skill packaging (`hermes-skill.md`) for daemon deployment
- Auth scaffolding (~/.frqncy-harness/auth/keys.json mode 0600); supports anthropic, openai, google, openrouter, tavily, brave, chutes

What's deferred (the "down the roads" — see `/Users/orli/Documents/Claude/Projects/FRQNCY WEBSITE/proposals/HARNESS-PLAN.md`):

1. **Anthropic OAuth via Claude Max** — REVOKED. Anthropic's 2026 ToS prohibits OAuth tokens from consumer subscriptions in third-party tools. Workaround already shipped: subprocess wrap `claude -p` (the `claude-code/*` provider lane). API key is the only legitimate direct-API path.
2. Inkified REPL — high friction vs value; deferred indefinitely
3. Bi-temporal memory (Graphiti/Zep) — v2+
4. DSPy + GRPO Python sidecar for trace optimization — v2+
5. Voyager-style auto-skill library — v3
6. AG-UI Protocol surface for the FRQNCY Capacitor app — v3

Companion repo: `/Users/orli/Documents/Claude/Projects/FRQNCY WEBSITE/` — the FRQNCY content + planning docs. Read its top-level `CLAUDE.md` for FRQNCY-specific context (editorial values, content schemas, etc.). The FRQNCY content MCP server (`mcp-servers/frqncy-content/` in that repo) is wired in by default — the harness can already query 146 topics + 766 resources as tools.

## Recommended next sprints

In priority order:

1. **`frqncy-harness costs` + traces filter by thread** — already records the tags, but neither command surfaces them yet. ~30 min.
2. **Inkified REPL** — visual polish. Deferred indefinitely; only do if asked.
