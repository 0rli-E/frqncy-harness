# `frqncy-harness` cheat sheet

Daily-use reference. Skim this end-to-end once, then come back to specific sections as needed.

---

## 1. One-time install (~3 min)

From inside the harness folder, link the CLI globally on your machine:

```
cd ~/Documents/Claude/Projects/frqncy-harness
```

```
npm install
```

```
npm run build
```

```
npm link
```

After `npm link`, the `frqncy-harness` command works from any directory on your terminal. Verify:

```
frqncy-harness --version
```

```
frqncy-harness doctor
```

`doctor` prints a green/yellow/red status of every provider key, every external CLI, and the trace store. **Read its output once now** — it tells you exactly what's set up and what's missing.

If you ever update the harness code, re-run `npm run build` (no need to re-link).

---

## 2. Auth setup — one key per provider you actually use (~5 min)

You only need keys for providers you'll actually use. None are required to start; if you only want the free `claude-code/sonnet` lane via your Claude Max subscription, skip this section entirely.

### OpenRouter — single API key, ~300 models

Get a key at https://openrouter.ai/keys (top up credits with Stripe or crypto). Then:

```
frqncy-harness auth set openrouter sk-or-...
```

This unlocks: `openrouter/openrouter/free` (auto-router, $0), `openrouter/nousresearch/hermes-4-405b`, `openrouter/qwen/qwen3-coder:free`, `openrouter/deepseek/deepseek-r1:free`, and ~300 others.

### Perplexity — search-grounded answers with citations

Get a key at https://www.perplexity.ai/account/api/keys (Pro/Max subscriptions include monthly API credits). Then:

```
frqncy-harness auth set perplexity pplx-...
```

This unlocks: `perplexity/sonar`, `perplexity/sonar-pro`, `perplexity/sonar-reasoning`, `perplexity/sonar-reasoning-pro`. Returns structured `sources` alongside the text.

### Anthropic — for `claude-sdk/*` and `anthropic/*` lanes

Get a key at https://console.anthropic.com (separate from your Claude Max subscription — API access is billed independently). Then:

```
frqncy-harness auth set anthropic sk-ant-...
```

This unlocks: `claude-sdk/claude-sonnet-4-6`, `claude-sdk/claude-opus-4-6`, `claude-sdk/claude-haiku-4-5-20251001`, plus the direct `anthropic/*` lane with prompt caching.

### OpenAI / Google / Chutes — optional

```
frqncy-harness auth set openai sk-...
```

```
frqncy-harness auth set google AIza...
```

```
frqncy-harness auth set chutes ...
```

### Codex CLI — free OpenAI work via ChatGPT Pro subscription

Install the official Codex CLI separately, then `codex/*` lanes work via subprocess (no API key, drawn from your ChatGPT Pro quota):

```
brew install openai/codex/codex
```

Then run `codex` once interactively to authenticate. After that, `frqncy-harness chat "..." --model codex/default` works.

### Web search — for `web_search` tool inside agent loops

Either Tavily or Brave (or both):

```
frqncy-harness auth set tavily tvly-...
```

```
frqncy-harness auth set brave BSA-...
```

Re-run `frqncy-harness doctor` after any auth changes — should show all the providers you set as green.

---

## 3. Daily use — the four commands you'll actually run

### `frqncy-harness chat` — one-shot, for "answer this question"

```
frqncy-harness chat "summarise this article: <paste url>"
```

Uses the configured default model (set with `frqncy-harness config set defaultModel <model>`). Override per-call with `--model`:

```
frqncy-harness chat "research the latest on Templar Covenant and Bittensor SN3" --model perplexity/sonar-pro
```

```
frqncy-harness chat "write a tight 200-word brief on conscious capitalism for FRQNCY" --model claude-code/sonnet
```

### `frqncy-harness repl` — interactive, for back-and-forth

Two modes:

**Text-only chat** (low cost, no tool execution):

```
frqncy-harness repl
```

```
frqncy-harness repl --model openrouter/openrouter/free
```

**Persistent agent conversation** (with tools — bash, file, web, MCP — and a per-session sandbox):

```
frqncy-harness repl --agent --model openrouter/google/gemini-2.5-flash --yolo
```

This is what you want when you don't want to keep typing `frqncy-harness agent "..."`. Each turn runs a multi-step agent loop, but the conversation, sandbox, and MCP connections persist across turns. You stay in one session.

Inside the REPL, slash commands:
- `/model claude-sdk/claude-opus-4-6` — swap models mid-conversation
- `/new` — start a fresh conversation
- `/resume <id>` — resume a past conversation
- `/system "you are a brand voice editor for FRQNCY"` — set system prompt
- `/tools on|off` — toggle tool use mid-conversation (agent mode only)
- `/yolo on|off` — toggle approval bypass (agent mode only)
- `/help` — full list
- `/exit` — leave

### `frqncy-harness agent` — multi-step with tools (bash, file, web, MCP)

```
frqncy-harness agent "look at /Users/orli/Documents/Claude/Projects/FRQNCY\ WEBSITE/v2/explore.html, find one thin topic, web-search for 5 fresh resources, write a draft to /tmp/proposed-resources.json" --model openrouter/openrouter/free --yolo
```

`--yolo` skips per-tool approval prompts (safe for sandboxed work, careful with `write`/`bash`).

For long multi-step work, use a working directory the agent can scaffold into:

```
frqncy-harness agent "rewrite the meditation topic page to be twice as deep" --model claude-sdk/claude-sonnet-4-6 --cwd ~/Documents/Claude/Projects/FRQNCY\ WEBSITE
```

The agent creates `progress.md`, `tasks.json`, `init.sh`, and a baseline git commit so any future agent run can resume the work by reading those files.

### `frqncy-harness costs` — what you've spent

```
frqncy-harness costs --period 7d
```

```
frqncy-harness costs --period 30d --json
```

`claude-code/*` and `codex/*` lanes always show `$0` (subscription quota, not API tokens). Everything else is real per-token cost.

---

## 4. Which model for which job

| Need | Command snippet | Why |
|---|---|---|
| Free chat from your Max sub, no tools | `chat "..." --model claude-code/sonnet` | Top quality, $0, but no tool use |
| Free chat with full tools/MCP | `chat "..." --model openrouter/openrouter/free` | Auto-routes to working free model, can do tools |
| Highest-quality work that needs tools | `agent "..." --model claude-sdk/claude-opus-4-6` | Real per-token API cost; full agent loop |
| Search-grounded answer with citations | `chat "..." --model perplexity/sonar-pro` | Returns structured `sources` array |
| Fast cheap agent for rote work | `agent "..." --model openrouter/google/gemini-2.5-flash --yolo` | Pennies per call |
| Reasoning-heavy task with shown work | `chat "..." --model openrouter/deepseek/deepseek-r1:free` | Free, shows full chain-of-thought |
| Code-heavy work | `agent "..." --model openrouter/qwen/qwen3-coder:free --yolo` | Designed for coding tools, free |
| Free OpenAI work via ChatGPT Pro | `chat "..." --model codex/default` | Subprocess to `codex` CLI, $0 |
| Decentralised inference (cheap, on-mission) | `chat "..." --model chutes/deepseek-ai/deepseek-r1` | Bittensor SN64, ~$0.30/Mtok |
| Direct Anthropic with prompt caching | `chat "..." --model anthropic/claude-sonnet-4-6` | ~10x cheaper on long stable system prompts |

**Default recommendation:** set `claude-code/sonnet` as the default for daily chat (free), and reach for `claude-sdk/claude-opus-4-6` or `openrouter/openrouter/free` when you want tools.

```
frqncy-harness config set defaultModel claude-code/sonnet
```

---

## 5. Cross-session continuity — when this Claude session runs out

**The whole point of this setup.** Two patterns work:

### Pattern A — `frqncy-harness agent` with external artifacts

When you start an agent run with `--cwd <some-folder>`, the harness scaffolds:
- `progress.md` — append-only log of every step + reasoning
- `tasks.json` — the prompt decomposed into testable items, status tracked
- `init.sh` — env setup
- A baseline git commit at run start

If the run halts (window full, error, you stop it), the next agent run from the same folder reads those files and resumes:

```
frqncy-harness agent "continue the previous work" --cwd <same-folder> --resume
```

### Pattern B — REPL conversation resume

Every REPL conversation gets a UUID and is logged at `~/.frqncy-harness/traces/<date>/<uuid>.jsonl`. To resume any of them:

```
frqncy-harness repl --resume <uuid>
```

Find recent UUIDs:

```
frqncy-harness traces --recent 10
```

Or replay an old conversation through a different/newer model to compare:

```
frqncy-harness replay <uuid> --model claude-sdk/claude-opus-4-6
```

---

## 6. Common workflows for FRQNCY work

### Brand-voice review on a draft

```
frqncy-harness chat "review against FRQNCY voice playbook (cooperation over competition, conviction as self-expression, no leaderboards, no spiritual cliches): <paste draft>" --model claude-code/sonnet
```

For ongoing work in the FRQNCY repo, the harness auto-loads `AGENT.md` / `CLAUDE.md` from `--cwd`, so it picks up the editorial values automatically.

### Research with verifiable citations

```
frqncy-harness chat "what's new in conscious capitalism in 2026 — Sequoia, Bessemer, B Corp, recent papers" --model perplexity/sonar-pro
```

The output includes a `sources` array; for the harness CLI in v0.7 they appear inside the text body (structured-source rendering is a v0.8 polish item).

### Add a resource to FRQNCY

```
frqncy-harness agent "find 3 fresh high-quality resources on permaculture from 2025-2026, write resources.json-shaped entries to /tmp/permaculture-additions.json" --model openrouter/openrouter/free --yolo
```

Then review the JSON and merge into `resources.json` by hand.

### Long content commission (e.g. a topic page)

```
frqncy-harness agent "commission Topic 0003 on permaculture per proposals/TOPIC-COMMISSION-CONTEXT-GRAPH.md — research, draft, voice-pass, output to v2/permaculture/index.html" --model claude-sdk/claude-opus-4-6 --cwd ~/Documents/Claude/Projects/FRQNCY\ WEBSITE
```

This will run for a while, scaffold progress.md, do the research, write the page, iterate based on the voice playbook check.

---

## 7. Troubleshooting

**`command not found: frqncy-harness`** — re-run `npm link` from the harness folder. Confirm npm's global bin is on your `$PATH`: `npm bin -g`.

**`Anthropic API key is missing`** — `frqncy-harness auth set anthropic sk-ant-...`, or `export ANTHROPIC_API_KEY=sk-ant-...` in your shell.

**Tools don't work on `claude-code/*` or `codex/*`** — by design. Those lanes subprocess the official CLIs which do their own internal tooling. Use `claude-sdk/*` or any API lane for tools.

**Cost cap aborted my run** — defaults are $5 soft warn / $25 hard abort per conversation. Bump for big jobs:

```
frqncy-harness config set costCap.softWarnUsd 25
```

```
frqncy-harness config set costCap.hardAbortUsd 100
```

**Lethal-trifecta warning fired** — you have private data + untrusted content + outbound network in the same trace. By default this warns; for daemon use you can block:

```
frqncy-harness config set trifectaSeverity block
```

**MCP server not loading** — `frqncy-harness mcp list` to see what's configured. The FRQNCY content MCP server (`mcp-servers/frqncy-content/` in the website repo) is NOT auto-wired — add it via:

```
frqncy-harness mcp add frqncy-content node ~/Documents/Claude/Projects/FRQNCY\ WEBSITE/mcp-servers/frqncy-content/dist/index.js
```

```
frqncy-harness mcp test frqncy-content
```

**Trace dir filled up** — the trace store at `~/.frqncy-harness/traces/` is never compacted by design. Mirror to a private GitHub repo for off-machine backup:

```
cd ~/.frqncy-harness/traces
```

```
git init && git remote add origin git@github.com:0rli-E/frqncy-harness-traces.git
```

The auto-commit-and-push hook in the harness then mirrors every conversation.

---

## 8. The whole picture in three sentences

The harness is your provider-indifferent LLM substrate — one CLI, nine lanes (free Claude Max via subprocess, free OpenAI via subprocess, free OpenRouter auto-router, paid Anthropic with prompt caching, paid Claude Agent SDK with tools, paid Perplexity with citations, paid OpenAI/Google/Chutes), one trace store, one cost ledger.

When this Claude session ends, you keep working: open your terminal, run `frqncy-harness chat`, `repl`, or `agent` against any of those lanes, and every step gets logged to `~/.frqncy-harness/traces/` so future sessions (and future Claude conversations) can read the history and pick up where you left off.

The `agent` command's external-artifacts pattern (`progress.md` + `tasks.json` + `init.sh` + git baseline) is the cross-session memory bridge — it's how a multi-day or multi-week piece of work survives any single session ending, including this one.
