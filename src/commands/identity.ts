/**
 * `frqncy-harness identity <subcmd>` — ERC-8004 identity commands.
 *
 *   register [--domain <d>] [--network base|base-sepolia] [--upload-to <path>]
 *     Register the agent on-chain. Reads name/description/url from
 *     ~/.frqncy-harness/config.json (or the inline flags). Prints the
 *     resulting agentId + agentRegistry. If --upload-to is given, writes the
 *     registration JSON to that path so you can serve it under
 *     /.well-known/agent-registration.json.
 *
 *   whoami
 *     Print the agent's identity: agentId (if registered), owner address,
 *     smart-account address (CDP), bound agentWallet (if any), and the JSON
 *     of the AgentCard the harness would publish.
 *
 *   card [--out <path>]
 *     Render the AgentCard locally to stdout or `--out`. No network calls.
 *
 *   serve [--port 3030]
 *     Run the .well-known HTTP server.
 *
 *   lookup <agentId>
 *     Read another agent's record + registration file.
 */
import { promises as fs } from 'node:fs';
import {
  AgentCardSchema,
  toErc8004RegistrationFile,
  withIdentity,
  withPayments,
  withA2A,
  type AgentCard,
} from '../identity/agent-card.js';
import {
  registerAgent,
  getAgent,
  type AgentRecord,
} from '../identity/registry.js';
import { serveAgentCard } from '../identity/serve.js';
import {
  createSigner,
  getNetworkInfo,
  resolveNetwork,
  type Network,
} from '../wallet/index.js';

export type IdentitySubcommand = 'register' | 'whoami' | 'card' | 'serve' | 'lookup';

interface IdentityRegisterOpts {
  domain?: string;
  network?: Network;
  uploadTo?: string;
  json?: boolean;
  /**
   * v0.13.3 — when set AND the resolved signer has a smart-account address,
   * call setAgentWallet after register to bind the smart account to the
   * newly-issued agentId. Off by default — it's a second on-chain transaction
   * and not all setups want the smart account in the metadata.
   */
  bindSmartAccount?: boolean;
}

interface IdentityServeOpts {
  port?: number;
  network?: Network;
}

interface IdentityCardOpts {
  out?: string;
  json?: boolean;
}

interface IdentityLookupOpts {
  network?: Network;
  json?: boolean;
}

export async function runIdentityCommand(sub: IdentitySubcommand, args: string[]): Promise<void> {
  switch (sub) {
    case 'register':
      await registerCmd(parseRegisterFlags(args));
      return;
    case 'whoami':
      await whoamiCmd();
      return;
    case 'card':
      await cardCmd(parseCardFlags(args));
      return;
    case 'serve':
      await serveCmd(parseServeFlags(args));
      return;
    case 'lookup':
      await lookupCmd(args[0], parseLookupFlags(args.slice(1)));
      return;
    default:
      throw new Error(`unknown identity subcommand: ${sub}`);
  }
}

async function buildCard(network: Network, domain?: string): Promise<AgentCard> {
  const name = process.env.FRQNCY_AGENT_NAME ?? 'frqncy-harness';
  const description =
    process.env.FRQNCY_AGENT_DESCRIPTION ??
    'A FRQNCY-network agent built on the @frqncy-network/harness LLM substrate.';
  const url = domain ? `https://${domain}` : process.env.FRQNCY_AGENT_URL;
  const endpoint = url; // they're the same in the simple case
  const card: AgentCard = AgentCardSchema.parse({
    name,
    description,
    ...(url ? { url } : {}),
    ...(endpoint ? { endpoint } : {}),
    capabilities: { streaming: true },
  });
  return withPayments(card, { networks: [network], defaultPriceUsdcAtomic: '10000' });
}

async function registerCmd(opts: IdentityRegisterOpts): Promise<void> {
  const network = opts.network ?? resolveNetwork();
  const signer = await createSigner({ network });
  const info = getNetworkInfo(network);

  const domain = opts.domain ?? process.env.FRQNCY_AGENT_DOMAIN;
  if (!domain) {
    throw new Error(
      'identity register: --domain is required (or set FRQNCY_AGENT_DOMAIN). Used to derive agentURI = https://<domain>/.well-known/agent-registration.json',
    );
  }

  const agentURI = `https://${domain}/.well-known/agent-registration.json`;

  process.stderr.write(`[identity] registering on ${network} (chainId ${info.chainId})\n`);
  process.stderr.write(`[identity]   agentURI = ${agentURI}\n`);
  process.stderr.write(`[identity]   owner    = ${signer.address}\n`);
  if (signer.smartAccount) process.stderr.write(`[identity]   smart    = ${signer.smartAccount}\n`);

  const result = await registerAgent({ signer, network, agentURI, verbose: true });

  // v0.13.3 — optionally bind the smart account via setAgentWallet. Per the
  // EIP-8004 spec, the new wallet must sign EIP-712 typed-data proving control;
  // for CDP smart accounts the owner EOA signs and the smart account contract's
  // ERC-1271 isValidSignature accepts. The harness's Signer abstraction handles
  // this transparently — both adapters return signatures the contract verifies.
  let bindResult: { txHash: string; newWallet: string; deadline: string } | undefined;
  if (opts.bindSmartAccount) {
    if (!signer.smartAccount) {
      process.stderr.write(
        `[identity] --bind-smart-account requested but signer has no smart account (kind=${signer.kind}); skipping\n`,
      );
    } else {
      try {
        const { signSetAgentWalletAuthorization } = await import('../identity/sign-wallet.js');
        const { setAgentWallet } = await import('../identity/registry.js');
        process.stderr.write(`[identity] binding smart account ${signer.smartAccount} via setAgentWallet...\n`);
        const auth = await signSetAgentWalletAuthorization({
          signer,
          network,
          agentId: result.agentId,
          newWallet: signer.smartAccount,
        });
        const txHash = await setAgentWallet({
          signer,
          network,
          agentId: result.agentId,
          newWallet: auth.newWallet,
          signature: auth.signature,
          deadline: auth.deadline,
        });
        bindResult = {
          txHash,
          newWallet: auth.newWallet,
          deadline: auth.deadline.toString(),
        };
        process.stderr.write(`[identity]   bind tx: ${txHash}\n`);
      } catch (err) {
        process.stderr.write(
          `[identity] bind failed: ${err instanceof Error ? err.message : String(err)}\n` +
            `[identity] register succeeded; you can retry the bind manually\n`,
        );
      }
    }
  }

  let card = await buildCard(network, domain);
  card = withIdentity(card, { agentId: result.agentId, agentRegistry: result.agentRegistry });
  card = withA2A(card, {});

  if (opts.uploadTo) {
    const registrationFile = toErc8004RegistrationFile(card);
    await fs.writeFile(opts.uploadTo, JSON.stringify(registrationFile, null, 2) + '\n', 'utf-8');
    process.stderr.write(`[identity] wrote registration file to ${opts.uploadTo}\n`);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...result, ...(bindResult ? { bind: bindResult } : {}), card }, null, 2) + '\n');
  } else {
    process.stdout.write(
      `Registered as agent ${result.agentId} on ${result.agentRegistry}\n` +
        `  tx:    ${result.txHash}\n` +
        `  owner: ${result.owner}\n` +
        (bindResult
          ? `  bind:  ${bindResult.txHash} (newWallet=${bindResult.newWallet})\n`
          : '') +
        `Next: serve the registration file at ${agentURI}\n`,
    );
  }
}

async function whoamiCmd(): Promise<void> {
  const network = resolveNetwork();
  const info = getNetworkInfo(network);
  const signer = await createSigner({ network });

  process.stdout.write(
    JSON.stringify(
      {
        kind: signer.kind,
        network,
        chainId: info.chainId,
        owner: signer.address,
        smartAccount: signer.smartAccount,
        identityRegistry: info.identityRegistry,
        reputationRegistry: info.reputationRegistry,
        usdc: info.usdc,
      },
      null,
      2,
    ) + '\n',
  );
}

async function cardCmd(opts: IdentityCardOpts): Promise<void> {
  const network = resolveNetwork();
  const card = await buildCard(network, process.env.FRQNCY_AGENT_DOMAIN);
  const text = JSON.stringify(card, null, 2);
  if (opts.out) {
    await fs.writeFile(opts.out, text + '\n', 'utf-8');
    process.stderr.write(`[identity] wrote agent card to ${opts.out}\n`);
  } else {
    process.stdout.write(text + '\n');
  }
}

async function serveCmd(opts: IdentityServeOpts): Promise<void> {
  const network = opts.network ?? resolveNetwork();
  const card = await buildCard(network, process.env.FRQNCY_AGENT_DOMAIN);
  const handle = await serveAgentCard({ card, port: opts.port });
  process.stderr.write(
    `[identity] serving at ${handle.url}\n` +
      `  GET /.well-known/agent-card.json\n` +
      `  GET /.well-known/agent-registration.json\n` +
      `  GET /healthz\n`,
  );
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      handle.close().finally(() => resolve());
    });
    process.on('SIGTERM', () => {
      handle.close().finally(() => resolve());
    });
  });
}

async function lookupCmd(arg: string | undefined, opts: IdentityLookupOpts): Promise<void> {
  if (!arg) throw new Error('Usage: frqncy-harness identity lookup <agentId>');
  const network = opts.network ?? resolveNetwork();
  const agentId = Number(arg);
  if (!Number.isInteger(agentId) || agentId < 0) throw new Error(`invalid agentId: ${arg}`);

  const record: AgentRecord = await getAgent({ network, agentId, fetchRegistration: true });
  if (opts.json) {
    process.stdout.write(JSON.stringify(record, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    `Agent ${record.agentId}\n` +
      `  registry:    ${record.agentRegistry}\n` +
      `  owner:       ${record.owner}\n` +
      `  agentWallet: ${record.agentWallet ?? '(none)'}\n` +
      `  agentURI:    ${record.agentURI}\n` +
      (record.registration
        ? `  name:        ${record.registration.name}\n` +
          `  description: ${record.registration.description}\n` +
          `  x402:        ${record.registration.x402Support ? 'yes' : 'no'}\n` +
          `  trust:       ${(record.registration.supportedTrust ?? []).join(', ') || '(none)'}\n` +
          `  services:    ${(record.registration.services ?? [])
            .map((s) => `${s.name}=${s.endpoint}`)
            .join(', ') || '(none)'}\n`
        : ''),
  );
}

// ── flag parsing ────────────────────────────────────────────────────

function parseRegisterFlags(args: string[]): IdentityRegisterOpts {
  const out: IdentityRegisterOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--domain') out.domain = args[++i];
    else if (a === '--network') out.network = args[++i] as Network;
    else if (a === '--upload-to') out.uploadTo = args[++i];
    else if (a === '--bind-smart-account') out.bindSmartAccount = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function parseCardFlags(args: string[]): IdentityCardOpts {
  const out: IdentityCardOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--out') out.out = args[++i];
    else if (a === '--json') out.json = true;
  }
  return out;
}

function parseServeFlags(args: string[]): IdentityServeOpts {
  const out: IdentityServeOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--port') out.port = Number(args[++i]);
    else if (a === '--network') out.network = args[++i] as Network;
  }
  return out;
}

function parseLookupFlags(args: string[]): IdentityLookupOpts {
  const out: IdentityLookupOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--network') out.network = args[++i] as Network;
    else if (a === '--json') out.json = true;
  }
  return out;
}
