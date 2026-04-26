import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  ConfigSchema,
} from '../src/config.js';

let testConfigPath: string;

beforeEach(async () => {
  testConfigPath = join(tmpdir(), `frqncy-harness-config-${randomUUID()}.json`);
});

afterEach(async () => {
  await fs.rm(testConfigPath, { force: true });
});

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig(testConfigPath);
    expect(config.defaultModel).toBe('anthropic/claude-sonnet-4-6');
    expect(config.costCap.softWarnUsd).toBe(5);
    expect(config.costCap.hardAbortUsd).toBe(25);
    expect(config.notifications.enabled).toBe(false);
  });

  it('loads from a valid file', async () => {
    await fs.writeFile(
      testConfigPath,
      JSON.stringify({
        defaultModel: 'openai/gpt-5',
        costCap: { softWarnUsd: 10, hardAbortUsd: 50 },
      }),
    );
    const config = await loadConfig(testConfigPath);
    expect(config.defaultModel).toBe('openai/gpt-5');
    expect(config.costCap.softWarnUsd).toBe(10);
  });

  it('throws on malformed JSON', async () => {
    await fs.writeFile(testConfigPath, '{not-json}');
    await expect(loadConfig(testConfigPath)).rejects.toThrow();
  });

  it('throws on schema-invalid values', async () => {
    await fs.writeFile(
      testConfigPath,
      JSON.stringify({ defaultModel: 'no-slash-here' }),
    );
    await expect(loadConfig(testConfigPath)).rejects.toThrow();
  });
});

describe('saveConfig', () => {
  it('writes a valid config to disk', async () => {
    const config = ConfigSchema.parse({ defaultModel: 'openai/gpt-5-mini' });
    await saveConfig(config, testConfigPath);
    const reloaded = await loadConfig(testConfigPath);
    expect(reloaded.defaultModel).toBe('openai/gpt-5-mini');
  });
});

describe('getConfigValue', () => {
  it('reads top-level keys', async () => {
    const config = await loadConfig(testConfigPath);
    expect(getConfigValue(config, 'defaultModel')).toBe('anthropic/claude-sonnet-4-6');
  });

  it('reads nested keys via dot path', async () => {
    const config = await loadConfig(testConfigPath);
    expect(getConfigValue(config, 'costCap.softWarnUsd')).toBe(5);
  });

  it('returns undefined for missing keys', async () => {
    const config = await loadConfig(testConfigPath);
    expect(getConfigValue(config, 'doesNotExist.foo')).toBeUndefined();
  });
});

describe('setConfigValue', () => {
  it('sets a top-level value and validates', async () => {
    const config = await loadConfig(testConfigPath);
    const updated = setConfigValue(config, 'defaultModel', 'openai/gpt-5');
    expect(updated.defaultModel).toBe('openai/gpt-5');
  });

  it('coerces numbers from strings', async () => {
    const config = await loadConfig(testConfigPath);
    const updated = setConfigValue(config, 'costCap.softWarnUsd', '15');
    expect(updated.costCap.softWarnUsd).toBe(15);
  });

  it('coerces booleans from strings', async () => {
    const config = await loadConfig(testConfigPath);
    const updated = setConfigValue(config, 'notifications.enabled', 'true');
    expect(updated.notifications.enabled).toBe(true);
  });

  it('throws on invalid model strings', async () => {
    const config = await loadConfig(testConfigPath);
    expect(() => setConfigValue(config, 'defaultModel', 'no-slash')).toThrow();
  });
});
