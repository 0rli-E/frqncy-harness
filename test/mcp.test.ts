import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  loadMcpConfig,
  saveMcpConfig,
  getEnabledServers,
  McpConfigSchema,
  claudeDesktopConfigPath,
} from '../src/mcp/config.js';

let testPath: string;

beforeEach(() => {
  testPath = join(tmpdir(), `frqncy-harness-mcp-${randomUUID()}.json`);
});

afterEach(async () => {
  await fs.rm(testPath, { force: true });
});

describe('loadMcpConfig', () => {
  it('returns empty mcpServers when no file exists', async () => {
    const config = await loadMcpConfig(testPath);
    expect(config.mcpServers).toEqual({});
  });

  it('loads a valid Claude Desktop-shape config', async () => {
    await fs.writeFile(
      testPath,
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          },
        },
      }),
    );
    const config = await loadMcpConfig(testPath);
    expect(config.mcpServers.filesystem?.command).toBe('npx');
    expect(config.mcpServers.filesystem?.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  });

  it('parses _harness extensions', async () => {
    await fs.writeFile(
      testPath,
      JSON.stringify({
        mcpServers: {
          notion: {
            command: 'npx',
            args: ['-y', 'mcp-notion'],
            env: { NOTION_TOKEN: 'secret' },
            _harness: {
              enabled: false,
              permissions: 'auto',
              flags: { privateData: true },
            },
          },
        },
      }),
    );
    const config = await loadMcpConfig(testPath);
    expect(config.mcpServers.notion?._harness?.enabled).toBe(false);
    expect(config.mcpServers.notion?._harness?.permissions).toBe('auto');
    expect(config.mcpServers.notion?._harness?.flags?.privateData).toBe(true);
  });

  it('throws on malformed JSON', async () => {
    await fs.writeFile(testPath, '{not-json}');
    await expect(loadMcpConfig(testPath)).rejects.toThrow();
  });

  it('throws on schema-invalid entries', async () => {
    await fs.writeFile(testPath, JSON.stringify({ mcpServers: { x: { args: [] } } })); // missing `command`
    await expect(loadMcpConfig(testPath)).rejects.toThrow();
  });
});

describe('saveMcpConfig', () => {
  it('writes a valid config and reads it back', async () => {
    const config = McpConfigSchema.parse({
      mcpServers: {
        time: { command: 'npx', args: ['-y', 'mcp-time'] },
      },
    });
    await saveMcpConfig(config, testPath);
    const reloaded = await loadMcpConfig(testPath);
    expect(reloaded.mcpServers.time?.command).toBe('npx');
  });
});

describe('getEnabledServers', () => {
  it('includes servers with no _harness block', async () => {
    const config = McpConfigSchema.parse({
      mcpServers: {
        a: { command: 'npx', args: ['a'] },
        b: { command: 'npx', args: ['b'] },
      },
    });
    expect(getEnabledServers(config)).toHaveLength(2);
  });

  it('excludes servers with _harness.enabled=false', async () => {
    const config = McpConfigSchema.parse({
      mcpServers: {
        a: { command: 'npx', args: ['a'] },
        b: { command: 'npx', args: ['b'], _harness: { enabled: false } },
      },
    });
    const enabled = getEnabledServers(config);
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.name).toBe('a');
  });
});

describe('claudeDesktopConfigPath', () => {
  it('returns a non-empty platform-specific path', () => {
    const path = claudeDesktopConfigPath();
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain('Claude');
  });
});
