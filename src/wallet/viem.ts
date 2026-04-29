/**
 * viem-based Signer adapter.
 *
 * Uses `privateKeyToAccount` from `viem/accounts`. Lightweight, no remote
 * services. Used for CI tests, testnet smoke runs, and as a fallback when CDP
 * credentials are not configured.
 *
 * `viem` is a runtime peer dependency. This module imports it lazily so the
 * harness can be used without viem installed when the user only needs the
 * non-wallet surface.
 */
import { getNetworkInfo, type Network, type Signer, type Address, type Hex, type Eip712TypedData } from './index.js';
import { peerImport } from './peerimport.js';

export interface CreateViemSignerOptions {
  network: Network;
  privateKey: Hex;
}

export async function createViemSigner(opts: CreateViemSignerOptions): Promise<Signer> {
  // Lazy import — peer dep
  let mod: { privateKeyToAccount: (k: Hex) => unknown };
  try {
    mod = await peerImport<{ privateKeyToAccount: (k: Hex) => unknown }>('viem/accounts');
  } catch {
    throw new Error(
      "Cannot load 'viem' — install it as a peer dep: `npm install viem`. " +
        'viem powers the local-private-key signer; CDP signer does not require it.',
    );
  }
  const { privateKeyToAccount } = mod;

  const network = opts.network;
  const info = getNetworkInfo(network);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = privateKeyToAccount(opts.privateKey) as any;

  return {
    kind: 'viem' as const,
    address: account.address as Address,
    network,
    async signTypedData(data: Eip712TypedData): Promise<Hex> {
      // viem expects the chain id as number, normalize bigint
      const domain = {
        ...data.domain,
        chainId:
          data.domain.chainId !== undefined
            ? Number(data.domain.chainId)
            : info.chainId,
      };
      const sig = await account.signTypedData({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        domain: domain as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        types: data.types as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        primaryType: data.primaryType as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        message: data.message as any,
      });
      return sig as Hex;
    },
    async signMessage(message: string | { raw: Hex }): Promise<Hex> {
      const sig = await account.signMessage({
        message: typeof message === 'string' ? message : { raw: message.raw },
      });
      return sig as Hex;
    },
  };
}
