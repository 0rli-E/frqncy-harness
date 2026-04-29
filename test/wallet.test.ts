/**
 * Wallet / Signer / Network tests.
 *
 * Offline — exercises:
 *   - getNetworkInfo() returns the right addresses per network
 *   - resolveNetwork() reads FRQNCY_NETWORK
 *   - createSigner() routes to the right adapter under the right creds
 *   - WalletCredentialsSchema validates the wallet store shape
 *   - saveWalletCredentials writes 0600 file at default path
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  getNetworkInfo,
  resolveNetwork,
  createSigner,
  WalletCredentialsSchema,
  saveWalletCredentials,
  loadWalletCredentials,
  NETWORKS,
} from '../src/wallet/index.js';

describe('getNetworkInfo', () => {
  it('returns Base mainnet defaults', () => {
    const info = getNetworkInfo('base');
    expect(info.network).toBe('base');
    expect(info.chainId).toBe(8453);
    expect(info.usdc.toLowerCase()).toBe('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    expect(info.identityRegistry).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(info.reputationRegistry).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(info.usdcName).toBe('USD Coin');
    expect(info.usdcVersion).toBe('2');
  });

  it('returns Base Sepolia defaults', () => {
    const info = getNetworkInfo('base-sepolia');
    expect(info.chainId).toBe(84532);
    expect(info.usdc.toLowerCase()).toBe('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
  });

  it('lets FRQNCY_RPC_URL override RPC', () => {
    process.env.FRQNCY_RPC_URL = 'https://custom.rpc';
    const info = getNetworkInfo('base');
    expect(info.rpcUrl).toBe('https://custom.rpc');
    delete process.env.FRQNCY_RPC_URL;
  });

  it('lets FRQNCY_X402_FACILITATOR_URL override facilitator', () => {
    process.env.FRQNCY_X402_FACILITATOR_URL = 'https://my.facilitator';
    const info = getNetworkInfo('base');
    expect(info.defaultFacilitatorUrl).toBe('https://my.facilitator');
    delete process.env.FRQNCY_X402_FACILITATOR_URL;
  });
});

describe('resolveNetwork', () => {
  beforeEach(() => {
    delete process.env.FRQNCY_NETWORK;
  });

  it('defaults to base mainnet', () => {
    expect(resolveNetwork()).toBe('base');
  });

  it('reads FRQNCY_NETWORK', () => {
    process.env.FRQNCY_NETWORK = 'base-sepolia';
    expect(resolveNetwork()).toBe('base-sepolia');
  });

  it('falls back to base when env is invalid', () => {
    process.env.FRQNCY_NETWORK = 'mainnet'; // not a valid network for us
    expect(resolveNetwork()).toBe('base');
  });
});

describe('NETWORKS', () => {
  it('exposes the full list', () => {
    expect(NETWORKS).toContain('base');
    expect(NETWORKS).toContain('base-sepolia');
  });
});

describe('WalletCredentialsSchema', () => {
  it('accepts an empty object', () => {
    expect(() => WalletCredentialsSchema.parse({})).not.toThrow();
  });

  it('rejects malformed private keys', () => {
    expect(() => WalletCredentialsSchema.parse({ privateKey: 'not-hex' })).toThrow();
    expect(() => WalletCredentialsSchema.parse({ privateKey: '0x' + 'a'.repeat(60) })).toThrow();
  });

  it('accepts a valid private key', () => {
    const validPk = '0x' + 'a'.repeat(64);
    expect(() => WalletCredentialsSchema.parse({ privateKey: validPk })).not.toThrow();
  });
});

describe('saveWalletCredentials / loadWalletCredentials', () => {
  let tempDir: string;
  let originalPath: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-wallet-'));
    originalPath = process.env.FRQNCY_WALLET_PATH;
    process.env.FRQNCY_WALLET_PATH = join(tempDir, 'wallet.json');
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.FRQNCY_WALLET_PATH;
    else process.env.FRQNCY_WALLET_PATH = originalPath;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('round-trips creds through the store', async () => {
    // Make sure env doesn't leak in
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
    delete process.env.FRQNCY_AGENT_PRIVATE_KEY;
    delete process.env.FRQNCY_AGENT_NAME;
    const validPk = ('0x' + 'a'.repeat(64)) as `0x${string}`;
    await saveWalletCredentials({ privateKey: validPk, cdpAccountName: 'unit-test' });
    const loaded = await loadWalletCredentials();
    expect(loaded.privateKey).toBe(validPk);
    expect(loaded.cdpAccountName).toBe('unit-test');
  });

  it('writes the file with mode 0600', async () => {
    const validPk = ('0x' + 'b'.repeat(64)) as `0x${string}`;
    const path = await saveWalletCredentials({ privateKey: validPk });
    const stat = await fs.stat(path);
    // Check owner-rw only on POSIX. Skip on Windows.
    if (process.platform !== 'win32') {
      const perms = stat.mode & 0o777;
      expect(perms & 0o077).toBe(0); // group + other have no perms
    }
  });
});

describe('createSigner', () => {
  let tempDir: string;
  let originalPath: string | undefined;
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-signer-'));
    originalPath = process.env.FRQNCY_WALLET_PATH;
    process.env.FRQNCY_WALLET_PATH = join(tempDir, `wallet-${randomUUID()}.json`);
    envSnapshot = {
      CDP_API_KEY_ID: process.env.CDP_API_KEY_ID,
      CDP_API_KEY_SECRET: process.env.CDP_API_KEY_SECRET,
      CDP_WALLET_SECRET: process.env.CDP_WALLET_SECRET,
      FRQNCY_AGENT_PRIVATE_KEY: process.env.FRQNCY_AGENT_PRIVATE_KEY,
      FRQNCY_AGENT_NAME: process.env.FRQNCY_AGENT_NAME,
    };
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
    delete process.env.FRQNCY_AGENT_PRIVATE_KEY;
    delete process.env.FRQNCY_AGENT_NAME;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.FRQNCY_WALLET_PATH;
    else process.env.FRQNCY_WALLET_PATH = originalPath;
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('throws when no creds are present', async () => {
    await expect(createSigner({ network: 'base-sepolia' })).rejects.toThrow(
      /No wallet credentials configured/,
    );
  });

  it('throws a clear error if user prefers cdp without creds', async () => {
    await expect(createSigner({ network: 'base', prefer: 'cdp' })).rejects.toThrow(
      /CDP credentials missing/,
    );
  });

  it('throws a clear error if user prefers viem without a private key', async () => {
    await expect(createSigner({ network: 'base', prefer: 'viem' })).rejects.toThrow(
      /No private key found/,
    );
  });

  // Note: a positive viem path test would require viem to be installed.
  // Skipped intentionally — we exercise it in the e2e suite gated on FRQNCY_E2E.
});
