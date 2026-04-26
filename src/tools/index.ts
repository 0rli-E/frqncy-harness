/**
 * Tool primitive.
 *
 * A `HarnessTool` is the harness's wrapper around an AI SDK tool definition,
 * with extra metadata the harness needs:
 *   - Permission tier (auto-execute vs propose-then-approve, per decision A1)
 *   - Lethal-trifecta flags (per Simon Willison; gate is enforced in v0.2.0)
 *   - Sandbox awareness via ToolContext
 *
 * To make a tool available to a model, define it as a HarnessTool and pass
 * it to chat() / stream() / agent() in the `tools` array. The harness handles
 * the conversion to the AI SDK's tool format and the permission/sandbox
 * plumbing per call.
 */
import { tool, jsonSchema, type Tool as AiSdkTool } from 'ai';
import type { z } from 'zod';
import type { Sandbox } from '../sandbox/index.js';
import type { ApprovalCallback } from '../approval.js';

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type Permission = 'auto' | 'propose-then-approve';

/**
 * Lethal-trifecta flags (Simon Willison, Feb 2026).
 *
 * Any single trace that has all three flags simultaneously is the
 * dominant security failure mode for agent harnesses (private data
 * exfiltrated to an attacker via a tool that took untrusted content).
 *
 * The `agent` loop checks these on each step; if all three are present
 * and severity is `block`, the step is refused.
 */
export interface ToolFlags {
  /** Reads or writes private user data (filesystem, secrets, local DB) */
  privateData?: boolean;
  /** Consumes content from untrusted sources (web pages, third-party APIs) */
  untrustedContent?: boolean;
  /** Makes outbound network calls */
  outboundNetwork?: boolean;
}

export interface ToolContext {
  conversationId: string;
  /** Working directory for the tool (usually the sandbox path) */
  cwd: string;
  /** The active sandbox if one was provisioned for this run */
  sandbox?: Sandbox;
  /** Optional logger — if provided, tools should write structured info here */
  log?: (event: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; data?: unknown }) => void;
}

export interface HarnessTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  flags: ToolFlags;
  permission: Permission;
  execute: (input: TInput, ctx: ToolContext) => Promise<TOutput>;
}

// ────────────────────────────────────────────────────────────────────
// AI SDK conversion
// ────────────────────────────────────────────────────────────────────

/**
 * Convert a HarnessTool into the AI SDK's tool format with the harness's
 * approval + sandbox plumbing wrapped around `execute`.
 *
 * The returned tool is bound to a specific ToolContext for one run.
 */
export function toAiSdkTool<TInput, TOutput>(
  harnessTool: HarnessTool<TInput, TOutput>,
  ctx: ToolContext,
  approval?: ApprovalCallback,
): AiSdkTool {
  // If this is an MCP-derived tool, it carries `_jsonSchema` with the original
  // JSON Schema from the MCP server. Use that for the AI SDK so the model sees
  // the proper schema. Otherwise use the Zod schema.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeJsonSchema = (harnessTool as any)._jsonSchema as unknown;
  const inputSchemaForAiSdk = maybeJsonSchema
    ? jsonSchema(maybeJsonSchema as Record<string, unknown>)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (harnessTool.inputSchema as any);

  return tool({
    description: harnessTool.description,
    inputSchema: inputSchemaForAiSdk,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (async (input: unknown) => {
      // Validate input — if the model produced something off-schema, reject
      // before running the tool. Returns a structured error the model can
      // read and retry with.
      const validated = harnessTool.inputSchema.safeParse(input);
      if (!validated.success) {
        return {
          error: 'invalid_input',
          message: `Input validation failed: ${validated.error.issues.map((i) => i.message).join('; ')}`,
        };
      }

      // Permission gate
      if (harnessTool.permission === 'propose-then-approve') {
        if (!approval) {
          return {
            error: 'permission_required',
            message: `Tool '${harnessTool.name}' requires approval but no approval callback is configured. Set --yolo to auto-approve, or pass an approval callback.`,
          };
        }
        const approved = await approval({
          toolName: harnessTool.name,
          input: validated.data,
          permission: harnessTool.permission,
          flags: harnessTool.flags,
        });
        if (!approved) {
          return {
            error: 'permission_denied',
            message: `User denied tool call to '${harnessTool.name}'.`,
          };
        }
      }

      // Run
      try {
        const result = await harnessTool.execute(validated.data, ctx);
        return result;
      } catch (err) {
        return {
          error: 'execution_failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }) as never,
  });
}

/**
 * Convert an array of HarnessTools into the record shape the AI SDK expects.
 */
export function toAiSdkToolSet(
  tools: HarnessTool[],
  ctx: ToolContext,
  approval?: ApprovalCallback,
): Record<string, AiSdkTool> {
  const result: Record<string, AiSdkTool> = {};
  for (const t of tools) {
    result[t.name] = toAiSdkTool(t, ctx, approval);
  }
  return result;
}

/**
 * Check whether a set of tools, used together, would exhibit the lethal trifecta
 * (private data + untrusted content + outbound network all in one trace).
 *
 * Returns the list of trifecta flags that are present across the toolset.
 * If all three are present, this is a high-risk configuration.
 */
export function detectLethalTrifecta(tools: HarnessTool[]): {
  privateData: boolean;
  untrustedContent: boolean;
  outboundNetwork: boolean;
  isTrifecta: boolean;
} {
  const flags = {
    privateData: tools.some((t) => t.flags.privateData),
    untrustedContent: tools.some((t) => t.flags.untrustedContent),
    outboundNetwork: tools.some((t) => t.flags.outboundNetwork),
  };
  return { ...flags, isTrifecta: flags.privateData && flags.untrustedContent && flags.outboundNetwork };
}
