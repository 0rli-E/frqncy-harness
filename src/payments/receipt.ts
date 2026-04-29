/**
 * Verifiable Settlement Receipts — EIP-712 signed proof of payment.
 *
 * Pattern lifted from Catena ACK-Pay's `PaymentReceiptCredential`. When a
 * paid skill route settles inbound, the seller agent signs a receipt over
 * the settlement details + the seller's ERC-8004 agentId. The customer can:
 *
 *   1. Verify the signature against the seller's agentId on-chain (the
 *      seller's `agentWallet` metadata is what does the signing).
 *   2. Show the receipt to ANY downstream party as proof of purchase.
 *   3. Append it to its own audit trail as evidence the call was paid for
 *      and acknowledged by a real ERC-8004 agent.
 *
 * Distinct from the on-chain x402 settlement (which is the financial fact)
 * and from the harness's `payment` trace record (which is the seller's
 * private audit log). The receipt is the *exportable artifact* that ties
 * the two together with cryptographic provenance.
 *
 * Why EIP-712 (not a JWT or VC-JWT): the signing wallet is already on-chain
 * via setAgentWallet, and EIP-712 verification is native to every wallet,
 * indexer, and contract in the EVM ecosystem. No VC tooling required.
 */
import { z } from 'zod';
import type { Signer, Address, Hex } from '../wallet/index.js';
import { peerImport } from '../wallet/peerimport.js';

// ────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────

/**
 * The receipt body. All fields are required and authenticated by the
 * signature. `agentId` is the seller's on-chain ERC-8004 id; receivers
 * verify the signature came from the wallet bound to that agentId.
 *
 * `nonce` is a per-receipt random 32-byte value so two settlements at the
 * same timestamp produce different signatures. `timestamp` is UNIX seconds.
 */
export const SettlementReceiptSchema = z.object({
  payer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  payee: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  resource: z.string().min(1).max(2048),
  amountAtomic: z.string().regex(/^\d+$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  network: z.string().min(1).max(64),
  txHash: z.string().regex(/^0x[0-9a-fA-F]+$/),
  timestamp: z.number().int().nonnegative(),
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  /** Seller's ERC-8004 agentId (uint256). 0 if not registered. */
  agentId: z.number().int().nonnegative(),
});
export type SettlementReceipt = z.infer<typeof SettlementReceiptSchema>;

/** EIP-712 typed-data primary type. */
export const SETTLEMENT_RECEIPT_PRIMARY_TYPE = 'SettlementReceipt';

/** EIP-712 typed-data struct definition. */
export const SETTLEMENT_RECEIPT_TYPES = {
  SettlementReceipt: [
    { name: 'payer', type: 'address' },
    { name: 'payee', type: 'address' },
    { name: 'resource', type: 'string' },
    { name: 'amountAtomic', type: 'uint256' },
    { name: 'asset', type: 'address' },
    { name: 'network', type: 'string' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'agentId', type: 'uint256' },
  ],
} as const;

/** Domain — the harness's own namespace. Versioned so future struct changes don't collide. */
export interface ReceiptDomain {
  name: string;
  version: string;
  chainId: number;
}

export const DEFAULT_RECEIPT_DOMAIN_NAME = 'frqncy-harness/SettlementReceipt';
export const DEFAULT_RECEIPT_DOMAIN_VERSION = '1';

// ────────────────────────────────────────────────────────────────────
// Sign
// ────────────────────────────────────────────────────────────────────

export interface SignSettlementReceiptOptions {
  signer: Signer;
  receipt: SettlementReceipt;
  /** Override the EIP-712 domain. Defaults to the harness's namespace + signer's chainId. */
  domain?: Partial<ReceiptDomain>;
}

export interface SignedSettlementReceipt {
  receipt: SettlementReceipt;
  signature: Hex;
  domain: ReceiptDomain;
}

/**
 * Sign a settlement receipt. Validates the receipt against the schema first
 * — never sign garbage. Returns the receipt + signature + the domain that
 * was used (so verifiers can reconstruct the typed-data exactly).
 */
export async function signSettlementReceipt(
  opts: SignSettlementReceiptOptions,
): Promise<SignedSettlementReceipt> {
  const receipt = SettlementReceiptSchema.parse(opts.receipt);

  // Pad txHash if it's shorter than 32 bytes (e.g. mocked test hashes).
  // bytes32 expects exactly 32 bytes; pad with trailing zeros.
  const paddedTxHash = padBytes32(receipt.txHash);

  // Resolve chain ID from the signer's network. We don't have a direct
  // accessor; for the receipt domain, default to a sentinel 0 if not pinned.
  // Callers can override via opts.domain.
  const domain: ReceiptDomain = {
    name: opts.domain?.name ?? DEFAULT_RECEIPT_DOMAIN_NAME,
    version: opts.domain?.version ?? DEFAULT_RECEIPT_DOMAIN_VERSION,
    chainId: opts.domain?.chainId ?? deriveChainId(opts.signer.network),
  };

  const signature = await opts.signer.signTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
    },
    types: SETTLEMENT_RECEIPT_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    primaryType: SETTLEMENT_RECEIPT_PRIMARY_TYPE,
    message: {
      payer: receipt.payer,
      payee: receipt.payee,
      resource: receipt.resource,
      amountAtomic: BigInt(receipt.amountAtomic),
      asset: receipt.asset,
      network: receipt.network,
      txHash: paddedTxHash,
      timestamp: BigInt(receipt.timestamp),
      nonce: receipt.nonce,
      agentId: BigInt(receipt.agentId),
    },
  });

  return { receipt, signature, domain };
}

// ────────────────────────────────────────────────────────────────────
// Verify
// ────────────────────────────────────────────────────────────────────

export interface VerifySettlementReceiptOptions {
  signed: SignedSettlementReceipt;
  /** When set, verify the recovered address matches this. */
  expectedSigner?: Address;
}

export interface VerifyResult {
  valid: boolean;
  recoveredAddress?: Address;
  reason?: string;
}

/**
 * Verify a signed receipt. Returns the recovered signer address (if EIP-712
 * verification succeeds) and whether it matches `expectedSigner` (if set).
 *
 * Requires viem as a peer dep — that's where `recoverTypedDataAddress` lives.
 * Falls back to `{ valid: false, reason: '...' }` if viem is unavailable.
 */
export async function verifySettlementReceipt(
  opts: VerifySettlementReceiptOptions,
): Promise<VerifyResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let viem: any;
  try {
    viem = await peerImport('viem');
  } catch {
    return {
      valid: false,
      reason: "viem peer dependency not installed; cannot verify receipt signatures",
    };
  }

  const parsed = SettlementReceiptSchema.safeParse(opts.signed.receipt);
  if (!parsed.success) {
    return { valid: false, reason: `invalid receipt: ${parsed.error.message}` };
  }
  const receipt = parsed.data;

  try {
    const recovered = (await viem.recoverTypedDataAddress({
      domain: {
        name: opts.signed.domain.name,
        version: opts.signed.domain.version,
        chainId: opts.signed.domain.chainId,
      },
      types: SETTLEMENT_RECEIPT_TYPES,
      primaryType: SETTLEMENT_RECEIPT_PRIMARY_TYPE,
      message: {
        payer: receipt.payer,
        payee: receipt.payee,
        resource: receipt.resource,
        amountAtomic: BigInt(receipt.amountAtomic),
        asset: receipt.asset,
        network: receipt.network,
        txHash: padBytes32(receipt.txHash),
        timestamp: BigInt(receipt.timestamp),
        nonce: receipt.nonce,
        agentId: BigInt(receipt.agentId),
      },
      signature: opts.signed.signature,
    })) as Address;

    if (opts.expectedSigner && recovered.toLowerCase() !== opts.expectedSigner.toLowerCase()) {
      return {
        valid: false,
        recoveredAddress: recovered,
        reason: `signer mismatch: recovered ${recovered}, expected ${opts.expectedSigner}`,
      };
    }
    return { valid: true, recoveredAddress: recovered };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Encode / decode for the X-RECEIPT header
// ────────────────────────────────────────────────────────────────────

/** Header name used to ship receipts back in HTTP responses. */
export const X402_RECEIPT_HEADER = 'X-RECEIPT';

/** base64-encode the signed receipt for transmission. */
export function encodeReceiptHeader(signed: SignedSettlementReceipt): string {
  return Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64');
}

/** base64-decode + Zod-validate. Throws on malformed input. */
export function decodeReceiptHeader(header: string): SignedSettlementReceipt {
  const json = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
  return {
    receipt: SettlementReceiptSchema.parse(json.receipt),
    signature: json.signature as Hex,
    domain: {
      name: String(json.domain?.name ?? DEFAULT_RECEIPT_DOMAIN_NAME),
      version: String(json.domain?.version ?? DEFAULT_RECEIPT_DOMAIN_VERSION),
      chainId: Number(json.domain?.chainId ?? 0),
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function deriveChainId(network: string): number {
  if (network === 'base') return 8453;
  if (network === 'base-sepolia') return 84532;
  return 0;
}

function padBytes32(hex: string): `0x${string}` {
  // Strip 0x, lowercase, and pad/truncate to 64 hex chars
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (stripped.length === 64) return `0x${stripped}` as `0x${string}`;
  if (stripped.length > 64) return `0x${stripped.slice(0, 64)}` as `0x${string}`;
  return `0x${stripped.padEnd(64, '0')}` as `0x${string}`;
}

// ────────────────────────────────────────────────────────────────────
// Receipt-issuer factory — wires into paymentMiddleware
// ────────────────────────────────────────────────────────────────────

export interface CreateReceiptIssuerOptions {
  signer: Signer;
  /** Seller's ERC-8004 agentId. 0 if not registered. */
  agentId?: number;
  /** Override domain. */
  domain?: Partial<ReceiptDomain>;
  /** Optional callback to capture every signed receipt (for the trace store). */
  onSigned?: (signed: SignedSettlementReceipt) => void | Promise<void>;
}

/**
 * Build a `receiptIssuer` callback shaped for the new
 * `PaymentMiddlewareOptions.receiptIssuer` slot. Returns a `{ name, value }`
 * pair the middleware sets as a response header.
 *
 * Returns null on signing failure — the route will still respond to the
 * customer (settlement already succeeded) but without a receipt header.
 */
export function createReceiptIssuer(
  opts: CreateReceiptIssuerOptions,
): (record: {
  direction: 'in';
  path: string;
  amountAtomic: string;
  asset: string;
  network: string;
  txHash?: string;
  payer?: string;
  payee: string;
  timestamp: string;
}) => Promise<{ name: string; value: string } | null> {
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto');
  return async (record) => {
    if (!record.payer || !record.txHash) return null;
    try {
      const receipt: SettlementReceipt = SettlementReceiptSchema.parse({
        payer: record.payer,
        payee: record.payee,
        resource: record.path,
        amountAtomic: record.amountAtomic,
        asset: record.asset,
        network: record.network,
        txHash: record.txHash,
        timestamp: Math.floor(Date.parse(record.timestamp) / 1000),
        nonce: '0x' + randomBytes(32).toString('hex'),
        agentId: opts.agentId ?? 0,
      });
      const signedOpts: SignSettlementReceiptOptions = { signer: opts.signer, receipt };
      if (opts.domain) signedOpts.domain = opts.domain;
      const signed = await signSettlementReceipt(signedOpts);
      if (opts.onSigned) await opts.onSigned(signed);
      return { name: X402_RECEIPT_HEADER, value: encodeReceiptHeader(signed) };
    } catch {
      // Signing failures must NEVER propagate to the customer — settlement
      // already happened and they're owed a response.
      return null;
    }
  };
}
