/**
 * Public MCP API.
 *
 * The harness uses MCP servers to extend its tool surface declaratively —
 * users edit `~/.frqncy-harness/mcp.json` (Claude Desktop schema-compatible),
 * and the agent loop auto-loads tools from connected servers.
 */
export {
  loadMcpConfig,
  saveMcpConfig,
  getEnabledServers,
  claudeDesktopConfigPath,
  DEFAULT_MCP_CONFIG_PATH,
  McpConfigSchema,
  McpServerSchema,
  HarnessExtensionsSchema,
  type McpConfig,
  type McpServerEntry,
  type HarnessExtensions,
} from './config.js';

export {
  connectMcpServer,
  connectMcpServers,
  callMcpTool,
  type McpToolDescriptor,
  type ConnectedMcpServer,
  type ConnectMcpServersResult,
} from './client.js';

export {
  mcpToolToHarnessTool,
  flattenMcpToolset,
  type McpHarnessTool,
} from './tool-adapter.js';
