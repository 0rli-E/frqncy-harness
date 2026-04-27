/**
 * `frqncy-harness chat <prompt>` — one-shot conversation, streams to stdout.
 */
import { stream } from '../stream.js';
import { loadConfig } from '../config.js';
import { loadProjectInstructions } from '../instructions.js';
import type { ModelString, Usage } from '../types.js';

export interface ChatCommandOptions {
  model?: string;
  system?: string;
  resume?: string;
  json?: boolean;
}

export async function runChatCommand(prompt: string, options: ChatCommandOptions): Promise<void> {
  const config = await loadConfig();
  const model = (options.model ?? config.defaultModel) as ModelString;

  if (!prompt || !prompt.trim()) {
    throw new Error('Prompt is required. Usage: frqncy-harness chat "your prompt"');
  }

  let assembledText = '';
  let conversationId = options.resume;
  let finalUsage: Usage | undefined;

  // Auto-load AGENT.md / CLAUDE.md as the system prompt when --system isn't given.
  // Resuming a conversation skips this — system already lives in the trace.
  let systemPrompt = options.system;
  if (!systemPrompt && !options.resume) {
    const loaded = await loadProjectInstructions(process.cwd());
    if (loaded) {
      systemPrompt = loaded.content;
      if (!options.json) {
        process.stderr.write(`[loaded ${loaded.source}]\n`);
      }
    }
  }

  // Errors thrown by stream() bubble up to the cli.ts catch which formats them via formatError().
  for await (const event of stream({
    model,
    messages: [{ role: 'user', content: prompt }],
    ...(systemPrompt ? { system: systemPrompt } : {}),
    ...(options.resume ? { conversationId: options.resume } : {}),
  })) {
    switch (event.type) {
      case 'text':
        if (!options.json) process.stdout.write(event.delta);
        assembledText += event.delta;
        break;
      case 'usage':
        finalUsage = event.usage;
        break;
      case 'done':
        conversationId = event.result.conversationId;
        break;
      case 'error':
        // Stream emits 'error' AND throws — the throw is caught above. The yielded event
        // is just the structured form for callers iterating the stream programmatically.
        break;
    }
  }

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        text: assembledText,
        conversationId,
        model,
        usage: finalUsage,
      }) + '\n',
    );
  } else {
    process.stdout.write('\n');
    if (finalUsage) {
      process.stderr.write(
        `\n[usage] in=${finalUsage.inputTokens} out=${finalUsage.outputTokens}` +
          (finalUsage.cachedInputTokens ? ` cached=${finalUsage.cachedInputTokens}` : '') +
          (finalUsage.costUsd !== undefined ? ` cost=$${finalUsage.costUsd.toFixed(6)}` : '') +
          ` conversation=${conversationId}\n`,
      );
    }
  }
}
