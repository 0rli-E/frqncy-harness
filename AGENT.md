# AGENT.md — instructions for any agent (including Claude itself) editing this repo

This file is the harness's own self-instructions. When you (an agent) work on `@frqncy/harness`, read this first.

## What this project is

`@frqncy/harness` is a plug-and-play LLM harness for FRQNCY. It is a thin TypeScript library + CLI that wraps the Vercel AI SDK v5 with a provider-indifferent API, a never-compacted trace store, and an opinionated agent loop.

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

## When you finish a task

1. Run `npm test` and confirm green
2. Run `npm run typecheck` and confirm green
3. Append your work to `progress.md` if working in agent mode
4. Update `tasks.json` if working in agent mode
5. Commit with a descriptive message; never `git add -A` blindly

## Building from this scaffold

**Current state: v0.4.0-alpha.1 (shipped 2026-04-26).** 112 tests passing, fully working end-to-end.

What's built:
- Six provider lanes: anthropic, openai, google, openrouter (API path with full feature support — tools, prompt caching) + claude-code, codex (subscription subprocess path — uses Max/Pro quota, no tools)
- Tools: bash (with gtr/tempdir sandbox), read/write/grep/glob, web_fetch, web_search (Tavily/Brave dual-provider)
- MCP client (Claude Desktop schema-compatible mcp.json + `_harness` extensions)
- CLI: chat, repl, agent, doctor, config, costs, mcp, auth
- External-artifacts pattern in agent mode (init.sh + progress.md + tasks.json + git baseline)
- Cost guardrails (default $5 soft warn / $25 hard abort, configurable)
- Lethal-trifecta gate (warn by default, configurable to block)
- Trace storage: `~/.frqncy-harness/traces/<date>/<id>.jsonl` + `INDEX.jsonl`, append-only never-compacted, mirrored to private `github.com/0rli-E/frqncy-harness-traces`
- Hermes Agent skill packaging (`hermes-skill.md`) for daemon deployment
- Auth scaffolding (~/.frqncy-harness/auth/keys.json mode 0600); supports anthropic, openai, google, openrouter, tavily, brave

What's deferred (the "down the roads" — see `/Users/orli/Documents/Claude/Projects/FRQNCY WEBSITE/proposals/HARNESS-PLAN.md`):

1. **Anthropic OAuth via Claude Max** — REVOKED. Anthropic's 2026 ToS prohibits OAuth tokens from consumer subscriptions in third-party tools. Workaround already shipped: subprocess wrap `claude -p` (the `claude-code/*` provider lane). API key is the only legitimate direct-API path.
2. Inkified REPL — high friction vs value; deferred indefinitely
3. Thread/project tagging on traces — v0.5
4. Auto-load AGENT.md/CLAUDE.md in chat/repl too (currently only agent mode reads them) — v0.5
5. Auto-push traces (the `autoPushTraces` config flag exists but isn't wired) — v0.5
6. Bi-temporal memory (Graphiti/Zep) — v2+
7. DSPy + GRPO Python sidecar for trace optimization — v2+
8. Voyager-style auto-skill library — v3
9. AG-UI Protocol surface for the FRQNCY Capacitor app — v3

Companion repo: `/Users/orli/Documents/Claude/Projects/FRQNCY WEBSITE/` — the FRQNCY content + planning docs. Read its top-level `CLAUDE.md` for FRQNCY-specific context (editorial values, content schemas, etc.). The FRQNCY content MCP server (`mcp-servers/frqncy-content/` in that repo) is wired in by default — the harness can already query 146 topics + 766 resources as tools.

## Recommended next sprints

In priority order:

1. **Thread tagging (v0.5)** — add `thread_id` + `project_id` to trace schema; CLI commands to manage threads. Turns the flat trace into the proto-context-graph. ~1.5 hours, ~400 LOC.
2. **AGENT.md auto-load in chat/repl** — small UX win, ~30 min, ~50 LOC.
3. **Auto-push traces** — wire the `autoPushTraces` flag to actually push. ~30 min, ~80 LOC.
4. **Inkified REPL** — visual polish. Deferred indefinitely; only do if asked.
