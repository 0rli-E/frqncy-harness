/**
 * Core types and Zod schemas for @frqncy-network/harness.
 *
 * The trace schema is sacred. Bump TRACE_SCHEMA_VERSION on any breaking change
 * and write a migration in src/trace/migrations/.
 */
import { z } from 'zod';

export const TRACE_SCHEMA_VERSION = '0.1.0';

// ────────────────────────────────────────────────────────────────────
// Provider model strings — `<provider>/<model>` namespace
// ────────────────────────────────────────────────────────────────────

/**
 * Supported providers.
 *
 * API providers (require API key, full feature support — tools, caching, streaming):
 *   - anthropic, openai, google, openrouter, chutes, perplexity
 *
 * Subscription providers (subprocess-wrap an official CLI; uses your $200/mo subscription
 * quota instead of API tokens; no tool support — the official CLI does its own tooling):
 *   - claude-code (wraps `claude -p`; uses Claude Max)
 *   - codex (wraps `codex exec`; uses ChatGPT Pro)
 *
 * SDK providers (programmatic agent loop via official SDK; full tool/MCP/hook support;
 * structured per-token usage; runs in-process so no CLI subprocess overhead):
 *   - claude-sdk (uses `@anthropic-ai/claude-agent-sdk`'s query() — supersedes the
 *     claude-code subprocess lane for any case where you have an API key. Subscription
 *     OAuth is deferred until Anthropic's 2026 ToS situation clears, see HARNESS-PLAN.md
 *     decision 4 revision.)
 *
 * Chutes is a decentralized inference network (Bittensor-based, OpenAI-compatible). Open-weight
 * models served via community GPUs; very low cost. Wired in v0.6 as the experimental DeAI lane.
 *
 * Perplexity is a search-grounded LLM provider (sonar family). Returns structured `sources`
 * alongside text via the @ai-sdk/perplexity adapter. Wired in v0.7 as the search-grounded lane.
 */
export const API_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'chutes',
  'perplexity',
  /**
   * Daydreams Router (`ai.xgate.run`) — x402-paid OpenAI-compatible inference.
   * Auth is an ERC-2612 USDC permit, not an API key. The harness's CDP signer
   * (or viem private-key fallback) signs once; sessions accumulate spend under
   * the router's `X-Upto-Session` until the cap or idle timeout. Model IDs use
   * the router's `provider:model` convention (e.g. `anthropic:claude-sonnet-4-6`),
   * so a full harness model string looks like `daydreams-router/anthropic:claude-sonnet-4-6`.
   */
  'daydreams-router',
] as const;
export const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'] as const;
export const SDK_PROVIDERS = ['claude-sdk'] as const;
export const PROVIDERS = [...API_PROVIDERS, ...SUBSCRIPTION_PROVIDERS, ...SDK_PROVIDERS] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
export type SdkProvider = (typeof SDK_PROVIDERS)[number];
export type Provider = (typeof PROVIDERS)[number];

export function isSubscriptionProvider(p: Provider): p is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(p);
}

export function isSdkProvider(p: Provider): p is SdkProvider {
  return (SDK_PROVIDERS as readonly string[]).includes(p);
}

/**
 * A model string is `<provider>/<model-name>`. Examples:
 *   anthropic/claude-sonnet-4-6
 *   openai/gpt-5
 *   google/gemini-2.5-pro
 *   openrouter/nousresearch/hermes-4-405b
 */
export const ModelStringSchema = z
  .string()
  .regex(/^[a-z0-9-]+\/.+/, 'model must be in <provider>/<model-name> format');
export type ModelString = z.infer<typeof ModelStringSchema>;

// ────────────────────────────────────────────────────────────────────
// Message format — Vercel AI SDK aligned
// ────────────────────────────────────────────────────────────────────

// Trace records can carry any role including 'tool' (v0.1+ tool calls).
export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

// Public chat()/stream() inputs only accept text-content roles in v0.0.1.
// 'tool' role messages get added when tool calling lands in v0.1.
export const MessageRoleSchema = z.enum(['system', 'user', 'assistant']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// ────────────────────────────────────────────────────────────────────
// Trace records — append-only JSONL
// ────────────────────────────────────────────────────────────────────

export const TraceRecordTypeSchema = z.enum([
  'user',
  'assistant',
  'tool_call',
  'tool_result',
  'decision',
  'reflection',
  'error',
  'system',
  /** v0.9 — x402 payment settlement record. Append-only. */
  'payment',
]);
export type TraceRecordType = z.infer<typeof TraceRecordTypeSchema>;

/**
 * Body shape carried in a `payment`-type trace record's `content` field.
 *
 * Captures one settled (or attempted) x402 settlement so the never-compacted
 * trace becomes the audit log for outbound + inbound spend. Independent of
 * the LLM cost cap — `costUsd` is for token usage, this is on-chain transfer.
 *
 * `direction: 'out'` — the harness paid an external resource.
 * `direction: 'in'`  — another agent paid the harness's monetized endpoint.
 */
export const PaymentTraceBodySchema = z.object({
  direction: z.enum(['out', 'in']),
  resource: z.string(),
  amountAtomic: z.string().regex(/^\d+$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  network: z.string(),
  txHash: z.string().optional(),
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  facilitator: z.string().optional(),
  /** Budget-trigger snapshot at the time of payment ('none', 'soft', 'hard'). */
  triggered: z.enum(['none', 'soft', 'hard']).optional(),
  /** Whether settlement actually succeeded (false = attempt logged but failed). */
  settled: z.boolean(),
  /** Server-emitted error reason when settled is false. */
  errorReason: z.string().optional(),
  /** Permit-vs-exact scheme tag for forward-compat. */
  scheme: z.enum(['exact', 'permit']).optional(),
});
export type PaymentTraceBody = z.infer<typeof PaymentTraceBodySchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const TraceRecordSchema = z.object({
  ts: z.string().datetime(),
  conversation_id: z.string().uuid(),
  step: z.number().int().nonnegative(),
  type: TraceRecordTypeSchema,
  role: RoleSchema.optional(),
  content: z.unknown(),
  model: ModelStringSchema.optional(),
  provider: z.enum(PROVIDERS).optional(),
  tools_called: z.array(z.string()).optional(),
  usage: UsageSchema.optional(),
  latency_ms: z.number().int().nonnegative().optional(),
  attempt_number: z.number().int().positive().optional(),
  fallback_reason: z.string().optional(),
  /** Thread tag — groups related conversations. v0.5+. Forward-compatible: older records have no tag. */
  thread_id: z.string().optional(),
  /** Project tag — usually inherited from the thread. v0.5+. */
  project_id: z.string().optional(),
  schema_version: z.literal(TRACE_SCHEMA_VERSION),
});
export type TraceRecord = z.infer<typeof TraceRecordSchema>;

// ────────────────────────────────────────────────────────────────────
// Index records — one per conversation, in INDEX.jsonl
// ────────────────────────────────────────────────────────────────────

export const ConversationStatusSchema = z.enum([
  'active',
  'completed',
  'aborted_cost_cap',
  'aborted_error',
  'aborted_user',
  'aborted_window_full',
]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const IndexRecordSchema = z.object({
  conversation_id: z.string().uuid(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().optional(),
  model: ModelStringSchema,
  message_count: z.number().int().nonnegative(),
  total_cost_usd: z.number().nonnegative(),
  total_input_tokens: z.number().int().nonnegative(),
  total_output_tokens: z.number().int().nonnegative(),
  total_cached_input_tokens: z.number().int().nonnegative(),
  status: ConversationStatusSchema,
  /** Thread tag — groups related conversations. v0.5+. */
  thread_id: z.string().optional(),
  /** Project tag — usually inherited from the thread. v0.5+. */
  project_id: z.string().optional(),
  schema_version: z.literal(TRACE_SCHEMA_VERSION),
});
export type IndexRecord = z.infer<typeof IndexRecordSchema>;

// ────────────────────────────────────────────────────────────────────
// Public API surface — chat() and stream() inputs/outputs
// ────────────────────────────────────────────────────────────────────

// We intentionally do NOT include `tools` or `approval` in this Zod schema —
// they're functions/objects with non-serializable fields. They live on the
// runtime ChatInput type instead.
export const ChatInputSchema = z.object({
  model: ModelStringSchema,
  messages: z.array(MessageSchema).min(1),
  system: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  conversationId: z.string().uuid().optional(),
  traceDir: z.string().optional(),
  /** Cap on tool-execution steps. Default 1 (no multi-step). */
  maxSteps: z.number().int().positive().max(50).optional(),
  /** Thread tag — explicit override. If unset, the active thread (if any) is used. */
  threadId: z.string().optional(),
  /** Project tag — explicit override. If unset, inherits from the resolved thread. */
  projectId: z.string().optional(),
});

// Forward reference — actual HarnessTool type is in src/tools/index.ts
// but we reference it loosely here to avoid a circular import.
export interface ChatInput extends z.infer<typeof ChatInputSchema> {
  /** Tools to make available. If empty/undefined, no tool calling is attempted. */
  tools?: ReadonlyArray<unknown>;
  /** Override sandbox path (otherwise the harness picks one) */
  sandboxPath?: string;
  /** Approval callback for tools with permission='propose-then-approve' */
  approval?: unknown;
  /** --yolo flag: bypass all approvals */
  yolo?: boolean;
  /** Cost cap thresholds in USD (defaults from config: 5 warn, 25 abort) */
  costCap?: { softWarnUsd?: number; hardAbortUsd?: number };
  /** Lethal-trifecta severity (default 'warn') */
  trifectaSeverity?: 'allow' | 'warn' | 'block';
  /**
   * Hooks config (v0.5+). If undefined and `useDefaultHooks` is true (CLI default),
   * the harness uses the bundled default hooks (auto-commit-traces + macos-notification on post-agent).
   * Pass `hooksConfig: { 'post-agent': [] }` to disable defaults explicitly.
   */
  hooksConfig?: unknown;
  /** Whether to apply bundled default hooks when no explicit hooksConfig given. CLI passes true; programmatic users default false. */
  useDefaultHooks?: boolean;
  /**
   * v0.13.4 — optional fetch override pushed into every tool's ToolContext.
   * The agent loop with --payments builds an x402-paying fetch and passes it
   * here so web_fetch (and other network-using tools) auto-pay 402'd
   * resources without the LLM having to invoke the `pay` tool explicitly.
   */
  toolFetch?: typeof fetch;
  /**
   * v0.14.0 — opt-in: prepend prior turns from this thread's trace history
   * onto the messages array before the call. Realizes "the trace IS the
   * memory" at the chat() level. Requires `threadId` to be set; otherwise
   * a no-op. Off by default for backward compatibility (existing callers
   * that pass full message arrays don't accidentally double-up history).
   * FRQNCY OS persona invocations turn this ON by default.
   */
  loadHistory?: boolean | {
    maxConversations?: number;
    maxMessages?: number;
    maxBytes?: number;
    includeAborted?: boolean;
  };
}

export interface ChatResult {
  text: string;
  conversationId: string;
  usage: Usage;
  model: ModelString;
  provider: Provider;
  finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other';
}

// Streaming events — the AsyncIterator yields these
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool_result'; toolCallId: string; toolName: string; output: unknown }
  | { type: 'tool_error'; toolCallId: string; toolName: string; error: { name: string; message: string } }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; error: { name: string; message: string } }
  | { type: 'step_start'; step: number }
  | { type: 'step_finish'; step: number; finishReason: string }
  | { type: 'cost_warn'; cumulativeCostUsd: number; thresholdUsd: number; message: string }
  | { type: 'cost_abort'; cumulativeCostUsd: number; thresholdUsd: number; message: string }
  | { type: 'trifecta_warn'; flags: { privateData: boolean; untrustedContent: boolean; outboundNetwork: boolean }; message: string }
  | {
      type: 'done';
      result: ChatResult;
    };
