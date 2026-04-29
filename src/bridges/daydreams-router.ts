/**
 * Daydreams Router (`ai.xgate.run`) — x402-paid OpenAI-compatible inference.
 *
 * Why this matters: a single CDP wallet + ERC-2612 USDC permit gives the
 * harness instant access to Anthropic Opus 4.6, GPT-5, Kimi K2.5, Flux 2,
 * Kling, etc. — no API keys per provider, just one signed permit that opens
 * an "upto" session (Daydreams' multi-request batching).
 *
 * This module provides three things:
 *   1. `createDaydreamsRouterFetch(...)` — a `fetch` wrapper that handles
 *      the 402 → permit → retry handshake and reuses sessions via the
 *      `X-Upto-Session` header.
 *   2. `daydreamsRouterChat(...)` — a thin client for `/v1/chat/completions`
 *      that uses the wrapped fetch. Returns the raw JSON.
 *   3. `daydreamsRouterModels(...)` — read `/v1/models` (free endpoint).
 *
 * We intentionally do NOT register `daydreams-router/*` as a model lane in
 * the existing `parseModelString` (yet) — that would require AI SDK
 * provider plumbing that's a separate concern. Instead callers can use
 * `daydreamsRouterChat` directly, or pass `createDaydreamsRouterFetch` into
 * any AI SDK `openai()` provider's `fetch` option to drop it in.
 *
 * SECURITY: the permit signs over a value cap. We default to a conservative
 * 1.00 USDC cap with a 1-hour deadline. Callers should pass their own caps
 * when running unattended.
 */
import { signPermit, encodePermitHeader, type EncodedPermitPayload } from '../payments/permit.js';
import { getNetworkInfo, type Network, type Signer, type Address, type Hex } from '../wallet/index.js';

export const DEFAULT_DAYDREAMS_ROUTER_URL = 'https://ai.xgate.run';
export const DAYDREAMS_PAYMENT_HEADER = 'PAYMENT-SIGNATURE';
export const DAYDREAMS_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const DAYDREAMS_SESSION_HEADER = 'X-Upto-Session';

export interface CreateDaydreamsRouterFetchOptions {
  signer: Signer;
  /** Network the USDC permit is signed over. Defaults to signer.network. */
  network?: Network;
  /** Atomic-USDC permit cap (max spend per session). Default: 1_000_000 = 1 USDC. */
  permitCapAtomic?: bigint;
  /** Permit deadline as seconds from now. Default: 3600 (1 hour). */
  permitDeadlineSeconds?: number;
  /** Override base URL — useful for self-hosted forks. */
  baseUrl?: string;
  /** Override fetch (for tests). */
  baseFetch?: typeof fetch;
  /**
   * Callback called whenever a new permit is signed. Useful for trace
   * recording — we route this through the harness's standard `payment` trace
   * record path.
   */
  onPermitSigned?: (info: {
    network: Network;
    capAtomic: bigint;
    deadline: bigint;
    spender: Address;
    asset: Address;
  }) => void | Promise<void>;
  /**
   * Optional override for nonce lookup. Defaults to reading `nonces(owner)`
   * via viem at the USDC contract. Tests inject this to skip the chain hop.
   */
  fetchNonce?: (owner: Address, asset: Address, network: Network) => Promise<bigint>;
}

interface SessionState {
  permitHeader: string;
  sessionId: string | null;
  capAtomic: bigint;
  deadline: bigint;
}

/**
 * Returns a `fetch` that handles the Daydreams Router 402-permit-retry flow.
 * Each opener-session (cap + deadline) is cached in-memory. When the router
 * issues an `X-Upto-Session` id, we attach it to subsequent requests so spend
 * accumulates under one settlement instead of one settlement per request.
 */
export function createDaydreamsRouterFetch(opts: CreateDaydreamsRouterFetchOptions): typeof fetch {
  const baseFetch = opts.baseFetch ?? fetch;
  const network = opts.network ?? opts.signer.network;
  const info = getNetworkInfo(network);
  const capAtomic = opts.permitCapAtomic ?? 1_000_000n; // 1.00 USDC
  const deadlineSeconds = opts.permitDeadlineSeconds ?? 3600;
  const baseUrl = (opts.baseUrl ?? DEFAULT_DAYDREAMS_ROUTER_URL).replace(/\/+$/, '');

  // One session per cap+deadline combo. Renew when expired.
  let session: SessionState | null = null;

  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    // Free-tier endpoints (e.g. /v1/models, /v1/config) — try without payment first
    const isFreeEndpoint =
      url.includes('/v1/models') || url.includes('/v1/config') || url.includes('/openapi.json');

    const tryOnce = async (withPayment: boolean): Promise<Response> => {
      const headers = new Headers(init?.headers);
      if (withPayment && session) {
        headers.set(DAYDREAMS_PAYMENT_HEADER, session.permitHeader);
        if (session.sessionId) headers.set(DAYDREAMS_SESSION_HEADER, session.sessionId);
      }
      const res = await baseFetch(input, { ...init, headers });
      // Capture session id if the router minted one
      if (session && !session.sessionId) {
        const sid = res.headers.get(DAYDREAMS_SESSION_HEADER);
        if (sid) session.sessionId = sid;
      }
      return res;
    };

    // First attempt — with payment if we already have a session, without if free endpoint.
    let res = await tryOnce(!isFreeEndpoint && session !== null && session.deadline > now() + 30n);

    if (res.status === 402) {
      // Sign a fresh permit (or rotate if expired) and retry.
      session = await openSession({
        signer: opts.signer,
        network,
        info,
        capAtomic,
        deadlineSeconds,
        baseUrl,
        fetchNonce: opts.fetchNonce,
      });
      if (opts.onPermitSigned) {
        await opts.onPermitSigned({
          network,
          capAtomic,
          deadline: session.deadline,
          spender: deriveSpender(baseUrl),
          asset: info.usdc,
        });
      }
      res = await tryOnce(true);
    }

    return res;
  };

  return wrapped;
}

/**
 * The Daydreams Router doesn't publish the `spender` in the SKILL.md (the
 * client typically reads it from the 402's PAYMENT-REQUIRED header). For the
 * pre-signing path (no 402 yet) we infer a spender from the base URL via a
 * tiny lookup table — fall back to a zero address if unknown so the router
 * will reject the permit and re-issue with the right spender.
 *
 * In production the spender comes from the 402 challenge; this helper only
 * matters when opening a session before any request. We always re-fetch the
 * 402 challenge if the spender is unknown.
 */
function deriveSpender(baseUrl: string): Address {
  // Known mainnet spender for ai.xgate.run (placeholder — the harness reads
  // the actual spender from the 402 challenge in `openSession` below).
  const KNOWN_SPENDERS: Record<string, Address> = {};
  return (KNOWN_SPENDERS[baseUrl] ?? '0x0000000000000000000000000000000000000000') as Address;
}

interface OpenSessionInput {
  signer: Signer;
  network: Network;
  info: ReturnType<typeof getNetworkInfo>;
  capAtomic: bigint;
  deadlineSeconds: number;
  baseUrl: string;
  fetchNonce?: CreateDaydreamsRouterFetchOptions['fetchNonce'];
}

async function openSession(input: OpenSessionInput): Promise<SessionState> {
  // Fetch the actual spender + recommended cap from a probe 402.
  // Some routers serve a 402 on /v1/config when no session is present; if not,
  // we fall back to /v1/chat/completions with a cheap probe body.
  const probe = await fetchPaymentChallenge(input.baseUrl);

  const spender = (probe.spender ?? deriveSpender(input.baseUrl)) as Address;
  const owner = input.signer.address;
  const nonceFn = input.fetchNonce ?? defaultFetchNonce;
  const nonce = await nonceFn(owner, input.info.usdc, input.network);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + input.deadlineSeconds);

  const signed = await signPermit({
    signer: input.signer,
    asset: input.info.usdc,
    tokenName: input.info.usdcName,
    tokenVersion: input.info.usdcVersion,
    chainId: input.info.chainId,
    message: {
      owner,
      spender,
      value: input.capAtomic,
      nonce,
      deadline,
    },
  });

  const payload: EncodedPermitPayload = {
    scheme: 'permit',
    network: input.network,
    asset: input.info.usdc,
    owner,
    spender,
    value: input.capAtomic.toString(),
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature: signed.signature,
    v: signed.v,
    r: signed.r,
    s: signed.s,
  };

  return {
    permitHeader: encodePermitHeader(payload),
    sessionId: null,
    capAtomic: input.capAtomic,
    deadline,
  };
}

interface PaymentChallenge {
  spender?: string;
  recommendedCap?: bigint;
}

async function fetchPaymentChallenge(baseUrl: string): Promise<PaymentChallenge> {
  // Probe /v1/config or /v1/chat/completions to read the PAYMENT-REQUIRED
  // header. Best-effort; on failure the caller falls back to deriveSpender().
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'probe' }] }),
    });
    if (res.status !== 402) return {};
    const header = res.headers.get(DAYDREAMS_REQUIRED_HEADER);
    if (!header) {
      // Some routers put requirements in body
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any;
        return { spender: body?.payTo ?? body?.spender };
      } catch {
        return {};
      }
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8')) as any;
      return { spender: decoded?.spender ?? decoded?.payTo };
    } catch {
      return {};
    }
  } catch {
    return {};
  }
}

async function defaultFetchNonce(owner: Address, asset: Address, network: Network): Promise<bigint> {
  // Read `nonces(address)` from the ERC-20 (USDC supports it on Base).
  const { peerImport } = await import('../wallet/peerimport.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viem: any = await peerImport('viem');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chains: any = await peerImport('viem/chains').catch(() => ({}));
  const info = getNetworkInfo(network);
  const chain = network === 'base' ? chains.base : chains.baseSepolia;
  const pc = viem.createPublicClient({ chain, transport: viem.http(info.rpcUrl) });
  const abi = [
    {
      type: 'function',
      name: 'nonces',
      stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ];
  return (await pc.readContract({ address: asset, abi, functionName: 'nonces', args: [owner] })) as bigint;
}

function now(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

// ────────────────────────────────────────────────────────────────────
// Convenience clients
// ────────────────────────────────────────────────────────────────────

export interface DaydreamsRouterChatRequest {
  /** Daydreams uses `provider:model` (e.g. "anthropic:claude-sonnet-4-6") or "auto". */
  model: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: any; name?: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface DaydreamsRouterChatResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  selectedModel?: string;
  tier?: string;
  routed: boolean;
}

/**
 * One-shot chat completion via Daydreams Router.
 *
 * For streaming, use `createDaydreamsRouterFetch` directly with `stream: true`
 * and parse the SSE response yourself — same shape as OpenAI's streaming.
 */
export async function daydreamsRouterChat(
  fetchImpl: typeof fetch,
  request: DaydreamsRouterChatRequest,
  baseUrl: string = DEFAULT_DAYDREAMS_ROUTER_URL,
): Promise<DaydreamsRouterChatResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return {
    status: res.status,
    body,
    selectedModel: res.headers.get('X-Router-Selected-Model') ?? undefined,
    tier: res.headers.get('X-Router-Tier') ?? undefined,
    routed: res.headers.get('X-Router-Routed') === 'true',
  };
}

/**
 * List models advertised by the router. Free endpoint — no permit required.
 */
export async function daydreamsRouterModels(
  baseUrl: string = DEFAULT_DAYDREAMS_ROUTER_URL,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetchImpl: typeof fetch = fetch,
): Promise<{
  data: Array<{
    id: string;
    object: string;
    pricing?: {
      input_per_1m?: number;
      output_per_1m?: number;
      cache_read_per_1m?: number;
      cache_write_per_1m?: number;
    };
    [key: string]: unknown;
  }>;
}> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/models`, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`daydreamsRouterModels: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as { data: Array<{ id: string; object: string }> };
}

// Re-export Hex type for convenience
export type { Hex };
