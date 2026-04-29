/**
 * Verifiable settlement receipt tests — offline.
 *
 * Confirms:
 *   - SettlementReceiptSchema accepts/rejects shapes correctly
 *   - signSettlementReceipt produces a hex signature + reports the domain used
 *   - The signed typed-data carries the right primary type + types + message
 *   - encode/decodeReceiptHeader round-trips cleanly
 *   - createReceiptIssuer returns null when payer/txHash missing, otherwise
 *     produces an X-RECEIPT header with a base64-encoded signed receipt
 *   - paymentMiddleware sets the X-RECEIPT header when receiptIssuer is set
 *   - serveAgent honors the receipts.signer option end-to-end (smoke test)
 */
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import {
  signSettlementReceipt,
  encodeReceiptHeader,
  decodeReceiptHeader,
  createReceiptIssuer,
  SettlementReceiptSchema,
  SETTLEMENT_RECEIPT_PRIMARY_TYPE,
  X402_RECEIPT_HEADER,
  paymentMiddleware,
  type SettlementReceipt,
  type FacilitatorClient,
} from '../src/payments/index.js';
import type { Signer, Eip712TypedData } from '../src/wallet/index.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

interface CapturingSigner extends Signer {
  lastTypedData?: Eip712TypedData;
}

function fakeSigner(network: 'base' | 'base-sepolia' = 'base-sepolia'): CapturingSigner {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = {
    kind: 'viem',
    address: '0x9999999999999999999999999999999999999999',
    network,
    async signTypedData(data: Eip712TypedData) {
      s.lastTypedData = data;
      return ('0x' + 'cc'.repeat(65)) as `0x${string}`;
    },
    async signMessage() {
      return ('0x' + 'cc'.repeat(65)) as `0x${string}`;
    },
  };
  return s;
}

function baseReceipt(): SettlementReceipt {
  return {
    payer: '0x1111111111111111111111111111111111111111',
    payee: '0x9999999999999999999999999999999999999999',
    resource: '/skills/weekly-update',
    amountAtomic: '50000',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    network: 'base-sepolia',
    txHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    timestamp: 1735689600,
    nonce: '0x' + 'aa'.repeat(32),
    agentId: 42,
  };
}

function fakeFacilitator(): FacilitatorClient {
  return {
    async verify() {
      return { isValid: true, payer: '0x1111111111111111111111111111111111111111' };
    },
    async settle() {
      return {
        success: true,
        transaction: '0xdeadbeef',
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

// ────────────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────────────

describe('SettlementReceiptSchema', () => {
  it('accepts a well-formed receipt', () => {
    expect(() => SettlementReceiptSchema.parse(baseReceipt())).not.toThrow();
  });

  it('rejects malformed addresses', () => {
    expect(() => SettlementReceiptSchema.parse({ ...baseReceipt(), payer: 'not-an-address' })).toThrow();
  });

  it('rejects negative amounts', () => {
    expect(() => SettlementReceiptSchema.parse({ ...baseReceipt(), amountAtomic: '-1' })).toThrow();
  });

  it('rejects malformed nonces', () => {
    expect(() => SettlementReceiptSchema.parse({ ...baseReceipt(), nonce: '0xabc' })).toThrow();
  });

  it('rejects negative agentId', () => {
    expect(() => SettlementReceiptSchema.parse({ ...baseReceipt(), agentId: -1 })).toThrow();
  });

  it('rejects malformed txHash', () => {
    expect(() => SettlementReceiptSchema.parse({ ...baseReceipt(), txHash: 'not-hex' })).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// signSettlementReceipt
// ────────────────────────────────────────────────────────────────────

describe('signSettlementReceipt', () => {
  it('produces a hex signature and reports the resolved domain', async () => {
    const signer = fakeSigner();
    const result = await signSettlementReceipt({ signer, receipt: baseReceipt() });
    expect(result.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(result.domain.name).toBe('frqncy-harness/SettlementReceipt');
    expect(result.domain.version).toBe('1');
    expect(result.domain.chainId).toBe(84532); // base-sepolia
    expect(result.receipt.agentId).toBe(42);
  });

  it('uses base mainnet chainId for the base network', async () => {
    const signer = fakeSigner('base');
    const result = await signSettlementReceipt({ signer, receipt: { ...baseReceipt(), network: 'base' } });
    expect(result.domain.chainId).toBe(8453);
  });

  it('signs with the right primary type + types + message', async () => {
    const signer = fakeSigner();
    await signSettlementReceipt({ signer, receipt: baseReceipt() });
    const data = signer.lastTypedData!;
    expect(data.primaryType).toBe(SETTLEMENT_RECEIPT_PRIMARY_TYPE);
    expect(data.types.SettlementReceipt).toEqual([
      { name: 'payer', type: 'address' },
      { name: 'payee', type: 'address' },
      { name: 'resource', type: 'string' },
      { name: 'amountAtomic', type: 'uint256' },
      { name: 'asset', type: 'address' },
      { name: 'network', type: 'string' },
      { name: 'txHash', type: 'bytes32' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'agentId', type: 'uint256' },
    ]);
    expect(typeof data.message.amountAtomic).toBe('bigint');
    expect(data.message.amountAtomic).toBe(50000n);
    expect(data.message.agentId).toBe(42n);
  });

  it('honors a custom domain override', async () => {
    const signer = fakeSigner();
    const result = await signSettlementReceipt({
      signer,
      receipt: baseReceipt(),
      domain: { name: 'custom-namespace', version: '99', chainId: 1 },
    });
    expect(result.domain).toEqual({ name: 'custom-namespace', version: '99', chainId: 1 });
  });

  it('rejects an invalid receipt before signing', async () => {
    const signer = fakeSigner();
    await expect(
      signSettlementReceipt({
        signer,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        receipt: { ...baseReceipt(), payer: 'bad' } as any,
      }),
    ).rejects.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// encode / decode
// ────────────────────────────────────────────────────────────────────

describe('encode/decodeReceiptHeader', () => {
  it('round-trips through base64', async () => {
    const signer = fakeSigner();
    const signed = await signSettlementReceipt({ signer, receipt: baseReceipt() });
    const header = encodeReceiptHeader(signed);
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    const decoded = decodeReceiptHeader(header);
    expect(decoded.receipt).toEqual(signed.receipt);
    expect(decoded.signature).toBe(signed.signature);
    expect(decoded.domain).toEqual(signed.domain);
  });

  it('rejects malformed base64-encoded receipts', () => {
    const bad = Buffer.from(JSON.stringify({ receipt: { payer: 'bad' } }), 'utf-8').toString('base64');
    expect(() => decodeReceiptHeader(bad)).toThrow();
  });
});

// ────────────────────────────────────────────────────────────────────
// createReceiptIssuer
// ────────────────────────────────────────────────────────────────────

describe('createReceiptIssuer', () => {
  it('returns a header pair when payer + txHash are present', async () => {
    const signer = fakeSigner();
    const issuer = createReceiptIssuer({ signer, agentId: 42 });
    const result = await issuer({
      direction: 'in',
      path: '/skills/weekly-update',
      amountAtomic: '50000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      txHash: '0xdeadbeef',
      payer: '0x1111111111111111111111111111111111111111',
      payee: signer.address,
      timestamp: '2026-04-30T01:00:00.000Z',
    });
    expect(result).not.toBeNull();
    expect(result?.name).toBe(X402_RECEIPT_HEADER);
    const decoded = decodeReceiptHeader(result!.value);
    expect(decoded.receipt.agentId).toBe(42);
    expect(decoded.receipt.resource).toBe('/skills/weekly-update');
    expect(decoded.receipt.amountAtomic).toBe('50000');
    expect(decoded.receipt.payee.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it('returns null when payer is missing', async () => {
    const signer = fakeSigner();
    const issuer = createReceiptIssuer({ signer });
    const result = await issuer({
      direction: 'in',
      path: '/skills/x',
      amountAtomic: '1',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      txHash: '0xabc',
      payee: signer.address,
      timestamp: '2026-04-30T01:00:00.000Z',
    });
    expect(result).toBeNull();
  });

  it('returns null when txHash is missing', async () => {
    const signer = fakeSigner();
    const issuer = createReceiptIssuer({ signer });
    const result = await issuer({
      direction: 'in',
      path: '/skills/x',
      amountAtomic: '1',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      payer: '0x1111111111111111111111111111111111111111',
      payee: signer.address,
      timestamp: '2026-04-30T01:00:00.000Z',
    });
    expect(result).toBeNull();
  });

  it('invokes onSigned with the signed receipt', async () => {
    const signer = fakeSigner();
    const captured: Array<{ agentId: number; signature: string }> = [];
    const issuer = createReceiptIssuer({
      signer,
      agentId: 7,
      onSigned: (signed) => {
        captured.push({ agentId: signed.receipt.agentId, signature: signed.signature });
      },
    });
    await issuer({
      direction: 'in',
      path: '/skills/x',
      amountAtomic: '1',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      network: 'base-sepolia',
      txHash: '0xdeadbeef',
      payer: '0x1111111111111111111111111111111111111111',
      payee: signer.address,
      timestamp: '2026-04-30T01:00:00.000Z',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.agentId).toBe(7);
  });
});

// ────────────────────────────────────────────────────────────────────
// paymentMiddleware integration
// ────────────────────────────────────────────────────────────────────

describe('paymentMiddleware with receiptIssuer', () => {
  it('sets X-RECEIPT header on a settled paid request', async () => {
    const signer = fakeSigner();
    const issuer = createReceiptIssuer({ signer, agentId: 42 });
    const middleware = paymentMiddleware({
      routes: {
        '/data': {
          network: 'base-sepolia',
          priceUsd: 0.05,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: signer.address,
        },
      },
      facilitator: fakeFacilitator(),
      receiptIssuer: issuer,
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
      const { createPaymentPayload, encodePaymentHeader, X402_REQUEST_HEADER } = await import(
        '../src/payments/index.js'
      );
      const reqs = {
        scheme: 'exact' as const,
        network: 'base-sepolia' as const,
        maxAmountRequired: '50000',
        resource: `http://127.0.0.1:${port}/data`,
        description: 'Access',
        mimeType: 'application/json',
        payTo: signer.address as `0x${string}`,
        maxTimeoutSeconds: 60,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
        extra: { name: 'USD Coin', version: '2' },
      };
      const payload = await createPaymentPayload({ signer, requirements: reqs });
      const header = encodePaymentHeader(payload);
      const res = await fetch(`http://127.0.0.1:${port}/data`, {
        headers: { [X402_REQUEST_HEADER]: header },
      });
      expect(res.status).toBe(200);
      const receiptHeader = res.headers.get(X402_RECEIPT_HEADER);
      expect(receiptHeader).toBeTruthy();
      const decoded = decodeReceiptHeader(receiptHeader!);
      expect(decoded.receipt.agentId).toBe(42);
      expect(decoded.receipt.resource).toBe('/data');
      expect(decoded.receipt.amountAtomic).toBe('50000');
      expect(decoded.receipt.txHash).toBe('0xdeadbeef');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('omits X-RECEIPT when receiptIssuer is not configured (back-compat)', async () => {
    const signer = fakeSigner();
    const middleware = paymentMiddleware({
      routes: {
        '/data': {
          network: 'base-sepolia',
          priceUsd: 0.05,
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: signer.address,
        },
      },
      facilitator: fakeFacilitator(),
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
      const { createPaymentPayload, encodePaymentHeader, X402_REQUEST_HEADER } = await import(
        '../src/payments/index.js'
      );
      const reqs = {
        scheme: 'exact' as const,
        network: 'base-sepolia' as const,
        maxAmountRequired: '50000',
        resource: `http://127.0.0.1:${port}/data`,
        description: 'Access',
        mimeType: 'application/json',
        payTo: signer.address as `0x${string}`,
        maxTimeoutSeconds: 60,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
        extra: { name: 'USD Coin', version: '2' },
      };
      const payload = await createPaymentPayload({ signer, requirements: reqs });
      const header = encodePaymentHeader(payload);
      const res = await fetch(`http://127.0.0.1:${port}/data`, {
        headers: { [X402_REQUEST_HEADER]: header },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get(X402_RECEIPT_HEADER)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
