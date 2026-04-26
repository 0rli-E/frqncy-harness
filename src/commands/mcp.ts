/**
 * `frqncy-harness mcp <subcommand>` — manage ~/.frqncy-harness/mcp.json.
 *
 * Subcommands:
 *   list                           print configured servers + status
 *   add <name> <command> [args...] add a new server entry
 *   remove <name>                  remove a server
 *   enable <name>                  set _harness.enabled = true
 *   disable <name>                 set _harness.enabled = false
 *   path                           print the config file path
 *   import-from-claude-desktop     copy mcpServers from Claude Desktop's config
 *   test [<name>]                  attempt to connect and list tools (all servers, or named)
 */
import { promises as fs } from 'node:fs';
import {
  loadMcpConfig,
  saveMcpConfig,
  claudeDesktopConfigPath,
  DEFAULT_MCP_CONFIG_PATH,
  getEnabledServers,
  McpConfigSchema,
  type McpServerEntry,
} from '../mcp/config.js';
import { connectMcpServers } from '../mcp/client.js';

export type McpSubcommand =
  | 'list'
  | 'add'
  | 'remove'
  | 'enable'
  | 'disable'
  | 'path'
  | 'import-from-claude-desktop'
  | 'test';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export async function runMcpCommand(subcommand: McpSubcommand, args: string[]): Promise<void> {
  switch (subcommand) {
    case 'path':
      process.stdout.write(DEFAULT_MCP_CONFIG_PATH + '\n');
      return;

    case 'list': {
      const config = await loadMcpConfig();
      const entries = Object.entries(config.mcpServers);
      if (entries.length === 0) {
        process.stdout.write(`${ANSI.dim}no MCP servers configured at ${DEFAULT_MCP_CONFIG_PATH}${ANSI.reset}\n`);
        process.stdout.write(`${ANSI.dim}add one with: frqncy-harness mcp add <name> <command> [args...]${ANSI.reset}\n`);
        return;
      }
      process.stdout.write(`${ANSI.bold}${ANSI.cyan}MCP servers${ANSI.reset} ${ANSI.dim}(${DEFAULT_MCP_CONFIG_PATH})${ANSI.reset}\n\n`);
      for (const [name, entry] of entries) {
        const enabled = entry._harness?.enabled !== false;
        const status = enabled ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.dim}·${ANSI.reset}`;
        process.stdout.write(`  ${status}  ${ANSI.bold}${name}${ANSI.reset} ${ANSI.dim}${entry.command} ${(entry.args ?? []).join(' ')}${ANSI.reset}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    case 'add': {
      const name = args[0];
      const command = args[1];
      const cmdArgs = args.slice(2);
      if (!name || !command) {
        throw new Error('Usage: frqncy-harness mcp add <name> <command> [args...]');
      }
      const config = await loadMcpConfig();
      if (config.mcpServers[name]) {
        throw new Error(`MCP server '${name}' already exists. Remove it first or pick a new name.`);
      }
      const entry: McpServerEntry = { command, ...(cmdArgs.length > 0 ? { args: cmdArgs } : {}) };
      config.mcpServers[name] = entry;
      await saveMcpConfig(McpConfigSchema.parse(config));
      process.stdout.write(`added ${name} → ${command} ${cmdArgs.join(' ')}\n`);
      return;
    }

    case 'remove': {
      const name = args[0];
      if (!name) throw new Error('Usage: frqncy-harness mcp remove <name>');
      const config = await loadMcpConfig();
      if (!config.mcpServers[name]) {
        throw new Error(`MCP server '${name}' not found`);
      }
      delete config.mcpServers[name];
      await saveMcpConfig(McpConfigSchema.parse(config));
      process.stdout.write(`removed ${name}\n`);
      return;
    }

    case 'enable':
    case 'disable': {
      const name = args[0];
      if (!name) throw new Error(`Usage: frqncy-harness mcp ${subcommand} <name>`);
      const config = await loadMcpConfig();
      const entry = config.mcpServers[name];
      if (!entry) throw new Error(`MCP server '${name}' not found`);
      entry._harness = { ...(entry._harness ?? {}), enabled: subcommand === 'enable' };
      await saveMcpConfig(McpConfigSchema.parse(config));
      process.stdout.write(`${subcommand}d ${name}\n`);
      return;
    }

    case 'import-from-claude-desktop': {
      const desktopPath = claudeDesktopConfigPath();
      let raw: string;
      try {
        raw = await fs.readFile(desktopPath, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Claude Desktop config not found at ${desktopPath}. ` +
              `Make sure Claude Desktop is installed and you've added at least one MCP server in its settings.`,
          );
        }
        throw err;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Failed to parse Claude Desktop config at ${desktopPath} as JSON`);
      }
      const desktop = json as { mcpServers?: Record<string, McpServerEntry> };
      if (!desktop.mcpServers || Object.keys(desktop.mcpServers).length === 0) {
        process.stdout.write(`${ANSI.yellow}no MCP servers configured in Claude Desktop${ANSI.reset}\n`);
        return;
      }
      const config = await loadMcpConfig();
      let imported = 0;
      let skipped = 0;
      for (const [name, entry] of Object.entries(desktop.mcpServers)) {
        if (config.mcpServers[name]) {
          skipped++;
          continue;
        }
        config.mcpServers[name] = entry;
        imported++;
      }
      await saveMcpConfig(McpConfigSchema.parse(config));
      process.stdout.write(
        `imported ${imported} server(s) from Claude Desktop` +
          (skipped > 0 ? ` (${skipped} skipped — already exist with that name)` : '') +
          `\n`,
      );
      return;
    }

    case 'test': {
      const onlyName = args[0];
      const config = await loadMcpConfig();
      let servers = getEnabledServers(config);
      if (onlyName) {
        servers = servers.filter((s) => s.name === onlyName);
        if (servers.length === 0) {
          throw new Error(`MCP server '${onlyName}' not found or disabled`);
        }
      }
      if (servers.length === 0) {
        process.stdout.write(`${ANSI.dim}no enabled MCP servers to test${ANSI.reset}\n`);
        return;
      }
      process.stdout.write(`${ANSI.dim}connecting to ${servers.length} server(s)...${ANSI.reset}\n\n`);
      const result = await connectMcpServers(servers);
      try {
        for (const s of result.servers) {
          process.stdout.write(`  ${ANSI.green}✓${ANSI.reset} ${ANSI.bold}${s.name}${ANSI.reset} ${ANSI.dim}— ${s.tools.length} tool(s)${ANSI.reset}\n`);
          for (const t of s.tools) {
            process.stdout.write(`      ${ANSI.dim}- ${t.namespacedName}${ANSI.reset}\n`);
          }
        }
        for (const e of result.errors) {
          process.stdout.write(`  ${ANSI.red}✗${ANSI.reset} ${ANSI.bold}${e.name}${ANSI.reset} ${ANSI.dim}— ${e.error.message}${ANSI.reset}\n`);
        }
        if (result.errors.length > 0) {
          process.exitCode = 1;
        }
      } finally {
        await result.disconnectAll();
      }
      return;
    }

    default:
      throw new Error(`Unknown mcp subcommand: ${subcommand}`);
  }
}
