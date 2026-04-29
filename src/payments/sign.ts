/**
 * EIP-3009 TransferWithAuthorization signer.
 *
 * Builds the typed-data envelope that a USDC issuer (Circle) verifies on
 * `transferWithAuthorization`, signs it via the harness Signer, and returns
 * the full PaymentPayload ready for base64'ing into X-PAYMENT.
 *
 * Validity windows:
 *   - validAfter:  now - 600 seconds (clock-skew slack, matches reference SDK)
 *   - validBefore: now + maxTimeoutSeconds (from PaymentRequirements)
 * Nonce: 32 random bytes per call. EIP-3009 contracts inherently prevent
 * nonce reuse on-chain.
 */
import { randomBytes } from 'node:crypto';
import type { Signer } from '../wallet/index.js';
import {
  NETWORK_TO_CHAIN_ID,
  PaymentPayloadSchema,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type PaymentPayload,
  type PaymentRequirements,
} from './schemes.js';

export interface CreatePaymentOptions {
  signer: Signer;
  requirements: PaymentRequirements;
  /**
   * Override the `from` address. Defaults to `signer.address` (the EOA), which
   * is correct for USDC's ecrecover-based check. CDP smart-account holders
   * should keep the default — sign from the owner EOA.
   */
  from?: `0x${string}`;
  /** Override `now` for tests; epoch seconds. */
  nowSeconds?: number;
}

export async function createPaymentPayload(opts: CreatePaymentOptions): Promise<PaymentPayload> {
  const reqs = opts.requirements;
  const chainId = NETWORK_TO_CHAIN_ID[reqs.network];
  if (!chainId) throw new Error(`unsupported network in PaymentRequirements: ${reqs.network}`);

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const validAfter = (now - 600).toString();
  const validBefore = (now + reqs.maxTimeoutSeconds).toString();
  const nonce = `0x${randomBytes(32).toString('hex')}` as const;

  const from = opts.from ?? opts.signer.address;

  const message = {
    from,
    to: reqs.payTo as `0x${string}`,
    value: BigInt(reqs.maxAmountRequired),
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  // EIP-712 domain — `name` and `version` come from PaymentRequirements.extra.
  // Falls back to USDC's domain if extra is missing (older facilitators).
  const domain = {
    name: reqs.extra?.name ?? 'USD Coin',
    version: reqs.extra?.version ?? '2',
    chainId,
    verifyingContract: reqs.asset as `0x${string}`,
  };

  const signature = await opts.signer.signTypedData({
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<
      string,
      Array<{ name: string; type: string }>
    >,
    primaryType: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
    message,
  });

  return PaymentPayloadSchema.parse({
    x402Version: 1,
    scheme: reqs.scheme,
    network: reqs.network,
    payload: {
      signature,
      authorization: {
        from,
        to: reqs.payTo,
        value: reqs.maxAmountRequired,
        validAfter,
        validBefore,
        nonce,
      },
    },
  });
}

/**
 * Encode a PaymentPayload for the `X-PAYMENT` header. Per spec: base64(JSON).
 * BigInt values inside `message` would normally fail JSON.stringify; we don't
 * carry any — `value`/`validAfter`/`validBefore` are decimal strings already.
 */
export function encodePaymentHeader(payload: PaymentPayload): string {
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf-8').toString('base64');
}

export function decodePaymentHeader(header: string): PaymentPayload {
  const json = Buffer.from(header, 'base64').toString('utf-8');
  const parsed = JSON.parse(json);
  return PaymentPayloadSchema.parse(parsed);
}
