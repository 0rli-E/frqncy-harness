/**
 * x402 server middleware — node:http style.
 *
 * Monetizes endpoints the harness serves. Same surface as `x402-express`'s
 * `paymentMiddleware` and `x402-hono`'s, framework-free so the harness can
 * mount it on its own minimal HTTP server (`identity/serve.ts`) or any
 * standard Node `(req, res, next)` stack.
 *
 * Flow:
 *   1. Request arrives without `X-PAYMENT` → respond 402 + accepts list.
 *   2. Request arrives with `X-PAYMENT` → decode, call `facilitator.verify`.
 *      - On invalid: 402 again with diagnostic.
 *      - On valid:   call `next()` (run handler), then call `facilitator.settle`,
 *        set `X-PAYMENT-RESPONSE` header on the response.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PaymentRequirementsSchema,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
  type PaymentRequirements,
  type X402Network,
} from './schemes.js';
import { decodePaymentHeader } from './sign.js';
import type { FacilitatorClient } from './facilitator.js';

export interface PaywallRoute {
  /**
   * Full PaymentRequirements minus what the middleware fills in (`resource`,
   * which is the request URL, plus a default `mimeType`/`description` if
   * not given).
   */
  scheme?: 'exact';
  network: X402Network;
  /**
   * Atomic-units price (string of integer). Either this or `priceUsd` is
   * required.
   */
  maxAmountRequired?: string;
  /** Convenience: USD as a number; converted to atomic USDC (6 decimals). */
  priceUsd?: number;
  asset: `0x${string}`;
  payTo: `0x${string}`;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: { name: string; version: string };
}

export interface PaymentMiddlewareOptions {
  /** Map from request path (exact match) to PaywallRoute. */
  routes: Record<string, PaywallRoute>;
  facilitator: FacilitatorClient;
  /** Receiver address used when a route doesn't specify `payTo`. */
  defaultPayTo?: `0x${string}`;
  /** Callback for inbound payment trace records. */
  onPayment?: (record: {
    direction: 'in';
    path: string;
    requirements: PaymentRequirements;
    amountAtomic: string;
    asset: string;
    network: X402Network;
    txHash?: string;
    payer?: string;
    payee: string;
    timestamp: string;
  }) => void | Promise<void>;
}

export type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => Promise<void> | void,
) => Promise<void>;

export function paymentMiddleware(opts: PaymentMiddlewareOptions): Middleware {
  return async (req, res, next) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const route = opts.routes[path];
    if (!route) {
      // Not a paid route — pass through
      await next();
      return;
    }

    const requirements = buildRequirements(route, path, req, opts.defaultPayTo);

    const headerName = X402_REQUEST_HEADER.toLowerCase();
    const header = req.headers[headerName];
    if (!header || typeof header !== 'string') {
      respondWith402(res, [requirements], 'X-PAYMENT header is required');
      return;
    }

    let payload;
    try {
      payload = decodePaymentHeader(header);
    } catch (err) {
      respondWith402(res, [requirements], `invalid X-PAYMENT header: ${(err as Error).message}`);
      return;
    }

    // Verify with facilitator
    let verifyResult;
    try {
      verifyResult = await opts.facilitator.verify(payload, requirements);
    } catch (err) {
      respondWith402(res, [requirements], `verify failed: ${(err as Error).message}`);
      return;
    }
    if (!verifyResult.isValid) {
      respondWith402(
        res,
        [requirements],
        `invalid payment: ${verifyResult.invalidReason ?? 'unknown'}`,
      );
      return;
    }

    // Run the handler — when it finishes, settle.
    // We can't reliably hook into res.end across all stacks, so we settle
    // *before* calling next() and set the header. This is a small UX
    // simplification at the cost of double-settling protection on the
    // server's part (idempotent at the facilitator).
    let settled;
    try {
      settled = await opts.facilitator.settle(payload, requirements);
    } catch (err) {
      respondWith402(res, [requirements], `settle failed: ${(err as Error).message}`);
      return;
    }
    if (!settled.success) {
      respondWith402(res, [requirements], `settle failed: ${settled.errorReason ?? 'unknown'}`);
      return;
    }

    // Set X-PAYMENT-RESPONSE header before the handler runs so it's emitted
    // even if the handler streams the body.
    res.setHeader(
      X402_RESPONSE_HEADER,
      Buffer.from(JSON.stringify(settled), 'utf-8').toString('base64'),
    );

    if (opts.onPayment) {
      await opts.onPayment({
        direction: 'in',
        path,
        requirements,
        amountAtomic: requirements.maxAmountRequired,
        asset: requirements.asset,
        network: requirements.network,
        txHash: settled.transaction,
        payer: settled.payer ?? verifyResult.payer ?? payload.payload.authorization.from,
        payee: requirements.payTo,
        timestamp: new Date().toISOString(),
      });
    }

    await next();
  };
}

function buildRequirements(
  route: PaywallRoute,
  path: string,
  req: IncomingMessage,
  defaultPayTo?: `0x${string}`,
): PaymentRequirements {
  const maxAmountRequired =
    route.maxAmountRequired ??
    (route.priceUsd !== undefined
      ? Math.round(route.priceUsd * 1_000_000).toString()
      : undefined);
  if (!maxAmountRequired) {
    throw new Error(`route ${path} has neither maxAmountRequired nor priceUsd set`);
  }
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'http';
  const resource = `${proto}://${host}${path}`;
  return PaymentRequirementsSchema.parse({
    scheme: route.scheme ?? 'exact',
    network: route.network,
    maxAmountRequired,
    resource,
    description: route.description ?? `Access to ${path}`,
    mimeType: route.mimeType ?? 'application/json',
    payTo: route.payTo ?? defaultPayTo,
    maxTimeoutSeconds: route.maxTimeoutSeconds ?? 60,
    asset: route.asset,
    extra: route.extra ?? { name: 'USD Coin', version: '2' },
  });
}

function respondWith402(res: ServerResponse, accepts: PaymentRequirements[], error: string): void {
  res.writeHead(402, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      x402Version: 1,
      error,
      accepts,
    }),
  );
}
