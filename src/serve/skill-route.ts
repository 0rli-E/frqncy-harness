/**
 * Build a paid HTTP handler from a LoadedSkill.
 *
 * The handler is a node:http-style `(req, res) => Promise<void>`. It expects:
 *   - POST method
 *   - Content-Type: application/json
 *   - body: { input: string, model?: string }
 *
 * Behavior:
 *   1. Parse + validate the body.
 *   2. Run `chat({ system: skill.body, messages: [{ role: 'user', content: input }], model })`
 *      — the skill body becomes the system prompt; the customer's `input` becomes the
 *      single user message. One-shot, no streaming. Per AGENT-AS-SERVICE decision 2.
 *   3. Return 200 with JSON `{ output, model, conversationId, usage }`.
 *
 * The x402 payment middleware sits IN FRONT of this handler — when the route is
 * paid, settlement is verified before the handler runs. By that point the customer
 * has paid; the handler must succeed or the operator owes a refund (out of scope).
 *
 * Errors during chat() return a 500 with a structured error body so the customer
 * has something to attach to a refund claim.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LoadedSkill } from '../skills/index.js';
import type { ModelString } from '../types.js';

export interface SkillRouteOptions {
  skill: LoadedSkill;
  /**
   * Model used for chat() invocations on this route. Falls back to the
   * harness default model when unset.
   */
  model?: ModelString;
  /**
   * `chat` injection — defaults to the harness's `chat()` from `../chat.js`.
   * Tests override with a stub.
   */
  chatFn?: typeof import('../chat.js').chat;
}

export interface PaidSkillResponse {
  output: string;
  model: string;
  conversationId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    costUsd?: number;
  };
}

/** Build a handler. Pure factory — no side effects until invoked. */
export function createSkillRouteHandler(
  opts: SkillRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method_not_allowed', message: 'use POST' });
      return;
    }

    const ctype = (req.headers['content-type'] ?? '').toString();
    if (!ctype.toLowerCase().includes('application/json')) {
      writeJson(res, 415, {
        error: 'unsupported_media_type',
        message: 'Content-Type must be application/json',
      });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJson(res, 400, {
        error: 'invalid_json',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { input?: unknown }).input !== 'string'
    ) {
      writeJson(res, 400, {
        error: 'invalid_input',
        message: 'body must be { "input": string, "model"?: string }',
      });
      return;
    }

    const { input, model: bodyModel } = body as { input: string; model?: string };
    const modelOverride = (bodyModel ?? opts.model) as ModelString | undefined;

    try {
      // Lazy-import chat so the route module is import-cheap when unused.
      const chatFn = opts.chatFn ?? (await import('../chat.js')).chat;
      const result = await chatFn({
        ...(modelOverride ? { model: modelOverride } : { model: 'anthropic/claude-sonnet-4-6' as ModelString }),
        system: opts.skill.body,
        messages: [{ role: 'user', content: input }],
      });

      const response: PaidSkillResponse = {
        output: result.text,
        model: result.model,
        conversationId: result.conversationId,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...(result.usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: result.usage.cachedInputTokens }
            : {}),
          ...(result.usage.costUsd !== undefined ? { costUsd: result.usage.costUsd } : {}),
        },
      };
      writeJson(res, 200, response);
    } catch (err) {
      writeJson(res, 500, {
        error: 'inference_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (!raw.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
