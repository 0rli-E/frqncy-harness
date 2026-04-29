/**
 * x402 v1 wire format — Zod schemas.
 *
 * Verbatim mirror of `coinbase/x402/typescript/packages/legacy/x402/src/types/verify/x402Specs.ts`,
 * stripped to the EVM `exact` scheme we ship today. The names and shapes are
 * intentionally identical to the canonical SDK so payloads we sign here
 * verify against any x402 v1 facilitator without translation.
 *
 * v2 (PAYMENT-SIGNATURE header, CAIP-2 networks) drops in by extending
 * `PaymentPayloadSchema.x402Version` to include `2` and adding a v2 envelope
 * around the same `payload`.
 */
import { z } from 'zod';

const HexEncoded64ByteRegex = /^0x[0-9a-fA-F]{64}$/;
const EvmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const EvmSignatureRegex = /^0x[0-9a-fA-F]+$/;

const isInteger = (s: string) => /^\d+$/.test(s);
const hasMaxLength = (max: number) => (s: string) => s.length <= max;
const EvmMaxAtomicUnits = 18; // uint256 → up to 78 digits, but x402 spec uses 18 for sanity

export const SCHEMES = ['exact'] as const;
export type Scheme = (typeof SCHEMES)[number];

/**
 * x402 network identifier strings (v1).
 * Mainnets we accept: base, polygon, avalanche.
 * Testnets: base-sepolia, polygon-amoy, avalanche-fuji.
 * The harness defaults to `base`; others are accepted to cover counterparties.
 */
export const NetworkSchema = z.enum([
  'base',
  'base-sepolia',
  'polygon',
  'polygon-amoy',
  'avalanche',
  'avalanche-fuji',
  'iotex',
  'sei',
  'sei-testnet',
]);
export type X402Network = z.infer<typeof NetworkSchema>;

// ────────────────────────────────────────────────────────────────────
// PaymentRequirements (sent by server in the 402 body)
// ────────────────────────────────────────────────────────────────────

export const PaymentRequirementsSchema = z.object({
  scheme: z.enum(SCHEMES),
  network: NetworkSchema,
  /** Atomic units (e.g. USDC has 6 decimals → "1000000" = $1.00). */
  maxAmountRequired: z.string().refine(isInteger, 'must be a non-negative integer string'),
  resource: z.string().url(),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.any()).optional(),
  payTo: z.string().regex(EvmAddressRegex),
  maxTimeoutSeconds: z.number().int().positive(),
  /** ERC-20 token contract that will pay (USDC on Base by default). */
  asset: z.string().regex(EvmAddressRegex),
  /** EIP-712 domain extras: { name, version } for the asset. */
  extra: z
    .object({
      name: z.string(),
      version: z.string(),
    })
    .passthrough()
    .optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

export const PaymentRequiredBodySchema = z.object({
  x402Version: z.literal(1),
  error: z.string(),
  accepts: z.array(PaymentRequirementsSchema),
});
export type PaymentRequiredBody = z.infer<typeof PaymentRequiredBodySchema>;

// ────────────────────────────────────────────────────────────────────
// PaymentPayload (sent by client in X-PAYMENT header)
// ────────────────────────────────────────────────────────────────────

export const ExactEvmPayloadAuthorizationSchema = z.object({
  from: z.string().regex(EvmAddressRegex),
  to: z.string().regex(EvmAddressRegex),
  value: z.string().refine(isInteger).refine(hasMaxLength(EvmMaxAtomicUnits)),
  validAfter: z.string().refine(isInteger),
  validBefore: z.string().refine(isInteger),
  nonce: z.string().regex(HexEncoded64ByteRegex),
});
export type ExactEvmPayloadAuthorization = z.infer<typeof ExactEvmPayloadAuthorizationSchema>;

export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(EvmSignatureRegex),
  authorization: ExactEvmPayloadAuthorizationSchema,
});
export type ExactEvmPayload = z.infer<typeof ExactEvmPayloadSchema>;

export const PaymentPayloadSchema = z.object({
  x402Version: z.literal(1),
  scheme: z.enum(SCHEMES),
  network: NetworkSchema,
  payload: ExactEvmPayloadSchema,
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

// ────────────────────────────────────────────────────────────────────
// SettleResponse (X-PAYMENT-RESPONSE header, base64'd JSON)
// ────────────────────────────────────────────────────────────────────

export const SettleResponseSchema = z.object({
  success: z.boolean(),
  /** ERC-20 transfer hash — empty string when success=false. */
  transaction: z.string(),
  network: NetworkSchema,
  payer: z.string().regex(EvmAddressRegex).optional(),
  errorReason: z.string().optional(),
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

// ────────────────────────────────────────────────────────────────────
// EIP-3009 typed-data structure — the load-bearing types
// ────────────────────────────────────────────────────────────────────

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export const TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE = 'TransferWithAuthorization';

// ────────────────────────────────────────────────────────────────────
// Header constants — ascii-only so they survive HTTP transports
// ────────────────────────────────────────────────────────────────────

export const X402_REQUEST_HEADER = 'X-PAYMENT';
export const X402_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

// ────────────────────────────────────────────────────────────────────
// Network → chain id (v1 string identifiers)
// ────────────────────────────────────────────────────────────────────

export const NETWORK_TO_CHAIN_ID: Record<X402Network, number> = {
  base: 8453,
  'base-sepolia': 84532,
  polygon: 137,
  'polygon-amoy': 80002,
  avalanche: 43114,
  'avalanche-fuji': 43113,
  iotex: 4689,
  sei: 1329,
  'sei-testnet': 1328,
};
