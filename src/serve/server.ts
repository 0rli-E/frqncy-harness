/**
 * Combined .well-known + paid skill HTTP server.
 *
 * Mounts:
 *   - /.well-known/agent-card.json          (A2A AgentCard)
 *   - /.well-known/agent-registration.json  (EIP-8004 registration proof)
 *   - /healthz                              (liveness)
 *   - /skills/<name>                        (POST, x402-paid via paymentMiddleware)
 *
 * Free routes (priceUsdCents === 0) bypass payment. Inbound payment trace
 * records are auto-written when traceContext is provided. Per AGENT-AS-SERVICE
 * decision 5.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  toA2AAgentCard,
  toAgentRegistrationProof,
  withPayments as withPaymentsCard,
  type AgentCard,
} from '../identity/agent-card.js';
import {
  paymentMiddleware,
  type FacilitatorClient,
  type PaywallRoute,
  type X402Network,
  type X402Middleware,
} from '../payments/index.js';
import {
  createInboundPaymentTraceWriter,
  type CreatePaymentTraceWriterOptions,
} from '../payments/trace.js';
import type { LoadedSkill } from '../skills/index.js';
import type { ModelString } from '../types.js';
import { createSkillRouteHandler } from './skill-route.js';

export interface ServeRouteSpec {
  /** Skill name (must exist in the supplied skills array). */
  skill: string;
  /** Price in USD cents. 0 = free (no payment middleware). */
  priceUsdCents: number;
  /** Per-route model override; falls back to the server-level default. */
  model?: ModelString;
  /** Override path; defaults to `/skills/<skill>`. */
  path?: string;
}

export interface ServeAgentOptions {
  /** AgentCard to publish at /.well-known/agent-card.json. */
  card: AgentCard;
  /** Skills available for monetization. Routes reference by name. */
  skills: LoadedSkill[];
  /** Routes to mount. Each maps a skill name to a price + (optional) path. */
  routes: ServeRouteSpec[];
  /** Network the harness accepts payments on. */
  network: X402Network;
  /** USDC contract for the network. */
  usdcAddress: `0x${string}`;
  /** Receiver address — settled USDC lands here. */
  payTo: `0x${string}`;
  /** Facilitator client (verify + settle). */
  facilitator: FacilitatorClient;
  /** Default model when no per-route override is set. */
  defaultModel?: ModelString;
  /** Optional inbound trace context — when set, paid calls append `payment` records. */
  traceContext?: CreatePaymentTraceWriterOptions;
  /**
   * v0.14.1 — sign verifiable settlement receipts on every paid call.
   * When `signer` is provided, each settled inbound payment produces an
   * EIP-712-signed SettlementReceipt that the response carries via the
   * X-RECEIPT header. Customers verify the signature against the seller's
   * on-chain agentWallet (ERC-8004) to prove the payment was acknowledged
   * by a real registered agent. `agentId` is the seller's id (0 if not
   * registered).
   */
  receipts?: {
    signer: import('../wallet/index.js').Signer;
    agentId?: number;
    /** Optional callback to capture each signed receipt (e.g. for the trace). */
    onSigned?: (signed: import('../payments/receipt.js').SignedSettlementReceipt) => void | Promise<void>;
  };
  /** Server bind options. */
  port?: number;
  host?: string;
  /** Optional OASF body for /.well-known/oasf-record.json. */
  oasf?: unknown;
  /** Optional logger — defaults to stderr. */
  log?: (msg: string) => void;
}

export interface ServingHandle {
  url: string;
  port: number;
  /** Routes that were actually mounted (post-validation). */
  mounted: Array<{ path: string; skill: string; priceUsdCents: number; paid: boolean }>;
  close(): Promise<void>;
}

export async function serveAgent(opts: ServeAgentOptions): Promise<ServingHandle> {
  const log = opts.log ?? ((msg) => process.stderr.write(`[serve] ${msg}\n`));
  const port = opts.port ?? Number(process.env.FRQNCY_AGENT_PORT ?? 3030);
  const host = opts.host ?? '0.0.0.0';

  // Derive the AgentCard with served prices populated so /.well-known reflects
  // what's mounted. Clean alignment with the EIP-8004 / A2A discovery flow.
  const skillByName = new Map(opts.skills.map((s) => [s.name, s] as const));
  const validRoutes = opts.routes.filter((r) => skillByName.has(r.skill));
  for (const r of opts.routes) {
    if (!skillByName.has(r.skill)) {
      log(`route skipped: skill '${r.skill}' not found in supplied skills`);
    }
  }

  // Stamp prices onto the card's payments.x402.resources block.
  const resources: Record<string, { priceUsdcAtomic: string; description?: string }> = {};
  for (const r of validRoutes) {
    if (r.priceUsdCents > 0) {
      const path = r.path ?? `/skills/${r.skill}`;
      resources[path] = {
        priceUsdcAtomic: usdCentsToUsdcAtomic(r.priceUsdCents).toString(),
        description: skillByName.get(r.skill)!.description,
      };
    }
  }
  const cardWithPrices: AgentCard =
    Object.keys(resources).length > 0
      ? withPaymentsCard(opts.card, { networks: [opts.network], resources })
      : opts.card;

  const a2aCardJson = JSON.stringify(toA2AAgentCard(cardWithPrices));
  const registrationJson = JSON.stringify(toAgentRegistrationProof(cardWithPrices));
  const oasfJson = opts.oasf ? JSON.stringify(opts.oasf) : null;

  // Build a (path → middleware?, handler) map. Free routes have no middleware.
  const inboundTraceFn = opts.traceContext
    ? createInboundPaymentTraceWriter(opts.traceContext)
    : undefined;

  // v0.14.1 — receipt issuer (one per server, shared across all paid routes).
  let receiptIssuerFn:
    | ((record: {
        direction: 'in';
        path: string;
        amountAtomic: string;
        asset: string;
        network: string;
        txHash?: string;
        payer?: string;
        payee: string;
        timestamp: string;
      }) => Promise<{ name: string; value: string } | null>)
    | undefined;
  if (opts.receipts) {
    const { createReceiptIssuer } = await import('../payments/receipt.js');
    const issuerOpts: {
      signer: typeof opts.receipts.signer;
      agentId?: number;
      onSigned?: (signed: import('../payments/receipt.js').SignedSettlementReceipt) => void | Promise<void>;
    } = { signer: opts.receipts.signer };
    if (opts.receipts.agentId !== undefined) issuerOpts.agentId = opts.receipts.agentId;
    if (opts.receipts.onSigned) issuerOpts.onSigned = opts.receipts.onSigned;
    receiptIssuerFn = createReceiptIssuer(issuerOpts);
  }

  const handlers = new Map<
    string,
    {
      middleware?: X402Middleware;
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
      info: { skill: string; priceUsdCents: number; paid: boolean };
    }
  >();

  const mounted: ServingHandle['mounted'] = [];
  for (const r of validRoutes) {
    const path = r.path ?? `/skills/${r.skill}`;
    const skill = skillByName.get(r.skill)!;
    const handler = createSkillRouteHandler({
      skill,
      ...(r.model ?? opts.defaultModel ? { model: (r.model ?? opts.defaultModel) as ModelString } : {}),
    });
    const paid = r.priceUsdCents > 0;
    const route: { middleware?: X402Middleware; handler: typeof handler; info: { skill: string; priceUsdCents: number; paid: boolean } } = {
      handler,
      info: { skill: r.skill, priceUsdCents: r.priceUsdCents, paid },
    };
    if (paid) {
      const paywallRoute: PaywallRoute = {
        scheme: 'exact',
        network: opts.network,
        priceUsd: r.priceUsdCents / 100,
        asset: opts.usdcAddress,
        payTo: opts.payTo,
        description: skill.description,
        mimeType: 'application/json',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      };
      route.middleware = paymentMiddleware({
        routes: { [path]: paywallRoute },
        facilitator: opts.facilitator,
        ...(inboundTraceFn ? { onPayment: inboundTraceFn } : {}),
        ...(receiptIssuerFn
          ? { receiptIssuer: receiptIssuerFn as Parameters<typeof paymentMiddleware>[0]['receiptIssuer'] }
          : {}),
      });
    }
    handlers.set(path, route);
    mounted.push({ path, skill: r.skill, priceUsdCents: r.priceUsdCents, paid });
  }

  const server: Server = createServer(async (req, res) => {
    const url = req.url ?? '/';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT');
    res.setHeader('Access-Control-Expose-Headers', 'X-PAYMENT-RESPONSE, X-RECEIPT');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // .well-known + healthz
    if (url === '/.well-known/agent-card.json' || url === '/agent-card') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(a2aCardJson);
      return;
    }
    if (url === '/.well-known/agent-registration.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(registrationJson);
      return;
    }
    if (url === '/.well-known/oasf-record.json' && oasfJson) {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=60',
      });
      res.end(oasfJson);
      return;
    }
    if (url === '/healthz' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', mounted: mounted.length }));
      return;
    }

    // Skill routes
    const path = url.split('?')[0] ?? '/';
    const route = handlers.get(path);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'not_found', path }));
      return;
    }

    try {
      if (route.middleware) {
        // x402 gate. Middleware writes the 402 response itself if payment is
        // missing/invalid; only calls next() on a valid + settled payment.
        let nextCalled = false;
        await route.middleware(req, res, async () => {
          nextCalled = true;
          await route.handler(req, res);
        });
        if (!nextCalled && !res.writableEnded) {
          // Defensive: middleware should have closed the response.
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'middleware_did_not_complete' }));
        }
      } else {
        await route.handler(req, res);
      }
    } catch (err) {
      log(`route ${path} error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'route_error',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${boundPort}`;

  return {
    url,
    port: boundPort,
    mounted,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function usdCentsToUsdcAtomic(cents: number): bigint {
  // 1 cent = 0.01 USD, USDC has 6 decimals → 1 cent = 10000 atomic
  return BigInt(cents) * BigInt(10000);
}
