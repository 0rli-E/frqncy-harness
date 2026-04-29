/**
 * createPaymentToolset wiring — confirms traceContext + hookManager flow
 * through to the underlying `pay` HarnessTool's wrapped fetch, so when the
 * toolset is installed in an agent run the LLM's payments produce trace
 * records and consult pre-payment hooks.
 *
 * Offline. Mocks the upstream 402 server; spies on the toolset's behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  createPaymentToolset,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
} from '../src/payments/index.js';
import { HookManager } from '../src/hooks/index.js';
import { getTraceFilePath } from '../src/trace.js';
import type { Signer, Eip712TypedData } from '../src/wallet/index.js';

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

async function startMock402(): Promise<MockServer> {
  const server = createServer((req, res) => {
    const headerName = X402_REQUEST_HEADER.toLowerCase();
    if (!req.headers[headerName]) {
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          x402Version: 1,
          error: 'X-PAYMENT header is required',
          accepts: [
            {
              scheme: 'exact',
              network: 'base-sepolia',
              maxAmountRequired: '5000',
              resource: `http://localhost:${(server.address() as { port: number }).port}/`,
              description: 'mock',
              mimeType: 'application/json',
              payTo: '0x2222222222222222222222222222222222222222',
              maxTimeoutSeconds: 60,
              asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              extra: { name: 'USDC', version: '2' },
            },
          ],
        }),
      );
      return;
    }
    const settled = {
      success: true,
      transaction: '0xtoolsetx',
      network: 'base-sepolia',
      payer: '0x1111111111111111111111111111111111111111',
    };
    res.setHeader(
      X402_RESPONSE_HEADER,
      Buffer.from(JSON.stringify(settled), 'utf-8').toString('base64'),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, msg: 'paid via toolset' }));
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

describe('createPaymentToolset', () => {
  it('produces pay + discoverAgents tools', () => {
    const toolset = createPaymentToolset({ signer: fakeSigner() });
    expect(toolset.pay).toBeDefined();
    expect(toolset.discoverAgents).toBeDefined();
    expect(toolset.pay.name).toBe('pay');
    expect(toolset.discoverAgents.name).toBe('discover_agents');
  });

  it('pay tool flags carry the right lethal-trifecta posture', () => {
    const toolset = createPaymentToolset({ signer: fakeSigner() });
    expect(toolset.pay.flags.privateData).toBe(true);
    expect(toolset.pay.flags.outboundNetwork).toBe(true);
    expect(toolset.pay.flags.untrustedContent).toBe(false);
    // pay is propose-then-approve so the LLM can't single-handedly drain a wallet
    expect(toolset.pay.permission).toBe('propose-then-approve');
  });

  it('discoverAgents is auto-permission and read-only network', () => {
    const toolset = createPaymentToolset({ signer: fakeSigner() });
    expect(toolset.discoverAgents.permission).toBe('auto');
    expect(toolset.discoverAgents.flags.privateData).toBe(false);
    expect(toolset.discoverAgents.flags.untrustedContent).toBe(false);
    expect(toolset.discoverAgents.flags.outboundNetwork).toBe(true);
  });

  describe('with traceContext', () => {
    let traceDir: string;
    beforeEach(async () => {
      traceDir = await fs.mkdtemp(join(tmpdir(), 'frqncy-toolset-'));
    });
    afterEach(async () => {
      await fs.rm(traceDir, { recursive: true, force: true });
    });

    it('appends payment trace records when pay tool executes', async () => {
      const mock = await startMock402();
      try {
        const conversationId = randomUUID();
        const startedAt = new Date('2026-04-29T00:00:00Z');
        const toolset = createPaymentToolset({
          signer: fakeSigner(),
          traceContext: { conversationId, startedAt, traceDir },
        });

        // Invoke the pay tool directly (bypass approval — it's auto in tests
        // when no permission gate is wired into the standalone execute()).
        // Note: HarnessTool.execute() doesn't gate by permission tier — the
        // gating happens in toAiSdkTool. So invoking execute() directly
        // simulates the case where the LLM's approval has already passed.
        const result = await toolset.pay.execute(
          {
            url: mock.url,
            method: 'GET',
            maxAtomic: '10000',
          },
          { conversationId, cwd: '/tmp' },
        );
        expect(result.ok).toBe(true);
        expect(result.paid).toBe(true);
        expect(result.payment?.txHash).toBe('0xtoolsetx');

        // Trace file should now have a payment record
        const path = getTraceFilePath(conversationId, startedAt, traceDir);
        const raw = await fs.readFile(path, 'utf-8');
        const records = raw
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l));
        expect(records).toHaveLength(1);
        expect(records[0].type).toBe('payment');
        expect(records[0].content.txHash).toBe('0xtoolsetx');
      } finally {
        await mock.close();
      }
    });
  });

  describe('with hookManager', () => {
    it('vetoes payments when a pre-payment hook returns block:true', async () => {
      const mock = await startMock402();
      try {
        const hookManager = new HookManager({
          'pre-payment': [
            `cat >/dev/null; echo '{"block":true,"reason":"toolset veto"}'`,
          ],
        });
        const toolset = createPaymentToolset({
          signer: fakeSigner(),
          hookManager,
        });
        const result = await toolset.pay.execute(
          { url: mock.url, method: 'GET', maxAtomic: '10000' },
          { conversationId: 'test', cwd: '/tmp' },
        );
        expect(result.ok).toBe(false);
        expect(result.paid).toBe(false);
        expect(result.error).toMatch(/pre_payment_blocked/);
        expect(result.error).toMatch(/toolset veto/);
      } finally {
        await mock.close();
      }
    });

    it('allows payments when no pre-payment hook is configured', async () => {
      const mock = await startMock402();
      try {
        const hookManager = new HookManager({});
        const toolset = createPaymentToolset({
          signer: fakeSigner(),
          hookManager,
        });
        const result = await toolset.pay.execute(
          { url: mock.url, method: 'GET', maxAtomic: '10000' },
          { conversationId: 'test', cwd: '/tmp' },
        );
        expect(result.ok).toBe(true);
        expect(result.paid).toBe(true);
      } finally {
        await mock.close();
      }
    });
  });
});
