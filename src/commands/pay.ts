/**
 * `frqncy-harness pay <subcmd>` — x402 payment commands.
 *
 *   test <url>                 hit a 402'd URL with --max <atomic> cap
 *   balance                    USDC balance on the agent's smart account + EOA
 *   budget [show|set <usd>]    soft/hard caps for x402 spend
 *   discover                   query the facilitator for known paid resources
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  createSigner,
  getNetworkInfo,
  resolveNetwork,
  type Network,
} from '../wallet/index.js';
import {
  createBudgetState,
  formatAtomicUsdc,
  wrapFetchWithPayment,
} from '../payments/index.js';
import {
  createFacilitatorClient,
  createCdpFacilitatorAuth,
} from '../payments/facilitator.js';
import { DEFAULT_TRACE_DIR } from '../trace.js';

export type PaySubcommand = 'test' | 'balance' | 'budget' | 'discover' | 'history';

export async function runPayCommand(sub: PaySubcommand, args: string[]): Promise<void> {
  switch (sub) {
    case 'test':
      await testCmd(args[0], args.slice(1));
      return;
    case 'balance':
      await balanceCmd();
      return;
    case 'budget':
      await budgetCmd(args[0], args[1]);
      return;
    case 'discover':
      await discoverCmd();
      return;
    case 'history':
      await historyCmd(args);
      return;
    default:
      throw new Error(`unknown pay subcommand: ${sub}`);
  }
}

async function testCmd(url: string | undefined, args: string[]): Promise<void> {
  if (!url) {
    throw new Error(
      'Usage: frqncy-harness pay test <url> [--max <atomic>] [--feedback-agent <id>]',
    );
  }
  let maxAtomic = 100_000n;
  let feedbackAgentId: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max') maxAtomic = BigInt(args[++i] ?? '0');
    else if (args[i] === '--feedback-agent') {
      const v = args[++i];
      if (v) feedbackAgentId = Number(v);
    }
  }
  const network = resolveNetwork();
  const signer = await createSigner({ network });
  const budget = createBudgetState();

  // v0.9.2 — mint a conversation id so the payment lands in the never-compacted
  // trace, and load any user-defined `pre-payment` hooks from config so ops
  // policies fire. Both are opt-in via the auto-attach options on
  // `wrapFetchWithPayment`. Without this wiring the call would settle but be
  // invisible to `pay history` and unable to be vetoed by hooks.
  const { randomUUID } = await import('node:crypto');
  const { loadConfig } = await import('../config.js');
  const { HookManager } = await import('../hooks/index.js');
  const config = await loadConfig();
  const conversationId = randomUUID();
  const startedAt = new Date();
  const hookManager = new HookManager(config.hooks);

  // v0.13 — auto-feedback wiring. Two opt-in paths:
  //   1. `--feedback-agent <id>` overrides any config-level lookup for this run.
  //   2. `payments.autoFeedback.enabled` in config.json + a static map (here,
  //      we only honor the CLI flag — broader address→id lookups belong in
  //      library use, not the dev-loop CLI).
  // If neither is set, no feedback is written.
  const { createSettleFeedbackWriter } = await import('../payments/index.js');
  const autoFeedback = config.payments?.autoFeedback;
  const feedbackEnabled =
    typeof feedbackAgentId === 'number' || autoFeedback?.enabled === true;

  // Use an explicit type so PaymentTraceFn's void|Promise<void> return shape
  // doesn't have to be re-derived from a mapped import().
  type OnPay = NonNullable<Parameters<typeof wrapFetchWithPayment>[0]['onPayment']>;

  const onPaymentLog: OnPay = async (record) => {
    process.stderr.write(
      `[pay] ${record.direction.toUpperCase()} ${formatAtomicUsdc(BigInt(record.amountAtomic))} ` +
        `${record.asset} on ${record.network}\n`,
    );
    if (record.txHash) process.stderr.write(`[pay]   tx: ${record.txHash}\n`);
  };

  let composedOnPayment: OnPay = onPaymentLog;
  if (feedbackEnabled) {
    const lookup = (_addr: `0x${string}`): number | null =>
      typeof feedbackAgentId === 'number' ? feedbackAgentId : null;
    const feedbackOpts: Parameters<typeof createSettleFeedbackWriter>[0] = {
      signer,
      lookupAgentId: lookup,
      defaultValue: autoFeedback?.defaultValue ?? 1.0,
      defaultDecimals: autoFeedback?.defaultDecimals ?? 2,
      next: onPaymentLog,
    };
    if (autoFeedback?.defaultTag1) feedbackOpts.defaultTag1 = autoFeedback.defaultTag1;
    if (autoFeedback?.defaultTag2) feedbackOpts.defaultTag2 = autoFeedback.defaultTag2;
    composedOnPayment = createSettleFeedbackWriter(feedbackOpts);
    process.stderr.write(
      `[pay] auto-feedback enabled (agentId=${feedbackAgentId ?? 'config-lookup'})\n`,
    );
  }

  const wrapped = wrapFetchWithPayment({
    signer,
    acceptedNetworks: [network],
    maxPerCallAtomic: maxAtomic,
    budget,
    traceContext: { conversationId, startedAt },
    hookManager,
    onPayment: composedOnPayment,
  });

  process.stderr.write(`[pay] GET ${url} (max ${formatAtomicUsdc(maxAtomic)})\n`);
  process.stderr.write(`[pay] conversation: ${conversationId}\n`);
  const res = await wrapped(url, { method: 'GET' });
  const body = await res.text();
  process.stdout.write(body + '\n');
  process.stderr.write(`[pay] status=${res.status} bodyLen=${body.length}\n`);
  process.stderr.write(`[pay] (run 'frqncy-harness pay history' to see this in the trace)\n`);
}

async function balanceCmd(): Promise<void> {
  const network = resolveNetwork();
  const info = getNetworkInfo(network);
  const signer = await createSigner({ network });

  // Read USDC balanceOf for owner + smart account
  const { peerImport } = await import('../wallet/peerimport.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let viem: any = null;
  try {
    viem = await peerImport('viem');
  } catch {
    throw new Error("viem not installed — run 'npm install viem' to use pay balance.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chains: any = await peerImport('viem/chains').catch(() => ({}));
  const chain = network === 'base' ? chains.base : chains.baseSepolia;
  const pc = viem.createPublicClient({ chain, transport: viem.http(info.rpcUrl) });
  const erc20Abi = [
    {
      type: 'function',
      name: 'balanceOf',
      stateMutability: 'view',
      inputs: [{ name: 'a', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    },
  ];

  async function balanceOf(addr: string): Promise<bigint> {
    return (await pc.readContract({
      address: info.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [addr],
    })) as bigint;
  }

  const ownerBal = await balanceOf(signer.address);
  const smartBal = signer.smartAccount ? await balanceOf(signer.smartAccount) : null;

  process.stdout.write(
    JSON.stringify(
      {
        network,
        usdcContract: info.usdc,
        owner: { address: signer.address, usdc: formatAtomicUsdc(ownerBal), atomic: ownerBal.toString() },
        smartAccount: smartBal !== null
          ? {
              address: signer.smartAccount,
              usdc: formatAtomicUsdc(smartBal),
              atomic: smartBal.toString(),
            }
          : null,
      },
      null,
      2,
    ) + '\n',
  );
}

async function budgetCmd(action: string | undefined, value: string | undefined): Promise<void> {
  const action2 = action ?? 'show';
  if (action2 === 'show') {
    const state = createBudgetState();
    process.stdout.write(
      `Per-conversation x402 budget defaults\n` +
        `  soft warn: ${formatAtomicUsdc(state.softWarnAtomic)}\n` +
        `  hard cap:  ${formatAtomicUsdc(state.hardAbortAtomic)}\n` +
        `(set via config: payments.budget.softWarnUsdCents / hardAbortUsdCents)\n`,
    );
    return;
  }
  if (action2 === 'set') {
    if (!value) throw new Error('Usage: frqncy-harness pay budget set <usd>');
    process.stdout.write(
      `(stub) configurable budget storage isn't wired into config.json yet — set the env vars\n` +
        `  FRQNCY_X402_SOFT_WARN_USD=<usd>\n` +
        `  FRQNCY_X402_HARD_ABORT_USD=<usd>\n` +
        `or pass them programmatically.\n`,
    );
    return;
  }
  throw new Error(`unknown pay budget subcommand: ${action2}`);
}

interface HistoryOpts {
  last?: number;
  threadId?: string;
  json?: boolean;
  direction?: 'in' | 'out';
}

function parseHistoryFlags(args: string[]): HistoryOpts {
  const out: HistoryOpts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--last') out.last = Number(args[++i]);
    else if (a === '--thread') out.threadId = args[++i];
    else if (a === '--direction') out.direction = args[++i] as 'in' | 'out';
    else if (a === '--json') out.json = true;
  }
  return out;
}

async function historyCmd(args: string[]): Promise<void> {
  const opts = parseHistoryFlags(args);
  const limit = opts.last ?? 25;

  // Walk the date-partitioned dirs, newest first, collect `payment`-type
  // records until we've seen `limit`. Trace files are JSONL — one record per
  // line — and are append-only, so a tail-and-reverse pattern is safe.
  const traceDir = process.env.FRQNCY_TRACE_DIR ?? DEFAULT_TRACE_DIR;
  let dateDirs: string[];
  try {
    dateDirs = (await fs.readdir(traceDir)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    dateDirs.sort().reverse();
  } catch {
    if (opts.json) process.stdout.write('[]\n');
    else process.stderr.write(`[pay history] no trace directory at ${traceDir}\n`);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matches: any[] = [];
  outer: for (const date of dateDirs) {
    const dir = join(traceDir, date);
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    files.sort().reverse();
    for (const file of files) {
      let raw: string;
      try {
        raw = await fs.readFile(join(dir, file), 'utf-8');
      } catch {
        continue;
      }
      // Read in reverse — newest records first
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rec: any = JSON.parse(lines[i]!);
          if (rec.type !== 'payment') continue;
          if (opts.threadId && rec.thread_id !== opts.threadId) continue;
          if (opts.direction && rec.content?.direction !== opts.direction) continue;
          matches.push(rec);
          if (matches.length >= limit) break outer;
        } catch {
          // skip malformed line
        }
      }
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(matches, null, 2) + '\n');
    return;
  }

  if (matches.length === 0) {
    process.stdout.write('No payment records found.\n');
    return;
  }

  for (const rec of matches) {
    const c = rec.content ?? {};
    const arrow = c.direction === 'out' ? '→' : '←';
    const status = c.settled ? 'settled' : `failed${c.errorReason ? `: ${c.errorReason}` : ''}`;
    const amt = formatAtomicUsdc(BigInt(c.amountAtomic ?? '0'));
    const tx = c.txHash ? ` tx=${c.txHash.slice(0, 10)}…` : '';
    process.stdout.write(
      `${rec.ts}  ${arrow} ${amt}  ${c.network ?? '?'}  ${status}${tx}  ${c.resource ?? ''}\n`,
    );
  }
}

async function discoverCmd(): Promise<void> {
  const network = resolveNetwork();
  const info = getNetworkInfo(network);
  const fac = createFacilitatorClient({
    url: info.defaultFacilitatorUrl,
    ...(info.defaultFacilitatorUrl.includes('cdp.coinbase.com')
      ? { createAuthHeaders: createCdpFacilitatorAuth() }
      : {}),
  });
  const result = await fac.discover({ limit: 25 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
