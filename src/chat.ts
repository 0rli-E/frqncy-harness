/**
 * chat() — one-shot completion across any provider.
 *
 * The headline API. Same call works across Anthropic, OpenAI, Gemini, OpenRouter
 * with no other code changes — swap the model string.
 */
import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import {
  ChatInputSchema,
  type ChatInput,
  type ChatResult,
  type ModelString,
  type Provider,
} from './types.js';
import { getProvider, computeCostUsd } from './providers/index.js';
import {
  appendTraceRecord,
  getTraceFilePath,
  recordConversationEnd,
  loadThreadHistory,
  DEFAULT_TRACE_DIR,
  type LoadThreadHistoryOptions,
} from './trace.js';
import { resolveTags, touchActiveThread } from './threads.js';
import type { TraceRecord } from './types.js';

export async function chat(input: ChatInput): Promise<ChatResult> {
  // Validate input — refuse to proceed with bad arguments
  const parsed = ChatInputSchema.parse(input);

  const conversationId = parsed.conversationId ?? randomUUID();
  const traceDir = parsed.traceDir ?? DEFAULT_TRACE_DIR;
  const startedAt = new Date();
  const traceFile = getTraceFilePath(conversationId, startedAt, traceDir);

  // ── Thread + project tagging (v0.5) ────────────────────────
  const tags = await resolveTags({
    threadId: parsed.threadId,
    projectId: parsed.projectId,
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

  // Resolve the provider
  const { model: languageModel, provider, modelId } = await getProvider(parsed.model);

  // ── Load thread history (v0.14.0) ────────────────────────
  // Realize "the trace IS the memory": when loadHistory is on AND threadId is set,
  // pull prior turns from the trace store and prepend them to the messages array.
  // Loaded turns are NOT re-traced (they're already in the trace by definition);
  // only NEW turns from `parsed.messages` get logged on this call. A single
  // 'system' breadcrumb at step 0 records that history was injected.
  let messagesForCall = parsed.messages;
  let step = 0;
  if (input.loadHistory && tags.threadId) {
    const opts: LoadThreadHistoryOptions = {
      ...(typeof input.loadHistory === 'object' ? input.loadHistory : {}),
      ...(parsed.traceDir ? { traceDir: parsed.traceDir } : {}),
    };
    const history = await loadThreadHistory(tags.threadId, opts);
    if (history.messages.length > 0) {
      messagesForCall = [...history.messages, ...parsed.messages];
      // Breadcrumb so future readers (and the Learning Agent) know this call's
      // context wasn't fresh. Stored as content (not message) so it's visible
      // in the trace JSONL but doesn't get re-injected on subsequent calls.
      await trace({
        ts: new Date().toISOString(),
        conversation_id: conversationId,
        step,
        type: 'system',
        role: 'system',
        content: {
          loaded_history: {
            messages: history.messages.length,
            conversations_read: history.conversationsRead,
            messages_trimmed: history.messagesTrimmed,
            total_bytes: history.totalBytes,
          },
        },
      });
      step++;
    }
  }

  // Record each NEW user/system message from parsed.messages in the trace.
  // (Loaded history is NOT re-traced — it already lives in the prior conversations.)
  for (const message of parsed.messages) {
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

  // Make the call
  const callStartedAt = Date.now();
  let result;
  let errorOccurred: Error | null = null;
  try {
    result = await generateText({
      model: languageModel,
      messages: messagesForCall,
      system: parsed.system,
      temperature: parsed.temperature,
      ...(parsed.maxOutputTokens !== undefined ? { maxOutputTokens: parsed.maxOutputTokens } : {}),
    });
  } catch (err) {
    errorOccurred = err instanceof Error ? err : new Error(String(err));
    // Record the error in the trace before re-throwing
    await trace({
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step,
      type: 'error',
      content: { name: errorOccurred.name, message: errorOccurred.message },
      model: parsed.model,
      provider,
      latency_ms: Date.now() - callStartedAt,
    });
    await endConv({
      conversationId,
      startedAt,
      endedAt: new Date(),
      model: parsed.model,
      messageCount: step,
      cumulativeUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        costUsd: 0,
      },
      status: 'aborted_error',
      traceDir,
    });
    throw errorOccurred;
  }

  const latencyMs = Date.now() - callStartedAt;

  // Extract usage; AI SDK v5 exposes usage on the result
  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  const cachedInputTokens = result.usage?.cachedInputTokens ?? 0;
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

  // Record the assistant response in the trace
  await trace({
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    step,
    type: 'assistant',
    role: 'assistant',
    content: result.text,
    model: parsed.model,
    provider,
    usage,
    latency_ms: latencyMs,
  });

  // Write conversation-end summary to INDEX.jsonl
  await endConv({
    conversationId,
    startedAt,
    endedAt: new Date(),
    model: parsed.model,
    messageCount: step + 1,
    cumulativeUsage: usage,
    status: 'completed',
    traceDir,
  });

  return {
    text: result.text,
    conversationId,
    usage,
    model: parsed.model as ModelString,
    provider: provider as Provider,
    finishReason: normalizeFinishReason(result.finishReason),
  };
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
