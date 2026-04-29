/**
 * `pay quote <url>` — preview x402 pricing without paying.
 *
 * Confirms:
 *   - Hits the URL with no payment header
 *   - Renders the parsed 402 body in human-readable form
 *   - --json emits structured output
 *   - Non-402 responses produce a "not paywalled" message
 *   - Malformed 402 body throws a clear error
 *
 * Offline. In-process mock server returns crafted 402 bodies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { runPayCommand } from '../src/commands/pay.js';

interface MockHandle {
  url: string;
  close(): Promise<void>;
}

async function startMockServer(opts: { status: number; body: unknown }): Promise<MockHandle> {
  const server = createServer((_req, res) => {
    res.writeHead(opts.status, { 'Content-Type': 'application/json' });
    res.end(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
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

const FAKE_REQS = [
  {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '50000',
    resource: 'http://example.com/data',
    description: 'Premium data',
    mimeType: 'application/json',
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    extra: { name: 'USDC', version: '2' },
  },
];

describe('pay quote', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown) => {
        captured.push(typeof chunk === 'string' ? chunk : String(chunk));
        return true;
      }) as unknown as typeof process.stdout.write);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('renders pricing for a 402 response', async () => {
    const mock = await startMockServer({
      status: 402,
      body: { x402Version: 1, error: 'X-PAYMENT header is required', accepts: FAKE_REQS },
    });
    try {
      await runPayCommand('quote', [mock.url]);
      const output = captured.join('');
      expect(output).toMatch(/x402 v1/);
      expect(output).toMatch(/exact on base-sepolia/);
      expect(output).toMatch(/\$0\.05/); // 50000 atomic = 5¢
      expect(output).toMatch(/Premium data/);
      expect(output).toMatch(/0x036CbD53842c5426634e7929541eC2318f3dCF7e/);
      expect(output).toMatch(/0x2222222222222222222222222222222222222222/);
    } finally {
      await mock.close();
    }
  });

  it('emits structured JSON with --json', async () => {
    const mock = await startMockServer({
      status: 402,
      body: { x402Version: 1, error: 'X-PAYMENT header is required', accepts: FAKE_REQS },
    });
    try {
      await runPayCommand('quote', [mock.url, '--json']);
      const output = captured.join('');
      const parsed = JSON.parse(output);
      expect(parsed.url).toBe(mock.url);
      expect(parsed.x402Version).toBe(1);
      expect(parsed.accepts).toHaveLength(1);
      expect(parsed.accepts[0].maxAmountRequired).toBe('50000');
    } finally {
      await mock.close();
    }
  });

  it('reports cleanly when the URL is not paywalled (200 response)', async () => {
    const mock = await startMockServer({ status: 200, body: 'hello' });
    try {
      await runPayCommand('quote', [mock.url]);
      const output = captured.join('');
      expect(output).toMatch(/returned 200/);
      expect(output).toMatch(/not an x402 paywalled endpoint/);
    } finally {
      await mock.close();
    }
  });

  it('--json mode reports the not-paywalled case as paymentRequired:false', async () => {
    const mock = await startMockServer({ status: 200, body: 'hello' });
    try {
      await runPayCommand('quote', [mock.url, '--json']);
      const output = captured.join('');
      const parsed = JSON.parse(output);
      expect(parsed.paymentRequired).toBe(false);
      expect(parsed.status).toBe(200);
    } finally {
      await mock.close();
    }
  });

  it('throws on malformed 402 body', async () => {
    const mock = await startMockServer({
      status: 402,
      body: { wrong: 'shape', no: 'accepts' },
    });
    try {
      await expect(runPayCommand('quote', [mock.url])).rejects.toThrow(/PaymentRequiredBody/);
    } finally {
      await mock.close();
    }
  });

  it('throws on non-JSON 402 body', async () => {
    const mock = await startMockServer({ status: 402, body: 'plain text not json' });
    try {
      await expect(runPayCommand('quote', [mock.url])).rejects.toThrow(/not JSON|JSON/);
    } finally {
      await mock.close();
    }
  });

  it('throws when no URL is provided', async () => {
    await expect(runPayCommand('quote', [])).rejects.toThrow(/Usage:/);
  });

  it('renders multiple accepts in human-readable mode', async () => {
    const mock = await startMockServer({
      status: 402,
      body: {
        x402Version: 1,
        error: 'X-PAYMENT header is required',
        accepts: [
          FAKE_REQS[0]!,
          { ...FAKE_REQS[0]!, network: 'polygon', maxAmountRequired: '25000' },
        ],
      },
    });
    try {
      await runPayCommand('quote', [mock.url]);
      const output = captured.join('');
      expect(output).toMatch(/2 acceptable payment requirement\(s\)/);
      expect(output).toMatch(/exact on base-sepolia/);
      expect(output).toMatch(/exact on polygon/);
      expect(output).toMatch(/\$0\.05/);
      expect(output).toMatch(/\$0\.02/); // 25000 atomic
    } finally {
      await mock.close();
    }
  });
});
