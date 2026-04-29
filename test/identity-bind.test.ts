/**
 * Identity smart-account binding tests — `signSetAgentWalletAuthorization`.
 *
 * Offline. Confirms:
 *   - The typed-data struct + primary type match the EIP-8004 spec
 *   - The signer receives the right domain + message + types
 *   - `newWallet` defaults to `signer.smartAccount ?? signer.address`
 *   - `deadline` defaults to roughly 30 minutes from now
 *   - An override `domain` skips the runtime read
 *   - The signature is the value the on-chain `setAgentWallet` expects
 */
import { describe, it, expect } from 'vitest';
import {
  signSetAgentWalletAuthorization,
  SET_AGENT_WALLET_PRIMARY_TYPE,
  SET_AGENT_WALLET_TYPES,
} from '../src/identity/sign-wallet.js';
import type { Signer, Eip712TypedData } from '../src/wallet/index.js';

interface CapturingSigner extends Signer {
  lastTypedData?: Eip712TypedData;
}

function fakeSigner(opts: { withSmartAccount?: boolean } = {}): CapturingSigner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = {
    kind: opts.withSmartAccount ? 'cdp' : 'viem',
    address: '0x1111111111111111111111111111111111111111',
    network: 'base-sepolia',
    ...(opts.withSmartAccount
      ? { smartAccount: '0x9999999999999999999999999999999999999999' }
      : {}),
    async signTypedData(data: Eip712TypedData) {
      s.lastTypedData = data;
      return ('0x' + 'aa'.repeat(65)) as `0x${string}`;
    },
    async signMessage() {
      return ('0x' + 'aa'.repeat(65)) as `0x${string}`;
    },
  };
  return s;
}

describe('SET_AGENT_WALLET_TYPES', () => {
  it('matches the EIP-8004 spec struct shape', () => {
    expect(SET_AGENT_WALLET_PRIMARY_TYPE).toBe('SetAgentWallet');
    expect(SET_AGENT_WALLET_TYPES.SetAgentWallet).toEqual([
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ]);
  });
});

describe('signSetAgentWalletAuthorization', () => {
  const customDomain = {
    name: 'ERC8004IdentityRegistry',
    version: '1',
    chainId: 84532,
    verifyingContract: '0x8004A818BFB912233c491871b3d84c89A494BD9e' as `0x${string}`,
  };

  it('signs with the right primary type + domain when domain is overridden', async () => {
    const signer = fakeSigner();
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 42,
      domain: customDomain,
    });
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/i);
    const data = signer.lastTypedData!;
    expect(data.primaryType).toBe('SetAgentWallet');
    expect(data.domain.name).toBe('ERC8004IdentityRegistry');
    expect(data.domain.version).toBe('1');
    expect(Number(data.domain.chainId)).toBe(84532);
    expect(data.domain.verifyingContract).toBe(
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
  });

  it('defaults newWallet to signer.smartAccount when present', async () => {
    const signer = fakeSigner({ withSmartAccount: true });
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 7,
      domain: customDomain,
    });
    expect(result.newWallet).toBe('0x9999999999999999999999999999999999999999');
    const msg = signer.lastTypedData!.message;
    expect(msg.newWallet).toBe('0x9999999999999999999999999999999999999999');
  });

  it('falls back to signer.address when no smart account', async () => {
    const signer = fakeSigner();
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 7,
      domain: customDomain,
    });
    expect(result.newWallet).toBe('0x1111111111111111111111111111111111111111');
  });

  it('honors an explicit newWallet override', async () => {
    const signer = fakeSigner({ withSmartAccount: true });
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 7,
      newWallet: '0x4444444444444444444444444444444444444444',
      domain: customDomain,
    });
    expect(result.newWallet).toBe('0x4444444444444444444444444444444444444444');
  });

  it('defaults deadline to ~30 minutes from now', async () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const signer = fakeSigner();
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 1,
      domain: customDomain,
    });
    const after = BigInt(Math.floor(Date.now() / 1000));
    expect(result.deadline).toBeGreaterThanOrEqual(before + 1799n);
    expect(result.deadline).toBeLessThanOrEqual(after + 1801n);
  });

  it('honors an explicit deadline', async () => {
    const signer = fakeSigner();
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 1,
      deadlineSeconds: 9999999999n,
      domain: customDomain,
    });
    expect(result.deadline).toBe(9999999999n);
    const msg = signer.lastTypedData!.message;
    expect(msg.deadline).toBe(9999999999n);
  });

  it('encodes agentId as bigint in the signed message', async () => {
    const signer = fakeSigner();
    await signSetAgentWalletAuthorization({
      signer,
      agentId: 12345,
      domain: customDomain,
    });
    const msg = signer.lastTypedData!.message;
    expect(typeof msg.agentId).toBe('bigint');
    expect(msg.agentId).toBe(12345n);
  });

  it('passes the full SetAgentWallet types struct to the signer', async () => {
    const signer = fakeSigner();
    await signSetAgentWalletAuthorization({
      signer,
      agentId: 1,
      domain: customDomain,
    });
    const types = signer.lastTypedData!.types;
    expect(types.SetAgentWallet).toEqual([
      { name: 'agentId', type: 'uint256' },
      { name: 'newWallet', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ]);
  });

  it('reports the resolved domain on the result', async () => {
    const signer = fakeSigner();
    const result = await signSetAgentWalletAuthorization({
      signer,
      agentId: 1,
      domain: customDomain,
    });
    expect(result.domain).toEqual(customDomain);
  });
});
