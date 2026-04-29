/**
 * x402 facilitator HTTP client.
 *
 * Two roles, same surface:
 *   - The *server* (paymentMiddleware) calls `verify(payload, requirements)`
 *     before running its handler, then `settle(...)` after.
 *   - The *client* (x402Fetch) doesn't usually call the facilitator directly —
 *     the resource server handles verify + settle. But when the harness is
 *     itself a resource server, it uses these.
 *
 * Default URL is the network's `defaultFacilitatorUrl` from the wallet
 * module:
 *   - Base mainnet → CDP (https://api.cdp.coinbase.com/platform/v2/x402)
 *   - Base Sepolia → public facilitator (https://x402.org/facilitator)
 *
 * For CDP we mint a per-request JWT via `@coinbase/cdp-sdk`'s `generateJwt` —
 * lazy-imported so non-CDP users don't need it.
 */
import {
  PaymentPayloadSchema,
  PaymentRequirementsSchema,
  SettleResponseSchema,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from './schemes.js';

export interface FacilitatorConfig {
  url: string;
  /** If set, called per request to add auth headers (e.g. CDP JWT). */
  createAuthHeaders?: (request: {
    method: 'GET' | 'POST';
    path: string;
  }) => Promise<Record<string, string>> | Record<string, string>;
  /** Override fetch impl for testing. */
  fetchImpl?: typeof fetch;
}

export interface VerifyResult {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
}

export interface DiscoveredResource {
  resource: string;
  type: 'http';
  x402Version: number;
  accepts: PaymentRequirements[];
  lastUpdated: number;
  metadata?: Record<string, unknown>;
}

export interface FacilitatorClient {
  verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResult>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
  supported(): Promise<{ kinds: Array<{ x402Version: number; scheme: string; network: string }> }>;
  discover(opts?: { limit?: number; offset?: number; type?: string }): Promise<{
    items: DiscoveredResource[];
    pagination: { limit: number; offset: number; total: number };
  }>;
}

export function createFacilitatorClient(config: FacilitatorConfig): FacilitatorClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = config.url.replace(/\/+$/, ''); // strip trailing slashes

  async function post<T>(path: string, body: unknown, schema: { parse(x: unknown): T }): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.createAuthHeaders) {
      Object.assign(headers, await config.createAuthHeaders({ method: 'POST', path }));
    }
    const res = await fetchImpl(`${url}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`facilitator ${path} failed (${res.status}): ${text || res.statusText}`);
    }
    const json = await res.json();
    return schema.parse(json);
  }

  async function get<T>(path: string, schema: { parse(x: unknown): T }): Promise<T> {
    const headers: Record<string, string> = {};
    if (config.createAuthHeaders) {
      Object.assign(headers, await config.createAuthHeaders({ method: 'GET', path }));
    }
    const res = await fetchImpl(`${url}${path}`, { method: 'GET', headers });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`facilitator ${path} failed (${res.status}): ${text || res.statusText}`);
    }
    const json = await res.json();
    return schema.parse(json);
  }

  return {
    async verify(payload, requirements) {
      const body = {
        x402Version: payload.x402Version,
        paymentPayload: PaymentPayloadSchema.parse(payload),
        paymentRequirements: PaymentRequirementsSchema.parse(requirements),
      };
      // The facilitator's `verify` body shape is not deeply structured; we
      // accept anything and parse to our minimal expected shape.
      return post('/verify', body, {
        parse: (x: unknown): VerifyResult => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const o = x as any;
          return {
            isValid: !!o?.isValid,
            payer: typeof o?.payer === 'string' ? o.payer : undefined,
            invalidReason: typeof o?.invalidReason === 'string' ? o.invalidReason : undefined,
          };
        },
      });
    },

    async settle(payload, requirements) {
      const body = {
        x402Version: payload.x402Version,
        paymentPayload: PaymentPayloadSchema.parse(payload),
        paymentRequirements: PaymentRequirementsSchema.parse(requirements),
      };
      return post('/settle', body, SettleResponseSchema);
    },

    async supported() {
      return get('/supported', {
        parse: (x: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const o = x as any;
          return { kinds: Array.isArray(o?.kinds) ? o.kinds : [] };
        },
      });
    },

    async discover(opts = {}) {
      const params = new URLSearchParams();
      params.set('type', opts.type ?? 'http');
      if (opts.limit !== undefined) params.set('limit', String(opts.limit));
      if (opts.offset !== undefined) params.set('offset', String(opts.offset));
      return get(`/discovery/resources?${params.toString()}`, {
        parse: (x: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const o = x as any;
          return {
            items: Array.isArray(o?.items) ? o.items : [],
            pagination: {
              limit: Number(o?.pagination?.limit ?? 0),
              offset: Number(o?.pagination?.offset ?? 0),
              total: Number(o?.pagination?.total ?? 0),
            },
          };
        },
      });
    },
  };
}

/**
 * Build a `createAuthHeaders` for the Coinbase CDP facilitator. Lazy-imports
 * `@coinbase/cdp-sdk` so non-CDP setups don't pay for it.
 *
 * Reads CDP_API_KEY_ID / CDP_API_KEY_SECRET from env or accepts them inline.
 */
export function createCdpFacilitatorAuth(opts?: {
  apiKeyId?: string;
  apiKeySecret?: string;
}): (request: { method: 'GET' | 'POST'; path: string }) => Promise<Record<string, string>> {
  return async (request) => {
    const apiKeyId = opts?.apiKeyId ?? process.env.CDP_API_KEY_ID;
    const apiKeySecret = opts?.apiKeySecret ?? process.env.CDP_API_KEY_SECRET;
    if (!apiKeyId || !apiKeySecret) {
      throw new Error(
        'CDP facilitator auth requires CDP_API_KEY_ID and CDP_API_KEY_SECRET. ' +
          'Either set them or switch facilitator URL to a non-CDP endpoint.',
      );
    }
    // Lazy-import to keep cdp-sdk a peer dep for non-CDP users
    const { peerImport } = await import('../wallet/peerimport.js');
    let mod: { generateJwt?: unknown } = {};
    try {
      mod = await peerImport<{ generateJwt?: unknown }>('@coinbase/cdp-sdk/auth');
    } catch {
      try {
        mod = await peerImport<{ generateJwt?: unknown }>('@coinbase/cdp-sdk');
      } catch {
        throw new Error('Cannot load @coinbase/cdp-sdk for facilitator JWT signing.');
      }
    }
    const generateJwt = (mod as { generateJwt?: (cfg: unknown) => Promise<string> }).generateJwt;
    if (!generateJwt) throw new Error('@coinbase/cdp-sdk: generateJwt not available');

    const cdpUrl = new URL('https://api.cdp.coinbase.com');
    const jwt = await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: request.method,
      requestHost: cdpUrl.host,
      requestPath: `/platform/v2/x402${request.path}`,
    });
    return {
      Authorization: `Bearer ${jwt}`,
      'Correlation-Context':
        'sdk_version=harness,sdk_language=typescript,source=x402,sdk_runtime=node',
    };
  };
}
