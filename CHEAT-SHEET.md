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

### `frqncy-harness codify` — turn a failed run into a regression test

The cornerstone self-improvement primitive. Every time you watch the loop fail, one command makes the fix permanent.

```
frqncy-harness traces --recent 10
```

Pick a conversation id (or its first 8 chars) that produced a wrong/off-brand/aborted output. Then:

```
frqncy-harness codify <conv-id>
```

That reads the conversation, infers the failure mode, asks an LLM to write a Vitest regression test, and writes it to `test/regression/<slug>.test.ts`. A row gets appended to `test/regression/MANIFEST.md` so you can see what's been codified at a glance.

The generated test starts as `describe.skip(...)` so it doesn't break the suite. Open the file, review the proposed assertion, fix any wrong inference, then change `describe.skip` to `describe` when you're ready to gate against this regression.

If the trace looks "successful" (status=completed, no error records) but the output was still wrong, pass `--reason` so codify doesn't refuse:

```
frqncy-harness codify <conv-id> --reason "homepage CTA went off-brand: said 'unlock' instead of 'enter'"
```

Other useful flags:

```
frqncy-harness codify <conv-id> --dry-run         # print the proposed test, don't write
frqncy-harness codify <conv-id> --output path.ts  # custom output location
frqncy-harness codify <conv-id> --model claude-sdk/claude-opus-4-6  # use a sharper model for the generation
frqncy-harness codify <conv-id> --json            # structured output for piping
```

Safety: every codify invocation prepends an inoculation sentence to the LLM's system prompt naming reward-hacking as a known anti-pattern. This is the Anthropic Nov 2025 mitigation (arXiv 2511.18397) and reduces misalignment generalization 75-90% even at high reward-hacking rates. See `proposals/SELF-IMPROVING-HARNESS.md` for the full design.

### `frqncy-harness evolve` — close the self-improvement loop

After `harness reflect` has produced a proposal, `harness evolve` actually implements it. It wraps `ralph` with the `claude-sdk` lane (which does in-process tool calling), then runs `npm test` from outside ralph to verify. The agent cannot fake the test gate.

```
frqncy-harness reflect                        # generate the proposal
frqncy-harness evolve                         # implement proposal #1 from the latest reflection
```

The default flow:

1. Reads the most recent `proposals/reflection-*.md` (or `--reflection <path>`)
2. Picks proposal `#1` (or `--proposal N`)
3. Refuses if the working tree is dirty (commit, stash, or `--yes` to override)
4. Wraps `ralph` with an implementation prompt: read the proposal, implement the smallest correct change, run typecheck + npm test via the bash tool, emit `<promise>EVOLVE COMPLETE</promise>`
5. After ralph completes, runs `npm test` independently (defensive verify — agent cannot fake this)
6. Lists changed files via `git diff --name-only`
7. Tells you to review with `git diff` and run `gh pr create --draft` when ready

Useful flags:

```
frqncy-harness evolve --proposal 2            # implement the second proposal
frqncy-harness evolve --reflection proposals/reflection-2026-04-26.md
frqncy-harness evolve --max-iterations 10     # tighter cap on the inner loop (default 15)
frqncy-harness evolve --skip-verify           # don't run npm test (faster, less safe)
frqncy-harness evolve --yes                   # bypass dirty-tree refusal
frqncy-harness evolve --json                  # structured stdout for piping
```

Default model is whatever your config says, but `evolve` auto-promotes `anthropic/*` lanes to `claude-sdk/*` because that's the lane that does multi-step tool calling automatically inside each iteration. Pass `--model` to override.

Hard rules baked into the implementation prompt:
- Agent cannot modify files outside the working directory
- Agent cannot push, merge, or open a PR — your job ends at "tests pass on a clean diff"
- Agent cannot modify `rubrics/*.md`, AGENT.md's locked decisions, or `proposals/SELF-IMPROVING-HARNESS.md` itself
- Agent cannot fabricate completion to escape a hard problem

### The pre-evolve gate (v0.9 — runs by default)

Between ralph completing and `npm test` running, evolve now runs a three-part gate:

1. **rubric-anchor** — refuses if the agent modified `rubrics/`, `AGENT.md`, or `proposals/SELF-IMPROVING-HARNESS.md`. Configurable via the `EvolveCommandOptions.rubricAnchors` programmatic option.
2. **inoculation-audit** — verifies the agent's actual system prompt contained "reward hacking" (per Anthropic Nov 2025). Defense-in-depth against future refactors that drop the inoculation sentence silently.
3. **voice-anchor** — if `~/.frqncy-harness/voice-anchor.md` exists, scans the agent's added lines for banned phrases. No-op pass when the file is absent.

The gate runs BEFORE `npm test` because:
- An agent can write tests that lock in off-brand prose; the voice gate catches that
- An agent can rewrite a rubric and have tests still pass; the rubric gate catches that
- Tests don't audit the agent's own system prompt; inoculation-audit does

To set up the voice anchor, drop a file at `~/.frqncy-harness/voice-anchor.md`:

```markdown
# Voice anchor for FRQNCY

## Banned phrases

- unlock
- leverage
- synergy
- 10x
- circle back
- low-hanging fruit

## Banned in code comments

- @ts-ignore
- TODO without owner
```

Banned phrases are matched case-insensitively as substrings against agent-added lines (lines starting with `+` in the diff). Code-comment phrases match only inside lines starting with `//`, `#`, `*`, `/*`, or `--`.

Skip the gate explicitly with `--skip-gate` (NOT recommended — it removes the rubric and voice protections; only use if you're debugging the gate itself).

### `frqncy-harness evolve --auto-pr` — fully autonomous through PR review

After all gates pass and `npm test` exits 0, `--auto-pr` automatically commits the agent's changes, pushes a new branch (`evolve/<slug>-<random>`), and opens a draft PR via `gh pr create --draft`. The PR body includes structured provenance metadata: source reflection, source thread, agent model, iterations, total cost, gates passed, test result, and the full proposal text.

```
frqncy-harness evolve --auto-pr
```

What it requires:
- `gh` CLI installed (`brew install gh`) and authenticated (`gh auth login`)
- A git remote configured for cwd
- You're not on a protected branch (`main`, `master`, `develop`, `production`, `release`) — or you pass `--yes` to override

Hard rules baked in:
- The PR is ALWAYS draft — never auto-merges
- `git add` is surgical (only the files the agent actually changed; never `git add -A`)
- A new branch is always created (never pushes to your current branch)
- Branch name has a 6-char random suffix so multiple evolves of the same proposal don't collide
- Status maps to `pr_opened` only when the PR successfully opens; if anything in the PR-creation chain fails (gh missing, push rejected, etc.), status stays `completed` and `prResult.reason` explains what to do manually

Example PR body sections (auto-generated):

```
## Source
- Reflection: `proposals/reflection-2026-04-28.md`
- Proposal: Tone drift on long-form content
- Source thread: `evolve-abc12345`

## Provenance
- Agent model: `claude-sdk/claude-sonnet-4-6`
- Iterations: 3
- Total cost: $0.0421
- Inoculation active: ✓ (per Anthropic Nov 2025, arXiv:2511.18397)
- Provenance: `agent`

## Pre-evolve gate
- ✓ rubric-anchor
- ✓ inoculation-audit
- ✓ voice-anchor

## Test gate
- ✓ `npm test` exited 0

## The proposal
[...full proposal markdown...]

## Files changed
- `src/skills/brand-anchor.ts`

## How to merge safely
1. Review the diff manually
2. Run `npm test` locally
3. Read the proposal again — does the implementation actually solve the recurring failure mode?
4. If everything looks good, mark as Ready for review and merge.
```

### `frqncy-harness evolve --worktree` — full file isolation

When `--worktree` is set, evolve runs all operations inside an isolated gtr worktree. Your main checkout is never modified — the agent edits files in a separate folder, on a separate branch, with its own HEAD.

```
frqncy-harness evolve --worktree --auto-pr
```

That's the fully autonomous flow: worktree creation → ralph implements → gates → tests → auto-PR — all with zero touches to your working tree.

What it requires:
- `git gtr` installed (`brew install git-gtr`)
- cwd is inside a git repo

What's different from default mode:
- Skips the dirty-tree check (worktree is fresh by construction; user's cwd doesn't matter)
- All `git add`, `git commit`, `git push` happen inside the worktree
- The branch on origin still ends up at `evolve/<slug>-<random>` — the worktree's local branch name doesn't matter
- The reflection file is read from your USER cwd (the worktree starts empty); everything else uses the worktree path

Cleanup behavior:
- **On success:** worktree is cleaned up automatically (`git gtr clean`)
- **On failure:** worktree is kept on disk for inspection — its path is in `result.worktreePath`
- **`--keep-worktree`:** force keep regardless of success/failure (clean up manually with `git gtr clean`)

Pairing with `--auto-pr`:

```
frqncy-harness evolve --worktree --auto-pr
```

This is the safest possible autonomous flow: file isolation (worktree) + commit/push from inside the worktree + draft PR + provenance metadata + all the safety gates. After success, the worktree disappears and the only artifact is the draft PR ready for your review.

### What `evolve` still does NOT do (v1.0 work)

- Does NOT use embedding-distance for voice (lexical regex only — v1.0 adds the embedding-based anchor check)
- Does NOT auto-merge — the PR is always draft and requires human review
- Does NOT auto-rerun on failure — if ralph exhausts iterations or tests fail, you re-invoke manually

### `frqncy-harness frqncy` — talk to your AI organization

The router into FRQNCY OS — Orli's personal AI organization. Loads 33 persona `.md` files from `./frqncy-os/` and routes your prompt to one or more.

```
frqncy-harness frqncy "should I sit with this or move on it"
```

**v0.12 default behavior — auto-routing.** FRQNCY makes a routing decision (`direct` / `single` / `multi`), the harness invokes the chosen persona(s), and for multi-persona FRQNCY synthesizes the responses into one voice. You see the [ROUTE] line printed first, then the final response.

To bypass routing and just talk to FRQNCY (the v0.11 behavior), pass `--no-route`:

```
frqncy-harness frqncy --no-route "what's your read on this"
```

For specific personas:

```
frqncy-harness frqncy --persona kali "this old project keeps getting back into my calendar"
frqncy-harness frqncy --persona ceo "draft this week's exec summary"
frqncy-harness frqncy --persona text-content-writer "draft a Substack on coherence breathing"
```

For the full Council in parallel (7 simultaneous chat calls, ~$0.04 total at default models):

```
frqncy-harness frqncy --council "I need a read on whether to take the Lugano partnership"
```

Each Council member responds independently. You (or FRQNCY) integrate.

To save the deliberation as a structured Markdown record (for later review, Telegram linking, or feeding into the Learning Agent):

```
frqncy-harness frqncy --council --save "I need a read on whether to take the Lugano partnership"
# → writes proposals/council-deliberations/<date>-i-need-a-read-on.md
```

The file contains the question, all 7 Council responses with metadata, and a "Synthesis (yours to write)" placeholder for you to edit by hand as the deliberation lands. Pi-aligned: filesystem as substrate, externalized state.

`--save` also works in default (auto-routed) mode whenever FRQNCY decides to convene multiple personas:

```
frqncy-harness frqncy --save "should we take the Lugano partnership"
# → if FRQNCY routes multi (e.g. sai-maa + ceo), writes proposals/council-deliberations/<date>-should-we-take-the-lugano.md
# → if FRQNCY answers direct or routes to a single persona, no file is written (cheap calls; trace store has it)
```

Auto-routed deliberation files use the title `Routed deliberation`, embed FRQNCY's actual synthesis in `## Synthesis (FRQNCY)` (not the human-write placeholder), and include a `## Routing reason` section so future readers know why those personas were convened together.

**See the whole org at a glance:**

```
frqncy-harness frqncy --list
# → prints every persona grouped by tier (FRQNCY / Council / C-Suite / Workers / Meta)
#   with role, model, parent, and flags (evolves:false, veto). Prompt-free, no LLM cost.

frqncy-harness frqncy --list --json | jq '.[] | select(.tier == "Workers")'
# → structured output for filtering/scripting
```

**Validate the org's architectural invariants:**

```
frqncy-harness frqncy --validate
# → checks: FRQNCY exists; all 7 Council members present; Council + Learning Agent
#   have evolves:false; worker parents resolve; inoculation invariant in every body.
#   Exits non-zero on error — wire into CI to gate persona-file commits.
```

**Drill into one persona:**

```
frqncy-harness frqncy --show kali
# → frontmatter (name/role/parent/model/voice/veto/evolves), full system prompt body,
#   byte count, inoculation status. Useful before you edit a persona file or right
#   after, to confirm the change rendered as expected.

frqncy-harness frqncy --show kali --json | jq .frontmatter
# → structured output for scripting
```

**The 34 personas:**

| Tier | Personas | Voice |
|---|---|---|
| FRQNCY | frqncy | Jarvis — routes everything |
| Council (7) | krishna, kali, merlin, saraswati, sai-maa, gary-spivey, kevin-trudeau | Spiritual, veto authority over C-Suite, never auto-evolved |
| C-Suite (6) | ceo, cto, cmo, coo, cso, cfo | Operational executives under CEO |
| Workers (19) | (under each C-Suite member) | Specialized craftsmen |
| Learning Agent | learning-agent | Reads traces, proposes prompt updates (never Council prompts) |

All persona files live at `FRQNCY WEBSITE/frqncy-os/`. Each is a flat `.md` with frontmatter (name, role, parent, model, voice, veto_authority, evolves) + system prompt body. Edit them by hand to refine voice — they're version-controlled like any other doc.

**Each invocation is tagged:**
- `thread=frqncy-os/<persona-name>`
- `project=frqncy-os`

So `frqncy-harness reflect --project frqncy-os` synthesizes failure modes across the whole organization, `frqncy-harness gain --project frqncy-os --period 7d` shows weekly spend by persona, and `frqncy-harness costs --by-thread --project frqncy-os` shows per-Council-member cost.

**Hard rules baked into the persona prompts:**
- The 7 Council members report only to God + Orli, never to CEO. They have veto authority over C-Suite.
- The Learning Agent will never modify Council prompts (Council frontmatter has `evolves: false`).
- No persona spawns another persona mid-conversation. Top-level dispatch only (per pi's design).
- Each persona's system prompt includes the inoculation sentence (per Anthropic Nov 2025).

### `frqncy-harness learning-agent run` — let the org improve itself

The Learning Agent — meta-tier sibling of FRQNCY. Reads recent traces from your FRQNCY OS invocations, identifies recurring failure modes per persona, and proposes prompt updates.

```
# Default: dry-run, scoped to whole frqncy-os project, last 7d, 30 traces
frqncy-harness learning-agent run

# Focus on one persona's traces
frqncy-harness learning-agent run --persona ceo

# Write the proposal to disk for review
frqncy-harness learning-agent run --persona text-content-writer --apply
```

The proposal lands at `proposals/learning-agent/<date>-<persona>.md` with:
- Source persona + reflection path + traces analyzed + timestamp
- Hard guarantees (inoculation active, Council not touched, no prompt change applied)
- Reflection synthesis (recurring failure modes, recommended fixes)
- Concrete next-step commands you can run verbatim

**Hard rule (enforced two ways):**
- Will refuse on the 7 Council members by name (krishna, kali, merlin, saraswati, sai-maa, gary-spivey, kevin-trudeau)
- Will refuse on any persona whose `evolves: false` is set in frontmatter

To list pending proposals:

```
frqncy-harness learning-agent list-pending
```

To go from proposal to draft PR (the Learning Agent doesn't do this directly in v0.11; use the existing evolve machinery):

```
# After reviewing the learning-agent proposal:
frqncy-harness evolve --reflection proposals/reflection-<date>.md --auto-pr --worktree
```

This pairs the Learning Agent's pattern recognition with `evolve`'s implementation + safety gates + auto-PR.

### `frqncy-harness gain` — see where the tokens go

`costs` shows your total spend; `gain` shows what it went to. Three views in one command.

```
frqncy-harness gain --period 7d
```

Default output:
- **Spend by model** — which lanes ate the budget (e.g., `claude-sdk/claude-opus-4-6  $4.20  3 conv`)
- **Tool-call distribution** — what tools the agents reached for, across how many conversations
- **Top 10 most-expensive conversations** — outliers worth replaying with `--diff`

Filter to one thread/project, or change the time window:

```
frqncy-harness gain --period 30d --top 20 --thread frqncy-content
frqncy-harness gain --period all --json
```

Use the top-conversations list as input to `replay --diff` to see exactly what an expensive run produced. Pair with `compress-memory` if a single conversation is eating tokens via repeated stable inputs.

### `frqncy-harness compress-memory <target>` — pay for inputs once, not every iteration

Rewrites the harness's stable agent inputs (CLAUDE.md, AGENT.md, skill READMEs, persona blocks — anything injected every turn) into compressed form. Preserves the unchanged original at `<file>.original.md`. Idempotent.

```
frqncy-harness compress-memory ~/.frqncy-harness/skills/
frqncy-harness compress-memory AGENT.md --dry-run
```

How it works:
- Walks the target dir for `.md` files (skips `node_modules/`, `dist/`, files under 1500 bytes)
- For each, calls the LLM with a token-compression system prompt (preserves facts, code, headings; drops articles + filler)
- Writes original to `<file>.original.md`, compressed version to `<file>` with frontmatter `compressed_from_hash: <16-char-hash>`
- Re-running is a no-op when the sidecar hash matches the live file's `compressed_from_hash` (unless `--force`)
- Refuses compressions that grew the file (some models do this)

Why it pays off forever: a loop running 25 iterations against a 4000-token CLAUDE.md pays 100K tokens just for standing context. Compress that to 2000 tokens once and save 50K tokens per loop, every loop.

Hard guarantees:
- The first `<file>.original.md` is preserved across re-compressions; you never lose the canonical source
- The compression LLM is run with the inoculation sentence + cost cap from your config
- Editing the live (compressed) file by hand and re-running compresses your edits, not the original

### `frqncy-harness eval-three-arm <skill>` — catch placebo skill improvements

The methodological gate. Most skill claims compare *(skill on)* to *(skill off)* and credit the skill with whatever generic effect they triggered. Three-arm controls for that.

```
frqncy-harness eval-three-arm brand-voice-anchor --dataset test/eval-fixtures.jsonl
```

Each fixture in the dataset (JSONL, one per line) has the form:

```json
{"prompt": "Write a hero section for the equanimity page", "expected_contains": "practitioner", "banned_phrases": ["unlock", "synergy"], "label": "equanimity-hero"}
```

The command runs every fixture three times:
1. **baseline** — prompt only
2. **generic** — prompt + a short generic addendum (default: `"Answer concisely. Drop filler. Keep code blocks unchanged."`; override with `--modifier`)
3. **skill** — prompt + the named skill's body as system addendum

Aggregates pass-rates per arm. Computes:
- **lift over baseline** (does the skill help at all?)
- **lift over generic** (is it doing anything specific the generic modifier wasn't?)

The gate fails if `(skill_passrate - generic_passrate) < --lift-threshold` (default 5 percentage points). Failure means: your skill is mostly a placebo for the generic terseness effect; revise it or accept it doesn't add specific value.

Use it as a CI gate on any new skill or prompt edit:

```
frqncy-harness eval-three-arm <new-skill> --lift-threshold 5 --json | jq '.passedThreshold'
# returns true|false; exit 1 in CI on false
```

### `frqncy-harness ralph` — leave it running

The persistent outer loop. Re-invokes the model against the same prompt + thread until a completion predicate matches, max-iterations is hit, the cost cap fires, or you touch `~/.frqncy-harness/kill.flag`.

```
frqncy-harness ralph "draft a topic page on equanimity practice and emit <promise>DONE</promise> when build green && lighthouse > 90"
```

The default predicate is the literal string `<promise>DONE</promise>`. Override it for explicit conditions:

```
frqncy-harness ralph "build the haiku" --until "BUILD GREEN" --max-iterations 10
```

```
frqncy-harness ralph "raise lighthouse score" --until "/lighthouse score:\\s*9\\d/i"
```

Every iteration is a single `chat()` call against the configured model. For TOOL work (bash, file edits), use the in-process SDK lane:

```
frqncy-harness ralph "fix the broken test" --model claude-sdk/claude-sonnet-4-6 --until "all tests passing"
```

The SDK lane does multi-step tool calling automatically inside each iteration; ralph wraps that in the persistent re-injection loop.

All iterations share one `--thread` id (auto-generated as `ralph-<short>` if not given) so you can later run:

```
frqncy-harness reflect --thread <ralph-thread-id>     # synthesize what kept failing
frqncy-harness codify <conv-id>                       # fix one specific failed iteration
```

Kill switch (works mid-loop):

```
touch ~/.frqncy-harness/kill.flag    # halts before the next iteration starts
rm ~/.frqncy-harness/kill.flag       # clears it for next run
```

Other flags: `--cwd <path>` (informational; full file-tool integration lands in v0.9), `--project <id>` (tag), `--json` (structured stdout).

Same safety guarantees: inoculation sentence baked into the system prompt; cost cap from config aggregated across the whole loop, not per iteration; max-iterations is a HARD cap.

### `frqncy-harness reflect` — what's been failing across the last N runs

Where `codify` operates on one failed conversation, `reflect` reads many at once and asks an LLM to synthesize the recurring failure modes and propose fixes. Use it weekly — or after a batch of agent runs — to spot patterns you'd miss looking at one trace at a time.

```
frqncy-harness reflect
```

Reads the last 20 traces from the past 7 days (failures only), runs the reflection, writes the proposal to `proposals/reflection-<YYYY-MM-DD>.md`.

Filter to one project / thread / time window:

```
frqncy-harness reflect --thread frqncy-content --since 30d --last 50
```

```
frqncy-harness reflect --project frqncy --include-success
```

Other flags:

```
frqncy-harness reflect --dry-run                  # print proposal, don't write
frqncy-harness reflect --output analysis/today.md # custom output
frqncy-harness reflect --model claude-sdk/claude-opus-4-6  # use a sharper model
frqncy-harness reflect --json                     # structured stdout for piping
```

The proposal asks for the top 3 recurring failure modes and recommends ONE concrete fix per mode — a new hook, a new skill, a system-prompt amendment, or a regression test (which you can then feed into `harness codify`). Read it, decide, hand-implement (or wait for `harness evolve` next sprint).

Same safety guarantee as codify: every reflect invocation prepends the inoculation sentence to the LLM's system prompt naming reward-hacking as a known anti-pattern (Anthropic Nov 2025, arXiv 2511.18397).

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
