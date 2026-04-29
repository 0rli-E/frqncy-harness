/**
 * ERC-8004 identity tests — offline.
 *
 * Covers:
 *   - AgentCard composer (`withIdentity`, `withPayments`, `withA2A`) immutability
 *   - Erc8004RegistrationFile serialization round-trips the spec shape
 *   - formatAgentRegistry produces CAIP-style strings
 *   - serveAgentCard responds with the right JSON at the .well-known paths
 */
import { describe, it, expect } from 'vitest';
import {
  AgentCardSchema,
  withIdentity,
  withPayments,
  withA2A,
  toErc8004RegistrationFile,
  toAgentRegistrationProof,
  toA2AAgentCard,
  formatAgentRegistry,
  serveAgentCard,
  type AgentCard,
} from '../src/identity/index.js';
import { REGISTRATION_TYPE_V1 } from '../src/identity/abi.js';

function baseCard(): AgentCard {
  return AgentCardSchema.parse({
    name: 'test-agent',
    description: 'A test agent.',
    url: 'https://api.example.com',
    endpoint: 'https://api.example.com',
  });
}

describe('AgentCard composers', () => {
  it('withIdentity adds a registration entry', () => {
    const card = baseCard();
    const next = withIdentity(card, {
      agentId: 42,
      agentRegistry: 'eip155:8453:0xdead',
      trustModels: ['reputation'],
    });
    // Original is untouched (immutable composition)
    expect(card.registrations).toBeUndefined();
    // Next has the new entry
    expect(next.registrations).toEqual([{ agentId: 42, agentRegistry: 'eip155:8453:0xdead' }]);
    expect(next.trustModels).toEqual(['reputation']);
  });

  it('withIdentity dedupes trust models', () => {
    let card = baseCard();
    card = withIdentity(card, {
      agentId: 1,
      agentRegistry: 'eip155:8453:0xa',
      trustModels: ['reputation'],
    });
    card = withIdentity(card, {
      agentId: 2,
      agentRegistry: 'eip155:8453:0xb',
      trustModels: ['reputation', 'tee-attestation'],
    });
    expect(card.trustModels).toEqual(['reputation', 'tee-attestation']);
    expect(card.registrations).toHaveLength(2);
  });

  it('withPayments stamps x402 networks + prices', () => {
    const card = baseCard();
    const next = withPayments(card, {
      networks: ['base'],
      defaultPriceUsdcAtomic: '10000',
      resources: { '/premium': { priceUsdcAtomic: '100000', description: 'premium' } },
    });
    expect(next.payments?.x402?.enabled).toBe(true);
    expect(next.payments?.x402?.networks).toEqual(['base']);
    expect(next.payments?.x402?.defaultPriceUsdcAtomic).toBe('10000');
    expect(next.payments?.x402?.resources?.['/premium']?.priceUsdcAtomic).toBe('100000');
  });

  it('withPayments dedupes networks across calls', () => {
    let card = baseCard();
    card = withPayments(card, { networks: ['base'] });
    card = withPayments(card, { networks: ['base', 'base-sepolia'] });
    expect(card.payments?.x402?.networks).toEqual(['base', 'base-sepolia']);
  });

  it('withA2A appends an AP2 capability extension', () => {
    const card = baseCard();
    const next = withA2A(card, { ap2Roles: ['merchant'] });
    const ext = next.capabilities?.extensions ?? [];
    expect(ext).toHaveLength(1);
    expect(ext[0]?.uri).toBe('https://github.com/google-agentic-commerce/AP2');
    expect(ext[0]?.required).toBe(true); // merchant role is required
    expect(ext[0]?.params?.roles).toEqual(['merchant']);
  });

  it('withA2A is a no-op when no roles given', () => {
    const card = baseCard();
    const next = withA2A(card, {});
    expect(next.capabilities?.extensions).toBeUndefined();
  });

  it('withA2A replaces existing AP2 entry on rerun', () => {
    let card = baseCard();
    card = withA2A(card, { ap2Roles: ['merchant'] });
    card = withA2A(card, { ap2Roles: ['shopper'] });
    const ext = card.capabilities?.extensions ?? [];
    expect(ext).toHaveLength(1);
    expect(ext[0]?.params?.roles).toEqual(['shopper']);
    expect(ext[0]?.required).toBe(false);
  });
});

describe('toErc8004RegistrationFile', () => {
  it('produces an EIP-8004 v1 file with services derived from URL/endpoint', () => {
    let card = baseCard();
    card = withIdentity(card, { agentId: 7, agentRegistry: 'eip155:8453:0xdead' });
    card = withPayments(card, { networks: ['base'] });
    const file = toErc8004RegistrationFile(card);

    expect(file.type).toBe(REGISTRATION_TYPE_V1);
    expect(file.name).toBe('test-agent');
    expect(file.x402Support).toBe(true);
    expect(file.registrations).toEqual([{ agentId: 7, agentRegistry: 'eip155:8453:0xdead' }]);

    const services = file.services;
    const a2aSvc = services.find((s) => s.name === 'A2A');
    expect(a2aSvc?.endpoint).toBe('https://api.example.com/.well-known/agent-card.json');
    expect(a2aSvc?.version).toBe('0.3.0');
    const webSvc = services.find((s) => s.name === 'web');
    expect(webSvc?.endpoint).toBe('https://api.example.com');
  });

  it('honors a trailing slash on endpoint', () => {
    const card: AgentCard = AgentCardSchema.parse({
      name: 'a',
      description: 'b',
      endpoint: 'https://api.example.com/',
    });
    const file = toErc8004RegistrationFile(card);
    const a2aSvc = file.services.find((s) => s.name === 'A2A');
    expect(a2aSvc?.endpoint).toBe('https://api.example.com/.well-known/agent-card.json');
  });

  it('passes supportedTrust through', () => {
    let card = baseCard();
    card = withIdentity(card, {
      agentId: 1,
      agentRegistry: 'eip155:8453:0xdead',
      trustModels: ['reputation', 'tee-attestation'],
    });
    const file = toErc8004RegistrationFile(card);
    expect(file.supportedTrust).toEqual(['reputation', 'tee-attestation']);
  });
});

describe('toAgentRegistrationProof', () => {
  it('returns just the registrations array', () => {
    let card = baseCard();
    card = withIdentity(card, { agentId: 99, agentRegistry: 'eip155:8453:0xdead' });
    const proof = toAgentRegistrationProof(card);
    expect(proof).toEqual({ registrations: [{ agentId: 99, agentRegistry: 'eip155:8453:0xdead' }] });
  });
});

describe('toA2AAgentCard', () => {
  it('round-trips the schema', () => {
    const card = baseCard();
    const a2a = toA2AAgentCard(card);
    expect(a2a.name).toBe(card.name);
    expect(a2a.protocolVersion).toBe('0.3.0');
  });
});

describe('formatAgentRegistry', () => {
  it('formats CAIP-style', () => {
    expect(formatAgentRegistry(8453, '0xdead')).toBe('eip155:8453:0xdead');
  });
});

describe('serveAgentCard', () => {
  it('responds 200 at /.well-known/agent-card.json', async () => {
    const card = baseCard();
    const handle = await serveAgentCard({ card, port: 0 }); // port 0 = random
    try {
      const res = await fetch(`${handle.url}/.well-known/agent-card.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe(card.name);
    } finally {
      await handle.close();
    }
  });

  it('responds 200 at /.well-known/agent-registration.json with just registrations', async () => {
    let card = baseCard();
    card = withIdentity(card, { agentId: 5, agentRegistry: 'eip155:8453:0xdead' });
    const handle = await serveAgentCard({ card, port: 0 });
    try {
      const res = await fetch(`${handle.url}/.well-known/agent-registration.json`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ registrations: [{ agentId: 5, agentRegistry: 'eip155:8453:0xdead' }] });
    } finally {
      await handle.close();
    }
  });

  it('responds 200 at /healthz', async () => {
    const handle = await serveAgentCard({ card: baseCard(), port: 0 });
    try {
      const res = await fetch(`${handle.url}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: 'ok' });
    } finally {
      await handle.close();
    }
  });

  it('responds 404 for unknown paths', async () => {
    const handle = await serveAgentCard({ card: baseCard(), port: 0 });
    try {
      const res = await fetch(`${handle.url}/nope`);
      expect(res.status).toBe(404);
    } finally {
      await handle.close();
    }
  });

  it('serves OASF when provided', async () => {
    const handle = await serveAgentCard({
      card: baseCard(),
      port: 0,
      oasf: { skills: ['x', 'y'] },
    });
    try {
      const res = await fetch(`${handle.url}/.well-known/oasf-record.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ skills: ['x', 'y'] });
    } finally {
      await handle.close();
    }
  });

  it('handles CORS preflight', async () => {
    const handle = await serveAgentCard({ card: baseCard(), port: 0 });
    try {
      const res = await fetch(`${handle.url}/.well-known/agent-card.json`, {
        method: 'OPTIONS',
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    } finally {
      await handle.close();
    }
  });
});
