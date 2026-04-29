/**
 * web_fetch with ctx.fetch override — confirms the agent loop's
 * payment-wrapped fetch flows through the tool's HTTP call so 402'd URLs
 * get auto-paid without the LLM invoking the `pay` tool explicitly.
 *
 * Offline. Mocks a 402 server, builds a real wrapFetchWithPayment, hands it
 * to webFetchTool via ToolContext.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { webFetchTool } from '../src/tools/web.js';
import {
  wrapFetchWithPayment,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
} from '../src/payments/index.js';
import type { ToolContext } from '../src/tools/index.js';
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

interface MockHandle {
  url: string;
  paymentsReceived: number;
  close(): Promise<void>;
}

async function startMock402(): Promise<MockHandle> {
  let paymentsReceived = 0;
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
    paymentsReceived++;
    const settled = {
      success: true,
      transaction: '0xwebfetchtx',
      network: 'base-sepolia',
      payer: '0x1111111111111111111111111111111111111111',
    };
    res.setHeader(
      X402_RESPONSE_HEADER,
      Buffer.from(JSON.stringify(settled), 'utf-8').toString('base64'),
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: 'paid premium content' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    get paymentsReceived() {
      return paymentsReceived;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('web_fetch with ctx.fetch override', () => {
  it('uses ctx.fetch when provided', async () => {
    const mock = await startMock402();
    try {
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
      });
      const ctx: ToolContext = {
        conversationId: 'test',
        cwd: '/tmp',
        fetch: wrapped,
      };
      const result = await webFetchTool.execute({ url: mock.url }, ctx);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body).data).toBe('paid premium content');
      // Confirm the wrapped fetch actually paid (the mock saw an X-PAYMENT)
      expect(mock.paymentsReceived).toBe(1);
    } finally {
      await mock.close();
    }
  });

  it('falls back to global fetch when ctx.fetch is unset (back-compat)', async () => {
    // Server that just returns 200 without any payment requirement
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const ctx: ToolContext = { conversationId: 'test', cwd: '/tmp' };
      const result = await webFetchTool.execute(
        { url: `http://127.0.0.1:${port}/` },
        ctx,
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe('hello');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes through 402 errors when ctx.fetch is unset (no auto-pay)', async () => {
    const mock = await startMock402();
    try {
      // No ctx.fetch — uses global fetch which has no x402 awareness
      const ctx: ToolContext = { conversationId: 'test', cwd: '/tmp' };
      const result = await webFetchTool.execute({ url: mock.url }, ctx);
      expect(result.status).toBe(402);
      expect(mock.paymentsReceived).toBe(0);
    } finally {
      await mock.close();
    }
  });
});
