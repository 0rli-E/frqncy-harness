/**
 * `frqncy-harness serve` — turn the harness into a paid agent endpoint.
 *
 * Flag UX: --skill / --price pair up positionally so multiple skills can be
 * registered in one invocation. Examples:
 *
 *   frqncy-harness serve --skill weekly-update --price 0.25 --port 8080
 *
 *   frqncy-harness serve \
 *     --skill frqncy-editorial --price 0.05 \
 *     --skill weekly-update    --price 0.25
 *
 * Or via config (`config.serve.routes[]`):
 *
 *   frqncy-harness serve --port 8080
 *
 * Either source is valid; CLI flags merge ON TOP of config-defined routes.
 *
 * Per AGENT-AS-SERVICE design: each skill becomes a paid POST /skills/<name>
 * route, the harness's existing .well-known endpoints serve the agent card,
 * and inbound x402 settlements get logged as `payment` trace records (in
 * direction).
 */
import { randomUUID } from 'node:crypto';
import {
  createSigner,
  getNetworkInfo,
  resolveNetwork,
  type Network,
  type Address,
} from '../wallet/index.js';
import { createFacilitatorClient, createCdpFacilitatorAuth } from '../payments/facilitator.js';
import { loadSkills } from '../skills/index.js';
import { loadConfig } from '../config.js';
import {
  AgentCardSchema,
  withIdentity,
  withPayments as withPaymentsCard,
  withA2A,
  type AgentCard,
} from '../identity/agent-card.js';
import { formatAgentRegistry } from '../identity/agent-card.js';
import { serveAgent, type ServeRouteSpec } from '../serve/index.js';
import type { X402Network } from '../payments/index.js';

export interface ServeCommandOptions {
  port?: number;
  network?: Network;
  payTo?: Address;
  /**
   * Per-call mapping from skill name to USD-cents price. CLI flags populate
   * this; config-defined routes are merged in unless the flag also names them.
   */
  skillPrices?: Array<{ skill: string; priceUsdCents: number; model?: string }>;
  /** Override the default model for skill chat() calls. */
  model?: string;
  /** Don't register any new skills — serve only what's in config. */
  configOnly?: boolean;
  /** Pre-existing agentId to advertise on the served card. */
  agentId?: number;
}

export async function runServeCommand(opts: ServeCommandOptions = {}): Promise<void> {
  const config = await loadConfig();
  const network = opts.network ?? resolveNetwork();
  const info = getNetworkInfo(network);

  // 1) Resolve a Signer — needed for the receiver address default. The Signer
  // doesn't sign anything during serve (only the customer signs), but it
  // determines the default `payTo` (smart account preferred).
  let signer: Awaited<ReturnType<typeof createSigner>>;
  try {
    signer = await createSigner({ network });
  } catch (err) {
    throw new Error(
      `cannot start serve: wallet credentials missing — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const payTo = (opts.payTo ?? signer.smartAccount ?? signer.address) as Address;

  // 2) Load skills + merge route sources (config + CLI flags). CLI wins on
  // duplicate skill names so operators can override prices ad-hoc.
  const skills = await loadSkills();
  const configRoutes = config.serve?.routes ?? [];
  const cliRoutes: ServeRouteSpec[] = (opts.skillPrices ?? []).map((p) => {
    const r: ServeRouteSpec = { skill: p.skill, priceUsdCents: p.priceUsdCents };
    if (p.model) r.model = p.model as ServeRouteSpec['model'];
    return r;
  });

  const mergedMap = new Map<string, ServeRouteSpec>();
  if (!opts.configOnly) {
    for (const r of configRoutes) {
      const spec: ServeRouteSpec = {
        skill: r.skill,
        priceUsdCents: r.priceUsdCents,
      };
      if (r.model) spec.model = r.model as ServeRouteSpec['model'];
      if (r.path) spec.path = r.path;
      mergedMap.set(r.skill, spec);
    }
  }
  for (const r of cliRoutes) mergedMap.set(r.skill, r); // CLI overrides config
  const routes = Array.from(mergedMap.values());

  if (routes.length === 0) {
    throw new Error(
      'serve: no routes configured. Add --skill <name> --price <usd> flags, or populate `serve.routes[]` in ~/.frqncy-harness/config.json.',
    );
  }

  // 3) Facilitator client — same network as the rest of the harness.
  const facilitator = createFacilitatorClient({
    url: info.defaultFacilitatorUrl,
    ...(info.defaultFacilitatorUrl.includes('cdp.coinbase.com')
      ? { createAuthHeaders: createCdpFacilitatorAuth() }
      : {}),
  });

  // 4) Build the AgentCard. We don't call IdentityRegistry — serve is a pure
  // server-side concern; on-chain registration lives in `identity register`.
  // If the user registered earlier and provided --agent-id, we stamp it onto
  // the card so customers see the registry pointer in the .well-known JSON.
  const name = process.env.FRQNCY_AGENT_NAME ?? 'frqncy-harness';
  const description =
    process.env.FRQNCY_AGENT_DESCRIPTION ??
    `An x402-paid agent service powered by @frqncy-network/harness, exposing ${routes.length} skill(s).`;
  const domain = process.env.FRQNCY_AGENT_DOMAIN;
  const url = domain ? `https://${domain}` : undefined;

  let card: AgentCard = AgentCardSchema.parse({
    name,
    description,
    ...(url ? { url, endpoint: url } : {}),
    capabilities: { streaming: false },
  });
  if (opts.agentId !== undefined) {
    card = withIdentity(card, {
      agentId: opts.agentId,
      agentRegistry: formatAgentRegistry(info.chainId, info.identityRegistry),
    });
  }
  card = withPaymentsCard(card, { networks: [network] });
  card = withA2A(card, {});

  // 5) Trace context — the serve command runs as a long-lived process; we
  // mint one conversationId for the lifetime so all inbound settlements get
  // grouped (and so `pay history --thread <id>` shows them as a unit).
  const conversationId = randomUUID();
  const startedAt = new Date();

  // 6) Spin up the server.
  const port = opts.port ?? config.serve?.port ?? Number(process.env.FRQNCY_AGENT_PORT ?? 3030);
  const handle = await serveAgent({
    card,
    skills,
    routes,
    network: network as X402Network,
    usdcAddress: info.usdc,
    payTo,
    facilitator,
    ...(opts.model ?? config.serve?.defaultModel
      ? { defaultModel: (opts.model ?? config.serve?.defaultModel) as `${string}/${string}` }
      : {}),
    traceContext: { conversationId, startedAt },
    // v0.14.1 — sign verifiable settlement receipts on every paid call.
    // The signer we resolved earlier (for receiver address default) is the
    // same one we use to sign — its on-chain agentWallet binding (if set)
    // proves the receipt came from a real ERC-8004 agent.
    receipts: {
      signer,
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
    },
    port,
  });

  process.stderr.write(`\n[serve] listening at ${handle.url}\n`);
  process.stderr.write(`[serve]   network:    ${network} (chainId ${info.chainId})\n`);
  process.stderr.write(`[serve]   payTo:      ${payTo}\n`);
  process.stderr.write(`[serve]   facilitator: ${info.defaultFacilitatorUrl}\n`);
  process.stderr.write(`[serve]   conversation: ${conversationId}\n`);
  process.stderr.write(`[serve] mounted routes:\n`);
  for (const m of handle.mounted) {
    const priceLabel = m.paid
      ? `$${(m.priceUsdCents / 100).toFixed(2)}`
      : 'free';
    process.stderr.write(`[serve]   ${m.path}  ${priceLabel}  → skill: ${m.skill}\n`);
  }
  process.stderr.write(`[serve] also serving:\n`);
  process.stderr.write(`[serve]   GET /.well-known/agent-card.json\n`);
  process.stderr.write(`[serve]   GET /.well-known/agent-registration.json\n`);
  process.stderr.write(`[serve]   GET /healthz\n`);
  process.stderr.write(`[serve] (ctrl-c to stop)\n\n`);

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      process.stderr.write('\n[serve] shutting down...\n');
      handle.close().finally(() => resolve());
    });
    process.on('SIGTERM', () => {
      handle.close().finally(() => resolve());
    });
  });
}
