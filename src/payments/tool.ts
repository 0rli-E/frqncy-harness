/**
 * Two HarnessTools that expose the payments + identity surface to the LLM.
 *
 * `pay` — explicit micropayment. The LLM names a URL and an upper bound; the
 *   tool calls the wrapped fetch (which will 402 → sign → retry → settle) and
 *   returns the response body + payment receipt. `permission: 'propose-then-approve'`
 *   so the user must approve each payment unless `--yolo` is set. Carries
 *   `flags: { privateData: true, outboundNetwork: true }` — note: NOT
 *   `untrustedContent`, by design: this tool only *posts* payment, it doesn't
 *   ingest the response into the LLM's reasoning automatically. Combined with
 *   web_fetch (which carries `untrustedContent`), the lethal-trifecta gate
 *   already enforces the right policy.
 *
 * `discover_agents` — read-only ERC-8004 lookup. `flags: { outboundNetwork: true }`.
 *   `permission: 'auto'`. Returns up to N matching agents.
 *
 * Both tools are OPT-IN — they're not in the default tool set. Wire them via
 * `tools: [payTool, discoverAgentsTool]` (both factory functions take config).
 */
import { z, type ZodType } from 'zod';
import type { HarnessTool } from '../tools/index.js';
import type { Signer } from '../wallet/index.js';
import { wrapFetchWithPayment, type WrapFetchWithPaymentOptions, X402Error } from './client.js';
import { getAgent } from '../identity/registry.js';

// ────────────────────────────────────────────────────────────────────
// pay
// ────────────────────────────────────────────────────────────────────

export const PayInputSchema = z.object({
  url: z.string().url().describe('The URL to fetch — expected to return 402 then accept payment.'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  body: z.string().optional().describe('Optional request body (will be sent as-is).'),
  contentType: z.string().optional().describe('Content-Type for the body, if any.'),
  /** Maximum atomic-USDC the LLM is willing to pay. */
  maxAtomic: z
    .string()
    .regex(/^\d+$/)
    .default('100000')
    .describe('Maximum atomic-USDC units to pay (default 100000 = $0.10).'),
});
export type PayInput = z.infer<typeof PayInputSchema>;

export interface PayOutput {
  ok: boolean;
  status: number;
  body: string;
  paid: boolean;
  payment?: {
    amountAtomic: string;
    asset: string;
    network: string;
    txHash?: string;
    payer?: string;
    payee: string;
  };
  error?: string;
}

export interface CreatePayToolOptions
  extends Omit<WrapFetchWithPaymentOptions, 'baseFetch' | 'maxPerCallAtomic'> {
  /** Default max per call for this tool, overridden by `maxAtomic` from the LLM. */
  defaultMaxPerCallAtomic?: bigint;
}

export function createPayTool(opts: CreatePayToolOptions): HarnessTool<PayInput, PayOutput> {
  return {
    name: 'pay',
    description:
      'Make a paid HTTP request via x402. The endpoint is expected to return 402 with PaymentRequirements; ' +
      'the harness signs an EIP-3009 USDC TransferWithAuthorization, retries with X-PAYMENT, and returns the ' +
      'response body. Use `maxAtomic` to cap the spend per call (in atomic USDC, 6 decimals).',
    // Cast to satisfy HarnessTool's `ZodType<TInput>` slot — Zod's `.default()`
    // creates a schema whose *input* type allows `undefined` while the *output*
    // (parsed) type matches PayInput. The harness validates inputs via
    // `safeParse`, which returns the output type, so the cast is sound.
    inputSchema: PayInputSchema as unknown as ZodType<PayInput>,
    flags: { privateData: true, outboundNetwork: true, untrustedContent: false },
    permission: 'propose-then-approve',
    async execute(input): Promise<PayOutput> {
      let lastReceipt:
        | {
            amountAtomic: string;
            asset: string;
            network: string;
            txHash?: string;
            payer?: string;
            payee: string;
          }
        | undefined;
      const wrapped = wrapFetchWithPayment({
        ...opts,
        maxPerCallAtomic: BigInt(input.maxAtomic),
        onPayment: async (record) => {
          lastReceipt = {
            amountAtomic: record.amountAtomic,
            asset: record.asset,
            network: record.network,
            txHash: record.txHash,
            payer: record.payer,
            payee: record.payee,
          };
          // chain user-provided callback if any
          if (opts.onPayment) await opts.onPayment(record);
        },
      });

      try {
        const headers: Record<string, string> = {};
        if (input.contentType) headers['Content-Type'] = input.contentType;
        const res = await wrapped(input.url, {
          method: input.method,
          headers,
          ...(input.body !== undefined ? { body: input.body } : {}),
        });
        const body = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          body,
          paid: !!lastReceipt,
          payment: lastReceipt,
        };
      } catch (err) {
        if (err instanceof X402Error) {
          return {
            ok: false,
            status: 0,
            body: '',
            paid: false,
            error: `${err.code}: ${err.message}`,
          };
        }
        return {
          ok: false,
          status: 0,
          body: '',
          paid: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// discover_agents
// ────────────────────────────────────────────────────────────────────

export const DiscoverAgentsInputSchema = z.object({
  agentId: z.number().int().nonnegative().optional().describe('Look up a specific agent by id'),
  network: z.enum(['base', 'base-sepolia']).default('base'),
  /** When set, fetch the agent's tokenURI body and parse the registration file. */
  fetchRegistration: z.boolean().default(true),
});
export type DiscoverAgentsInput = z.infer<typeof DiscoverAgentsInputSchema>;

export interface DiscoverAgentsOutput {
  agents: Array<{
    agentId: number;
    agentRegistry: string;
    owner: string;
    agentURI: string;
    agentWallet?: string;
    name?: string;
    description?: string;
    services?: Array<{ name: string; endpoint: string; version?: string }>;
    x402Support?: boolean;
    supportedTrust?: string[];
  }>;
}

export interface CreateDiscoverAgentsToolOptions {
  /** Optional RPC override; defaults to the harness network's default. */
  network?: 'base' | 'base-sepolia';
}

export function createDiscoverAgentsTool(
  _opts: CreateDiscoverAgentsToolOptions = {},
): HarnessTool<DiscoverAgentsInput, DiscoverAgentsOutput> {
  return {
    name: 'discover_agents',
    description:
      'Look up an ERC-8004 agent by id. Returns the agent owner, agentURI, bound wallet (if any), ' +
      'and parsed registration metadata (name, description, services, supportedTrust). ' +
      'Pass `agentId` to look up a specific agent.',
    inputSchema: DiscoverAgentsInputSchema as unknown as ZodType<DiscoverAgentsInput>,
    flags: { outboundNetwork: true, untrustedContent: false, privateData: false },
    permission: 'auto',
    async execute(input): Promise<DiscoverAgentsOutput> {
      if (input.agentId === undefined) {
        // No `enumerate` on the registry — caller must supply an id.
        return { agents: [] };
      }
      const record = await getAgent({
        agentId: input.agentId,
        network: input.network,
        fetchRegistration: input.fetchRegistration,
      });
      return {
        agents: [
          {
            agentId: record.agentId,
            agentRegistry: record.agentRegistry,
            owner: record.owner,
            agentURI: record.agentURI,
            agentWallet: record.agentWallet,
            name: record.registration?.name,
            description: record.registration?.description,
            services: record.registration?.services,
            x402Support: record.registration?.x402Support,
            supportedTrust: record.registration?.supportedTrust,
          },
        ],
      };
    },
  };
}

/**
 * Convenience signer-aware factory used by the CLI.
 *
 * v0.9.2: forwards `traceContext` and `hookManager` so payments made through
 * the LLM-callable `pay` tool automatically:
 *   - append `payment`-type records to the active conversation's JSONL trace
 *   - consult `pre-payment` hooks for ops vetoes
 *
 * Without these fields, the tool runs as before — opt-in observability.
 */
export function createPaymentToolset(opts: {
  signer: Signer;
  network?: 'base' | 'base-sepolia';
  budget?: WrapFetchWithPaymentOptions['budget'];
  onPayment?: WrapFetchWithPaymentOptions['onPayment'];
  /** Conversation context — when set, payments auto-trace. */
  traceContext?: WrapFetchWithPaymentOptions['traceContext'];
  /** HookManager — when set, `pre-payment` hooks fire before each settle. */
  hookManager?: WrapFetchWithPaymentOptions['hookManager'];
}): { pay: HarnessTool<PayInput, PayOutput>; discoverAgents: HarnessTool<DiscoverAgentsInput, DiscoverAgentsOutput> } {
  return {
    pay: createPayTool({
      signer: opts.signer,
      acceptedNetworks: [opts.network ?? opts.signer.network],
      budget: opts.budget,
      onPayment: opts.onPayment,
      ...(opts.traceContext ? { traceContext: opts.traceContext } : {}),
      ...(opts.hookManager ? { hookManager: opts.hookManager } : {}),
    }),
    discoverAgents: createDiscoverAgentsTool({ network: opts.network }),
  };
}
