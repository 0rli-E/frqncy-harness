/**
 * web_search tool — search the web via Tavily or Brave.
 *
 * Provider auto-detection (in order):
 *   1. TAVILY_API_KEY → use Tavily (https://tavily.com — designed for AI agents)
 *   2. BRAVE_SEARCH_API_KEY → use Brave (https://api.search.brave.com — generous free tier)
 *   3. Neither set → tool returns a structured error explaining how to set one
 *
 * Both providers are normalized to the same output shape so the model sees
 * a uniform tool regardless of which is configured.
 */
import { z } from 'zod';
import type { HarnessTool } from './index.js';

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).describe('Search query'),
  max_results: z.number().int().positive().max(20).optional().describe('Default 5'),
  include_answer: z
    .boolean()
    .optional()
    .describe('Tavily-only: include an LLM-synthesized answer alongside results'),
});
export type WebSearchInput = z.infer<typeof WebSearchInputSchema>;

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
  /** Provider-specific score, normalized to 0-1 if possible */
  score?: number;
  /** Publication date if known (ISO 8601) */
  published?: string;
}

export interface WebSearchOutput {
  query: string;
  provider: 'tavily' | 'brave' | 'none';
  results: WebSearchResultItem[];
  /** LLM-synthesized answer if include_answer=true and provider supports it (Tavily only) */
  answer?: string;
  duration_ms: number;
}

export const webSearchTool: HarnessTool<WebSearchInput, WebSearchOutput> = {
  name: 'web_search',
  description:
    'Search the web via Tavily (preferred) or Brave Search (fallback). Returns a list of {title, url, snippet} ' +
    'results. Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY env var to enable.',
  inputSchema: WebSearchInputSchema,
  flags: { untrustedContent: true, outboundNetwork: true },
  permission: 'auto',
  execute: async ({ query, max_results, include_answer }) => {
    const startMs = Date.now();
    const limit = max_results ?? 5;

    if (process.env['TAVILY_API_KEY']) {
      const result = await searchTavily(query, limit, include_answer ?? false);
      return { ...result, duration_ms: Date.now() - startMs };
    }

    if (process.env['BRAVE_SEARCH_API_KEY']) {
      const result = await searchBrave(query, limit);
      return { ...result, duration_ms: Date.now() - startMs };
    }

    return {
      query,
      provider: 'none',
      results: [],
      duration_ms: Date.now() - startMs,
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// Tavily (https://docs.tavily.com)
// ────────────────────────────────────────────────────────────────────

async function searchTavily(
  query: string,
  maxResults: number,
  includeAnswer: boolean,
): Promise<Omit<WebSearchOutput, 'duration_ms'>> {
  const apiKey = process.env['TAVILY_API_KEY']!;
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_answer: includeAnswer,
      search_depth: 'basic',
    }),
  });

  if (!res.ok) {
    return {
      query,
      provider: 'tavily',
      results: [],
      answer: `Tavily error: ${res.status} ${res.statusText}`,
    };
  }

  const data = (await res.json()) as {
    answer?: string;
    results?: Array<{ title?: string; url?: string; content?: string; score?: number; published_date?: string }>;
  };

  return {
    query,
    provider: 'tavily',
    results: (data.results ?? []).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: r.content ?? '',
      ...(r.score !== undefined ? { score: r.score } : {}),
      ...(r.published_date ? { published: r.published_date } : {}),
    })),
    ...(data.answer ? { answer: data.answer } : {}),
  };
}

// ────────────────────────────────────────────────────────────────────
// Brave Search (https://api.search.brave.com)
// ────────────────────────────────────────────────────────────────────

async function searchBrave(
  query: string,
  maxResults: number,
): Promise<Omit<WebSearchOutput, 'duration_ms'>> {
  const apiKey = process.env['BRAVE_SEARCH_API_KEY']!;
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(Math.min(maxResults, 20)));

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!res.ok) {
    return {
      query,
      provider: 'brave',
      results: [],
    };
  }

  const data = (await res.json()) as {
    web?: {
      results?: Array<{ title?: string; url?: string; description?: string; age?: string }>;
    };
  };

  return {
    query,
    provider: 'brave',
    results: (data.web?.results ?? []).slice(0, maxResults).map((r) => ({
      title: r.title ?? '(untitled)',
      url: r.url ?? '',
      snippet: r.description ?? '',
      ...(r.age ? { published: r.age } : {}),
    })),
  };
}
