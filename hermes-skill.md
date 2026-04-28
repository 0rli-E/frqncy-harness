# @frqncy-network/harness — as a Hermes Agent skill

This file is the **Hermes Agent skill** that lets a running [Hermes Agent](https://hermes-agent.nousresearch.com/) daemon invoke the harness for any user message.

Per **HARNESS-PLAN.md decision 11**: the harness ships as a focused CLI/library (decision 1) AND as a Hermes skill — Hermes provides the daemon shell, multi-platform gateways (Telegram, Discord, Slack, SMS, Email), and persistent process management. The harness CLI does the actual LLM work.

## Setup (one time, on the machine running Hermes)

### 1. Install Hermes Agent
Follow [hermes-agent.nousresearch.com/docs](https://hermes-agent.nousresearch.com/docs/) — typically:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup
```

This runs Hermes as a daemon listening on whichever platforms you connect (Telegram, Discord, etc.).

### 2. Install the harness globally

```bash
npm install -g @frqncy-network/harness
frqncy-harness doctor   # verify setup
```

### 3. Drop this file in Hermes's skills directory

Hermes loads skills from `~/.hermes/skills/<skill-name>/SKILL.md` (one folder per skill, file always named `SKILL.md`):

```bash
mkdir -p ~/.hermes/skills/frqncy-harness
cp hermes-skill.md ~/.hermes/skills/frqncy-harness/SKILL.md
```

Run `hermes config show` to confirm the skills directory on your install — older builds used `~/.hermes-agent/skills/<name>.md` (single file per skill); current builds use the folder layout above.

### 4. (Optional) Set provider keys in Hermes's env so the harness inherits them

The env file location varies by Hermes version — `hermes config show` will print the path. Common locations are `~/.hermes/env` (current) or `~/.hermes-agent/env` (older builds).

```bash
echo 'export ANTHROPIC_API_KEY=sk-ant-...' >> ~/.hermes/env
echo 'export OPENROUTER_API_KEY=sk-or-...' >> ~/.hermes/env
hermes restart
```

Or use the harness's own auth store:

```bash
frqncy-harness auth set anthropic sk-ant-...
frqncy-harness auth set openrouter sk-or-...
```

## Skill metadata

```yaml
name: frqncy-harness
description: |
  Provider-indifferent LLM harness — chat / agent loops with bash, file, web, and MCP tools.
  Use this skill whenever the user wants a model to reason, write, or take an action.
  Supports Claude, GPT-5, Gemini, and any OpenRouter model with the same one-line call.
triggers:
  - any user message that needs a model response
  - any user message asking the agent to do work (read/write files, run commands, fetch URLs, call MCP servers)
default: true
```

## How Hermes invokes the harness

When a user message comes in via any gateway (Telegram, Discord, SMS, etc.), Hermes invokes this skill which shells out to the harness CLI:

### For chat-style messages (no action needed)

```bash
frqncy-harness chat "${USER_MESSAGE}" \
  --model anthropic/claude-sonnet-4-6 \
  --resume "${HERMES_CONVERSATION_ID:-}" \
  --json
```

The harness streams the response, handles trace logging, and returns JSON Hermes can parse and forward back to the gateway.

### For action-requiring messages (run an agent loop)

```bash
frqncy-harness agent "${USER_MESSAGE}" \
  --model anthropic/claude-sonnet-4-6 \
  --max-steps 15 \
  --yolo
```

The agent loop creates a sandbox, scaffolds external artifacts (`progress.md` + `tasks.json` + `init.sh`), runs bash + file + web + MCP tools, and writes the final reply back to `progress.md`.

`--yolo` is appropriate for daemon use because there's no human at the terminal to approve interactively. If you want approval-gated tools in daemon mode, the v0.3 release will add a webhook-based approval flow.

## Recommended Hermes routing

Add this rule to your Hermes config (`~/.hermes/routing.yaml` on current builds, `~/.hermes-agent/routing.yaml` on older — confirm with `hermes config`):

```yaml
default_skill: frqncy-harness
fallback_model: anthropic/claude-sonnet-4-6
session_timeout_minutes: 60
trace_dir: ~/.frqncy-harness/traces/
```

Hermes will route every incoming message through this skill, the harness will log the trace to `~/.frqncy-harness/traces/`, and your private GitHub trace repo gets the full record (per HARNESS-PLAN.md decision 7).

## Why this setup is the right answer

The alternative is for the harness itself to be a daemon — implementing platform gateways (Telegram bot, Discord bot, Slack app, SMS provider, IMAP loop), persistent process management, scheduling, etc. That's a 1500-2500 LOC project that Hermes already does well. By packaging the harness as a Hermes skill instead, we get:

- Multi-platform gateway support **for free**
- Persistent daemon **for free**
- Scheduling **for free** (Hermes has cron-like triggers)
- The harness stays a focused CLI + library — testable, scriptable, embeddable in non-Hermes contexts (Cowork plugin, FRQNCY product code, CI/CD)

## Updating

When new harness versions ship:

```bash
npm install -g @frqncy-network/harness@latest
hermes restart
```

This skill file rarely changes — most of the action is in the harness itself.

## Troubleshooting

- **"command not found: frqncy-harness"** — `npm install -g @frqncy-network/harness` and check that npm's global bin is on Hermes's `PATH`.
- **"Anthropic API key is missing"** — set `ANTHROPIC_API_KEY` in Hermes's env, or run `frqncy-harness auth set anthropic <key>` once on the box.
- **MCP servers configured in `~/.frqncy-harness/mcp.json` aren't connecting from Hermes** — make sure the user running Hermes has read access to that file. Or move the config to a shared location and set `FRQNCY_HARNESS_MCP_CONFIG_PATH` (v0.3+).
- **High costs in daemon mode** — the harness's per-conversation soft warn and hard abort caps still fire under daemon use. Check `frqncy-harness costs --period 7d` regularly. To tighten: `frqncy-harness config set costCap.hardAbortUsd 5`.

## See also

- The four-essay corpus: [`harness.md`](../harness.md)
- Architectural plan: [`proposals/HARNESS-PLAN.md`](../proposals/HARNESS-PLAN.md) — see decision 11 for the daemon-via-Hermes rationale
- Beginner guide for direct CLI use: [`proposals/HARNESS-BEGINNER-GUIDE.md`](../proposals/HARNESS-BEGINNER-GUIDE.md)
