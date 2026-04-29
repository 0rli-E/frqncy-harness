/**
 * Coinbase CDP Server Wallet v2 Signer adapter.
 *
 * Uses `@coinbase/cdp-sdk`. Requires three credentials (CDP_API_KEY_ID,
 * CDP_API_KEY_SECRET, CDP_WALLET_SECRET) — the SDK signs everything with a
 * short-lived JWT under the hood.
 *
 * Default flow:
 *   1. `cdp.evm.getOrCreateAccount({ name })` → owner EOA (this is what signs)
 *   2. `cdp.evm.getOrCreateSmartAccount({ owner, name })` → ERC-4337 smart
 *      account (this is what holds funds; gas is sponsored on Base via CDP
 *      Paymaster)
 *
 * Both addresses are exposed on the returned Signer:
 *   - `address`        = owner EOA (used for ecrecover-checked signatures
 *                        like USDC's transferWithAuthorization)
 *   - `smartAccount`   = smart-account address (used for receiving payments,
 *                        ERC-1271 signatures, gas-sponsored sends)
 *
 * `@coinbase/cdp-sdk` is a runtime peer dependency. We lazy-import so users
 * who don't need a CDP wallet can use the harness without installing it.
 */
import {
  getNetworkInfo,
  type Network,
  type Signer,
  type Address,
  type Hex,
  type Eip712TypedData,
} from './index.js';
import { peerImport } from './peerimport.js';

export interface CreateCdpSignerOptions {
  network: Network;
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
  /** CDP account name (one CDP project can have many). Defaults 'frqncy'. */
  accountName?: string;
}

export async function createCdpSigner(opts: CreateCdpSignerOptions): Promise<Signer> {
  // Lazy import — peer dep
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cdpModule: any;
  try {
    cdpModule = await peerImport('@coinbase/cdp-sdk');
  } catch {
    throw new Error(
      "Cannot load '@coinbase/cdp-sdk' — install it as a peer dep: `npm install @coinbase/cdp-sdk`. " +
        'Or set FRQNCY_WALLET_KIND=viem to use a local private key instead.',
    );
  }
  const { CdpClient } = cdpModule;

  const cdp = new CdpClient({
    apiKeyId: opts.apiKeyId,
    apiKeySecret: opts.apiKeySecret,
    walletSecret: opts.walletSecret,
  });

  const accountName = opts.accountName ?? 'frqncy';
  const owner = await cdp.evm.getOrCreateAccount({ name: accountName });
  const smart = await cdp.evm.getOrCreateSmartAccount({
    owner,
    name: `${accountName}-smart`,
  });

  // Hoist the smart account onto the chosen network so callers don't have to
  // pass `network` on every send. CDP sponsors gas on Base via Paymaster when
  // the smart account is scoped to base/base-sepolia.
  const networkScopedSmart =
    typeof smart.useNetwork === 'function' ? await smart.useNetwork(opts.network) : smart;

  const networkInfo = getNetworkInfo(opts.network);

  return {
    kind: 'cdp' as const,
    address: owner.address as Address,
    smartAccount: smart.address as Address,
    network: opts.network,

    async signTypedData(data: Eip712TypedData): Promise<Hex> {
      // EIP-3009 transferWithAuthorization is ecrecover-checked on `from`,
      // so the EOA owner — not the smart account — must sign.
      const sig = await owner.signTypedData({
        domain: {
          ...data.domain,
          chainId:
            data.domain.chainId !== undefined ? Number(data.domain.chainId) : networkInfo.chainId,
        },
        types: data.types,
        primaryType: data.primaryType,
        message: data.message,
      });
      return sig as Hex;
    },

    async signMessage(message: string | { raw: Hex }): Promise<Hex> {
      const sig = await owner.signMessage({
        message: typeof message === 'string' ? message : { raw: message.raw },
      });
      return sig as Hex;
    },

    // Internal handle so other modules can issue gas-sponsored sends from the
    // smart account when needed (USDC transfers, registry calls). This is not
    // part of the public Signer interface — callers must downcast and check.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _smart: networkScopedSmart as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _cdp: cdp as any,
  } as Signer & { _smart: unknown; _cdp: unknown };
}
