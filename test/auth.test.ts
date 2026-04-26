import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  loadAuthStore,
  saveAuthStore,
  AUTH_PROVIDERS,
  ENV_VAR_BY_PROVIDER,
} from '../src/auth/index.js';

let testPath: string;

beforeEach(() => {
  testPath = join(tmpdir(), `frqncy-harness-auth-${randomUUID()}.json`);
});

afterEach(async () => {
  await fs.rm(testPath, { force: true });
});

describe('loadAuthStore', () => {
  it('returns empty defaults when no file exists', async () => {
    const store = await loadAuthStore(testPath);
    expect(store.apiKeys).toEqual({});
    expect(store.oauthTokens).toEqual({});
  });

  it('loads stored API keys', async () => {
    await fs.writeFile(
      testPath,
      JSON.stringify({
        apiKeys: { anthropic: 'sk-ant-test' },
      }),
    );
    const store = await loadAuthStore(testPath);
    expect(store.apiKeys.anthropic).toBe('sk-ant-test');
  });

  it('throws on malformed JSON', async () => {
    await fs.writeFile(testPath, '{not-json}');
    await expect(loadAuthStore(testPath)).rejects.toThrow();
  });
});

describe('saveAuthStore', () => {
  it('writes with restrictive file mode (0600)', async () => {
    const store = await loadAuthStore(testPath);
    store.apiKeys.openrouter = 'sk-or-test';
    await saveAuthStore(store, testPath);
    const stat = await fs.stat(testPath);
    // Only check the user permission bits — group/world should be 0
    const mode = stat.mode & 0o777;
    expect(mode & 0o077).toBe(0); // no group/world bits
  });

  it('round-trips API keys', async () => {
    const store = await loadAuthStore(testPath);
    store.apiKeys.anthropic = 'sk-ant-1';
    store.apiKeys.openai = 'sk-openai-1';
    await saveAuthStore(store, testPath);
    const reloaded = await loadAuthStore(testPath);
    expect(reloaded.apiKeys.anthropic).toBe('sk-ant-1');
    expect(reloaded.apiKeys.openai).toBe('sk-openai-1');
  });
});

describe('AUTH_PROVIDERS + ENV_VAR_BY_PROVIDER', () => {
  it('every provider has an env var name', () => {
    for (const provider of AUTH_PROVIDERS) {
      expect(ENV_VAR_BY_PROVIDER[provider]).toBeDefined();
      expect(ENV_VAR_BY_PROVIDER[provider].length).toBeGreaterThan(0);
    }
  });

  it('env var names look right for each provider', () => {
    expect(ENV_VAR_BY_PROVIDER.anthropic).toBe('ANTHROPIC_API_KEY');
    expect(ENV_VAR_BY_PROVIDER.openai).toBe('OPENAI_API_KEY');
    expect(ENV_VAR_BY_PROVIDER.google).toBe('GOOGLE_GENERATIVE_AI_API_KEY');
    expect(ENV_VAR_BY_PROVIDER.openrouter).toBe('OPENROUTER_API_KEY');
  });
});
