import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { webSearchTool } from '../src/tools/web-search.js';

const ORIGINAL_TAVILY = process.env['TAVILY_API_KEY'];
const ORIGINAL_BRAVE = process.env['BRAVE_SEARCH_API_KEY'];

beforeEach(() => {
  delete process.env['TAVILY_API_KEY'];
  delete process.env['BRAVE_SEARCH_API_KEY'];
});

afterEach(() => {
  if (ORIGINAL_TAVILY === undefined) delete process.env['TAVILY_API_KEY'];
  else process.env['TAVILY_API_KEY'] = ORIGINAL_TAVILY;
  if (ORIGINAL_BRAVE === undefined) delete process.env['BRAVE_SEARCH_API_KEY'];
  else process.env['BRAVE_SEARCH_API_KEY'] = ORIGINAL_BRAVE;
});

describe('webSearchTool', () => {
  it('returns provider:none when no API key configured', async () => {
    const result = await webSearchTool.execute(
      { query: 'test' },
      { conversationId: 'test', cwd: '/tmp' },
    );
    expect(result.provider).toBe('none');
    expect(result.results).toEqual([]);
    expect(result.query).toBe('test');
  });

  it('declares the right flags (untrusted + outbound)', () => {
    expect(webSearchTool.flags.untrustedContent).toBe(true);
    expect(webSearchTool.flags.outboundNetwork).toBe(true);
    expect(webSearchTool.flags.privateData).toBeFalsy();
  });

  it('is auto-permission', () => {
    expect(webSearchTool.permission).toBe('auto');
  });

  it('validates input via Zod schema', () => {
    expect(webSearchTool.inputSchema.safeParse({ query: 'hello' }).success).toBe(true);
    expect(webSearchTool.inputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(webSearchTool.inputSchema.safeParse({}).success).toBe(false);
    expect(
      webSearchTool.inputSchema.safeParse({ query: 'ok', max_results: 5 }).success,
    ).toBe(true);
    expect(
      webSearchTool.inputSchema.safeParse({ query: 'ok', max_results: 100 }).success,
    ).toBe(false);
  });
});
