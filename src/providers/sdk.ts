/**
 * SDK provider runner — wraps `@anthropic-ai/claude-agent-sdk`'s `query()`.
 *
 * This is the in-process counterpart to the subprocess lane (subprocess.ts).
 * Where claude-code/* subprocess-wraps the `claude` CLI (no tools, no per-token
 * usage, free via subscription), claude-sdk/* runs the same agent loop in-process
 * via the official SDK — yielding structured tool_call / tool_result events,
 * real per-token usage, and all the SDK's tools (bash, file ops, web, MCP).
 *
 * Trade-offs (vs subscription lane):
 *   PRO: tools work, MCP works, hooks work, real per-token cost data
 *   PRO: one process — no spawn overhead, no JSON-over-stdio fragility
 *   CON: bills your API account, not your subscription quota
 *
 * Trade-offs (vs api lane / @ai-sdk/anthropic):
 *   PRO: includes the entire Claude Code agent loop — sub-agents, the SDK's
 *        default tool registry, hook events, MCP server hosting — without us
 *        having to wire each piece
 *   CON: parallel tool plumbing — the harness's HarnessTool array is NOT
 *        currently bridged into the SDK's tool registry. v0.7 ships with
 *        the SDK's own tools only; bridging is a v0.8 follow-up.
 *   CON: less granular control over the agent loop than calling streamText()
 *        directly with our own tool set
 *
 * Use this lane for: anything that wants the Claude Code agent shape
 * (sub-agents via the Agent tool — pending the SUB-AGENTS proposal —
 * structured tool calls, MCP tool hosting) without the subprocess overhead.
 *
 * Use the API lane (anthropic/*) for: explicit harness-side control of the
 * tool set, AI SDK Tool composition, or anywhere you don't want the SDK's
 * default tool registry imposed.
 */
import type { Message, StreamEvent } from '../types.js';

export interface SdkRunOptions {
  /** Claude model id (e.g. 'claude-sonnet-4-6'). The 'claude-sdk/' prefix is stripped before this is called. */
  modelId: string;
  messages: Message[];
  system?: string;
  cwd?: string;
  /**
   * Pass-through MCP server configs for the SDK to host. Shape matches the SDK's
   * `mcpServers` option (Claude Desktop schema-compatible). The harness's existing
   * mcp.json can be passed in directly.
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Allowed-tool list filter applied by the SDK. If undefined, the SDK's default
   * tool set is allowed. Pass an empty array `[]` to disable all tools.
   */
  allowedTools?: string[];
}

/**
 * Run a Claude Agent SDK query and yield harness-shaped StreamEvents.
 *
 * Schema mapping:
 *   SDKAssistantMessage with text block       → 'text' event
 *   SDKAssistantMessage with tool_use block   → 'tool_call' event
 *   SDKUserMessage with tool_result block     → 'tool_result' event (or tool_error if is_error)
 *   SDKResultMessage                          → 'usage' event + final return
 *   SDKSystemMessage                          → ignored (init metadata)
 */
export async function* runSdkProvider(
  opts: SdkRunOptions,
): AsyncGenerator<StreamEvent, void, unknown> {
  // Lazy-import so users not on the SDK lane don't pay the cost.
  let queryFn: typeof import('@anthropic-ai/claude-agent-sdk').query;
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    queryFn = mod.query;
  } catch (err) {
    const message =
      `@anthropic-ai/claude-agent-sdk is not installed. ` +
      `Install with: npm install @anthropic-ai/claude-agent-sdk`;
    yield { type: 'error', error: { name: 'SdkNotInstalled', message } };
    throw Object.assign(new Error(message), { name: 'SdkNotInstalled', cause: err });
  }

  if (!process.env['ANTHROPIC_API_KEY']) {
    const message =
      'ANTHROPIC_API_KEY environment variable is required for claude-sdk/* models. ' +
      'Subscription-OAuth via Claude Max is deferred until Anthropic\'s 2026 ToS situation clears ' +
      '(see HARNESS-PLAN.md decision 4 revision). Until then: use claude-code/* for the subscription path.';
    yield { type: 'error', error: { name: 'SdkAuth', message } };
    throw Object.assign(new Error(message), { name: 'SdkAuth' });
  }

  const prompt = flattenMessagesToPrompt(opts.messages);

  // Build SDK options. The SDK accepts a typed Options shape; we cast through
  // `unknown` because the harness types should not depend on the SDK types
  // (lazy import principle), and the option keys are stable across the
  // SDK's documented v0+ surface.
  //
  // SUB-AGENTS NOTE: we explicitly disallow the SDK's built-in `Agent` tool.
  // See proposals/SUB-AGENTS.md — the default block is reversible; trace integrity
  // loss from sub-agent tool calls without a schema bump is not. Override by
  // passing `allowedTools` that includes 'Agent' if you've read the proposal
  // and accepted the trade-off for a specific run.
  const sdkOptions: Record<string, unknown> = {
    model: opts.modelId,
    disallowedTools: ['Agent'],
  };
  if (opts.system) sdkOptions['systemPrompt'] = opts.system;
  if (opts.cwd) sdkOptions['cwd'] = opts.cwd;
  if (opts.mcpServers) sdkOptions['mcpServers'] = opts.mcpServers;
  if (opts.allowedTools) {
    sdkOptions['allowedTools'] = opts.allowedTools;
    // If caller explicitly opts back in, drop the disallow.
    if (opts.allowedTools.includes('Agent')) {
      delete sdkOptions['disallowedTools'];
    }
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let costUsd = 0;

  try {
    const result = queryFn({
      prompt,
      options: sdkOptions as Parameters<typeof queryFn>[0]['options'],
    });

    for await (const message of result as AsyncIterable<SdkMessage>) {
      yield* mapSdkMessageToEvents(message);

      if (message.type === 'result') {
        // Capture usage from the final result message.
        const usage = message.usage ?? {};
        inputTokens = usage.input_tokens ?? 0;
        outputTokens = usage.output_tokens ?? 0;
        cachedInputTokens = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        costUsd = message.total_cost_usd ?? 0;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    yield { type: 'error', error: { name: 'SdkStreamError', message: error.message } };
    throw error;
  }

  yield {
    type: 'usage',
    usage: { inputTokens, outputTokens, cachedInputTokens, costUsd },
  };
}

// ────────────────────────────────────────────────────────────────────
// Message mapping — SDK message shape → StreamEvent
// ────────────────────────────────────────────────────────────────────

/**
 * Minimal structural type for SDK messages — we don't import the SDK's types
 * at module-eval time (lazy import). These match the documented SDK message
 * union as of @anthropic-ai/claude-agent-sdk v0.x.
 */
interface SdkMessage {
  type: 'assistant' | 'user' | 'result' | 'system';
  message?: {
    content?: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: string | unknown;
      is_error?: boolean;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd?: number;
}

function* mapSdkMessageToEvents(message: SdkMessage): Generator<StreamEvent, void, unknown> {
  if (message.type === 'system' || message.type === 'result') return;

  const blocks = message.message?.content ?? [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      yield { type: 'text', delta: block.text };
    } else if (block.type === 'tool_use' && block.id && block.name) {
      yield {
        type: 'tool_call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input ?? {},
      };
    } else if (block.type === 'tool_result' && block.tool_use_id) {
      if (block.is_error) {
        yield {
          type: 'tool_error',
          toolCallId: block.tool_use_id,
          toolName: 'unknown', // SDK tool_result blocks don't carry name; map by id at trace-read time
          error: {
            name: 'SdkToolError',
            message: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          },
        };
      } else {
        yield {
          type: 'tool_result',
          toolCallId: block.tool_use_id,
          toolName: 'unknown',
          output: block.content ?? null,
        };
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Message flattening
// ────────────────────────────────────────────────────────────────────

/**
 * The SDK's `query()` accepts either a string prompt or an async iterable of
 * SDKUserMessages. For v0.7 we flatten to a single prompt string — same approach
 * as the subscription lane. Multi-turn continuity should rely on the SDK's
 * own session resume (sessionId option), wired in v0.8.
 */
function flattenMessagesToPrompt(messages: Message[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    throw new Error('SDK provider requires at least one user message');
  }
  return lastUser.content;
}

// ────────────────────────────────────────────────────────────────────
// Doctor helper — check whether the SDK package is installed
// ────────────────────────────────────────────────────────────────────

export async function isClaudeAgentSdkAvailable(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}
