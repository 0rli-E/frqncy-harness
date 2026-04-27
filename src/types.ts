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
 *   - anthropic, openai, google, openrouter
 *
 * Subscription providers (subprocess-wrap an official CLI; uses your $200/mo subscription
 * quota instead of API tokens; no tool support — the official CLI does its own tooling):
 *   - claude-code (wraps `claude -p`; uses Claude Max)
 *   - codex (wraps `codex exec`; uses ChatGPT Pro)
 */
export const API_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;
export const SUBSCRIPTION_PROVIDERS = ['claude-code', 'codex'] as const;
export const PROVIDERS = [...API_PROVIDERS, ...SUBSCRIPTION_PROVIDERS] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];
export type Provider = (typeof PROVIDERS)[number];

export function isSubscriptionProvider(p: Provider): p is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(p);
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
]);
export type TraceRecordType = z.infer<typeof TraceRecordTypeSchema>;

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
