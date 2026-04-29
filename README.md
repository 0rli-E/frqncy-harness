# @frqncy-network/harness

> A plug-and-play LLM harness — provider-indifferent, trace-first, never compacted.

`@frqncy-network/harness` is the LLM harness that powers FRQNCY's agent surfaces and Orlando's daily workflow. It wraps the [Vercel AI SDK v6](https://sdk.vercel.ai) with direct provider SDKs for tier-1 models (Anthropic Claude, OpenAI, Google Gemini) and OpenRouter for the long tail (Hermes 4, Llama, DeepSeek, Qwen, etc.).

**Status:** v0.8.0-alpha.1+ — everything in v0.7 plus the **complete self-improvement loop** (4 new subcommands, 122 new tests, 326 passing total): `frqncy-harness ralph "<prompt>"` (persistent outer loop with completion-promise + max-iterations + kill switch — turns the harness from "a CLI you invoke" into "a process you can leave running"), `frqncy-harness reflect` (reads N recent traces, synthesizes the top recurring failure modes, proposes a fix per mode as a structured Markdown doc), `frqncy-harness codify <trace-id>` (reads one failed conversation, generates a Vitest regression test), and `frqncy-harness evolve` (reads a reflection, picks one proposal, wraps ralph to implement it via the claude-sdk lane, verifies with an external `npm test` gate the agent cannot fake). Ralph generates traces; reflect synthesizes patterns; codify makes individual failures into permanent tests; evolve actually closes the loop by implementing the proposed fixes. See `proposals/SELF-IMPROVING-HARNESS.md` for the full design. The earlier shipped surface: **nine provider lanes** (anthropic / openai / google / openrouter / chutes / perplexity / claude-sdk via API + claude-code / codex via subprocess), bash + read + write + grep + glob + web_fetch + web_search tools, MCP client, full agent loop with external-artifacts pattern, gtr/tempdir sandbox, cost guardrails, lethal-trifecta gate, never-compacted JSONL trace store mirrored to a private GitHub repo, hooks (5 bundled: auto-commit-traces, macos-notification, editorial-lint, cost-cap-monitor, trifecta-monitor), thread + project tagging, AGENT.md / CLAUDE.md auto-load in chat / repl / agent, **skill packs** (drop in `~/.frqncy-harness/skills/<name>/SKILL.md` and they auto-inject when the prompt matches), **trace replay + diff** (`frqncy-harness replay <id> --diff` to compare a saved conversation against a different model), and **persistent agent REPL** (`repl --agent` keeps the same sandbox, MCP connections, and conversation across turns).

---

## Why it exists

The 2026 consensus from Sequoia, Bessemer, Anthropic, OpenAI, Cognition, Cursor, and others: **the harness layer is where founders compete, not the model.** This is the harness layer for FRQNCY.

See the four-essay corpus in [`harness.md`](../harness.md) (TRAE on Harness Engineering, Jaya & Ashu / Animesh / Ishan on Context Graphs) and the architectural plan in [`proposals/HARNESS-PLAN.md`](../proposals/HARNESS-PLAN.md) for the full story.

---

## Quick start

```bash
# Install
npm install @frqncy-network/harness

# Set provider keys (any subset — the harness only requires keys for providers you actually use)
export ANTHROPIC_API_KEY=sk-...    # or OAuth via Claude Max (recommended, see below)
export OPENAI_API_KEY=sk-...
export GOOGLE_GENERATIVE_AI_API_KEY=...
export OPENROUTER_API_KEY=sk-or-...
```

```typescript
import { chat } from '@frqncy-network/harness';

// Same call works across all providers — swap a string, no other changes
const reply = await chat({
  model: 'anthropic/claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'hi' }],
});

console.log(reply.text);
console.log(reply.usage);  // { inputTokens, outputTokens, cachedInputTokens, costUsd }

// Streaming
import { stream } from '@frqncy-network/harness';

for await (const event of stream({
  model: 'openrouter/nousresearch/hermes-4-405b',
  messages: [{ role: 'user', content: 'count to ten slowly' }],
})) {
  if (event.type === 'text') process.stdout.write(event.delta);
}
```

### With tools (v0.2)

```typescript
import { stream, bashTool } from '@frqncy-network/harness';

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

### Agent commerce (v0.9 — ERC-8004 + x402)

```bash
# Configure: peer deps + CDP creds
npm install viem @coinbase/cdp-sdk
export CDP_API_KEY_ID=...
export CDP_API_KEY_SECRET=...
export CDP_WALLET_SECRET=...
export FRQNCY_NETWORK=base                   # or base-sepolia for testing
export FRQNCY_AGENT_DOMAIN=api.your-domain.com

# Verify
frqncy-harness doctor                        # surfaces wallet, network, registry, USDC, facilitator
frqncy-harness identity whoami               # owner EOA + smart-account address
frqncy-harness pay balance                   # USDC on both addresses

# Get discoverable
frqncy-harness identity register --domain api.your-domain.com --upload-to ./agent-registration.json
frqncy-harness identity serve --port 3030    # serves /.well-known/agent-card.json + /.well-known/agent-registration.json

# Look up another agent
frqncy-harness identity lookup 22 --network base

# Pay an x402-priced URL (under a per-call cap)
frqncy-harness pay test https://api.example.com/premium --max 100000  # cap = 0.10 USDC

# Discover paid resources via the facilitator
frqncy-harness pay discover
```

```typescript
// Library use — wrap any fetch with auto-paying behavior
import { createSigner } from '@frqncy-network/harness/wallet';
import { wrapFetchWithPayment, createBudgetState } from '@frqncy-network/harness/payments';

const signer = await createSigner({ network: 'base' });
const budget = createBudgetState({ softWarnUsdCents: 50, hardAbortUsdCents: 500 });

const paidFetch = wrapFetchWithPayment({
  signer,
  acceptedNetworks: ['base'],
  maxPerCallAtomic: 100_000n,                  // 0.10 USDC
  budget,
  onPrePayment: ({ resource, requirements }) =>
    console.error(`[pay] about to pay ${requirements.maxAmountRequired} for ${resource}`),
  onPayment: (record) =>
    console.error(`[pay] settled ${record.txHash} on ${record.network}`),
});

const res = await paidFetch('https://api.example.com/premium-data');
```

```typescript
// Library use — monetize an endpoint
import { createServer } from 'node:http';
import { paymentMiddleware, createFacilitatorClient, createCdpFacilitatorAuth } from '@frqncy-network/harness/payments';

const facilitator = createFacilitatorClient({
  url: 'https://api.cdp.coinbase.com/platform/v2/x402',
  createAuthHeaders: createCdpFacilitatorAuth(),  // CDP JWT auth
});

const middleware = paymentMiddleware({
  routes: {
    '/premium': {
      network: 'base',
      priceUsd: 0.05,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // USDC on Base
      payTo: '0xYourReceiverAddress',
    },
  },
  facilitator,
});

createServer(async (req, res) => {
  await middleware(req, res, async () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: 'premium content' }));
  });
}).listen(8080);
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

### v0.3.0-alpha.1 (shipped)
- ✅ `web_search` tool — auto-detects `TAVILY_API_KEY` or `BRAVE_SEARCH_API_KEY`, normalizes results across providers
- ⚠️ Anthropic OAuth — **NOT shipped**. Anthropic's 2026 *Authentication and credential use* policy prohibits using OAuth tokens from Free/Pro/Max accounts in third-party tools.

### v0.4.0-alpha.1 (this release — subscription providers)
- ✅ **`claude-code/*` provider** — subprocess-wraps the official `claude -p` CLI; uses your Claude Max subscription quota instead of API tokens. Permitted by Anthropic ToS (subprocess to official CLI ≠ OAuth token extraction).
- ✅ **`codex/*` provider** — subprocess-wraps `codex exec`; uses your ChatGPT Pro subscription quota.
- ✅ Doctor now detects both CLIs and reports installed/missing.
- ✅ Tools NOT supported on subscription path (the official CLIs do their own internal tooling) — clean structured error if attempted.
- ✅ Trace records mark `provider: 'claude-code' | 'codex'` and `costUsd: 0` (drawn from subscription quota, not API).

### v0.8.0-alpha.1 (this release — complete self-improvement loop, 4 sprints)
- ✅ **`frqncy-harness codify <conv-id>`** — reads one failed conversation, generates a Vitest regression test (34 tests)
- ✅ **`frqncy-harness reflect`** — reads N recent traces (filter by `--thread`, `--project`, `--since`, `--last`), generates a structured Markdown proposal of the top 3 recurring failure modes + a recommended fix per mode (new hook / new skill / system-prompt amendment / regression test). (27 tests)
- ✅ **`frqncy-harness ralph "<prompt>"`** — persistent outer loop with completion-promise + max-iterations + filesystem kill switch. The missing primitive that turns the harness from "a CLI you invoke" into "a process you can leave running." All iterations share one thread tag so reflect/codify can query them as a unit. Supports substring and `/regex/` predicates. (32 tests)
- ✅ **`frqncy-harness evolve`** — reads a reflection, picks one proposal, wraps `ralph` (auto-promotes anthropic/* models to claude-sdk/* for in-process tool calling) to implement the change, then verifies with an external `npm test` the agent cannot fake. Refuses on a dirty working tree unless `--yes` is passed. Does not open a PR; review the diff and run `gh pr create --draft` yourself. (29 tests)
- ✅ Inoculation prompting baked into all four commands' LLM calls (per Anthropic Nov 2025 reward-hacking paper, arXiv 2511.18397) — single-line system-prompt mitigation that reduces misalignment generalization 75-90% even at high reward-hacking rates
- ✅ Test seams (`chatFn`/`ralphFn`/`execFn`) on all four commands — fully testable without real LLM calls (122 new tests, total 326 passing)
- ✅ Manifest-based regression set: `test/regression/MANIFEST.md` auto-created and appended on each `codify`
- ✅ Default reflect output: `proposals/reflection-<YYYY-MM-DD>.md` with full source-trace list + filter metadata + the model proposal
- ✅ Default ralph kill switch: `touch ~/.frqncy-harness/kill.flag` halts before the next iteration starts
- ✅ Evolve hard rules: agent cannot modify files outside cwd, cannot push/merge/PR, cannot modify rubrics/AGENT.md locked decisions/the proposal doc itself, cannot fabricate completion
- ✅ Exports: `runCodifyCommand`, `runReflectCommand`, `runRalphCommand`, `runEvolveCommand`, plus all pure helpers (`matchesCompletionPredicate`, `buildCodifyPrompt`, `buildReflectionPrompt`, `parseProposalsFromMarkdown`, `buildImplementationPrompt`, `upgradeToSdkLane`, `INOCULATION_SENTENCE`, `REFLECT_SYSTEM_PROMPT`, `RALPH_SYSTEM_PROMPT`, etc.) and types

### v0.8.1-alpha.1 (this release — pre-evolve safety gates)
- ✅ **Three pre-evolve safety gates**, run BEFORE `npm test` inside `evolve`:
  - **rubric-anchor (C.5)** — path-based refusal. Default anchors: `rubrics/`, `AGENT.md`, `proposals/SELF-IMPROVING-HARNESS.md`. Configurable.
  - **inoculation-audit** — verifies agent's actual system prompt contained "reward hacking" (defense-in-depth against future refactors that drop the inoculation sentence silently).
  - **voice-anchor (C.4 — regex form, embedding form is v1.0)** — reads `~/.frqncy-harness/voice-anchor.md` (operator-curated banned-phrase list), scans agent's added lines for matches.
- ✅ Composite `runPreEvolveGate` runs the three in order (cheap → expensive), short-circuits on first failure.
- ✅ New `EvolveStatus`: `'gate_blocked'` (in addition to existing `completed`, `tests_failed`, `ralph_failed`, `dirty_tree`, `no_reflection`).
- ✅ `--skip-gate` flag for debugging the gate itself (NOT recommended for normal use).
- ✅ 49 new tests (45 in `evolve-safety.test.ts` + 4 new gate-integration tests in `evolve.test.ts`); total **375 passing**.
- ✅ Exports: `runPreEvolveGate`, `rubricAnchorGate`, `voiceAnchorGate`, `inoculationAuditGate`, `parseVoiceAnchor`, `loadVoiceAnchor`, `DEFAULT_RUBRIC_ANCHORS`, `DEFAULT_VOICE_ANCHOR_PATH`, `INOCULATION_REQUIRED_PHRASE`, plus types

### v0.8.2-alpha.1 (this release — auto-PR closes the last manual step)
- ✅ **`frqncy-harness evolve --auto-pr`** — after all gates + tests pass, automatically commits the agent's changes, pushes a new branch (`evolve/<slug>-<random>`), and opens a draft PR via `gh pr create --draft` with structured provenance metadata in both the commit message and the PR body.
- ✅ Hard safety rules: PR is always draft (never auto-merges); `git add` is surgical (only agent-modified files, never `-A`); always creates a new branch (never pushes to current); refuses on protected branches (`main`, `master`, `develop`, `production`, `release`) unless `--yes` is also set.
- ✅ PR body includes: source reflection, source thread, agent model, iterations, total cost, gates passed, test result, full proposal markdown, file list, and explicit "review manually before merging" instructions.
- ✅ Soft-fail design: if any PR-creation step fails (gh missing, push rejected, etc.), status stays `completed` (the diff IS on disk and tests DID pass) with `prResult.reason` explaining what to do manually.
- ✅ New `EvolveStatus`: `'pr_opened'`. New `EvolveResult.prResult: AutoPrResult`.
- ✅ 37 new tests in `test/evolve-pr.test.ts` + 3 new evolve-side integration tests covering the auto-pr path, gh-missing soft-fail, and tests-fail-no-pr.
- ✅ Total **412 passing**.
- ✅ Exports: `createPullRequest`, `generateBranchName`, `formatPrTitle`, `formatCommitMessage`, `formatPrBody`, `extractPrUrl`, `PROTECTED_BRANCHES`, plus types

### v0.13.4-alpha.1 (this release — `frqncy --show <slug>` inspects one persona)
- ✅ **`frqncy-harness frqncy --show <slug>`** drills into one persona: prints frontmatter (name / role / parent / model / voice / veto_authority / evolves), full system-prompt body, byte count, and inoculation status. Prompt-free, no LLM cost.
- ✅ Closes the inspection trio: `--list` (every persona, one line each), `--validate` (architectural invariants), `--show <slug>` (full body + metadata for one).
- ✅ Tier classifier reuses the v0.13.2 logic — drilling into `kali` correctly tags the result as `Council`; drilling into `frontend-dev` tags it `Workers`.
- ✅ JSON mode (`--json`) emits a structured `PersonaInspection` (slug / tier / path / frontmatter / body / bodyBytes / hasInoculation) suitable for piping into `jq`, building a persona-explorer UI, or feeding into the Telegram bridge.
- ✅ Throws with a helpful "Run \`frqncy --list\` to see available slugs" message when the persona isn't found.
- ✅ 11 new tests (101 total in `frqncy.test.ts`); total **759 passing**.
- ✅ Exports: `inspectPersona`, `runFrqncyShowCommand`, `PersonaInspection`, `FrqncyShowOptions`.

### v0.13.3-alpha.1 (`frqncy --validate` checks architectural invariants)
- ✅ **`frqncy-harness frqncy --validate`** runs a static check over the persona dir and reports issues by severity. Prompt-free, no LLM cost. Exits non-zero on any error so CI pipelines can gate on it.
- ✅ Rules enforced: FRQNCY persona exists at root (error); all 7 canonical Council members present (error per missing); Council members have `evolves: false` (error); Learning Agent has `evolves: false` (error); Worker parents resolve to a real persona (error); non-CEO C-Suite reports to `ceo` (warning); every persona body contains the inoculation invariant (warning); no duplicate slugs across tiers (error); name + role frontmatter present (warning).
- ✅ External parent roots (`orli`, `god`) are recognized — Council parents like `god + orli (NOT CEO)` validate cleanly without firing orphan-parent errors.
- ✅ Real FRQNCY OS smoke-tested: 34 personas, **0 errors, 0 warnings** — the hand-edited org is architecturally consistent.
- ✅ `--json` emits a structured `ValidationResult` (ok / totalPersonas / errorCount / warningCount / issues[]) suitable for CI parsing.
- ✅ 15 new tests in `test/frqncy.test.ts` covering each rule (positive + negative path), parent-slug extraction, external root handling, and the human + JSON CLI render. Total **747 passing**.
- ✅ Exports: `validateFrqncyOs`, `runFrqncyValidateCommand`, `extractFirstParentSlug`, `PERSONA_INOCULATION_INVARIANT`, `ValidationIssue`, `ValidationResult`, `ValidationSeverity`, `ValidationCategory`, `FrqncyValidateOptions`.

### v0.13.2-alpha.1 (`frqncy --list` enumerates the org)
- ✅ **`frqncy-harness frqncy --list`** prints every persona in FRQNCY OS grouped by tier (FRQNCY → Council → C-Suite → Workers → Meta), with role, model, parent, and flags (`evolves:false`, `veto`). Prompt-free — no LLM calls, no cost. Just reads the filesystem.
- ✅ Each persona line: slug, flags (yellow), role (dim), parent (dim, with `←`), model (dim, parens). Footer recaps the three invocation modes (`--persona`, `--council`, auto).
- ✅ JSON mode (`--json`) emits a structured array of `PersonaListing` objects suitable for piping into `jq`, the Telegram bridge, or any UI/inspector.
- ✅ New tier classifier reads the persona's directory: root + `frqncy.md` → FRQNCY; `council/` → Council; `c-suite/` → C-Suite; `workers/` → Workers; root + everything else (e.g. `learning-agent.md`) → Meta.
- ✅ `--persona-dir <path>` flag added to override the persona dir (matching what `runFrqncyCommand` already supports).
- ✅ 8 new tests in `test/frqncy.test.ts` covering tier classification, frontmatter parsing, sort order, missing-dir robustness, non-md filtering, and the human + JSON CLI render. Total **722 passing**.
- ✅ Exports: `runFrqncyListCommand`, `listPersonasGrouped`, `PersonaListing`, `PersonaTier`, `FrqncyListOptions`.

### v0.13.1-alpha.1 (`--save` extends to auto-routed deliberations)
- ✅ **`frqncy --save "<question>"`** now writes a deliberation file when FRQNCY's auto-routing decision is `multi`. The file lives at the same path (`proposals/council-deliberations/<date>-<slug>.md`) but uses the title `Routed deliberation` and embeds FRQNCY's actual synthesis text instead of the human-write placeholder.
- ✅ Each auto-routed deliberation file: H1 with `Routed deliberation — <date>`, source line names `frqncy-harness frqncy --save (auto-routed)`, the user's question, a `## Routing reason` section (FRQNCY's `reason` from the `[ROUTE]` decision), one section per invoked persona (model, cost, conv-id, body), and a `## Synthesis (FRQNCY)` section with FRQNCY's integrated answer verbatim.
- ✅ `--save` remains a no-op for `--persona` mode and for auto-mode `direct` / `single` decisions (only multi-perspective convenes get a durable artifact). The Council-mode behavior from v0.13.0 is unchanged.
- ✅ The routing pass and synthesis pass are NOT written as persona sections — only the personas FRQNCY actually invoked. The decision chain itself is preserved in the trace store as JSONL.
- ✅ `formatCouncilDeliberation` extended with optional `title`, `source`, `synthesisText`, `routingReason` params; backward compatible (default args reproduce v0.13.0 council output exactly).
- ✅ 8 new tests in `test/frqncy.test.ts` covering the auto-mode `--save` path, the suppressed-when-direct/single behavior, the routing-reason section, and the embedded-synthesis variant. Total **708 passing**.

### v0.13.0-alpha.1 (Council deliberation files)
- ✅ **`frqncy --council --save "<question>"`** writes a structured Markdown deliberation record at `proposals/council-deliberations/<date>-<slug>.md`. The trace store already preserved every invocation as JSONL — this is the human-readable rendering.
- ✅ Each deliberation file: H1 with date, the question verbatim, source metadata (members convened, total cost, trace tags), one section per Council member (name, model, cost, conv-id, response body), and a "Synthesis (yours to write)" placeholder for Orli to edit by hand as the deliberation lands.
- ✅ Pi-aligned: filesystem as substrate, externalized state. The deliberation file is the durable artifact a Telegram bridge can later link to, the Learning Agent can reflect on, or another agent can read in context.
- ✅ Slug derivation: date-prefixed + first 5 words of the question, kebab-cased and punctuation-stripped. Falls back to `<date>-council` for empty/all-symbol questions.
- ✅ `--save` is a no-op when not in `--council` mode (single-persona invocations are cheap and the trace store already preserves them; deliberation files only make sense for multi-perspective convenes).
- ✅ 13 new tests; total **676 passing**.
- ✅ Exports: `formatCouncilDeliberation`, `generateDeliberationSlug`, `DEFAULT_DELIBERATIONS_DIR`.

### v0.12.0-alpha.1 (FRQNCY auto-routing)
- ✅ **`frqncy "<prompt>"`** default mode is now **auto-routing.** FRQNCY decides whether to (a) answer directly, (b) route to one persona, or (c) convene multiple in parallel. For multi-persona, FRQNCY is then called again to synthesize the responses into one voice.
- ✅ FRQNCY emits routing decisions as `[ROUTE]: {...json...}` lines. The orchestrator parses this and dispatches. If the decision is unparseable, fallback returns FRQNCY's response as-is (no crash, no surprise).
- ✅ Each routing pass / persona invocation / synthesis is its own trace record (tagged `thread=frqncy-os/<persona>`, `project=frqncy-os`), so the entire decision chain is queryable via `reflect`/`codify`/`gain`. The Learning Agent can see WHY FRQNCY routed somewhere and whether the routing was right.
- ✅ **`--no-route`** flag preserves the v0.11 behavior (FRQNCY responds in its own voice, no routing protocol). Useful for testing the persona itself without the router layer.
- ✅ Hard rules baked into ROUTING_INSTRUCTIONS: routing must be wasteless (use `direct` for small questions); list of valid persona slugs is enumerated in the prompt; orchestrator validates persona names exist before invoking.
- ✅ 19 new tests; total **636 passing**.
- ✅ Exports: `parseRoutingDecision`, `buildSynthesisPrompt`, `ROUTING_INSTRUCTIONS`, `SYNTHESIS_INSTRUCTIONS`, `RoutingDecision` type.

### v0.11.0-alpha.1 (Learning Agent self-runner)
- ✅ **`frqncy-harness learning-agent run`** — meta-tier sibling of FRQNCY. Reads recent FRQNCY OS traces, identifies recurring failure modes per persona, proposes prompt updates. Composes the existing primitives (reflect → eval-three-arm → auto-PR are all reusable).
- ✅ Hard rule: **never touches Council personas.** The 7 Council members have `evolves: false` in their frontmatter; the Learning Agent enforces this both by checking the canonical Council list AND by reading the persona's frontmatter (defensive belt + suspenders). Council prompts evolve only by Orli's hand.
- ✅ Default mode is dry-run (proposal generated but not written). `--apply` writes the proposal to `proposals/learning-agent/<date>-<persona>.md` for review.
- ✅ `--persona <name>` focuses on one persona's traces (filters by `thread=frqncy-os/<persona>`); without it, the Learning Agent runs against the whole `project=frqncy-os` slice.
- ✅ Subcommand pattern: `learning-agent run` / `list-pending` / `list-applied` (last is v0.12 placeholder pointing at `git log --grep`).
- ✅ Inoculation sentence in the Learning Agent's own system prompt — this is the system most at risk of self-rewarding behavior, doubly explicit per Anthropic Nov 2025.
- ✅ 26 new tests; total **617 passing**.
- ✅ Exports: `runLearningAgentRun`, `runLearningAgentCommand`, `isCouncilPersona`, `shouldRefusePersonaUpdate`, `formatProposalMarkdown`, plus types.

### v0.10.0-alpha.1 (FRQNCY OS native router)
- ✅ **`frqncy-harness frqncy "<prompt>"`** — invoke FRQNCY OS, Orli's personal AI organization. Loads persona `.md` files from `./frqncy-os/` (default location) and routes through:
  - **Default mode** — invokes the FRQNCY persona (Jarvis-style router)
  - **`--persona <name>`** — direct invocation of any of the 33 personas (1 FRQNCY + 7 Council + 6 C-Suite + 19 Workers + 1 Learning Agent)
  - **`--council`** — convenes all 7 Council members in parallel (Krishna, Kali, Merlin, Saraswati, Sai Maa, Gary Spivey, Kevin Trudeau)
- ✅ All 33 persona files committed at `FRQNCY WEBSITE/frqncy-os/` with frontmatter (`name`, `role`, `parent`, `model`, `voice`, `veto_authority`, `evolves`). Council members have `evolves: false` (Learning Agent will not modify them — only Orli does).
- ✅ Each invocation tagged with `thread=frqncy-os/<persona>` and `project=frqncy-os`, so the entire org's traces are queryable via existing `reflect`/`codify`/`gain`/`costs` commands.
- ✅ Pi-aligned design (per `proposals/pi-coding-agent-zechner.md`): filesystem-as-substrate, top-level dispatch only (no persona ever spawns another), each persona gets its own independent `chat()` call. Council convene = 7 parallel calls + structured aggregation; the personas never share state.
- ✅ Pi blog post saved verbatim at `proposals/pi-coding-agent-zechner.md` (~6,873 words) — the canonical reference for "minimal harness" discipline.
- ✅ 27 new tests; total **591 passing**.
- ✅ Exports: `runFrqncyCommand`, `parsePersonaFile`, `defaultLoadPersona`, `listPersonas`, `COUNCIL_MEMBERS`, `DEFAULT_PERSONA_DIR`, `DEFAULT_FRQNCY_PERSONA`, plus types

### v0.9.0-alpha.1 (Tier B operations primitives)
- ✅ **`frqncy-harness gain`** — cost decomposition by tool / model / lane / conversation. Where `costs` shows total spend, `gain` shows what the tokens went to. Surfaces top-N most-expensive conversations for replay+diff analysis. (18 tests)
- ✅ **`frqncy-harness compress-memory <target>`** — rewrites stable agent inputs (CLAUDE.md, AGENT.md, skill READMEs) into compressed form, preserving the unchanged original at `<file>.original.md`. Idempotent (skips files where sidecar's hash matches the live file's compressed_from_hash). Saves 40-60% on every iteration forever. (26 tests)
- ✅ **`frqncy-harness eval-three-arm <skill>`** — runs a three-arm eval (baseline / generic-modifier / full-skill) against a fixture dataset, rejects skills whose lift over the generic modifier is below threshold (default 5pp). Catches the 80% of "improvements" that are placebos for a generic terseness effect. (19 tests)
- ✅ All three reuse existing primitives: trace-store readers (gain), `chat()` with cost cap (compress + eval), inoculation sentence in every LLM call.
- ✅ 63 new tests; total **486 passing**.
- ✅ Borrows directly from `juliusbrussee/caveman` (compress-memory, three-arm methodology) and `rtk-ai/rtk` (gain decomposition pattern) per `proposals/SELF-IMPROVING-HARNESS.md` Tier B.

### v0.8.3-alpha.1 (worktree isolation completes the safety story)
- ✅ **`frqncy-harness evolve --worktree`** — runs all evolve operations inside an isolated gtr worktree. The user's main checkout is never modified. Pairs with `--auto-pr` for the fully sandboxed autonomous flow (`evolve --worktree --auto-pr`).
- ✅ Reuses the existing `Sandbox` abstraction from `src/sandbox/` (`createGtrSandbox` + `isGtrAvailable`). No fallback to tempdir — evolve needs git history for the auto-PR push, so `--worktree` requires real gtr.
- ✅ Skips the dirty-tree check when in worktree mode (worktrees are fresh by construction).
- ✅ Smart cleanup: cleans up on success by default, keeps on failure for debugging. Override with `--keep-worktree` to always keep.
- ✅ New `EvolveStatus`: `'worktree_failed'`. New `EvolveResult.worktreePath` field.
- ✅ New `setupWorktreeFn` test seam so the worktree creation can be stubbed without invoking real `git gtr`.
- ✅ 8 new tests covering gtr-missing failure, cwd substitution, dirty-tree skip, cleanup-on-success, keep-on-failure, --keep-worktree override, worktreePath population, no-setup-when-unset.
- ✅ Total **423 passing**.

### v0.9.0-alpha.1 (this release — agent commerce: ERC-8004 + x402)
The 2026 consensus from MetaMask, Ethereum Foundation, Google, and Coinbase: agent identity (ERC-8004) and HTTP-native payments (x402) are the agentic-commerce primitives. This release ships both, native, on **Base mainnet** by default, with **Coinbase CDP smart wallets** as the default signer and a `viem` private-key fallback.

- ✅ **`src/wallet/`** — pluggable `Signer` interface. CDP adapter (`@coinbase/cdp-sdk`) is the default; viem private-key adapter is the fallback. Network-aware: Base mainnet (chainId 8453) and Base Sepolia (84532). USDC, IdentityRegistry, ReputationRegistry, and facilitator URL all keyed off `FRQNCY_NETWORK`. Wallet creds stored at `~/.frqncy-harness/auth/wallet.json` (mode 0600) or env (`CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` / `CDP_WALLET_SECRET` / `FRQNCY_AGENT_PRIVATE_KEY`).
- ✅ **`src/identity/`** — ERC-8004 IdentityRegistry + ReputationRegistry viem clients, Zod-validated AgentCard model with three composers (`withIdentity`, `withPayments`, `withA2A`), serialization to both `/.well-known/agent-card.json` (A2A) and `/.well-known/agent-registration.json` (EIP-8004 endpoint-domain proof), and a tiny built-in HTTP server (`serveAgentCard`) for the `.well-known` paths. Validation Registry stubs only (per Lucid Agents — spec is "under active development"). AP2 declared as a capability in `card.capabilities.extensions[]`, not implemented as wire protocol. Canonical contract addresses: Base IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, ReputationRegistry `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`.
- ✅ **`src/payments/`** — x402 v1 wire format end-to-end. Verbatim Zod mirrors of the Coinbase reference SDK schemas (`PaymentRequirements`, `PaymentPayload`, `SettleResponse`, `TransferWithAuthorization` typed-data). Three integration surfaces: (a) **`wrapFetchWithPayment`** — a `fetch` wrapper that auto-pays 402 responses under a per-call cap and a per-conversation budget (default $0.50 soft / $5.00 hard, configurable); (b) **`paymentMiddleware`** — Node-`http` style middleware to monetize endpoints; (c) **`createPayTool` + `createDiscoverAgentsTool`** — opt-in `HarnessTool`s the LLM can call, both `propose-then-approve`. Pre-payment hook for ops vetoes. Coinbase CDP facilitator default on Base mainnet, public `https://x402.org/facilitator` on Sepolia, configurable.
- ✅ **CLI**: `frqncy-harness identity {register|whoami|card|serve|lookup}` and `frqncy-harness pay {test|balance|budget|discover}`. `doctor` extended to surface viem + cdp-sdk peer dep status, wallet creds, network, registry addresses, USDC contract, and facilitator URL.
- ✅ **Daydreams patterns lifted** (from `daydreamsai/lucid-agents`): three-hook extension lifecycle, immutable AgentCard composition, payments-at-HTTP-first / LLM-tool-second, signer-handle preference order. We do **not** bundle Lucid — we implement the same protocol surface natively, in a shape consistent with the harness's locked decisions (provider-indifferent, trace-first, never compacted, Zod-at-every-boundary). Other ecosystem patterns lifted: ChaosChain's `8004#<tokenId>` agentId convention, Catena ACK's symmetrical caller/handler pattern, Phala's three `.well-known/*` endpoints.
- ✅ **59 new tests, 545 total passing**. Offline by design: `wrapFetchWithPayment` exercised against an in-process mock 402 server; `paymentMiddleware` against a fake facilitator; viem and CDP are *optional* peer deps.
- ✅ **Peer deps** (both `optional: true`): `viem ^2.21.0`, `@coinbase/cdp-sdk ^1.0.0`. Install only what you use.
- ✅ Full design + research dossier: [`proposals/AGENT-COMMERCE.md`](./proposals/AGENT-COMMERCE.md), plus `proposals/research/{erc8004-spec,x402-spec,daydreams-patterns,cdp-and-ecosystem}.md`.

### v0.9.1-alpha.1 (this release — Daydreams bridge + router lane)
- ✅ **`src/bridges/daydreams.ts`** — bidirectional Daydreams interop. `harnessToolToDaydreamsAction(tool, ctx)` lifts a HarnessTool into a Daydreams `Action` with permission tier (auto vs propose-then-approve) intact. `daydreamsActionToHarnessTool(action)` is the inverse — wrap Daydreams plugins (hyperliquid, starknet, telegram, etc.) as HarnessTools so the harness loop can call them. `createDaydreamsExtension({ tools, toolContext, prefix })` bundles a list of harness tools into a Daydreams `Extension` shape so a single `.use(...)` line gets the entire harness primitive surface inside a Daydreams agent. `daydreamsExtensionToHarnessTools(ext)` is the inverse bundle.
- ✅ **`src/bridges/daydreams-router.ts`** — the Daydreams Router (`ai.xgate.run`) as a new paid inference lane. OpenAI-compatible (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models`, embeddings, audio, video) with **ERC-2612 USDC permit** auth (not EIP-3009 — distinct signing path on `src/payments/permit.ts`). Single CDP wallet → access to Anthropic Opus 4.6, GPT-5, Kimi K2.5, Flux 2 Pro, Kling, no per-provider API keys. `createDaydreamsRouterFetch({ signer, permitCapAtomic, permitDeadlineSeconds })` returns a `fetch` that handles the 402 → permit → retry handshake and reuses sessions via the `X-Upto-Session` header. Smart routing supported via `model: "auto"`.
- ✅ **`src/payments/permit.ts`** — ERC-2612 Permit signer (Daydreams' x402 variant). `signPermit({ signer, asset, tokenName, tokenVersion, chainId, message })` returns the (v, r, s)-decomposed signature plus base64-encodable header payload via `encodePermitHeader`/`decodePermitHeader`. Coexists with the existing EIP-3009 `transferWithAuthorization` signer in `src/payments/sign.ts` — wire format pluggable.
- ✅ **s4mmy patterns lifted** (from `proposals/research/s4mmy-and-daydreams-router.md`): "service integration + payments is the bottleneck, not model quality" — directly informs decision to privilege payment-rail breadth (CDP + Daydreams Router + x402 facilitator pluggability) over marginal model selection logic. "Encode human approval for sensitive actions" — already enforced via `propose-then-approve` permission tier and the pre-payment hook. "Endorsement provenance matters" — fed back into the AGENT-COMMERCE roadmap for ERC-8004 reputation writes that expose *who* attested. Bankless's framing of his account as a daily-cadence alpha source is why the bridge ships in this release rather than waiting for v1.0.
- ✅ **19 new tests, 564 total passing**. Mock-router test exercises the full handshake — 402 challenge, permit signing, retry, session reuse — without touching a real chain or facilitator.
- ✅ `@daydreamsai/core` is a peer dep (not bundled) — the bridge typechecks structurally so installations without Daydreams compile clean. Install `@daydreamsai/core` only if you want the interop surface.

### v0.10 (next)
- ⏳ Ralph + tools per iteration — wire the existing tool surface (bash, file, web, MCP) into ralph's per-iteration calls so it works for coding tasks across all lanes
- ⏳ Voice-anchor v2 — embedding-distance check against a canonical voice exemplar (today's anchor is purely lexical/regex)
- ⏳ Inkified REPL + agent UI (richer streaming display, spinner, tool-call boxes)
- ⏳ DSPy + GEPA Python sidecar for trace optimization (down-the-roads)
- ⏳ MCP sampling support (let MCP servers request LLM calls back through the harness)
- ⏳ Make `--worktree` the default in v1.0 (today it's opt-in for backwards compat)
- ⏳ x402 v2 wire format (`PAYMENT-SIGNATURE` headers, CAIP-2 networks) drop-in
- ⏳ Verifiable Receipt issuance on settlement (Catena ACK pattern)
- ⏳ Reputation auto-write after settlement (currently opt-in, default off)
- ⏳ Permit2 + ERC-7710 transfer methods alongside EIP-3009
- ⏳ TEE attestation surface (Phala pattern)

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
