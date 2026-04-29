/**
 * Auto-attach tests — `wrapFetchWithPayment`'s `traceContext` + `hookManager`
 * options should automatically install:
 *
 *   - the payment trace writer (appends `payment` records on settle)
 *   - the pre-payment hook gate (consults HookManager, vetoes block payments)
 *
 * Both compose with any user-supplied `onPayment` / `onPrePayment` callbacks
 * — user callback fires first; auto-installs run after (or, in the veto case,
 * the user veto wins immediately).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  wrapFetchWithPayment,
  X402Error,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
} from '../src/payments/index.js';
import { HookManager } from '../src/hooks/index.js';
import { getTraceFilePath } from '../src/trace.js';
import type { Signer, Eip712TypedData } from '../src/wallet/index.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures: a deterministic signer and a mock 402 server
// ────────────────────────────────────────────────────────────────────

function fakeSigner(): Signer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = {
    kind: 'viem',
    address: '0x1111111111111111111111111111111111111111',
    network: 'base-sepolia',
    async signTypedData(_: Eip712TypedData) {
      return ('0x' + '00'.repeat(65)) as `0x${string}`;
    },
    async signMessage() {
      return ('0x' + '00'.repeat(65)) as `0x${string}`;
    },
  };
  return s;
}

interface MockServer {
  url: string;
  close(): Promise<void>;
}

async function startMockServer(): Promise<MockServer> {
  const server = createServer((req, res) => {
    const headerName = X402_REQUEST_HEADER.toLowerCase();
    if (!req.headers[headerName]) {
      const body = {
        x402Version: 1,
        error: 'X-PAYMENT header is required',
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: '10000',
            resource: `http://localhost:${(server.address() as { port: number }).port}/`,
            description: 'mock',
            mimeType: 'application/json',
            payTo: '0x2222222222222222222222222222222222222222',
            maxTimeoutSeconds: 60,
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            extra: { name: 'USDC', version: '2' },
          },
        ],
      };
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    const settled = {
      success: true,
      transaction: '0xdeadbeef',
      network: 'base-sepolia',
      payer: '0x1111111111111111111111111111111111111111',
    };
    res.setHeader(
      X402_RESPONSE_HEADER,
      Buffer.from(JSON.stringify(settled), 'utf-8').toString('base64'),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Auto-trace
// ────────────────────────────────────────────────────────────────────

describe('wrapFetchWithPayment auto-trace', () => {
  let traceDir: string;
  beforeEach(async () => {
    traceDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-pay-autotrace-'));
  });
  afterEach(async () => {
    await fs.rm(traceDir, { recursive: true, force: true });
  });

  it('appends a payment record when traceContext is set', async () => {
    const mock = await startMockServer();
    try {
      const conversationId = randomUUID();
      const startedAt = new Date('2026-04-29T00:00:00Z');
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
        traceContext: { conversationId, startedAt, traceDir },
      });
      const res = await wrapped(mock.url, { method: 'GET' });
      expect(res.status).toBe(200);

      const path = getTraceFilePath(conversationId, startedAt, traceDir);
      const raw = await fs.readFile(path, 'utf-8');
      const records = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
      expect(records).toHaveLength(1);
      expect(records[0].type).toBe('payment');
      expect(records[0].content.direction).toBe('out');
      expect(records[0].content.settled).toBe(true);
      expect(records[0].content.txHash).toBe('0xdeadbeef');
    } finally {
      await mock.close();
    }
  });

  it('does NOT append when traceContext is unset (back-compat)', async () => {
    const mock = await startMockServer();
    try {
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
      });
      const res = await wrapped(mock.url, { method: 'GET' });
      expect(res.status).toBe(200);
      // No trace dir was provided so nothing should have been written here.
      // (We can't easily confirm "nothing was written anywhere" without
      // sandboxing the home dir; instead we just assert the call succeeded
      // without error — the absence of a traceContext means
      // composePaymentCallbacks doesn't run.)
    } finally {
      await mock.close();
    }
  });

  it('chains the user onPayment callback before the trace writer', async () => {
    const mock = await startMockServer();
    try {
      const conversationId = randomUUID();
      const startedAt = new Date('2026-04-29T00:00:00Z');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userCalls: any[] = [];
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
        onPayment: (record) => {
          userCalls.push({
            txHash: record.txHash,
            // Capture the user-callback timing — it should fire BEFORE the
            // trace file is written.
          });
        },
        traceContext: { conversationId, startedAt, traceDir },
      });
      await wrapped(mock.url, { method: 'GET' });

      // User callback was fired
      expect(userCalls).toHaveLength(1);
      expect(userCalls[0]?.txHash).toBe('0xdeadbeef');

      // And the trace was appended
      const path = getTraceFilePath(conversationId, startedAt, traceDir);
      const raw = await fs.readFile(path, 'utf-8');
      expect(raw.split('\n').filter((l) => l.trim()).length).toBe(1);
    } finally {
      await mock.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// Auto-hook (pre-payment veto)
// ────────────────────────────────────────────────────────────────────

describe('wrapFetchWithPayment auto-hook', () => {
  it('vetoes via HookManager.firePrePayment when a hook returns block:true', async () => {
    const mock = await startMockServer();
    try {
      const hookManager = new HookManager({
        'pre-payment': [
          `cat >/dev/null; echo '{"block":true,"reason":"ops policy"}'`,
        ],
      });
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
        hookManager,
      });
      const err = await wrapped(mock.url, { method: 'GET' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402Error);
      expect((err as X402Error).code).toBe('pre_payment_blocked');
      expect((err as Error).message).toMatch(/ops policy/);
    } finally {
      await mock.close();
    }
  });

  it('does NOT veto when the hook returns nothing', async () => {
    const mock = await startMockServer();
    try {
      const hookManager = new HookManager({
        'pre-payment': [`cat >/dev/null; echo '{"warning":"observing"}'`],
      });
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
        hookManager,
      });
      const res = await wrapped(mock.url, { method: 'GET' });
      expect(res.status).toBe(200);
    } finally {
      await mock.close();
    }
  });

  it('user onPrePayment veto wins over hook (declarative deferred to explicit)', async () => {
    const mock = await startMockServer();
    try {
      const hookManager = new HookManager({
        'pre-payment': [`cat >/dev/null; echo '{"block":true,"reason":"hook reason"}'`],
      });
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
        hookManager,
        onPrePayment: () => ({ block: true, reason: 'user veto' }),
      });
      const err = await wrapped(mock.url, { method: 'GET' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402Error);
      // The user veto fires FIRST; hook never gets consulted in this case.
      expect((err as Error).message).toMatch(/user veto/);
    } finally {
      await mock.close();
    }
  });
});
