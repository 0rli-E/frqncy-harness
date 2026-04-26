# @frqncy/harness

> A plug-and-play LLM harness — provider-indifferent, trace-first, never compacted.

`@frqncy/harness` is the LLM harness that powers FRQNCY's agent surfaces and Orlando's daily workflow. It wraps the [Vercel AI SDK v6](https://sdk.vercel.ai) with direct provider SDKs for tier-1 models (Anthropic Claude, OpenAI, Google Gemini) and OpenRouter for the long tail (Hermes 4, Llama, DeepSeek, Qwen, etc.).

**Status:** v0.2.0-alpha.1 — tools + sandbox land. `chat()`, `stream()`, the trace writer, the CLI, the cost tracker, the config loader, the bash tool, the gtr/tempdir sandbox, the approval system, and the lethal-trifecta detector all ship. Agent loop with external-artifacts pattern, MCP client, file primitives, web tools, and Anthropic OAuth come next.

---

## Why it exists

The 2026 consensus from Sequoia, Bessemer, Anthropic, OpenAI, Cognition, Cursor, and others: **the harness layer is where founders compete, not the model.** This is the harness layer for FRQNCY.

See the four-essay corpus in [`harness.md`](../harness.md) (TRAE on Harness Engineering, Jaya & Ashu / Animesh / Ishan on Context Graphs) and the architectural plan in [`proposals/HARNESS-PLAN.md`](../proposals/HARNESS-PLAN.md) for the full story.

---

## Quick start

```bash
# Install
npm install @frqncy/harness

# Set provider keys (any subset — the harness only requires keys for providers you actually use)
export ANTHROPIC_API_KEY=sk-...    # or OAuth via Claude Max (recommended, see below)
export OPENAI_API_KEY=sk-...
export GOOGLE_GENERATIVE_AI_API_KEY=...
export OPENROUTER_API_KEY=sk-or-...
```

```typescript
import { chat } from '@frqncy/harness';

// Same call works across all providers — swap a string, no other changes
const reply = await chat({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
});

console.log(reply.text);
console.log(reply.usage);  // { inputTokens, outputTokens, cachedInputTokens, costUsd }

// Streaming
import { stream } from '@frqncy/harness';

for await (const event of stream({
  model: 'openrouter/nousresearch/hermes-4-405b',
  messages: [{ role: 'user', content: 'count to ten slowly' }],
})) {
  if (event.type === 'text') process.stdout.write(event.delta);
}
```

### With tools (v0.2)

```typescript
import { stream, bashTool } from '@frqncy/harness';

for await (const event of stream({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'list files in /tmp and count them' }],
  tools: [bashTool],
  maxSteps: 5,
  yolo: true,  // skip per-tool approval prompts
})) {
  switch (event.type) {
    case 'text':         process.stdout.write(event.delta); break;
    case 'tool_call':    console.error(`\n[→ ${event.toolName}] ${JSON.stringify(event.input)}`); break;
    case 'tool_result':  console.error(`[← ${event.toolName}] (done)`); break;
  }
}
```

### CLI

```bash
# Setup
frqncy-harness doctor                       # check your environment
frqncy-harness config set defaultModel anthropic/claude-sonnet-4-6

# Use
frqncy-harness chat "what is the capital of france"
frqncy-harness repl                          # interactive, /model to swap mid-stream
frqncy-harness costs --period 7d             # spend summary
```

---

## Locked architectural decisions

(Full list in [`proposals/HARNESS-PLAN.md`](../proposals/HARNESS-PLAN.md))

1. **Standalone TS package + CLI** — not embedded in any host runtime
2. **TypeScript-first** — runs on Node 20+ and Cloudflare Workers
3. **Direct provider SDKs + OpenRouter** for the long tail
4. **OAuth via Claude Max** for Anthropic auth (API key fallback)
5. **gtr worktree** as the bash sandbox per agent run
6. **Tool surface:** bash + file primitives + web + MCP client
7. **Trace storage:** local JSONL + private GitHub repo (never compacted)
8. **No in-context summarization** that loses detail; halt + resume via `progress.md`
9. **Full Anthropic external-artifacts pattern** in v0 agent mode
10. **Cost guardrails:** $5 soft warn / $25 hard abort per conversation
11. **Hermes Agent as the daemon shell** — harness packaged as a Hermes skill for multi-platform deployment

---

## Project status

### v0.0.1 (shipped)
- ✅ Provider abstraction (Anthropic, OpenAI, Gemini, OpenRouter)
- ✅ `chat()` — one-shot
- ✅ `stream()` — AsyncIterator of typed events
- ✅ Trace writer — JSONL per conversation + INDEX.jsonl
- ✅ Vitest provider-swap matrix

### v0.1.0 (shipped)
- ✅ CLI binary `frqncy-harness` (chat, repl, doctor, config, costs)
- ✅ Per-model cost tracking (Claude Sonnet/Opus/Haiku, GPT-5/mini, Gemini Pro/Flash, Hermes 405B/70B)
- ✅ Config loader at `~/.frqncy-harness/config.json` with Zod-validated schema
- ✅ REPL with slash commands (`/model`, `/new`, `/resume`, `/system`, `/help`)
- ✅ Doctor command
- ✅ Friendly error formatting (Zod errors, AI SDK API key errors with hints)

### v0.2.0-alpha.1 (this release — tools + sandbox)
- ✅ Tool primitive: `HarnessTool` with permission tier + lethal-trifecta flags + AI SDK conversion
- ✅ Bash tool with stdout/stderr capture, timeout enforcement, output truncation
- ✅ Sandbox abstraction: gtr worktree (when in a git repo with `git gtr` installed) + tempdir fallback
- ✅ Approval system: per-conversation memory, default-deny when no callback, `--yolo` bypass
- ✅ Lethal-trifecta detector
- ✅ Tool events surfaced via `stream()` AsyncIterator (`tool_call`, `tool_result`, `tool_error`, `step_start`, `step_finish`)

### v0.2.0-alpha.3 (this release — full sprint #2 + #3)
- ✅ File primitives (`read`, `write`, `grep`, `glob`)
- ✅ `web_fetch` tool (web_search deferred to v0.3 with API selection)
- ✅ Cost cap enforcement (soft warn / hard abort, configurable)
- ✅ Lethal-trifecta gate (allow / warn / block severity)
- ✅ `agent` CLI command with full Anthropic external-artifacts pattern
- ✅ MCP client (Claude Desktop schema + `_harness` extensions)
- ✅ `mcp` CLI subcommand (list/add/remove/enable/disable/import-from-claude-desktop/test/path)
- ✅ Auth scaffolding (stored API keys at ~/.frqncy-harness/auth/keys.json, mode 0600)
- ✅ `auth` CLI subcommand (status/set/unset/path)
- ✅ Hermes Agent skill packaging (`hermes-skill.md`)

### v0.3.0-alpha.1 (this release)
- ✅ `web_search` tool — auto-detects `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY`, normalizes results across providers
- ⚠️ Anthropic OAuth — **NOT shipped**. Anthropic's 2026 *Authentication and credential use* policy prohibits using OAuth tokens from Free/Pro/Max accounts in third-party tools. Use API keys via `auth set anthropic <key>` or `ANTHROPIC_API_KEY=...`
- ⏳ Inkified REPL — deferred to v0.4 (high friction vs. value tradeoff)

### v0.4.0 (next, focused polish)
- ⏳ Inkified REPL + agent UI (richer streaming display, spinner, tool-call boxes)
- ⏳ DSPy + GRPO Python sidecar for trace optimization (down-the-roads)
- ⏳ MCP sampling support (let MCP servers request LLM calls back through the harness)

### Down the roads (v2+)
See [`proposals/HARNESS-PLAN.md`](../proposals/HARNESS-PLAN.md) for the full down-the-roads index.

---

## Development

```bash
# Install
npm install

# Build
npm run build

# Test (offline — uses MockLanguageModel)
npm test

# Watch mode
npm run dev
```

---

## License

MIT — see [`LICENSE`](./LICENSE).
