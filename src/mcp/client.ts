/**
 * MCP client wrapper.
 *
 * Connects to one or more configured MCP servers via stdio, lists their tools,
 * and exposes a uniform interface for the harness to call them through.
 *
 * The connections live for the duration of an `agent` run; cleanup() disconnects
 * all of them.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServerEntry } from './config.js';

export interface McpToolDescriptor {
  /** Original tool name as the MCP server reports it */
  rawName: string;
  /** Namespaced name we expose to the model: "<serverName>__<rawName>" */
  namespacedName: string;
  /** Server this tool came from */
  serverName: string;
  description: string;
  inputJsonSchema: unknown;
}

/**
 * v0.13.5 — relaxed `transport` type. The MCP SDK exposes three concrete
 * transport classes (`StdioClientTransport`, `StreamableHTTPClientTransport`,
 * `SSEClientTransport`). They share a common interface — `start()`, `close()`,
 * `send()` — but TypeScript doesn't expose that union directly. We accept any
 * object with a `close(): Promise<void>` method, which is all this module
 * cares about.
 */
type AnyMcpTransport = {
  close(): Promise<void>;
};

export interface ConnectedMcpServer {
  name: string;
  entry: McpServerEntry;
  client: Client;
  transport: AnyMcpTransport;
  tools: McpToolDescriptor[];
  /** Disconnect this server cleanly */
  disconnect: () => Promise<void>;
}

/**
 * Optional connection-time options. v0.13.5+: `fetch` flows through to the
 * HTTP/SSE transports so paid MCP servers can auto-pay 402 responses under
 * the agent run's wallet + budget + hook plumbing.
 */
export interface ConnectMcpServerOptions {
  fetch?: typeof fetch;
}

export interface ConnectMcpServersResult {
  servers: ConnectedMcpServer[];
  errors: Array<{ name: string; error: Error }>;
  /** Disconnect ALL servers — call when the agent run ends */
  disconnectAll: () => Promise<void>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Connect to a single MCP server. Returns null if connection fails.
 */
export async function connectMcpServer(
  name: string,
  entry: McpServerEntry,
  options: ConnectMcpServerOptions = {},
): Promise<ConnectedMcpServer> {
  const timeoutMs = entry._harness?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  // Resolve transport kind. Schema enforces command XOR url.
  const transportKind: 'stdio' | 'streamable-http' | 'sse' =
    entry.transport ?? (entry.url ? 'streamable-http' : 'stdio');

  let transport: AnyMcpTransport;
  if (transportKind === 'stdio') {
    if (!entry.command) {
      throw new Error(`MCP server '${name}': stdio transport requires \`command\``);
    }
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ? { ...process.env, ...entry.env } as Record<string, string> : (process.env as Record<string, string>),
    });
  } else if (transportKind === 'streamable-http') {
    if (!entry.url) {
      throw new Error(`MCP server '${name}': streamable-http transport requires \`url\``);
    }
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {};
    if (options.fetch) opts.fetch = options.fetch;
    transport = new StreamableHTTPClientTransport(new URL(entry.url), opts);
  } else {
    if (!entry.url) {
      throw new Error(`MCP server '${name}': sse transport requires \`url\``);
    }
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {};
    if (options.fetch) opts.fetch = options.fetch;
    transport = new SSEClientTransport(new URL(entry.url), opts);
  }

  const client = new Client(
    { name: '@frqncy-network/harness', version: '0.4.0' },
    { capabilities: {} },
  );

  // Race the connect against a timeout. If the timeout wins, we still need to
  // close the stdio transport — otherwise the spawned subprocess (and its pipes)
  // leak file descriptors. Repeated MCP connect attempts in a long-running
  // session would eventually exhaust FDs.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  // Cast through `unknown` because the AnyMcpTransport union only narrows on
  // close(); the SDK's internal Transport requires start()+send() too. The
  // three concrete transports (Stdio/StreamableHTTP/SSE) all implement those.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connectPromise = client.connect(transport as any);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`MCP server '${name}' connect timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([connectPromise, timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    // Best-effort: close the transport so the subprocess and its FDs are released.
    // We swallow errors here because the original connect failure is what the
    // caller cares about.
    try { await transport.close(); } catch { /* ignore */ }
    throw err;
  }

  // List tools
  const listed = await client.listTools();
  const tools: McpToolDescriptor[] = (listed.tools ?? []).map((t) => ({
    rawName: t.name,
    namespacedName: `${name}__${t.name}`,
    serverName: name,
    description: t.description ?? `Tool ${t.name} from MCP server ${name}`,
    inputJsonSchema: t.inputSchema,
  }));

  return {
    name,
    entry,
    client,
    transport,
    tools,
    disconnect: async () => {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Connect to all enabled servers in parallel. Returns successful connections
 * plus errors for any that failed (so a single broken server doesn't kill the run).
 */
export async function connectMcpServers(
  servers: Array<{ name: string; entry: McpServerEntry }>,
  options: ConnectMcpServerOptions = {},
): Promise<ConnectMcpServersResult> {
  const results = await Promise.allSettled(
    servers.map(({ name, entry }) => connectMcpServer(name, entry, options)),
  );

  const connected: ConnectedMcpServer[] = [];
  const errors: Array<{ name: string; error: Error }> = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const { name } = servers[i]!;
    if (r.status === 'fulfilled') {
      connected.push(r.value);
    } else {
      const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
      errors.push({ name, error: err });
    }
  }

  return {
    servers: connected,
    errors,
    disconnectAll: async () => {
      await Promise.allSettled(connected.map((s) => s.disconnect()));
    },
  };
}

/**
 * Call a tool on a connected MCP server. Returns the structured tool result,
 * or an error object compatible with the harness's tool-result shape.
 */
export async function callMcpTool(
  server: ConnectedMcpServer,
  rawToolName: string,
  args: unknown,
): Promise<unknown> {
  try {
    const result = await server.client.callTool({
      name: rawToolName,
      arguments: (args as Record<string, unknown>) ?? {},
    });
    // MCP returns { content: [...], isError?: boolean }
    if (result.isError) {
      return {
        error: 'mcp_tool_error',
        message: 'MCP server returned isError=true',
        content: result.content,
      };
    }
    return result;
  } catch (err) {
    return {
      error: 'mcp_call_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
