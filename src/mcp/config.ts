/**
 * MCP config schema.
 *
 * Per HARNESS-DEFAULTS-REVIEW.md decision D1: Hybrid format.
 *   - Top level matches Claude Desktop's `mcpServers` schema (copy-paste portable)
 *   - Optional `_harness` namespaced extensions per server for harness-specific
 *     concerns (cost caps, permissions, enable/disable)
 *
 * File: ~/.frqncy-harness/mcp.json
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_MCP_CONFIG_PATH = join(homedir(), '.frqncy-harness', 'mcp.json');

// ────────────────────────────────────────────────────────────────────
// Per-server extensions (harness-only)
// ────────────────────────────────────────────────────────────────────

export const HarnessExtensionsSchema = z
  .object({
    /** Set false to disable a server without removing the entry */
    enabled: z.boolean().optional(),
    /** Cost cap override for tools from this server (USD) */
    costCap: z
      .object({
        softWarnUsd: z.number().nonnegative().optional(),
        hardAbortUsd: z.number().nonnegative().optional(),
      })
      .optional(),
    /** Permission tier override applied to ALL tools from this server */
    permissions: z.enum(['auto', 'propose-then-approve']).optional(),
    /** Lethal-trifecta flags this server's tools should be tagged with */
    flags: z
      .object({
        privateData: z.boolean().optional(),
        untrustedContent: z.boolean().optional(),
        outboundNetwork: z.boolean().optional(),
      })
      .optional(),
    /** Connection timeout for the initial handshake (ms). Default 10000. */
    connectTimeoutMs: z.number().int().positive().optional(),
  })
  .partial();
export type HarnessExtensions = z.infer<typeof HarnessExtensionsSchema>;

// ────────────────────────────────────────────────────────────────────
// Single server entry — matches Claude Desktop's shape
// ────────────────────────────────────────────────────────────────────

export const McpServerSchema = z.object({
  command: z.string().describe('Executable to spawn (e.g. "npx", "node", "python")'),
  args: z.array(z.string()).optional().describe('Args passed to command'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
  // Harness-only extension namespace
  _harness: HarnessExtensionsSchema.optional(),
});
export type McpServerEntry = z.infer<typeof McpServerSchema>;

// ────────────────────────────────────────────────────────────────────
// Top-level config — matches Claude Desktop's mcp.json
// ────────────────────────────────────────────────────────────────────

export const McpConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

// ────────────────────────────────────────────────────────────────────
// Load / save
// ────────────────────────────────────────────────────────────────────

export async function loadMcpConfig(path = DEFAULT_MCP_CONFIG_PATH): Promise<McpConfig> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const json = JSON.parse(raw);
    return McpConfigSchema.parse(json);
  } catch (err) {
    if (isFileNotFound(err)) {
      return McpConfigSchema.parse({});
    }
    throw err;
  }
}

export async function saveMcpConfig(config: McpConfig, path = DEFAULT_MCP_CONFIG_PATH): Promise<void> {
  const validated = McpConfigSchema.parse(config);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

/**
 * Filter to only enabled servers (those without _harness.enabled=false).
 */
export function getEnabledServers(config: McpConfig): Array<{ name: string; entry: McpServerEntry }> {
  return Object.entries(config.mcpServers)
    .filter(([, entry]) => entry._harness?.enabled !== false)
    .map(([name, entry]) => ({ name, entry }));
}

/**
 * Look up Claude Desktop's mcp.json on this OS.
 *
 *   macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   Linux:   ~/.config/Claude/claude_desktop_config.json
 *   Windows: %APPDATA%\Claude\claude_desktop_config.json (we don't fully support, point user to manual import)
 */
export function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'linux') {
    return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }
  // Windows fallback — APPDATA env var
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function isFileNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
