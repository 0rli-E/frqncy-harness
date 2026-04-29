/**
 * ERC-2612 Permit signing — for x402 facilitators that use permit-based
 * sessions instead of EIP-3009 transferWithAuthorization.
 *
 * Daydreams Router (`ai.xgate.run`) is the canonical use case: a single
 * permit opens an "upto" session, requests accumulate spend until the cap or
 * idle timeout, the facilitator settles asynchronously.
 *
 * Distinct from `sign.ts` (which signs `TransferWithAuthorization` for x402
 * v1 "exact" scheme). Both can coexist — schemes are wire-format pluggable.
 *
 * EIP-2612 typed-data:
 *   Permit:
 *     owner:     address
 *     spender:   address
 *     value:     uint256
 *     nonce:     uint256
 *     deadline:  uint256
 *
 * Domain is the ERC-20 token's EIP-712 domain (USDC: name "USD Coin",
 * version "2", chainId, verifyingContract). The contract enforces nonce +
 * deadline replay protection.
 */
import type { Signer, Hex, Address } from '../wallet/index.js';

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const PERMIT_PRIMARY_TYPE = 'Permit';

export interface PermitMessage {
  owner: Address;
  spender: Address;
  /** Maximum atomic units the spender may transfer under this permit. */
  value: bigint;
  /** Per-owner-per-token nonce, fetched from `token.nonces(owner)`. */
  nonce: bigint;
  /** UNIX timestamp the permit is valid until. */
  deadline: bigint;
}

export interface SignPermitOptions {
  signer: Signer;
  asset: Address; // token contract
  /** EIP-712 domain `name` (USDC = "USD Coin" on Base mainnet, "USDC" on Base Sepolia). */
  tokenName: string;
  /** EIP-712 domain `version`. USDC v2 on Base. */
  tokenVersion: string;
  chainId: number;
  message: PermitMessage;
}

/**
 * Sign an ERC-2612 Permit and return the (v, r, s)-decomposed pieces plus the
 * 65-byte raw signature. Daydreams Router takes the base64'd payload of
 * `{ permit, signature }` so we return both.
 */
export async function signPermit(opts: SignPermitOptions): Promise<{
  signature: Hex;
  v: number;
  r: Hex;
  s: Hex;
  message: PermitMessage;
}> {
  const signature = await opts.signer.signTypedData({
    domain: {
      name: opts.tokenName,
      version: opts.tokenVersion,
      chainId: opts.chainId,
      verifyingContract: opts.asset,
    },
    types: PERMIT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    primaryType: PERMIT_PRIMARY_TYPE,
    message: opts.message as unknown as Record<string, unknown>,
  });

  // Decompose 65-byte signature into v, r, s. v is the last byte.
  if (!signature.startsWith('0x') || signature.length !== 132) {
    throw new Error(`signPermit: expected 65-byte (132-char) signature, got ${signature.length}`);
  }
  const r = ('0x' + signature.slice(2, 66)) as Hex;
  const s = ('0x' + signature.slice(66, 130)) as Hex;
  const v = parseInt(signature.slice(130, 132), 16);

  return { signature, v, r, s, message: opts.message };
}

/**
 * Encode a signed permit for Daydreams Router's `PAYMENT-SIGNATURE` header
 * (base64-encoded JSON). Header value layout follows the Daydreams x402
 * permit-mode spec:
 *
 *   {
 *     "scheme": "permit",
 *     "network": "base" | "base-sepolia",
 *     "asset": "0x...",          // USDC contract
 *     "owner": "0x...",
 *     "spender": "0x...",
 *     "value": "1000000",        // atomic units (string of integer)
 *     "nonce": "42",
 *     "deadline": "...",
 *     "signature": "0x...65bytes",
 *     "v": 27, "r": "0x...", "s": "0x..."
 *   }
 *
 * The exact wire shape is what the router parses; if Daydreams updates their
 * spec, only this serializer changes.
 */
export interface EncodedPermitPayload {
  scheme: 'permit';
  network: string;
  asset: Address;
  owner: Address;
  spender: Address;
  value: string;
  nonce: string;
  deadline: string;
  signature: Hex;
  v: number;
  r: Hex;
  s: Hex;
}

export function encodePermitHeader(p: EncodedPermitPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf-8').toString('base64');
}

export function decodePermitHeader(header: string): EncodedPermitPayload {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as EncodedPermitPayload;
}
