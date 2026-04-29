/**
 * x402 payments tests — offline.
 *
 * Covers:
 *   - Schemas reject malformed payloads
 *   - createPaymentPayload + encodePaymentHeader / decodePaymentHeader
 *   - Budget tracker math + soft/hard thresholds
 *   - wrapFetchWithPayment full flow against a mock 402 server
 *   - paymentMiddleware returns 402 → verifies → settles → emits header
 *
 * The Signer used in these tests is a fake that returns a deterministic 65-byte
 * "signature" without doing any crypto. Real signature verification happens at
 * the facilitator layer, which we mock as well.
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import {
  PaymentRequirementsSchema,
  PaymentRequiredBodySchema,
  PaymentPayloadSchema,
  createBudgetState,
  checkBudget,
  recordSpend,
  formatAtomicUsdc,
  usdCentsToUsdcAtomic,
  createPaymentPayload,
  encodePaymentHeader,
  decodePaymentHeader,
  wrapFetchWithPayment,
  X402Error,
  paymentMiddleware,
  X402_REQUEST_HEADER,
  X402_RESPONSE_HEADER,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  type PaymentRequirements,
  type FacilitatorClient,
} from '../src/payments/index.js';
import type { Signer, Eip712TypedData } from '../src/wallet/index.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function fakeSigner(): Signer & {
  lastTypedData?: Eip712TypedData;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = {
    kind: 'viem',
    address: '0x1111111111111111111111111111111111111111',
    network: 'base-sepolia',
    async signTypedData(data: Eip712TypedData) {
      s.lastTypedData = data;
      // 65-byte zero signature (deterministic for golden-vector tests)
      return ('0x' + '00'.repeat(65)) as `0x${string}`;
    },
    async signMessage(_m: unknown) {
      return ('0x' + '00'.repeat(65)) as `0x${string}`;
    },
  };
  return s;
}

function baseRequirements(): PaymentRequirements {
  return PaymentRequirementsSchema.parse({
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000', // $0.01
    resource: 'http://example.com/data',
    description: 'test',
    mimeType: 'application/json',
    payTo: '0x2222222222222222222222222222222222222222',
    maxTimeoutSeconds: 60,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    extra: { name: 'USDC', version: '2' },
  });
}

// ────────────────────────────────────────────────────────────────────
// Schemas
// ────────────────────────────────────────────────────────────────────

describe('PaymentRequirementsSchema', () => {
  it('accepts a well-formed requirements', () => {
    expect(() => baseRequirements()).not.toThrow();
  });

  it('rejects negative maxAmountRequired', () => {
    expect(() =>
      PaymentRequirementsSchema.parse({
        ...baseRequirements(),
        maxAmountRequired: '-1',
      }),
    ).toThrow();
  });

  it('rejects malformed addresses', () => {
    expect(() =>
      PaymentRequirementsSchema.parse({
        ...baseRequirements(),
        payTo: 'not-an-address',
      }),
    ).toThrow();
  });

  it('rejects invalid networks', () => {
    expect(() =>
      PaymentRequirementsSchema.parse({
        ...baseRequirements(),
        network: 'mainnet',
      }),
    ).toThrow();
  });
});

describe('PaymentRequiredBodySchema', () => {
  it('parses a 402 body', () => {
    const body = PaymentRequiredBodySchema.parse({
      x402Version: 1,
      error: 'X-PAYMENT header is required',
      accepts: [baseRequirements()],
    });
    expect(body.accepts).toHaveLength(1);
    expect(body.error).toBe('X-PAYMENT header is required');
  });
});

// ────────────────────────────────────────────────────────────────────
// Sign / encode / decode
// ────────────────────────────────────────────────────────────────────

describe('createPaymentPayload', () => {
  it('builds a valid PaymentPayload', async () => {
    const signer = fakeSigner();
    const payload = await createPaymentPayload({
      signer,
      requirements: baseRequirements(),
      nowSeconds: 1700000000,
    });
    expect(payload.x402Version).toBe(1);
    expect(payload.scheme).toBe('exact');
    expect(payload.network).toBe('base-sepolia');
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(payload.payload.authorization.from).toBe(signer.address);
    expect(payload.payload.authorization.to).toBe(
      '0x2222222222222222222222222222222222222222',
    );
    expect(payload.payload.authorization.value).toBe('10000');
    expect(payload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(payload.payload.authorization.validBefore)).toBe(
      BigInt(1700000000 + 60),
    );
    expect(BigInt(payload.payload.authorization.validAfter)).toBe(
      BigInt(1700000000 - 600),
    );
  });

  it('signs using TransferWithAuthorization typed data + USDC EIP-712 domain', async () => {
    const signer = fakeSigner();
    await createPaymentPayload({ signer, requirements: baseRequirements() });
    const data = signer.lastTypedData!;
    expect(data.primaryType).toBe(TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE);
    expect(data.types).toEqual(TRANSFER_WITH_AUTHORIZATION_TYPES);
    expect(data.domain.name).toBe('USDC');
    expect(data.domain.version).toBe('2');
    expect(Number(data.domain.chainId)).toBe(84532); // base-sepolia
    expect(data.domain.verifyingContract).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });

  it('falls back to USD Coin domain name when extra is missing', async () => {
    const signer = fakeSigner();
    const reqs = baseRequirements();
    delete reqs.extra;
    await createPaymentPayload({ signer, requirements: reqs });
    expect(signer.lastTypedData!.domain.name).toBe('USD Coin');
  });
});

describe('encode/decodePaymentHeader', () => {
  it('round-trips a payload through base64', async () => {
    const signer = fakeSigner();
    const payload = await createPaymentPayload({ signer, requirements: baseRequirements() });
    const header = encodePaymentHeader(payload);
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    const decoded = decodePaymentHeader(header);
    expect(decoded).toEqual(payload);
  });

  it('rejects malformed payloads on decode', () => {
    const bad = Buffer.from('{"hello":1}', 'utf-8').toString('base64');
    expect(() => decodePaymentHeader(bad)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// Budget
// ────────────────────────────────────────────────────────────────────

describe('budget', () => {
  it('formatAtomicUsdc renders cents-precision', () => {
    expect(formatAtomicUsdc(0n)).toBe('$0.00');
    expect(formatAtomicUsdc(100000n)).toBe('$0.10');
    expect(formatAtomicUsdc(1234560n)).toBe('$1.23');
  });

  it('usdCentsToUsdcAtomic converts cents → atomic', () => {
    expect(usdCentsToUsdcAtomic(50)).toBe(500_000n);
    expect(usdCentsToUsdcAtomic(500)).toBe(5_000_000n);
  });

  it('checkBudget returns soft/hard/none correctly', () => {
    const state = createBudgetState({ softWarnUsdCents: 10, hardAbortUsdCents: 100 });
    // Below soft
    expect(checkBudget(state, 50_000n).triggered).toBe('none');
    // Crosses soft
    expect(checkBudget(state, 200_000n).triggered).toBe('soft');
    // Exceeds hard
    expect(checkBudget(state, 2_000_000n).triggered).toBe('hard');
    expect(checkBudget(state, 2_000_000n).allowed).toBe(false);
  });

  it('recordSpend accumulates', () => {
    const state = createBudgetState();
    recordSpend(state, 100n);
    recordSpend(state, 200n);
    expect(state.spentAtomic).toBe(300n);
  });
});

// ────────────────────────────────────────────────────────────────────
// wrapFetchWithPayment — full happy path against a mock 402 server
// ────────────────────────────────────────────────────────────────────

interface MockServerHandle {
  url: string;
  paymentsReceived: string[];
  close(): Promise<void>;
}

async function startMock402Server(): Promise<MockServerHandle> {
  const paymentsReceived: string[] = [];
  const server = createServer((req, res) => {
    const headerName = X402_REQUEST_HEADER.toLowerCase();
    const header = req.headers[headerName];
    if (!header || typeof header !== 'string') {
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
    paymentsReceived.push(header);
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
    res.end(JSON.stringify({ paid: true, hello: 'world' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    paymentsReceived,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('wrapFetchWithPayment', () => {
  it('auto-pays a 402 and returns the resource on retry', async () => {
    const mock = await startMock402Server();
    try {
      const signer = fakeSigner();
      const traces: Array<{ amountAtomic: string; txHash?: string }> = [];
      const wrapped = wrapFetchWithPayment({
        signer,
        acceptedNetworks: ['base-sepolia'],
        onPayment: (record) => {
          traces.push({ amountAtomic: record.amountAtomic, txHash: record.txHash });
        },
      });
      const res = await wrapped(mock.url, { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ paid: true, hello: 'world' });
      expect(mock.paymentsReceived).toHaveLength(1);
      expect(traces).toHaveLength(1);
      expect(traces[0]?.amountAtomic).toBe('10000');
      expect(traces[0]?.txHash).toBe('0xdeadbeef');
    } finally {
      await mock.close();
    }
  });

  it('refuses to pay above maxPerCallAtomic', async () => {
    const mock = await startMock402Server();
    try {
      const signer = fakeSigner();
      const wrapped = wrapFetchWithPayment({
        signer,
        acceptedNetworks: ['base-sepolia'],
        maxPerCallAtomic: 1n, // 0.000001 USDC — way too small
      });
      await expect(wrapped(mock.url, { method: 'GET' })).rejects.toThrow(
        /no acceptable PaymentRequirements/i,
      );
      expect(mock.paymentsReceived).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('honors a pre-payment hook veto', async () => {
    const mock = await startMock402Server();
    try {
      const signer = fakeSigner();
      const wrapped = wrapFetchWithPayment({
        signer,
        acceptedNetworks: ['base-sepolia'],
        onPrePayment: () => ({ block: true, reason: 'unit test' }),
      });
      const err = await wrapped(mock.url, { method: 'GET' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402Error);
      expect((err as X402Error).code).toBe('pre_payment_blocked');
      expect(mock.paymentsReceived).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('aborts when the budget hard cap would be exceeded', async () => {
    const mock = await startMock402Server();
    try {
      const signer = fakeSigner();
      // Hard cap of $0.0001 — well below the mock's $0.01 charge
      const budget = createBudgetState({ softWarnUsdCents: 0, hardAbortUsdCents: 0 });
      // Force hardAbortAtomic to something tiny so the test is deterministic
      budget.hardAbortAtomic = 1n;
      budget.softWarnAtomic = 1n;
      const wrapped = wrapFetchWithPayment({
        signer,
        acceptedNetworks: ['base-sepolia'],
        budget,
      });
      const err = await wrapped(mock.url, { method: 'GET' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(X402Error);
      expect((err as X402Error).code).toBe('budget_exceeded');
      expect(mock.paymentsReceived).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('passes through non-402 responses unchanged', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hi');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const wrapped = wrapFetchWithPayment({
        signer: fakeSigner(),
        acceptedNetworks: ['base-sepolia'],
      });
      const res = await wrapped(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hi');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// paymentMiddleware — server side
// ────────────────────────────────────────────────────────────────────

describe('paymentMiddleware', () => {
  function fakeFacilitator(): FacilitatorClient {
    return {
      async verify() {
        return { isValid: true, payer: '0x1111111111111111111111111111111111111111' };
      },
      async settle() {
        return {
          success: true,
          transaction: '0xabc',
          network: 'base-sepolia',
          payer: '0x1111111111111111111111111111111111111111',
        };
      },
      async supported() {
        return { kinds: [] };
      },
      async discover() {
        return { items: [], pagination: { limit: 0, offset: 0, total: 0 } };
      },
    };
  }

  it('returns 402 with PaymentRequirements when no header is present', async () => {
    const middleware = paymentMiddleware({
      routes: {
        '/data': {
          network: 'base-sepolia',
          priceUsd: 0.01,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x3333333333333333333333333333333333333333',
        },
      },
      facilitator: fakeFacilitator(),
    });
    const server = createServer(async (req, res) => {
      await middleware(req, res, async () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/data`);
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.x402Version).toBe(1);
      expect(body.accepts[0].maxAmountRequired).toBe('10000'); // 0.01 USD * 1e6
      expect(body.accepts[0].network).toBe('base-sepolia');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('verifies + settles + emits X-PAYMENT-RESPONSE on a paid request', async () => {
    const inboundTraces: Array<{ amountAtomic: string; txHash?: string }> = [];
    const middleware = paymentMiddleware({
      routes: {
        '/data': {
          network: 'base-sepolia',
          priceUsd: 0.05,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x3333333333333333333333333333333333333333',
        },
      },
      facilitator: fakeFacilitator(),
      onPayment: (record) => {
        inboundTraces.push({ amountAtomic: record.amountAtomic, txHash: record.txHash });
      },
    });
    const server = createServer(async (req, res) => {
      await middleware(req, res, async () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const signer = fakeSigner();
      // Build a payload manually so we don't need the wrapper here
      const reqs = PaymentRequirementsSchema.parse({
        scheme: 'exact',
        network: 'base-sepolia',
        maxAmountRequired: '50000',
        resource: `http://127.0.0.1:${port}/data`,
        description: 'Access to /data',
        mimeType: 'application/json',
        payTo: '0x3333333333333333333333333333333333333333',
        maxTimeoutSeconds: 60,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        extra: { name: 'USD Coin', version: '2' },
      });
      const payload = await createPaymentPayload({ signer, requirements: reqs });
      const header = encodePaymentHeader(payload);

      const res = await fetch(`http://127.0.0.1:${port}/data`, {
        headers: { [X402_REQUEST_HEADER]: header },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const respHeader = res.headers.get(X402_RESPONSE_HEADER);
      expect(respHeader).toBeTruthy();
      const settled = JSON.parse(Buffer.from(respHeader!, 'base64').toString('utf-8'));
      expect(settled.success).toBe(true);
      expect(settled.transaction).toBe('0xabc');
      expect(inboundTraces).toHaveLength(1);
      expect(inboundTraces[0]?.amountAtomic).toBe('50000');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('passes through unmonetized routes', async () => {
    const middleware = paymentMiddleware({
      routes: {
        '/paid': {
          network: 'base-sepolia',
          priceUsd: 0.01,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x3333333333333333333333333333333333333333',
        },
      },
      facilitator: fakeFacilitator(),
    });
    const server = createServer(async (req, res) => {
      await middleware(req, res, async () => {
        res.writeHead(200);
        res.end('free');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/free`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('free');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects bad X-PAYMENT headers with 402', async () => {
    const middleware = paymentMiddleware({
      routes: {
        '/data': {
          network: 'base-sepolia',
          priceUsd: 0.01,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x3333333333333333333333333333333333333333',
        },
      },
      facilitator: fakeFacilitator(),
    });
    const server = createServer(async (req, res) => {
      await middleware(req, res, async () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/data`, {
        headers: { [X402_REQUEST_HEADER]: 'not-base64-json' },
      });
      expect(res.status).toBe(402);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('PaymentPayloadSchema', () => {
  it('rejects malformed nonces', () => {
    expect(() =>
      PaymentPayloadSchema.parse({
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: {
          signature: '0x' + '00'.repeat(65),
          authorization: {
            from: '0x1111111111111111111111111111111111111111',
            to: '0x2222222222222222222222222222222222222222',
            value: '10000',
            validAfter: '0',
            validBefore: '99999999',
            nonce: '0xabc', // too short
          },
        },
      }),
    ).toThrow();
  });
});
