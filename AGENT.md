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

The current state (v0.0.1) is the minimum viable harness: provider abstraction, `chat()`, `stream()`, trace writer. The next things to build, in order:

1. Tool calling (Zod-typed tool definitions, AI SDK integration)
2. Bundled `bash` tool with gtr worktree sandbox
3. File primitives (`read`, `write`, `grep`, `glob`)
4. Web tools (`web_fetch`, `web_search`)
5. MCP client (Claude Desktop config-compatible, `_harness` extensions)
6. CLI: `chat`, `repl`, `agent`, `costs`, `doctor`, `config`, `mcp`, `sync`
7. External-artifacts pattern (`init.sh`, `progress.md`, `tasks.json`)
8. Lethal-trifecta gate
9. Cost cap enforcement
10. Anthropic OAuth (Claude Max)
11. Hermes Agent skill packaging
