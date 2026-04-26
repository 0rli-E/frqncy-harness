/**
 * web_fetch — fetch a URL and return text contents.
 *
 * Web search is deferred (needs a third-party API like Brave or Tavily).
 * For now, the agent can compose search behavior via bash + curl + web_fetch
 * or via an MCP server (v0.2 sprint #3).
 *
 * Permission: auto for now. Tagged untrustedContent + outboundNetwork —
 * combined with a tool flagged privateData, the lethal-trifecta gate fires.
 */
import { z } from 'zod';
import type { HarnessTool } from './index.js';

const FETCH_BYTE_LIMIT = 512 * 1024; // 512KB cap on response body

export const WebFetchInputSchema = z.object({
  url: z.string().url().describe('Full URL including protocol'),
  method: z.enum(['GET', 'HEAD']).optional().describe('Default: GET'),
  timeout_ms: z.number().int().positive().max(60_000).optional().describe('Default 20000'),
  headers: z.record(z.string(), z.string()).optional().describe('Optional request headers'),
});
export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

export interface WebFetchOutput {
  url: string;
  status: number;
  status_text: string;
  content_type: string;
  bytes_received: number;
  truncated: boolean;
  body: string;
  headers: Record<string, string>;
  duration_ms: number;
}

export const webFetchTool: HarnessTool<WebFetchInput, WebFetchOutput> = {
  name: 'web_fetch',
  description:
    'Fetch a URL via HTTP GET (default) or HEAD. Returns the response body up to ' +
    `${FETCH_BYTE_LIMIT} bytes plus headers. For binary content, expect garbled text — use HEAD or set Accept header.`,
  inputSchema: WebFetchInputSchema,
  flags: { untrustedContent: true, outboundNetwork: true },
  permission: 'auto',
  execute: async ({ url, method, timeout_ms, headers }) => {
    const startMs = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms ?? 20_000);
    try {
      const res = await fetch(url, {
        method: method ?? 'GET',
        headers: {
          'User-Agent': '@frqncy/harness/0.2 (https://github.com/0xOrli/frqncy-harness)',
          ...headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      const contentType = res.headers.get('content-type') ?? '';
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });

      let body = '';
      let bytesReceived = 0;
      let truncated = false;

      if (method !== 'HEAD') {
        const reader = res.body?.getReader();
        if (reader) {
          const chunks: Uint8Array[] = [];
          while (bytesReceived < FETCH_BYTE_LIMIT) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              const remainingCapacity = FETCH_BYTE_LIMIT - bytesReceived;
              if (value.length > remainingCapacity) {
                chunks.push(value.subarray(0, remainingCapacity));
                bytesReceived += remainingCapacity;
                truncated = true;
                break;
              }
              chunks.push(value);
              bytesReceived += value.length;
            }
          }
          if (!truncated) {
            // Drain remaining body to detect overall size
            // (skip — performance vs accuracy tradeoff in v0.2)
          } else {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
          }
          body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
        }
      }

      return {
        url: res.url,
        status: res.status,
        status_text: res.statusText,
        content_type: contentType,
        bytes_received: bytesReceived,
        truncated,
        body,
        headers: responseHeaders,
        duration_ms: Date.now() - startMs,
      };
    } catch (err) {
      const duration = Date.now() - startMs;
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.name === 'AbortError') {
        return {
          url,
          status: 0,
          status_text: 'Timeout',
          content_type: '',
          bytes_received: 0,
          truncated: false,
          body: `[harness] fetch exceeded ${timeout_ms ?? 20_000}ms timeout`,
          headers: {},
          duration_ms: duration,
        };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};
