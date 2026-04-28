/**
 * stream() — async-iterable streaming completion across any provider.
 *
 * Yields typed events: text deltas, tool calls, tool results, step boundaries,
 * usage at end-of-call, and a final 'done' event with the assembled ChatResult.
 *
 * Architectural principle (decision A8 in HARNESS-DEFAULTS-REVIEW.md):
 *   AsyncIterator of typed events. Native to TS. Consumable from any JS environment.
 *   UI code can render appropriately for each event type.
 *
 * Multi-step tool execution: pass `tools` and `maxSteps`. The AI SDK's
 * `stepCountIs(N)` stop condition handles the loop; we just surface events.
 */
import { streamText, stepCountIs } from 'ai';
import { randomUUID } from 'node:crypto';
import {
  ChatInputSchema,
  type ChatInput,
  type ChatResult,
  type ModelString,
  type Provider,
  type StreamEvent,
} from './types.js';
import { getProvider, computeCostUsd, parseModelString } from './providers/index.js';
import { runSubscription } from './providers/subprocess.js';
import { runSdkProvider } from './providers/sdk.js';
import { isSubscriptionProvider, isSdkProvider } from './types.js';
import {
  appendTraceRecord,
  getTraceFilePath,
  recordConversationEnd,
  DEFAULT_TRACE_DIR,
} from './trace.js';
import { resolveTags, touchActiveThread } from './threads.js';
import type { TraceRecord } from './types.js';
import { toAiSdkToolSet, detectLethalTrifecta, type HarnessTool, type ToolContext } from './tools/index.js';
import { ApprovalManager, type ApprovalCallback } from './approval.js';
import { HookManager, type HooksConfig } from './hooks/index.js';

export async function* stream(input: ChatInput): AsyncGenerator<StreamEvent, void, unknown> {
  // Validate the serializable subset; tools/approval are passed through untouched.
  const serializable = ChatInputSchema.parse({
    model: input.model,
    messages: input.messages,
    ...(input.system !== undefined ? { system: input.system } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.conversationId !== undefined ? { conversationId: input.conversationId } : {}),
    ...(input.traceDir !== undefined ? { traceDir: input.traceDir } : {}),
    ...(input.maxSteps !== undefined ? { maxSteps: input.maxSteps } : {}),
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
  });

  const conversationId = serializable.conversationId ?? randomUUID();
  const traceDir = serializable.traceDir ?? DEFAULT_TRACE_DIR;
  const startedAt = new Date();
  const traceFile = getTraceFilePath(conversationId, startedAt, traceDir);

  // ── Thread + project tagging (v0.5) ────────────────────────
  const tags = await resolveTags({
    threadId: serializable.threadId,
    projectId: serializable.projectId,
  });
  await touchActiveThread();
  const traceTagFields = {
    ...(tags.threadId ? { thread_id: tags.threadId } : {}),
    ...(tags.projectId ? { project_id: tags.projectId } : {}),
  };
  const trace = (rec: Omit<TraceRecord, 'schema_version'>) =>
    appendTraceRecord(traceFile, { ...rec, ...traceTagFields });
  const endConv = (rcArgs: Omit<Parameters<typeof recordConversationEnd>[0], 'threadId' | 'projectId'>) =>
    recordConversationEnd({
      ...rcArgs,
      ...(tags.threadId ? { threadId: tags.threadId } : {}),
      ...(tags.projectId ? { projectId: tags.projectId } : {}),
    });

  // ── Subscription provider lane (Claude Code / Codex subprocess) ──
  const parsed = parseModelString(serializable.model);
  if (isSubscriptionProvider(parsed.provider)) {
    yield* streamSubscription({
      conversationId,
      traceDir,
      traceFile,
      startedAt,
      input,
      serializable,
      provider: parsed.provider,
      modelId: parsed.modelId,
      ...(tags.threadId ? { threadId: tags.threadId } : {}),
      ...(tags.projectId ? { projectId: tags.projectId } : {}),
    });
    return;
  }

  // ── SDK provider lane (Claude Agent SDK in-process) ─────────────
  if (isSdkProvider(parsed.provider)) {
    yield* streamSdk({
      conversationId,
      traceDir,
      traceFile,
      startedAt,
      input,
      serializable,
      provider: parsed.provider,
      modelId: parsed.modelId,
      ...(tags.threadId ? { threadId: tags.threadId } : {}),
      ...(tags.projectId ? { projectId: tags.projectId } : {}),
    });
    return;
  }

  const { model: languageModel, provider, modelId } = await getProvider(serializable.model);

  // Tool plumbing
  const tools = (input.tools as HarnessTool[] | undefined) ?? [];
  const hasTools = tools.length > 0;
  const maxSteps = serializable.maxSteps ?? (hasTools ? 10 : 1);
  const approvalCallback = input.approval as ApprovalCallback | undefined;
  const approvalManager = new ApprovalManager({
    yolo: input.yolo === true,
    ...(approvalCallback ? { callback: approvalCallback } : {}),
  });

  const toolContext: ToolContext = {
    conversationId,
    cwd: input.sandboxPath ?? process.cwd(),
  };

  const aiSdkTools = hasTools ? toAiSdkToolSet(tools, toolContext, approvalManager.asCallback()) : undefined;

  // ── Lethal-trifecta gate (decision D5) ─────────────────────
  // Detection lives here because hooks are observers in v0.7 (cannot block).
  // The bundled `trifecta-monitor` hook reports it after the run.
  const trifectaSeverity = input.trifectaSeverity ?? 'warn';
  let trifectaTriggered = false;
  let pendingTrifectaWarn: { type: 'trifecta_warn'; flags: { privateData: boolean; untrustedContent: boolean; outboundNetwork: boolean }; message: string } | null = null;
  if (hasTools && trifectaSeverity !== 'allow') {
    const trifecta = detectLethalTrifecta(tools);
    if (trifecta.isTrifecta) {
      const message =
        'Lethal trifecta detected: tools provide private data + untrusted content + outbound network in the same trace. ' +
        'This is the dominant agent security failure mode (Simon Willison, 2026).';
      if (trifectaSeverity === 'block') {
        const err = new Error(message);
        err.name = 'LethalTrifectaError';
        throw err;
      }
      trifectaTriggered = true;
      pendingTrifectaWarn = {
        type: 'trifecta_warn',
        flags: { privateData: trifecta.privateData, untrustedContent: trifecta.untrustedContent, outboundNetwork: trifecta.outboundNetwork },
        message,
      };
    }
  }
  if (pendingTrifectaWarn) yield pendingTrifectaWarn;

  // ── Cost cap thresholds (decision A7) ──────────────────────
  const softWarnUsd = input.costCap?.softWarnUsd ?? 5;
  const hardAbortUsd = input.costCap?.hardAbortUsd ?? 25;
  // Track whether the soft/hard thresholds were crossed so the post-agent
  // hook can surface them via the bundled `cost-cap-monitor` hook (v0.7+).
  let costSoftWarnTriggered = false;
  let costHardAbortTriggered = false;

  // ── Hooks (v0.5) ────────────────────────────────────────────
  // If user passed hooksConfig, use it. Else if useDefaultHooks=true (CLI default),
  // pass undefined → HookManager applies bundled defaults (auto-commit + notification).
  // Else (programmatic default): construct an empty HookManager so no hooks fire.
  const hookManager = input.useDefaultHooks || input.hooksConfig !== undefined
    ? new HookManager(input.hooksConfig as HooksConfig)
    : new HookManager({});
  const lastUserMessage = [...serializable.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  // Fire pre-agent (only meaningful when tools are present — agent loop is happening)
  if (hasTools) {
    await hookManager.fire({
      event: 'pre-agent',
      conversationId,
      model: serializable.model,
      prompt: lastUserMessage,
      toolNames: tools.map((t) => t.name),
      ...(input.sandboxPath !== undefined ? { sandboxPath: input.sandboxPath } : {}),
    });
  }

  // Trace the input messages
  let step = 0;
  for (const message of serializable.messages) {
    if (message.role === 'user' || message.role === 'system') {
      await trace({
        ts: new Date().toISOString(),
        conversation_id: conversationId,
        step,
        type: message.role === 'user' ? 'user' : 'system',
        role: message.role,
        content: message.content,
      });
      step++;
    }
  }

  const callStartedAt = Date.now();
  let assembledText = '';
  let cumulativeUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

  // Track in-flight tool calls so post-tool-use hook gets the input + duration
  const toolCallTimings = new Map<string, { toolName: string; input: unknown; startMs: number }>();

  // Capture provider errors so we can re-throw them with proper cause chains
  let capturedError: unknown = null;

  try {
    const result = streamText({
      model: languageModel,
      messages: serializable.messages,
      system: serializable.system,
      temperature: serializable.temperature,
      ...(serializable.maxOutputTokens !== undefined ? { maxOutputTokens: serializable.maxOutputTokens } : {}),
      ...(aiSdkTools ? { tools: aiSdkTools } : {}),
      ...(hasTools ? { stopWhen: stepCountIs(maxSteps) } : {}),
      onError: ({ error }) => {
        capturedError = error;
      },
    });

    // Iterate the unified full stream, surfacing each AI SDK event type as our own
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'text-delta': {
          // AI SDK v6 uses textDelta; v5 used text. Try both.
          const delta = (part as { text?: string; textDelta?: string }).text ?? (part as { textDelta?: string }).textDelta ?? '';
          if (delta) {
            assembledText += delta;
            yield { type: 'text', delta };
          }
          break;
        }
        case 'tool-call': {
          const tc = part as { toolCallId: string; toolName: string; input: unknown };
          toolCallTimings.set(tc.toolCallId, { toolName: tc.toolName, input: tc.input, startMs: Date.now() });
          await trace({
            ts: new Date().toISOString(),
            conversation_id: conversationId,
            step,
            type: 'tool_call',
            role: 'assistant',
            content: { toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input },
            model: serializable.model,
            provider,
            tools_called: [tc.toolName],
          });
          step++;
          yield { type: 'tool_call', toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input };
          break;
        }
        case 'tool-result': {
          const tr = part as { toolCallId: string; toolName: string; output: unknown };
          await trace({
            ts: new Date().toISOString(),
            conversation_id: conversationId,
            step,
            type: 'tool_result',
            role: 'tool',
            content: { toolCallId: tr.toolCallId, toolName: tr.toolName, output: tr.output },
          });
          step++;
          yield { type: 'tool_result', toolCallId: tr.toolCallId, toolName: tr.toolName, output: tr.output };

          // Fire post-tool-use hook (non-blocking, errors swallowed)
          const timing = toolCallTimings.get(tr.toolCallId);
          if (timing) {
            toolCallTimings.delete(tr.toolCallId);
            await hookManager.fire({
              event: 'post-tool-use',
              conversationId,
              toolName: tr.toolName,
              input: timing.input,
              output: tr.output,
              durationMs: Date.now() - timing.startMs,
            }).catch(() => { /* hooks never block stream */ });
          }
          break;
        }
        case 'tool-error': {
          const te = part as { toolCallId: string; toolName: string; error: unknown };
          const errMsg = te.error instanceof Error ? te.error.message : String(te.error);
          await trace({
            ts: new Date().toISOString(),
            conversation_id: conversationId,
            step,
            type: 'error',
            content: { toolCallId: te.toolCallId, toolName: te.toolName, error: errMsg },
          });
          step++;
          yield {
            type: 'tool_error',
            toolCallId: te.toolCallId,
            toolName: te.toolName,
            error: { name: 'ToolError', message: errMsg },
          };
          break;
        }
        case 'start-step':
          yield { type: 'step_start', step };
          break;
        case 'finish-step': {
          const fs = part as { finishReason?: string };
          yield { type: 'step_finish', step, finishReason: fs.finishReason ?? 'unknown' };
          break;
        }
        case 'error': {
          const e = part as { error: unknown };
          capturedError = e.error;
          break;
        }
        default:
          // Ignore other event types (reasoning, sources, etc.)
          break;
      }
    }

    // If onError or stream-error captured something, surface it
    if (capturedError) {
      throw capturedError instanceof Error ? capturedError : new Error(String(capturedError));
    }

    // Wait for the full result to finalize usage / finish reason
    const finalUsage = await result.usage;
    const finalFinishReason = await result.finishReason;
    const latencyMs = Date.now() - callStartedAt;

    const inputTokens = finalUsage?.inputTokens ?? 0;
    const outputTokens = finalUsage?.outputTokens ?? 0;
    const cachedInputTokens = finalUsage?.cachedInputTokens ?? 0;
    const costUsd = computeCostUsd({
      provider,
      modelId,
      inputTokens,
      outputTokens,
      cachedInputTokens,
    });
    const usage = {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    cumulativeUsage = {
      inputTokens: cumulativeUsage.inputTokens + inputTokens,
      outputTokens: cumulativeUsage.outputTokens + outputTokens,
      cachedInputTokens: cumulativeUsage.cachedInputTokens + cachedInputTokens,
      costUsd: cumulativeUsage.costUsd + (costUsd ?? 0),
    };

    yield { type: 'usage', usage };

    // ── Cost cap enforcement ────────────────────────────────
    if (cumulativeUsage.costUsd >= hardAbortUsd) {
      costHardAbortTriggered = true;
      yield {
        type: 'cost_abort',
        cumulativeCostUsd: cumulativeUsage.costUsd,
        thresholdUsd: hardAbortUsd,
        message: `Cost cap hit: $${cumulativeUsage.costUsd.toFixed(4)} >= hard abort $${hardAbortUsd}. Aborting.`,
      };
      await trace({
        ts: new Date().toISOString(),
        conversation_id: conversationId,
        step,
        type: 'assistant',
        role: 'assistant',
        content: assembledText,
        model: serializable.model,
        provider,
        usage,
        latency_ms: latencyMs,
      });
      await endConv({
        conversationId,
        startedAt,
        endedAt: new Date(),
        model: serializable.model,
        messageCount: step + 1,
        cumulativeUsage,
        status: 'aborted_cost_cap',
        traceDir,
      });
      const err = new Error(`Cost cap exceeded: $${cumulativeUsage.costUsd.toFixed(4)} >= $${hardAbortUsd}`);
      err.name = 'CostCapAbortError';
      throw err;
    }
    if (cumulativeUsage.costUsd >= softWarnUsd) {
      costSoftWarnTriggered = true;
      yield {
        type: 'cost_warn',
        cumulativeCostUsd: cumulativeUsage.costUsd,
        thresholdUsd: softWarnUsd,
        message: `Cost soft warn: $${cumulativeUsage.costUsd.toFixed(4)} >= $${softWarnUsd}`,
      };
    }

    // Trace the assistant response
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step,
      type: 'assistant',
      role: 'assistant',
      content: assembledText,
      model: serializable.model,
      provider,
      usage,
      latency_ms: latencyMs,
    });

    await endConv({
      conversationId,
      startedAt,
      endedAt: new Date(),
      model: serializable.model,
      messageCount: step + 1,
      cumulativeUsage,
      status: 'completed',
      traceDir,
    });

    const chatResult: ChatResult = {
      text: assembledText,
      conversationId,
      usage,
      model: serializable.model as ModelString,
      provider: provider as Provider,
      finishReason: normalizeFinishReason(finalFinishReason),
    };

    yield { type: 'done', result: chatResult };

    // Fire post-agent hook (success path) — non-blocking
    await hookManager.fire({
      event: 'post-agent',
      conversationId,
      model: serializable.model,
      prompt: lastUserMessage,
      text: assembledText,
      status: 'completed',
      usage,
      ...(input.sandboxPath !== undefined ? { sandboxPath: input.sandboxPath } : {}),
      traceFilePath: traceFile,
      guardrails: {
        costSoftWarn: costSoftWarnTriggered,
        costHardAbort: costHardAbortTriggered,
        trifectaWarn: trifectaTriggered,
        cumulativeCostUsd: cumulativeUsage.costUsd,
      },
    }).catch(() => { /* hooks never block */ });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step,
      type: 'error',
      content: { name: error.name, message: error.message },
      model: serializable.model,
      provider,
      latency_ms: Date.now() - callStartedAt,
    });
    const errorStatus = error.name === 'CostCapAbortError' ? 'aborted_cost_cap' : 'aborted_error';
    await endConv({
      conversationId,
      startedAt,
      endedAt: new Date(),
      model: serializable.model,
      messageCount: step,
      cumulativeUsage,
      status: errorStatus,
      traceDir,
    });
    yield { type: 'error', error: { name: error.name, message: error.message } };

    // Fire post-agent hook (error path) — non-blocking
    await hookManager.fire({
      event: 'post-agent',
      conversationId,
      model: serializable.model,
      prompt: lastUserMessage,
      text: assembledText,
      status: errorStatus,
      usage: cumulativeUsage,
      ...(input.sandboxPath !== undefined ? { sandboxPath: input.sandboxPath } : {}),
      traceFilePath: traceFile,
      guardrails: {
        costSoftWarn: costSoftWarnTriggered,
        costHardAbort: costHardAbortTriggered,
        trifectaWarn: trifectaTriggered,
        cumulativeCostUsd: cumulativeUsage.costUsd,
      },
    }).catch(() => { /* hooks never block */ });

    throw error;
  }
}

function normalizeFinishReason(reason: string | undefined): ChatResult['finishReason'] {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
      return reason;
    default:
      return 'other';
  }
}

// ────────────────────────────────────────────────────────────────────
// Subscription provider routing (claude-code, codex)
// ────────────────────────────────────────────────────────────────────

interface StreamSubscriptionArgs {
  conversationId: string;
  traceDir: string;
  traceFile: string;
  startedAt: Date;
  input: ChatInput;
  serializable: ChatInput;
  provider: 'claude-code' | 'codex';
  modelId: string;
  threadId?: string;
  projectId?: string;
}

async function* streamSubscription(args: StreamSubscriptionArgs): AsyncGenerator<StreamEvent, void, unknown> {
  const { conversationId, traceDir, traceFile, startedAt, input, serializable, provider, modelId, threadId, projectId } = args;
  const traceTagFields = {
    ...(threadId ? { thread_id: threadId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
  const trace = (rec: Omit<TraceRecord, 'schema_version'>) =>
    appendTraceRecord(traceFile, { ...rec, ...traceTagFields });
  const endConv = (rcArgs: Omit<Parameters<typeof recordConversationEnd>[0], 'threadId' | 'projectId'>) =>
    recordConversationEnd({
      ...rcArgs,
      ...(threadId ? { threadId } : {}),
      ...(projectId ? { projectId } : {}),
    });

  // Subscription path doesn't support tools — refuse with a clean error if any are passed
  if (input.tools && (input.tools as unknown[]).length > 0) {
    const message =
      `Tools are not supported with subscription provider '${provider}' — the official CLI does its own tooling. ` +
      `Use an API provider (anthropic/*, openai/*, google/*, openrouter/*) for tool-using agents.`;
    const err = Object.assign(new Error(message), { name: 'SubscriptionTools' });
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step: 0,
      type: 'error',
      content: { name: err.name, message },
      model: serializable.model,
      provider,
    });
    await endConv({
      conversationId,
      startedAt,
      endedAt: new Date(),
      model: serializable.model,
      messageCount: 0,
      cumulativeUsage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 },
      status: 'aborted_error',
      traceDir,
    });
    yield { type: 'error', error: { name: err.name, message } };
    throw err;
  }

  // Trace input messages
  let step = 0;
  for (const message of serializable.messages) {
    if (message.role === 'user' || message.role === 'system') {
      await trace({
        ts: new Date().toISOString(),
        conversation_id: conversationId,
        step,
        type: message.role === 'user' ? 'user' : 'system',
        role: message.role,
        content: message.content,
      });
      step++;
    }
  }

  const callStartedAt = Date.now();
  let assembledText = '';
  let finalUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

  try {
    for await (const event of runSubscription({
      provider,
      modelId,
      messages: serializable.messages,
      ...(serializable.system !== undefined ? { system: serializable.system } : {}),
      ...(input.sandboxPath !== undefined ? { cwd: input.sandboxPath } : {}),
    })) {
      if (event.type === 'text') {
        assembledText += event.delta;
        yield event;
      } else if (event.type === 'usage') {
        finalUsage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedInputTokens: event.usage.cachedInputTokens ?? 0,
          costUsd: event.usage.costUsd ?? 0,
        };
        yield event;
      } else if (event.type === 'error') {
        yield event;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step,
      type: 'error',
      content: { name: error.name, message: error.message },
      model: serializable.model,
      provider,
      latency_ms: Date.now() - callStartedAt,
    });
    await endConv({
      conversationId,
      startedAt,
      endedAt: new Date(),
      model: serializable.model,
      messageCount: step,
      cumulativeUsage: finalUsage,
      status: 'aborted_error',
      traceDir,
    });
    throw error;
  }

  const latencyMs = Date.now() - callStartedAt;

  // Trace assistant response
  await trace({
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    step,
    type: 'assistant',
    role: 'assistant',
    content: assembledText,
    model: serializable.model,
    provider,
    usage: finalUsage,
    latency_ms: latencyMs,
  });

  await endConv({
    conversationId,
    startedAt,
    endedAt: new Date(),
    model: serializable.model,
    messageCount: step + 1,
    cumulativeUsage: finalUsage,
    status: 'completed',
    traceDir,
  });

  const chatResult: ChatResult = {
    text: assembledText,
    conversationId,
    usage: finalUsage,
    model: serializable.model as ModelString,
    provider: provider as Provider,
    finishReason: 'stop',
  };

  yield { type: 'done', result: chatResult };
}

// ────────────────────────────────────────────────────────────────────
// SDK provider routing (claude-sdk via @anthropic-ai/claude-agent-sdk)
// ────────────────────────────────────────────────────────────────────

interface StreamSdkArgs {
  conversationId: string;
  traceDir: string;
  traceFile: string;
  startedAt: Date;
  input: ChatInput;
  serializable: ChatInput;
  provider: 'claude-sdk';
  modelId: string;
  threadId?: string;
  projectId?: string;
}

async function* streamSdk(args: StreamSdkArgs): AsyncGenerator<StreamEvent, void, unknown> {
  const { conversationId, traceDir, traceFile, startedAt, input, serializable, provider, modelId, threadId, projectId } = args;
  const traceTagFields = {
    ...(threadId ? { thread_id: threadId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
  };
  const trace = (rec: Omit<TraceRecord, 'schema_version'>) =>
    appendTraceRecord(traceFile, { ...rec, ...traceTagFields });
  const endConv = (rcArgs: Omit<Parameters<typeof recordConversationEnd>[0], 'threadId' | 'projectId'>) =>
    recordConversationEnd({
      ...rcArgs,
      ...(threadId ? { threadId } : {}),
      ...(projectId ? { projectId } : {}),
    });

  // SDK lane note on tools: the harness's HarnessTool[] is NOT bridged into the
  // SDK's tool registry in v0.7. The SDK uses its own default tool set (bash,
  // file ops, etc.). If the user passed harness tools, warn but continue —
  // the SDK loop will run with SDK tools only.
  if (input.tools && (input.tools as unknown[]).length > 0) {
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step: 0,
      type: 'system',
      content:
        '[harness] HarnessTool[] passed to claude-sdk lane is currently ignored. ' +
        'The SDK uses its own default tool registry. Bridging is a v0.8 follow-up.',
      model: serializable.model,
      provider,
    });
  }

  // Trace input messages
  let step = 0;
  for (const message of serializable.messages) {
    if (message.role === 'user' || message.role === 'system') {
      await trace({
        ts: new Date().toISOString(),
        conversation_id: conversationId,
        step,
        type: message.role === 'user' ? 'user' : 'system',
        role: message.role,
        content: message.content,
      });
      step++;
    }
  }

  const callStartedAt = Date.now();
  let assembledText = '';
  let finalUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 };

  try {
    for await (const event of runSdkProvider({
      modelId,
      messages: serializable.messages,
      ...(serializable.system !== undefined ? { system: serializable.system } : {}),
      ...(input.sandboxPath !== undefined ? { cwd: input.sandboxPath } : {}),
    })) {
      if (event.type === 'text') {
        assembledText += event.delta;
        yield event;
      } else if (event.type === 'tool_call') {
        await trace({
          ts: new Date().toISOString(),
          conversation_id: conversationId,
          step,
          type: 'tool_call',
          content: { toolCallId: event.toolCallId, toolName: event.toolName, input: event.input },
          model: serializable.model,
          provider,
          tools_called: [event.toolName],
        });
        step++;
        yield event;
      } else if (event.type === 'tool_result') {
        await trace({
          ts: new Date().toISOString(),
          conversation_id: conversationId,
          step,
          type: 'tool_result',
          content: { toolCallId: event.toolCallId, output: event.output },
          model: serializable.model,
          provider,
        });
        step++;
        yield event;
      } else if (event.type === 'tool_error') {
        await trace({
          ts: new Date().toISOString(),
          conversation_id: conversationId,
          step,
          type: 'tool_result',
          content: { toolCallId: event.toolCallId, error: event.error },
          model: serializable.model,
          provider,
        });
        step++;
        yield event;
      } else if (event.type === 'usage') {
        finalUsage = {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          cachedInputTokens: event.usage.cachedInputTokens ?? 0,
          costUsd: event.usage.costUsd ?? 0,
        };
        yield event;
      } else if (event.type === 'error') {
        yield event;
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step,
      type: 'error',
      content: { name: error.name, message: error.message },
      model: serializable.model,
      provider,
      latency_ms: Date.now() - callStartedAt,
    });
    await endConv({
      conversationId,
      startedAt,
      endedAt: new Date(),
      model: serializable.model,
      messageCount: step,
      cumulativeUsage: finalUsage,
      status: 'aborted_error',
      traceDir,
    });
    throw error;
  }

  const latencyMs = Date.now() - callStartedAt;

  await trace({
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    step,
    type: 'assistant',
    role: 'assistant',
    content: assembledText,
    model: serializable.model,
    provider,
    usage: finalUsage,
    latency_ms: latencyMs,
  });

  await endConv({
    conversationId,
    startedAt,
    endedAt: new Date(),
    model: serializable.model,
    messageCount: step + 1,
    cumulativeUsage: finalUsage,
    status: 'completed',
    traceDir,
  });

  const chatResult: ChatResult = {
    text: assembledText,
    conversationId,
    usage: finalUsage,
    model: serializable.model as ModelString,
    provider: provider as Provider,
    finishReason: 'stop',
  };

  yield { type: 'done', result: chatResult };
}
