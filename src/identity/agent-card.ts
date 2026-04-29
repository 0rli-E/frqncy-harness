/**
 * AgentCard — the universal join key.
 *
 * One canonical AgentCard type, three composer functions:
 *   - withIdentity(card, identity)   → ERC-8004 registration metadata
 *   - withPayments(card, payments)   → x402 prices and supported networks
 *   - withA2A(card, a2a)             → A2A capability advertisement
 *
 * Pattern lifted directly from `@lucid-agents`: every extension is a pure
 * `(card, ctx) => card` enricher; the manifest is built by chaining them.
 *
 * Two artifacts get derived from the same AgentCard:
 *   1. `/.well-known/agent-card.json`           — the A2A AgentCard
 *   2. `/.well-known/agent-registration.json`   — the EIP-8004 registration
 *      file linked by the on-chain `tokenURI`
 *
 * The two are NOT the same JSON — they overlap. EIP-8004 v1 specifies a
 * specific registration-file shape; A2A specifies a different one. We keep an
 * AgentCard model that's a superset and serialize each format from it.
 */
import { z } from 'zod';
import { REGISTRATION_TYPE_V1 } from './abi.js';

// ────────────────────────────────────────────────────────────────────
// EIP-8004 registration file shape (verbatim from the spec)
// ────────────────────────────────────────────────────────────────────

export const Erc8004ServiceSchema = z.object({
  name: z.string(),
  endpoint: z.string(),
  version: z.string().optional(),
  /** Used by OASF entries — optional skill list. */
  skills: z.array(z.string()).optional(),
  /** Used by OASF entries — optional domain list. */
  domains: z.array(z.string()).optional(),
});
export type Erc8004Service = z.infer<typeof Erc8004ServiceSchema>;

export const Erc8004RegistrationEntrySchema = z.object({
  agentId: z.number().int().nonnegative(),
  /** CAIP-style: `{namespace}:{chainId}:{identityRegistry}` (e.g. `eip155:8453:0x8004...`). */
  agentRegistry: z.string(),
});
export type Erc8004RegistrationEntry = z.infer<typeof Erc8004RegistrationEntrySchema>;

/** Trust-model values per EIP-8004 spec. */
export const TRUST_MODELS = ['reputation', 'crypto-economic', 'tee-attestation'] as const;
export type TrustModel = (typeof TRUST_MODELS)[number];

export const Erc8004RegistrationFileSchema = z.object({
  type: z.literal(REGISTRATION_TYPE_V1).default(REGISTRATION_TYPE_V1),
  name: z.string(),
  description: z.string(),
  image: z.string().url().optional(),
  services: z.array(Erc8004ServiceSchema).default([]),
  x402Support: z.boolean().default(false),
  active: z.boolean().default(true),
  registrations: z.array(Erc8004RegistrationEntrySchema).default([]),
  supportedTrust: z.array(z.enum(TRUST_MODELS)).optional(),
});
export type Erc8004RegistrationFile = z.infer<typeof Erc8004RegistrationFileSchema>;

// ────────────────────────────────────────────────────────────────────
// AgentCard (A2A flavor, harness superset)
// ────────────────────────────────────────────────────────────────────

export const AgentCardSchema = z.object({
  /** A2A schema version — '0.3.0' is what Lucid Agents pins. */
  protocolVersion: z.string().default('0.3.0'),
  name: z.string(),
  description: z.string(),
  url: z.string().url().optional(),
  /** The agent's primary HTTPS endpoint (A2A invocations land here). */
  endpoint: z.string().url().optional(),
  iconUrl: z.string().url().optional(),
  /** Free-form provider info — Lucid uses this for the org name. */
  provider: z
    .object({
      organization: z.string().optional(),
      url: z.string().url().optional(),
    })
    .optional(),
  /** Free-form. EIP-8004 / A2A pile capabilities into here. */
  capabilities: z
    .object({
      streaming: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      stateTransitionHistory: z.boolean().optional(),
      /** A2A `extensions` array — declarative capability descriptors (AP2 etc.) */
      extensions: z
        .array(
          z.object({
            uri: z.string(),
            description: z.string().optional(),
            required: z.boolean().optional(),
            params: z.record(z.unknown()).optional(),
          }),
        )
        .optional(),
    })
    .default({}),
  /** A2A skills — free-form list of named capabilities. */
  skills: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        examples: z.array(z.string()).optional(),
        inputModes: z.array(z.string()).optional(),
        outputModes: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  /** Mirror of EIP-8004 `registrations[]`. */
  registrations: z.array(Erc8004RegistrationEntrySchema).optional(),
  /** Mirror of EIP-8004 `supportedTrust`. */
  trustModels: z.array(z.enum(TRUST_MODELS)).optional(),
  /** x402 — declared per-skill / per-resource pricing. */
  payments: z
    .object({
      x402: z
        .object({
          enabled: z.boolean().default(true),
          /** Networks the agent accepts payment on. */
          networks: z.array(z.string()).default([]),
          /** Default price per call in atomic USDC units (string of integer). */
          defaultPriceUsdcAtomic: z.string().optional(),
          /** Per-resource overrides; key is the URL path. */
          resources: z
            .record(
              z.object({
                priceUsdcAtomic: z.string(),
                description: z.string().optional(),
              }),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
export type AgentCard = z.infer<typeof AgentCardSchema>;

// ────────────────────────────────────────────────────────────────────
// Composers (pure (card, ctx) => card)
// ────────────────────────────────────────────────────────────────────

export interface IdentityCtx {
  agentId: number;
  agentRegistry: string;
  trustModels?: TrustModel[];
}

export function withIdentity(card: AgentCard, ctx: IdentityCtx): AgentCard {
  const next: AgentCard = {
    ...card,
    registrations: [...(card.registrations ?? []), { agentId: ctx.agentId, agentRegistry: ctx.agentRegistry }],
  };
  if (ctx.trustModels?.length) {
    next.trustModels = Array.from(new Set([...(card.trustModels ?? []), ...ctx.trustModels]));
  }
  return next;
}

export interface PaymentsCtx {
  networks: string[];
  defaultPriceUsdcAtomic?: string;
  resources?: Record<string, { priceUsdcAtomic: string; description?: string }>;
}

export function withPayments(card: AgentCard, ctx: PaymentsCtx): AgentCard {
  return {
    ...card,
    payments: {
      ...(card.payments ?? {}),
      x402: {
        enabled: true,
        networks: Array.from(new Set([...(card.payments?.x402?.networks ?? []), ...ctx.networks])),
        defaultPriceUsdcAtomic: ctx.defaultPriceUsdcAtomic ?? card.payments?.x402?.defaultPriceUsdcAtomic,
        resources: { ...(card.payments?.x402?.resources ?? {}), ...(ctx.resources ?? {}) },
      },
    },
  };
}

/** AP2 advertisement — copies the Lucid pattern verbatim. */
const AP2_EXTENSION_URI = 'https://github.com/google-agentic-commerce/AP2';

export interface A2aCtx {
  ap2Roles?: Array<'merchant' | 'shopper' | 'verifier' | 'auditor'>;
}

export function withA2A(card: AgentCard, ctx: A2aCtx = {}): AgentCard {
  if (!ctx.ap2Roles?.length) return card;
  const existing = card.capabilities?.extensions ?? [];
  const filtered = existing.filter((e) => e.uri !== AP2_EXTENSION_URI);
  return {
    ...card,
    capabilities: {
      ...card.capabilities,
      extensions: [
        ...filtered,
        {
          uri: AP2_EXTENSION_URI,
          description: 'Agent Payments Protocol (AP2)',
          required: ctx.ap2Roles.includes('merchant'),
          params: { roles: ctx.ap2Roles },
        },
      ],
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Serialization to the two well-known formats
// ────────────────────────────────────────────────────────────────────

/**
 * Serialize an AgentCard into the EIP-8004 v1 registration file (the JSON
 * the on-chain `tokenURI` should resolve to).
 */
export function toErc8004RegistrationFile(card: AgentCard): Erc8004RegistrationFile {
  const services: Erc8004Service[] = [];
  if (card.url) services.push({ name: 'web', endpoint: card.url });
  if (card.endpoint) {
    services.push({
      name: 'A2A',
      endpoint: card.endpoint.endsWith('/') ? `${card.endpoint}.well-known/agent-card.json` : `${card.endpoint}/.well-known/agent-card.json`,
      version: card.protocolVersion,
    });
  }
  return Erc8004RegistrationFileSchema.parse({
    type: REGISTRATION_TYPE_V1,
    name: card.name,
    description: card.description,
    image: card.iconUrl,
    services,
    x402Support: !!card.payments?.x402?.enabled,
    active: true,
    registrations: card.registrations ?? [],
    supportedTrust: card.trustModels,
  });
}

/**
 * Build the `/.well-known/agent-card.json` body — the A2A AgentCard. This is
 * just the card itself (less harness-only fields), serialized.
 */
export function toA2AAgentCard(card: AgentCard): AgentCard {
  // Currently the A2A card and our AgentCard are the same shape. Kept as a
  // separate function so future drift (when A2A bumps schema) stays local.
  return AgentCardSchema.parse(card);
}

/**
 * Build the `/.well-known/agent-registration.json` body for endpoint-domain
 * verification. Per spec: minimum body is just the `registrations` list.
 */
export function toAgentRegistrationProof(card: AgentCard): {
  registrations: Erc8004RegistrationEntry[];
} {
  return { registrations: card.registrations ?? [] };
}

/** Canonical CAIP-style agentRegistry string. */
export function formatAgentRegistry(chainId: number, identityRegistry: string): string {
  return `eip155:${chainId}:${identityRegistry}`;
}
