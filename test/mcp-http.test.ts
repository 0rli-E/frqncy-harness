/**
 * MCP HTTP / SSE transport tests — confirms:
 *   - The schema enforces command-XOR-url
 *   - The dispatch path picks the right transport class
 *   - The wrapped fetch flows through to the StreamableHTTPClientTransport's
 *     `fetch` option (so paid MCP servers auto-pay 402s)
 *
 * Offline. The dispatch test stubs the SDK's transport import via vi.mock
 * to avoid spinning up a real MCP server — what we actually want to confirm
 * is that the harness *constructs* the right transport with the right
 * options. End-to-end paid MCP is exercised at the wrapFetchWithPayment
 * layer in payment-auto-attach.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServerSchema } from '../src/mcp/config.js';

// Capture transport-construction calls.
const streamableCalls: Array<{ url: URL; opts: unknown }> = [];
const sseCalls: Array<{ url: URL; opts: unknown }> = [];
const stdioCalls: Array<{ command: string; args: string[] }> = [];

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts: unknown) {
      streamableCalls.push({ url, opts });
    }
    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(url: URL, opts: unknown) {
      sseCalls.push({ url, opts });
    }
    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(opts: { command: string; args: string[] }) {
      stdioCalls.push({ command: opts.command, args: opts.args });
    }
    async start(): Promise<void> {}
    async close(): Promise<void> {}
    async send(): Promise<void> {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async listTools(): Promise<{ tools: never[] }> {
      return { tools: [] };
    }
    async close(): Promise<void> {}
  },
}));

import { connectMcpServer } from '../src/mcp/client.js';

describe('McpServerSchema', () => {
  it('accepts a stdio entry with command set', () => {
    expect(() =>
      McpServerSchema.parse({ command: 'npx', args: ['some-mcp'] }),
    ).not.toThrow();
  });

  it('accepts an http entry with url set', () => {
    expect(() =>
      McpServerSchema.parse({ url: 'https://api.example.com/mcp' }),
    ).not.toThrow();
  });

  it('accepts an explicit transport: streamable-http', () => {
    expect(() =>
      McpServerSchema.parse({
        url: 'https://api.example.com/mcp',
        transport: 'streamable-http',
      }),
    ).not.toThrow();
  });

  it('accepts an explicit transport: sse', () => {
    expect(() =>
      McpServerSchema.parse({
        url: 'https://api.example.com/mcp',
        transport: 'sse',
      }),
    ).not.toThrow();
  });

  it('rejects entries with both command AND url', () => {
    expect(() =>
      McpServerSchema.parse({
        command: 'npx',
        url: 'https://api.example.com/mcp',
      }),
    ).toThrow(/exactly one/);
  });

  it('rejects entries with neither command nor url', () => {
    expect(() => McpServerSchema.parse({})).toThrow(/exactly one/);
  });

  it('rejects malformed urls', () => {
    expect(() =>
      McpServerSchema.parse({ url: 'not-a-url' }),
    ).toThrow();
  });
});

describe('connectMcpServer transport dispatch', () => {
  beforeEach(() => {
    streamableCalls.length = 0;
    sseCalls.length = 0;
    stdioCalls.length = 0;
  });

  it('picks StdioClientTransport when command is set', async () => {
    await connectMcpServer('stdio-server', {
      command: 'npx',
      args: ['some-mcp'],
    });
    expect(stdioCalls).toHaveLength(1);
    expect(stdioCalls[0]?.command).toBe('npx');
    expect(streamableCalls).toHaveLength(0);
    expect(sseCalls).toHaveLength(0);
  });

  it('picks StreamableHTTPClientTransport when url is set', async () => {
    await connectMcpServer('http-server', {
      url: 'https://api.example.com/mcp',
    });
    expect(streamableCalls).toHaveLength(1);
    expect(streamableCalls[0]?.url.href).toBe('https://api.example.com/mcp');
    expect(stdioCalls).toHaveLength(0);
    expect(sseCalls).toHaveLength(0);
  });

  it('picks SSEClientTransport when transport: sse is explicit', async () => {
    await connectMcpServer('sse-server', {
      url: 'https://api.example.com/mcp',
      transport: 'sse',
    });
    expect(sseCalls).toHaveLength(1);
    expect(sseCalls[0]?.url.href).toBe('https://api.example.com/mcp');
    expect(streamableCalls).toHaveLength(0);
  });

  it('threads the fetch option into StreamableHTTPClientTransport', async () => {
    const wrappedFetch: typeof fetch = (() => Promise.resolve(new Response())) as typeof fetch;
    await connectMcpServer(
      'paid-mcp',
      { url: 'https://api.example.com/mcp' },
      { fetch: wrappedFetch },
    );
    expect(streamableCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = streamableCalls[0]?.opts as any;
    expect(opts.fetch).toBe(wrappedFetch);
  });

  it('threads the fetch option into SSEClientTransport', async () => {
    const wrappedFetch: typeof fetch = (() => Promise.resolve(new Response())) as typeof fetch;
    await connectMcpServer(
      'paid-sse',
      { url: 'https://api.example.com/mcp', transport: 'sse' },
      { fetch: wrappedFetch },
    );
    expect(sseCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = sseCalls[0]?.opts as any;
    expect(opts.fetch).toBe(wrappedFetch);
  });

  it('does not pass a fetch option when none provided (back-compat)', async () => {
    await connectMcpServer('http-server', { url: 'https://api.example.com/mcp' });
    expect(streamableCalls).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = streamableCalls[0]?.opts as any;
    expect(opts.fetch).toBeUndefined();
  });

  it('does not pass a fetch option to stdio (irrelevant)', async () => {
    const wrappedFetch: typeof fetch = (() => Promise.resolve(new Response())) as typeof fetch;
    await connectMcpServer(
      'stdio-server',
      { command: 'npx', args: [] },
      { fetch: wrappedFetch },
    );
    expect(stdioCalls).toHaveLength(1);
    // No assertion on stdio's opts — the transport doesn't take a fetch.
  });
});
