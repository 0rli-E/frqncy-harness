/**
 * @frqncy-network/harness — public API
 *
 * v0.0.1 surface: chat() and stream(), with the trace writer behind them.
 * v0.1+ adds: tools, agent loop, MCP client, CLI, sandbox, external artifacts.
 */
export { chat } from './chat.js';
export { stream } from './stream.js';

export {
  TRACE_SCHEMA_VERSION,
  PROVIDERS,
  API_PROVIDERS,
  SUBSCRIPTION_PROVIDERS,
  isSubscriptionProvider,
  type ChatInput,
  type ChatResult,
  type Message,
  type ModelString,
  type Provider,
  type ApiProvider,
  type SubscriptionProvider,
  type Role,
  type StreamEvent,
  type TraceRecord,
  type TraceRecordType,
  type IndexRecord,
  type ConversationStatus,
  type Usage,
} from './types.js';

export {
  DEFAULT_TRACE_DIR,
  getTraceFilePath,
  getIndexFilePath,
  appendTraceRecord,
  appendIndexRecord,
  recordConversationEnd,
} from './trace.js';

export { parseModelString, getProvider } from './providers/index.js';
export {
  runSubscription,
  isClaudeCodeAvailable,
  isCodexAvailable,
  type SubscriptionRunOptions,
} from './providers/subprocess.js';

export { computeCost, getModelRate, DEFAULT_RATES, type ModelRate } from './pricing.js';

// ── Tools (v0.2) ─────────────────────────────────────────────
export {
  toAiSdkTool,
  toAiSdkToolSet,
  detectLethalTrifecta,
  type HarnessTool,
  type Permission,
  type ToolFlags,
  type ToolContext,
} from './tools/index.js';
export { bashTool, BashInputSchema, type BashInput, type BashOutput } from './tools/bash.js';
export {
  readTool,
  writeTool,
  grepTool,
  globTool,
  ReadInputSchema,
  WriteInputSchema,
  GrepInputSchema,
  GlobInputSchema,
  type ReadInput,
  type ReadOutput,
  type WriteInput,
  type WriteOutput,
  type GrepInput,
  type GrepOutput,
  type GlobInput,
  type GlobOutput,
  type GrepMatch,
} from './tools/file.js';
export { webFetchTool, WebFetchInputSchema, type WebFetchInput, type WebFetchOutput } from './tools/web.js';
export {
  webSearchTool,
  WebSearchInputSchema,
  type WebSearchInput,
  type WebSearchOutput,
  type WebSearchResultItem,
} from './tools/web-search.js';

// ── Sandbox (v0.2) ───────────────────────────────────────────
export {
  createSandbox,
  createGtrSandbox,
  createTempdirSandbox,
  isGtrAvailable,
  type Sandbox,
  type CreateSandboxOptions,
} from './sandbox/index.js';

// ── Approval (v0.2) ──────────────────────────────────────────
export {
  ApprovalManager,
  type ApprovalCallback,
  type ApprovalRequest,
  type ApprovalManagerOptions,
} from './approval.js';

// ── Hooks (v0.5) ─────────────────────────────────────────────
export {
  HookManager,
  HookEntrySchema,
  HooksConfigSchema,
  DEFAULT_HOOKS,
  bundledAutoCommitTraces,
  bundledMacosNotification,
  bundledEditorialLint,
  type HookEvent,
  type HookContext,
  type PreAgentContext,
  type PostToolUseContext,
  type PostAgentContext,
  type HookResult,
  type HookEntry,
  type HooksConfig,
} from './hooks/index.js';

// ── Auth (v0.2) ──────────────────────────────────────────────
export {
  loadAuthStore,
  saveAuthStore,
  resolveApiKey,
  hydrateApiKeysIntoEnv,
  AUTH_PROVIDERS,
  ENV_VAR_BY_PROVIDER,
  DEFAULT_AUTH_PATH,
  AuthStoreSchema,
  type AuthProvider,
  type AuthStore,
} from './auth/index.js';

// ── MCP (v0.2) ───────────────────────────────────────────────
export {
  loadMcpConfig,
  saveMcpConfig,
  getEnabledServers,
  claudeDesktopConfigPath,
  DEFAULT_MCP_CONFIG_PATH,
  McpConfigSchema,
  McpServerSchema,
  HarnessExtensionsSchema,
  connectMcpServer,
  connectMcpServers,
  callMcpTool,
  mcpToolToHarnessTool,
  flattenMcpToolset,
  type McpConfig,
  type McpServerEntry,
  type HarnessExtensions,
  type McpToolDescriptor,
  type ConnectedMcpServer,
  type ConnectMcpServersResult,
  type McpHarnessTool,
} from './mcp/index.js';
