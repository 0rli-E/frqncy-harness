/**
 * Bridges tests — Daydreams interop + Daydreams Router lane.
 *
 * Offline. Mocks the router with an in-process node:http server that emits
 * the 402 + PAYMENT-REQUIRED handshake, then accepts a permit and returns a
 * fake chat completion.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createServer } from 'node:http';
import {
  harnessToolToDaydreamsAction,
  daydreamsActionToHarnessTool,
  createDaydreamsExtension,
  daydreamsExtensionToHarnessTools,
  createDaydreamsRouterFetch,
  daydreamsRouterChat,
  daydreamsRouterModels,
  DAYDREAMS_PAYMENT_HEADER,
  DAYDREAMS_REQUIRED_HEADER,
  DAYDREAMS_SESSION_HEADER,
} from '../src/bridges/index.js';
import { signPermit, encodePermitHeader, decodePermitHeader } from '../src/payments/permit.js';
import type { HarnessTool, ToolContext } from '../src/tools/index.js';
import type { Signer, Eip712TypedData } from '../src/wallet/index.js';

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function fakeSigner(): Signer & { lastTypedData?: Eip712TypedData } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = {
    kind: 'viem',
    address: '0x1111111111111111111111111111111111111111',
    network: 'base-sepolia',
    async signTypedData(data: Eip712TypedData) {
      s.lastTypedData = data;
      return ('0x' + '11'.repeat(65)) as `0x${string}`;
    },
    async signMessage() {
      return ('0x' + '11'.repeat(65)) as `0x${string}`;
    },
  };
  return s;
}

function makeToolContext(): ToolContext {
  return { conversationId: 'test', cwd: '/tmp' };
}

function makeAddTool(): HarnessTool<{ a: number; b: number }, { sum: number }> {
  return {
    name: 'add',
    description: 'add two numbers',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    flags: {},
    permission: 'auto',
    async execute({ a, b }) {
      return { sum: a + b };
    },
  };
}

function makeRiskyTool(): HarnessTool<{ url: string }, { ok: true }> {
  return {
    name: 'spend',
    description: 'pretend to spend',
    inputSchema: z.object({ url: z.string().url() }),
    flags: { privateData: true, outboundNetwork: true },
    permission: 'propose-then-approve',
    async execute() {
      return { ok: true };
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// HarnessTool ↔ DaydreamsAction
// ────────────────────────────────────────────────────────────────────

describe('harnessToolToDaydreamsAction', () => {
  it('wraps a HarnessTool and returns the result', async () => {
    const action = harnessToolToDaydreamsAction(makeAddTool(), { toolContext: makeToolContext() });
    expect(action.name).toBe('add');
    const result = await action.handler({ a: 1, b: 2 }, {}, {});
    expect(result).toEqual({ sum: 3 });
  });

  it('honors propose-then-approve via the approval callback', async () => {
    const approvals: Array<{ approved: boolean }> = [];
    const action = harnessToolToDaydreamsAction(makeRiskyTool(), {
      toolContext: makeToolContext(),
      approval: async (req) => {
        approvals.push({ approved: req.toolName === 'spend' });
        return true;
      },
    });
    const result = await action.handler({ url: 'https://example.com' }, {}, {});
    expect(result).toEqual({ ok: true });
    expect(approvals).toHaveLength(1);
  });

  it('returns permission_required without an approval callback', async () => {
    const action = harnessToolToDaydreamsAction(makeRiskyTool(), { toolContext: makeToolContext() });
    const result = await action.handler({ url: 'https://example.com' }, {}, {});
    expect(result).toEqual(
      expect.objectContaining({ error: 'permission_required' }),
    );
  });

  it('returns permission_denied when the approval callback denies', async () => {
    const action = harnessToolToDaydreamsAction(makeRiskyTool(), {
      toolContext: makeToolContext(),
      approval: async () => false,
    });
    const result = await action.handler({ url: 'https://example.com' }, {}, {});
    expect(result).toEqual(expect.objectContaining({ error: 'permission_denied' }));
  });

  it('rejects malformed input with invalid_input', async () => {
    const action = harnessToolToDaydreamsAction(makeAddTool(), { toolContext: makeToolContext() });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await action.handler({ a: 'one', b: 2 } as any, {}, {});
    expect(result).toEqual(expect.objectContaining({ error: 'invalid_input' }));
  });

  it('catches handler exceptions as execution_failed', async () => {
    const tool: HarnessTool<{}, never> = {
      name: 'boom',
      description: 'always throws',
      inputSchema: z.object({}),
      flags: {},
      permission: 'auto',
      async execute() {
        throw new Error('kaboom');
      },
    };
    const action = harnessToolToDaydreamsAction(tool, { toolContext: makeToolContext() });
    const result = await action.handler({}, {}, {});
    expect(result).toEqual({ error: 'execution_failed', message: 'kaboom' });
  });
});

describe('daydreamsActionToHarnessTool', () => {
  it('wraps a Daydreams Action with a Zod schema', async () => {
    const action = {
      name: 'echo',
      description: 'echo back',
      schema: z.object({ msg: z.string() }),
      async handler({ msg }: { msg: string }) {
        return { reply: msg.toUpperCase() };
      },
    };
    const tool = daydreamsActionToHarnessTool(action);
    expect(tool.name).toBe('echo');
    const out = await tool.execute({ msg: 'hi' }, makeToolContext());
    expect(out).toEqual({ reply: 'HI' });
  });

  it('returns execution_failed when the action throws', async () => {
    const action = {
      name: 'bad',
      schema: z.object({}),
      async handler() {
        throw new Error('upstream broke');
      },
    };
    const tool = daydreamsActionToHarnessTool(action);
    const out = await tool.execute({}, makeToolContext());
    expect(out).toEqual({ error: 'execution_failed', message: 'upstream broke' });
  });

  it('defaults flags + permission to safe-but-network', () => {
    const action = { name: 'a', schema: z.object({}), async handler() {} };
    const tool = daydreamsActionToHarnessTool(action);
    expect(tool.flags.outboundNetwork).toBe(true);
    expect(tool.permission).toBe('auto');
  });

  it('honors flag overrides', () => {
    const action = { name: 'b', schema: z.object({}), async handler() {} };
    const tool = daydreamsActionToHarnessTool(action, {
      flags: { privateData: true, untrustedContent: true, outboundNetwork: true },
      permission: 'propose-then-approve',
    });
    expect(tool.flags.privateData).toBe(true);
    expect(tool.permission).toBe('propose-then-approve');
  });
});

describe('createDaydreamsExtension', () => {
  it('bundles tools into an Extension shape', () => {
    const ext = createDaydreamsExtension({
      tools: [makeAddTool()],
      toolContext: makeToolContext(),
    });
    expect(ext.name).toBe('frqncy-harness');
    expect(ext.actions).toHaveLength(1);
    expect(ext.actions?.[0]?.name).toBe('add');
  });

  it('applies a namespace prefix when provided', () => {
    const ext = createDaydreamsExtension({
      tools: [makeAddTool()],
      toolContext: makeToolContext(),
      prefix: 'harness.',
    });
    expect(ext.actions?.[0]?.name).toBe('harness.add');
  });
});

describe('daydreamsExtensionToHarnessTools', () => {
  it('lifts every action to a HarnessTool', () => {
    const ext = {
      name: 'demo',
      actions: [
        {
          name: 'a1',
          schema: z.object({ x: z.number() }),
          async handler({ x }: { x: number }) {
            return { y: x };
          },
        },
        {
          name: 'a2',
          schema: z.object({}),
          async handler() {
            return {};
          },
        },
      ],
    };
    const tools = daydreamsExtensionToHarnessTools(ext);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('a1');
    expect(tools[1]?.name).toBe('a2');
  });
});

// ────────────────────────────────────────────────────────────────────
// Permit signing
// ────────────────────────────────────────────────────────────────────

describe('signPermit + encode/decodePermitHeader', () => {
  it('signs a permit with the right typed-data domain', async () => {
    const signer = fakeSigner();
    const signed = await signPermit({
      signer,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenName: 'USDC',
      tokenVersion: '2',
      chainId: 84532,
      message: {
        owner: signer.address,
        spender: '0x2222222222222222222222222222222222222222',
        value: 1_000_000n,
        nonce: 0n,
        deadline: 9999999999n,
      },
    });
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(signed.v).toBe(0x11);
    expect(signed.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(signed.s).toMatch(/^0x[0-9a-f]{64}$/);
    const data = signer.lastTypedData!;
    expect(data.primaryType).toBe('Permit');
    expect(data.domain.name).toBe('USDC');
    expect(data.domain.chainId).toBe(84532);
    expect(data.domain.verifyingContract).toBe(
      '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    );
  });

  it('round-trips through base64 encode/decode', () => {
    const payload = {
      scheme: 'permit' as const,
      network: 'base-sepolia',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
      owner: '0x1111111111111111111111111111111111111111' as `0x${string}`,
      spender: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      value: '1000000',
      nonce: '0',
      deadline: '9999999999',
      signature: ('0x' + '11'.repeat(65)) as `0x${string}`,
      v: 27,
      r: ('0x' + '11'.repeat(32)) as `0x${string}`,
      s: ('0x' + '22'.repeat(32)) as `0x${string}`,
    };
    const header = encodePermitHeader(payload);
    expect(header).toMatch(/^[A-Za-z0-9+/=]+$/);
    const back = decodePermitHeader(header);
    expect(back).toEqual(payload);
  });
});

// ────────────────────────────────────────────────────────────────────
// Daydreams Router fetch — full handshake against a mock router
// ────────────────────────────────────────────────────────────────────

interface MockRouter {
  url: string;
  paymentsReceived: string[];
  close(): Promise<void>;
}

async function startMockRouter(): Promise<MockRouter> {
  const paymentsReceived: string[] = [];
  let nextSessionId = 1;
  const server = createServer((req, res) => {
    const headerName = DAYDREAMS_PAYMENT_HEADER.toLowerCase();
    const sessionHeader = req.headers[DAYDREAMS_SESSION_HEADER.toLowerCase()];
    const payment = req.headers[headerName];

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'anthropic:claude-sonnet-4-6',
              object: 'model',
              pricing: { input_per_1m: 3, output_per_1m: 15 },
            },
          ],
        }),
      );
      return;
    }

    if (typeof payment !== 'string') {
      const challenge = Buffer.from(
        JSON.stringify({
          spender: '0x3333333333333333333333333333333333333333',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          recommendedCap: '1000000',
        }),
        'utf-8',
      ).toString('base64');
      res.setHeader(DAYDREAMS_REQUIRED_HEADER, challenge);
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PAYMENT-SIGNATURE header is required' }));
      return;
    }

    paymentsReceived.push(payment);
    if (typeof sessionHeader !== 'string') {
      // Mint a session id on first paid request
      res.setHeader(DAYDREAMS_SESSION_HEADER, `sess_${nextSessionId++}`);
    }
    res.setHeader('X-Router-Selected-Model', 'anthropic:claude-sonnet-4-6');
    res.setHeader('X-Router-Tier', 'COMPLEX');
    res.setHeader('X-Router-Routed', 'true');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'cmpl_test',
        choices: [{ message: { role: 'assistant', content: 'pong' }, index: 0 }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    paymentsReceived,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('createDaydreamsRouterFetch', () => {
  it('performs the 402 → permit → retry handshake on first request', async () => {
    const mock = await startMockRouter();
    try {
      const signer = fakeSigner();
      const wrapped = createDaydreamsRouterFetch({
        signer,
        network: 'base-sepolia',
        baseUrl: mock.url,
        // Skip the chain-hop nonce read — fixed nonce for tests
        fetchNonce: async () => 0n,
      });
      const result = await daydreamsRouterChat(
        wrapped,
        {
          model: 'anthropic:claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'ping' }],
        },
        mock.url,
      );
      expect(result.status).toBe(200);
      expect(result.body.choices?.[0]?.message?.content).toBe('pong');
      expect(result.selectedModel).toBe('anthropic:claude-sonnet-4-6');
      expect(result.tier).toBe('COMPLEX');
      expect(result.routed).toBe(true);
      // The mock's challenge probe is the first paid request, the chat is the
      // second; both arrive after 402 retry. We don't pin a count here — what
      // matters is the wrapped fetch eventually got a 200.
      expect(mock.paymentsReceived.length).toBeGreaterThanOrEqual(1);
    } finally {
      await mock.close();
    }
  });

  it('decodes a valid permit header from the wrapped request', async () => {
    const mock = await startMockRouter();
    try {
      const signer = fakeSigner();
      const wrapped = createDaydreamsRouterFetch({
        signer,
        network: 'base-sepolia',
        baseUrl: mock.url,
        fetchNonce: async () => 0n,
      });
      await daydreamsRouterChat(
        wrapped,
        { model: 'auto', messages: [{ role: 'user', content: 'ping' }] },
        mock.url,
      );
      const header = mock.paymentsReceived[0]!;
      const decoded = decodePermitHeader(header);
      expect(decoded.scheme).toBe('permit');
      expect(decoded.network).toBe('base-sepolia');
      expect(decoded.owner.toLowerCase()).toBe(signer.address.toLowerCase());
      expect(decoded.value).toBe('1000000');
      expect(decoded.signature).toMatch(/^0x[0-9a-f]+$/i);
    } finally {
      await mock.close();
    }
  });

  it('skips payment for free endpoints', async () => {
    const mock = await startMockRouter();
    try {
      const signer = fakeSigner();
      const wrapped = createDaydreamsRouterFetch({
        signer,
        network: 'base-sepolia',
        baseUrl: mock.url,
        fetchNonce: async () => 0n,
      });
      const models = await daydreamsRouterModels(mock.url, wrapped);
      expect(models.data).toHaveLength(1);
      expect(models.data[0]?.id).toBe('anthropic:claude-sonnet-4-6');
      // Free endpoint should NOT have triggered a permit sign-and-pay
      expect(mock.paymentsReceived).toHaveLength(0);
    } finally {
      await mock.close();
    }
  });

  it('reuses an X-Upto-Session id across requests', async () => {
    const mock = await startMockRouter();
    try {
      const signer = fakeSigner();
      const wrapped = createDaydreamsRouterFetch({
        signer,
        network: 'base-sepolia',
        baseUrl: mock.url,
        fetchNonce: async () => 0n,
      });
      // First call — opens a session; second call — reuses it
      await daydreamsRouterChat(
        wrapped,
        { model: 'auto', messages: [{ role: 'user', content: 'first' }] },
        mock.url,
      );
      const before = mock.paymentsReceived.length;
      await daydreamsRouterChat(
        wrapped,
        { model: 'auto', messages: [{ role: 'user', content: 'second' }] },
        mock.url,
      );
      // Second call should NOT have added another challenge probe — just the
      // single retry with the same permit. Permits-received should only grow
      // by 1 (the second chat call).
      expect(mock.paymentsReceived.length).toBe(before + 1);
    } finally {
      await mock.close();
    }
  });
});
