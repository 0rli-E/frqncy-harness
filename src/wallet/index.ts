/**
 * Wallet / Signer abstraction.
 *
 * The harness signs EIP-712 typed data (for x402 EIP-3009) and EIP-191 messages
 * (for ERC-8004 setAgentWallet). It needs ONE interface that both Coinbase CDP
 * server-wallet accounts and viem `privateKeyToAccount` accounts can implement.
 *
 * Pluggable signer pattern lifted from `@lucid-agents/wallet`'s wallet-handle
 * preference order: explicit > developer > agent. We collapse to two
 * concrete adapters: `cdp` (default — gas-sponsored on Base via CDP Paymaster)
 * and `viem` (private-key fallback for CI, testnets, users opting out of CDP).
 *
 * Wallet keys NEVER enter the LLM context. The harness signs internally; the
 * LLM sees only the result. Per AGENT.md "trace schema is sacred" we never log
 * raw private keys, mnemonic phrases, or CDP wallet secrets to the trace.
 *
 * SECURITY NOTE on EIP-3009 + smart accounts:
 *   USDC.transferWithAuthorization() does plain ecrecover() against the EOA
 *   `from` parameter. So when the harness signs an x402 payment for a CDP
 *   smart account, the *owner EOA* must sign — not the smart-account address
 *   (which would route through ERC-1271). This module exposes both `address`
 *   and `ownerAddress` so callers can pick the right one.
 */
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────
// Networks
// ────────────────────────────────────────────────────────────────────

export const NETWORKS = ['base', 'base-sepolia'] as const;
export type Network = (typeof NETWORKS)[number];

export interface NetworkInfo {
  network: Network;
  chainId: number;
  rpcUrl: string;
  /** Native USDC contract for this chain. */
  usdc: `0x${string}`;
  /** USDC EIP-712 domain `name`. */
  usdcName: string;
  /** USDC EIP-712 domain `version`. */
  usdcVersion: string;
  /** ERC-8004 IdentityRegistry singleton. */
  identityRegistry: `0x${string}`;
  /** ERC-8004 ReputationRegistry singleton. */
  reputationRegistry: `0x${string}`;
  /** Default x402 facilitator URL for this network. */
  defaultFacilitatorUrl: string;
}

const BASE_MAINNET: NetworkInfo = {
  network: 'base',
  chainId: 8453,
  rpcUrl: 'https://mainnet.base.org',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  usdcName: 'USD Coin',
  usdcVersion: '2',
  identityRegistry: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  reputationRegistry: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
  defaultFacilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
};

const BASE_SEPOLIA: NetworkInfo = {
  network: 'base-sepolia',
  chainId: 84532,
  rpcUrl: 'https://sepolia.base.org',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  usdcName: 'USDC',
  usdcVersion: '2',
  identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  defaultFacilitatorUrl: 'https://x402.org/facilitator',
};

const NETWORK_INFO: Record<Network, NetworkInfo> = {
  base: BASE_MAINNET,
  'base-sepolia': BASE_SEPOLIA,
};

export function getNetworkInfo(network: Network): NetworkInfo {
  const info = NETWORK_INFO[network];
  if (!info) throw new Error(`Unknown network: ${network}`);
  // Allow env-var override of RPC and facilitator (per AGENT-COMMERCE decision 1).
  const rpcUrl = process.env.FRQNCY_RPC_URL ?? info.rpcUrl;
  const defaultFacilitatorUrl =
    process.env.FRQNCY_X402_FACILITATOR_URL ?? info.defaultFacilitatorUrl;
  return { ...info, rpcUrl, defaultFacilitatorUrl };
}

export function resolveNetwork(): Network {
  const env = process.env.FRQNCY_NETWORK;
  if (env === 'base' || env === 'base-sepolia') return env;
  return 'base';
}

// ────────────────────────────────────────────────────────────────────
// Signer interface
// ────────────────────────────────────────────────────────────────────

export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface Eip712TypedData {
  domain: {
    name?: string;
    version?: string;
    chainId?: number | bigint;
    verifyingContract?: Address;
    salt?: Hex;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * The harness signer. Both the CDP and viem adapters implement this.
 *
 *   - `address`         — the address that signs messages (always the EOA)
 *   - `smartAccount`    — present only for CDP smart accounts; this is the
 *                         address that holds funds and receives payments
 *   - `network`         — the chain this signer is bound to
 *   - `signTypedData`   — EIP-712 typed-data signature; produces a 65-byte hex
 *                         string suitable for ecrecover
 *   - `signMessage`     — EIP-191 personal_sign for ERC-8004 etc.
 *   - `kind`            — `'cdp' | 'viem'`; used in trace records and doctor output
 */
export interface Signer {
  readonly kind: 'cdp' | 'viem';
  readonly address: Address;
  /** For CDP smart accounts: the smart-account address that holds funds. */
  readonly smartAccount?: Address;
  readonly network: Network;
  signTypedData(data: Eip712TypedData): Promise<Hex>;
  signMessage(message: string | { raw: Hex }): Promise<Hex>;
}

// ────────────────────────────────────────────────────────────────────
// Auth-store schema additions
// ────────────────────────────────────────────────────────────────────

/**
 * Wallet credentials stored in `~/.frqncy-harness/auth/keys.json` (file mode
 * 0600). Same security properties as the rest of the auth store. We keep these
 * separate from the API-key bag because they unlock funds, not API quota.
 */
export const WalletCredentialsSchema = z.object({
  /** Coinbase Developer Platform API key id (UUID). */
  cdpApiKeyId: z.string().optional(),
  /** Coinbase Developer Platform API key secret (Ed25519/ECDSA). */
  cdpApiKeySecret: z.string().optional(),
  /** Coinbase Developer Platform wallet secret (required to move funds). */
  cdpWalletSecret: z.string().optional(),
  /** CDP account name to use (one CDP project can have many). Default: 'frqncy'. */
  cdpAccountName: z.string().optional(),
  /** Fallback: viem privateKeyToAccount with this hex key. */
  privateKey: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, 'private key must be 0x-prefixed 32-byte hex')
    .optional(),
});
export type WalletCredentials = z.infer<typeof WalletCredentialsSchema>;

// ────────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────────

export interface CreateSignerOptions {
  network?: Network;
  /** Force a specific adapter even if both sets of creds are present. */
  prefer?: 'cdp' | 'viem';
  /** Inline credentials override; otherwise read from the auth store / env. */
  credentials?: WalletCredentials;
}

/**
 * Create a Signer.
 *
 * Resolution order:
 *   1. Explicit `credentials` argument
 *   2. `~/.frqncy-harness/auth/keys.json` (wallet block)
 *   3. Env vars (CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET,
 *      FRQNCY_AGENT_PRIVATE_KEY)
 *
 * Adapter preference: `prefer` arg → CDP (if all three creds present) → viem
 * (if private key present) → throw.
 */
export async function createSigner(opts: CreateSignerOptions = {}): Promise<Signer> {
  const network = opts.network ?? resolveNetwork();
  const creds = opts.credentials ?? (await loadWalletCredentials());

  const wantCdp = opts.prefer === 'cdp' || (!opts.prefer && hasCdpCreds(creds));
  const wantViem = opts.prefer === 'viem' || (!opts.prefer && !hasCdpCreds(creds) && !!creds.privateKey);

  if (wantCdp) {
    if (!hasCdpCreds(creds)) {
      throw new Error(
        'CDP credentials missing — set CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET ' +
          'or store them via `frqncy-harness auth set cdp-*`.',
      );
    }
    const { createCdpSigner } = await import('./cdp.js');
    return createCdpSigner({
      network,
      apiKeyId: creds.cdpApiKeyId!,
      apiKeySecret: creds.cdpApiKeySecret!,
      walletSecret: creds.cdpWalletSecret!,
      accountName: creds.cdpAccountName ?? 'frqncy',
    });
  }

  if (wantViem) {
    if (!creds.privateKey) {
      throw new Error(
        'No private key found — set FRQNCY_AGENT_PRIVATE_KEY or store via `frqncy-harness auth set wallet-private-key`.',
      );
    }
    const { createViemSigner } = await import('./viem.js');
    return createViemSigner({ network, privateKey: creds.privateKey as Hex });
  }

  throw new Error(
    'No wallet credentials configured. Either CDP creds (preferred) or a private key are required.',
  );
}

function hasCdpCreds(c: WalletCredentials): boolean {
  return !!(c.cdpApiKeyId && c.cdpApiKeySecret && c.cdpWalletSecret);
}

/**
 * Read wallet credentials from the existing auth store + env. Pure read — does
 * not mutate. Env wins over stored, matching the API-key resolution pattern.
 */
export async function loadWalletCredentials(): Promise<WalletCredentials> {
  // Try env first
  const fromEnv: WalletCredentials = {
    cdpApiKeyId: process.env.CDP_API_KEY_ID,
    cdpApiKeySecret: process.env.CDP_API_KEY_SECRET,
    cdpWalletSecret: process.env.CDP_WALLET_SECRET,
    cdpAccountName: process.env.FRQNCY_AGENT_NAME,
    privateKey: process.env.FRQNCY_AGENT_PRIVATE_KEY,
  };

  // Then merge in stored creds for any field env didn't supply
  try {
    const { promises: fs } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const path = process.env.FRQNCY_WALLET_PATH ?? join(homedir(), '.frqncy-harness', 'auth', 'wallet.json');
    const raw = await fs.readFile(path, 'utf-8');
    const stored = WalletCredentialsSchema.parse(JSON.parse(raw));
    return WalletCredentialsSchema.parse({
      cdpApiKeyId: fromEnv.cdpApiKeyId ?? stored.cdpApiKeyId,
      cdpApiKeySecret: fromEnv.cdpApiKeySecret ?? stored.cdpApiKeySecret,
      cdpWalletSecret: fromEnv.cdpWalletSecret ?? stored.cdpWalletSecret,
      cdpAccountName: fromEnv.cdpAccountName ?? stored.cdpAccountName,
      privateKey: fromEnv.privateKey ?? stored.privateKey,
    });
  } catch {
    return WalletCredentialsSchema.parse(fromEnv);
  }
}

export async function saveWalletCredentials(creds: WalletCredentials): Promise<string> {
  const validated = WalletCredentialsSchema.parse(creds);
  const { promises: fs } = await import('node:fs');
  const { homedir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const path =
    process.env.FRQNCY_WALLET_PATH ?? join(homedir(), '.frqncy-harness', 'auth', 'wallet.json');
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, path);
  return path;
}
