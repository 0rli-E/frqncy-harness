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

export interface ConnectedMcpServer {
  name: string;
  entry: McpServerEntry;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDescriptor[];
  /** Disconnect this server cleanly */
  disconnect: () => Promise<void>;
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
): Promise<ConnectedMcpServer> {
  const timeoutMs = entry._harness?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args ?? [],
    env: entry.env ? { ...process.env, ...entry.env } as Record<string, string> : (process.env as Record<string, string>),
  });

  const client = new Client(
    { name: '@frqncy-network/harness', version: '0.4.0' },
    { capabilities: {} },
  );

  // Race the connect against a timeout
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP server '${name}' connect timeout after ${timeoutMs}ms`)), timeoutMs),
  );
  await Promise.race([connectPromise, timeoutPromise]);

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
): Promise<ConnectMcpServersResult> {
  const results = await Promise.allSettled(
    servers.map(({ name, entry }) => connectMcpServer(name, entry)),
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
