/**
 * ERC-8004 IdentityRegistry + ReputationRegistry viem clients.
 *
 * One module wraps both. We expose a small typed surface on top of the raw
 * viem `readContract` / `writeContract` calls so callers don't have to thread
 * ABIs around. All chain interaction goes through here — keep this file the
 * single chokepoint for "does the harness talk to ERC-8004 correctly".
 *
 * SIGNING POLICY:
 *   - Identity registration / setAgentURI: signed by the *owner EOA* of the
 *     agent NFT. For CDP signers, that's `signer.address`. The smart account
 *     can also own the NFT (ERC-721 supports contract owners via ERC-1271)
 *     but for cleanliness we register under the EOA and bind the smart
 *     account via setAgentWallet.
 *   - setAgentWallet: signed off-chain (EIP-712) by the *new wallet* to prove
 *     control, then submitted by the agent owner. We sign with whichever
 *     signer represents the new wallet; usually the smart account via
 *     ERC-1271 — when binding a CDP smart account this is the path.
 *
 * viem is a runtime peer dep; we lazy-import.
 */
import {
  getNetworkInfo,
  type Network,
  type Signer,
  type Address,
  type Hex,
} from '../wallet/index.js';
import { peerImport } from '../wallet/peerimport.js';
import { IDENTITY_REGISTRY_ABI, REPUTATION_REGISTRY_ABI } from './abi.js';
import {
  AgentCardSchema,
  Erc8004RegistrationFileSchema,
  formatAgentRegistry,
  type AgentCard,
  type Erc8004RegistrationFile,
} from './agent-card.js';

// ────────────────────────────────────────────────────────────────────
// Internal: viem clients
// ────────────────────────────────────────────────────────────────────

interface ViemClients {
  publicClient: unknown;
  walletClient: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadViem(): Promise<any> {
  try {
    return await peerImport('viem');
  } catch {
    throw new Error(
      "Cannot load 'viem' — install it as a peer dep: `npm install viem`. " +
        'viem powers all on-chain reads and writes for ERC-8004.',
    );
  }
}

async function getClients(network: Network, signer?: Signer): Promise<ViemClients> {
  const info = getNetworkInfo(network);
  const viem = await loadViem();
  const chainsModule = await peerImport('viem/chains').catch(() => ({}));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chains = chainsModule as any;
  const chain = network === 'base' ? chains.base ?? null : chains.baseSepolia ?? null;
  const publicClient = viem.createPublicClient({
    chain: chain ?? undefined,
    transport: viem.http(info.rpcUrl),
  });

  if (!signer) return { publicClient, walletClient: undefined };

  // Build a viem-shaped account from the harness signer.
  const { toAccount } = await peerImport<{ toAccount: (a: unknown) => unknown }>('viem/accounts');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const account = (toAccount as any)({
    address: signer.address,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signMessage({ message }: any) {
      return signer.signMessage(message);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signTypedData(typedData: any) {
      return signer.signTypedData(typedData);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async signTransaction(_tx: any): Promise<Hex> {
      throw new Error(
        'signTransaction is not supported by the harness Signer. Use the smart account ' +
          'helpers for sponsored sends, or the viem signer for raw transactions.',
      );
    },
  });

  const walletClient = viem.createWalletClient({
    account,
    chain: chain ?? undefined,
    transport: viem.http(info.rpcUrl),
  });
  return { publicClient, walletClient };
}

// ────────────────────────────────────────────────────────────────────
// Identity Registry
// ────────────────────────────────────────────────────────────────────

export interface RegisterAgentOptions {
  signer: Signer;
  network?: Network;
  /**
   * Public URL the registration JSON is served from. Per EIP-8004, an https://
   * URL on a domain you control demonstrates control. data: and ipfs: URIs are
   * also valid.
   */
  agentURI: string;
  /** Print extra status to stderr (for CLI use). */
  verbose?: boolean;
}

export interface RegisterAgentResult {
  agentId: number;
  agentRegistry: string;
  txHash: Hex;
  /** The owner address recorded on-chain (signer.address). */
  owner: Address;
}

export async function registerAgent(opts: RegisterAgentOptions): Promise<RegisterAgentResult> {
  const network = opts.network ?? opts.signer.network;
  const info = getNetworkInfo(network);
  const { publicClient, walletClient } = await getClients(network, opts.signer);
  if (!walletClient) throw new Error('walletClient unavailable; signer required');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wc = walletClient as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = publicClient as any;

  const txHash = (await wc.writeContract({
    address: info.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'register',
    args: [opts.agentURI],
  })) as Hex;

  if (opts.verbose) process.stderr.write(`[identity] register tx submitted: ${txHash}\n`);

  // Wait for receipt and parse the Registered event for agentId
  const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viem = await loadViem();
  const decoded: { args: { agentId?: bigint; owner?: Address } } | null =
    receipt.logs
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((log: any) => {
        try {
          return viem.decodeEventLog({
            abi: IDENTITY_REGISTRY_ABI,
            data: log.data,
            topics: log.topics,
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch {
          return null;
        }
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .find((e: any) => e?.eventName === 'Registered') ?? null;

  if (!decoded?.args?.agentId) {
    throw new Error('Registered event not found in transaction receipt');
  }

  const agentId = Number(decoded.args.agentId);
  return {
    agentId,
    agentRegistry: formatAgentRegistry(info.chainId, info.identityRegistry),
    txHash,
    owner: opts.signer.address,
  };
}

export interface GetAgentOptions {
  network?: Network;
  agentId: number;
  /** If provided, fetch the agentURI body via fetch and parse as the registration file. */
  fetchRegistration?: boolean;
}

export interface AgentRecord {
  agentId: number;
  agentRegistry: string;
  owner: Address;
  agentURI: string;
  agentWallet?: Address;
  registration?: Erc8004RegistrationFile;
}

export async function getAgent(opts: GetAgentOptions): Promise<AgentRecord> {
  const network = opts.network ?? 'base';
  const info = getNetworkInfo(network);
  const { publicClient } = await getClients(network);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = publicClient as any;

  const agentIdBig = BigInt(opts.agentId);

  const [owner, agentURI, agentWallet] = (await Promise.all([
    pc.readContract({
      address: info.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'ownerOf',
      args: [agentIdBig],
    }),
    pc.readContract({
      address: info.identityRegistry,
      abi: IDENTITY_REGISTRY_ABI,
      functionName: 'tokenURI',
      args: [agentIdBig],
    }),
    pc
      .readContract({
        address: info.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'getAgentWallet',
        args: [agentIdBig],
      })
      .catch(() => '0x0000000000000000000000000000000000000000'),
  ])) as [Address, string, Address];

  let registration: Erc8004RegistrationFile | undefined;
  if (opts.fetchRegistration && (agentURI.startsWith('http://') || agentURI.startsWith('https://'))) {
    try {
      const res = await fetch(agentURI);
      if (res.ok) {
        const json = await res.json();
        registration = Erc8004RegistrationFileSchema.parse(json);
      }
    } catch {
      // best-effort
    }
  }

  return {
    agentId: opts.agentId,
    agentRegistry: formatAgentRegistry(info.chainId, info.identityRegistry),
    owner,
    agentURI,
    agentWallet:
      agentWallet === '0x0000000000000000000000000000000000000000' ? undefined : agentWallet,
    registration,
  };
}

export interface SetAgentWalletOptions {
  signer: Signer; // owner of the agent NFT
  network?: Network;
  agentId: number;
  newWallet: Address;
  /** Off-chain EIP-712 signature from the *new wallet* proving control. */
  signature: Hex;
  /** UNIX timestamp the signature is valid until. */
  deadline: bigint;
}

export async function setAgentWallet(opts: SetAgentWalletOptions): Promise<Hex> {
  const network = opts.network ?? opts.signer.network;
  const info = getNetworkInfo(network);
  const { walletClient } = await getClients(network, opts.signer);
  if (!walletClient) throw new Error('walletClient unavailable');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wc = walletClient as any;
  return (await wc.writeContract({
    address: info.identityRegistry,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: 'setAgentWallet',
    args: [BigInt(opts.agentId), opts.newWallet, opts.deadline, opts.signature],
  })) as Hex;
}

// ────────────────────────────────────────────────────────────────────
// Reputation Registry
// ────────────────────────────────────────────────────────────────────

export interface GiveFeedbackOptions {
  signer: Signer;
  network?: Network;
  agentId: number;
  /** Fixed-point: real value = `value / 10**valueDecimals`. */
  value: number; // user passes a normal number; we encode
  valueDecimals?: number; // default 2 → cents-precision rating
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackURI?: string;
  feedbackHash?: Hex;
}

export async function giveFeedback(opts: GiveFeedbackOptions): Promise<Hex> {
  const network = opts.network ?? opts.signer.network;
  const info = getNetworkInfo(network);
  const { walletClient } = await getClients(network, opts.signer);
  if (!walletClient) throw new Error('walletClient unavailable');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wc = walletClient as any;

  const decimals = opts.valueDecimals ?? 2;
  const scaled = BigInt(Math.round(opts.value * Math.pow(10, decimals)));

  return (await wc.writeContract({
    address: info.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'giveFeedback',
    args: [
      BigInt(opts.agentId),
      scaled,
      decimals,
      opts.tag1 ?? '',
      opts.tag2 ?? '',
      opts.endpoint ?? '',
      opts.feedbackURI ?? '',
      opts.feedbackHash ?? ('0x' + '00'.repeat(32)),
    ],
  })) as Hex;
}

export interface FeedbackSummary {
  count: number;
  /** Real-valued summary: `value / 10**decimals`. */
  value: number;
  decimals: number;
}

export async function getFeedbackSummary(
  agentId: number,
  clientAddresses: Address[],
  opts: { network?: Network; tag1?: string; tag2?: string } = {},
): Promise<FeedbackSummary> {
  const network = opts.network ?? 'base';
  const info = getNetworkInfo(network);
  const { publicClient } = await getClients(network);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pc = publicClient as any;
  const result = (await pc.readContract({
    address: info.reputationRegistry,
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'getSummary',
    args: [BigInt(agentId), clientAddresses, opts.tag1 ?? '', opts.tag2 ?? ''],
  })) as readonly [bigint, bigint, number];
  const [count, summaryValue, decimals] = result;
  return {
    count: Number(count),
    value: Number(summaryValue) / Math.pow(10, decimals),
    decimals,
  };
}

// ────────────────────────────────────────────────────────────────────
// Re-exports for convenience
// ────────────────────────────────────────────────────────────────────

export { AgentCardSchema, type AgentCard };
