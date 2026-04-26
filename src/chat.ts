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
  DEFAULT_TRACE_DIR,
} from './trace.js';

export async function chat(input: ChatInput): Promise<ChatResult> {
  // Validate input — refuse to proceed with bad arguments
  const parsed = ChatInputSchema.parse(input);

  const conversationId = parsed.conversationId ?? randomUUID();
  const traceDir = parsed.traceDir ?? DEFAULT_TRACE_DIR;
  const startedAt = new Date();
  const traceFile = getTraceFilePath(conversationId, startedAt, traceDir);

  // Resolve the provider
  const { model: languageModel, provider, modelId } = await getProvider(parsed.model);

  // Record each user message in the trace
  let step = 0;
  for (const message of parsed.messages) {
    if (message.role === 'user' || message.role === 'system') {
      await appendTraceRecord(traceFile, {
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
      messages: parsed.messages,
      system: parsed.system,
      temperature: parsed.temperature,
      ...(parsed.maxOutputTokens !== undefined ? { maxOutputTokens: parsed.maxOutputTokens } : {}),
    });
  } catch (err) {
    errorOccurred = err instanceof Error ? err : new Error(String(err));
    // Record the error in the trace before re-throwing
    await appendTraceRecord(traceFile, {
      ts: new Date().toISOString(),
      conversation_id: conversationId,
      step,
      type: 'error',
      content: { name: errorOccurred.name, message: errorOccurred.message },
      model: parsed.model,
      provider,
      latency_ms: Date.now() - callStartedAt,
    });
    await recordConversationEnd({
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
  await appendTraceRecord(traceFile, {
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
  await recordConversationEnd({
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
