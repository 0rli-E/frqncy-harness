/**
 * Convert an MCP tool descriptor into a HarnessTool.
 *
 * MCP tools come with JSON Schema input definitions. We use z.unknown() in the
 * HarnessTool wrapper (the MCP server validates anyway) but pass the original
 * JSON Schema through to the AI SDK via the `_jsonSchema` extension below so
 * the model sees the proper schema in its tool description.
 */
import { z } from 'zod';
import type { HarnessTool, ToolFlags, Permission } from '../tools/index.js';
import { callMcpTool, type ConnectedMcpServer, type McpToolDescriptor } from './client.js';

/**
 * MCP tools wrapped as HarnessTools. The `inputSchema` is z.unknown() because
 * the JSON Schema lives separately (in `_jsonSchema`); the AI SDK conversion
 * uses the JSON Schema when present, falls back to Zod otherwise.
 */
export interface McpHarnessTool extends HarnessTool<unknown, unknown> {
  /** Original JSON Schema from the MCP server, surfaced to the AI SDK */
  _jsonSchema: unknown;
  /** Server this tool is bound to */
  _server: ConnectedMcpServer;
  /** Original (un-namespaced) tool name */
  _rawToolName: string;
}

export function mcpToolToHarnessTool(
  server: ConnectedMcpServer,
  descriptor: McpToolDescriptor,
): McpHarnessTool {
  const ext = server.entry._harness;
  const flags: ToolFlags = {
    privateData: ext?.flags?.privateData ?? false,
    untrustedContent: ext?.flags?.untrustedContent ?? false,
    outboundNetwork: ext?.flags?.outboundNetwork ?? false,
  };
  const permission: Permission = ext?.permissions ?? 'propose-then-approve';

  return {
    name: descriptor.namespacedName,
    description: descriptor.description,
    inputSchema: z.unknown() as z.ZodType<unknown>,
    flags,
    permission,
    execute: async (input: unknown) => {
      return callMcpTool(server, descriptor.rawName, input);
    },
    _jsonSchema: descriptor.inputJsonSchema,
    _server: server,
    _rawToolName: descriptor.rawName,
  };
}

/**
 * Flatten a list of connected MCP servers into a single HarnessTool array.
 */
export function flattenMcpToolset(servers: ConnectedMcpServer[]): McpHarnessTool[] {
  const out: McpHarnessTool[] = [];
  for (const server of servers) {
    for (const tool of server.tools) {
      out.push(mcpToolToHarnessTool(server, tool));
    }
  }
  return out;
}
