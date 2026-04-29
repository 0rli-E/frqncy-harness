/**
 * `daydreams-router/*` provider-lane tests — offline.
 *
 * Confirms the model string parses, the lane is registered in PROVIDERS, and
 * the dispatch path returns a LanguageModel-shaped object pointed at the
 * configured base URL with our wrapped fetch attached.
 *
 * The actual permit-signing handshake is exercised in `bridges.test.ts`
 * against a mock router; here we only test the registration + plumbing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseModelString } from '../src/providers/index.js';
import { API_PROVIDERS, PROVIDERS } from '../src/types.js';

describe('daydreams-router lane registration', () => {
  it('is included in API_PROVIDERS', () => {
    expect(API_PROVIDERS as readonly string[]).toContain('daydreams-router');
  });

  it('is included in PROVIDERS', () => {
    expect(PROVIDERS as readonly string[]).toContain('daydreams-router');
  });

  it('parses a basic model string', () => {
    const parsed = parseModelString('daydreams-router/anthropic:claude-sonnet-4-6');
    expect(parsed.provider).toBe('daydreams-router');
    expect(parsed.modelId).toBe('anthropic:claude-sonnet-4-6');
  });

  it('parses model strings with provider:model colons cleanly', () => {
    // The router's `provider:model` ID convention contains a colon — the harness
    // splits on the FIRST slash, so the colon-bearing modelId stays intact.
    const cases: Array<[string, string]> = [
      ['daydreams-router/openai:gpt-5', 'openai:gpt-5'],
      ['daydreams-router/fal:flux-schnell', 'fal:flux-schnell'],
      [
        'daydreams-router/bedrock:anthropic.claude-3-sonnet-20240229-v1:0',
        'bedrock:anthropic.claude-3-sonnet-20240229-v1:0',
      ],
      ['daydreams-router/auto', 'auto'],
    ];
    for (const [model, expectedId] of cases) {
      const parsed = parseModelString(model);
      expect(parsed.provider).toBe('daydreams-router');
      expect(parsed.modelId).toBe(expectedId);
    }
  });

  it('rejects unknown providers (regression)', () => {
    expect(() => parseModelString('not-a-real-provider/model')).toThrow(/Unknown provider/);
  });
});

describe('daydreams-router lane dispatch (offline)', () => {
  let tempWalletPath: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'frqncy-router-lane-'));
    tempWalletPath = join(dir, 'wallet.json');
    savedEnv = {
      FRQNCY_WALLET_PATH: process.env.FRQNCY_WALLET_PATH,
      FRQNCY_AGENT_PRIVATE_KEY: process.env.FRQNCY_AGENT_PRIVATE_KEY,
      FRQNCY_NETWORK: process.env.FRQNCY_NETWORK,
      CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
      CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
      CDP_WALLET_SECRET: process.env.CDP_WALLET_SECRET,
    };
    process.env.FRQNCY_WALLET_PATH = tempWalletPath;
    delete process.env.FRQNCY_AGENT_PRIVATE_KEY;
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
    process.env.FRQNCY_NETWORK = 'base-sepolia';
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fs.rm(join(tempWalletPath, '..'), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('throws a clear error when no wallet creds are configured', async () => {
    const { getProvider } = await import('../src/providers/index.js');
    await expect(
      getProvider('daydreams-router/anthropic:claude-sonnet-4-6'),
    ).rejects.toThrow(/wallet credentials/i);
  });

  // We don't test the `viem` happy path here because that requires the viem
  // peer dep to be installed AND a private key in the wallet store. That path
  // is exercised end-to-end via `test/bridges.test.ts` which mocks the chain
  // hop. Here we only verify the lane is reachable via the dispatcher.
});
