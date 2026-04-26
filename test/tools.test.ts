import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { detectLethalTrifecta, toAiSdkTool, type HarnessTool } from '../src/tools/index.js';

const readOnlyTool: HarnessTool = {
  name: 'read_only',
  description: 'reads things',
  inputSchema: z.object({}),
  flags: { privateData: true },
  permission: 'auto',
  execute: async () => ({ ok: true }),
};

const writeTool: HarnessTool = {
  name: 'write',
  description: 'writes things',
  inputSchema: z.object({ path: z.string() }),
  flags: { privateData: true },
  permission: 'propose-then-approve',
  execute: async () => ({ ok: true }),
};

const networkTool: HarnessTool = {
  name: 'fetch',
  description: 'fetches the web',
  inputSchema: z.object({ url: z.string().url() }),
  flags: { untrustedContent: true, outboundNetwork: true },
  permission: 'auto',
  execute: async () => ({ ok: true }),
};

describe('detectLethalTrifecta', () => {
  it('detects no trifecta with single tool', () => {
    expect(detectLethalTrifecta([readOnlyTool])).toEqual({
      privateData: true,
      untrustedContent: false,
      outboundNetwork: false,
      isTrifecta: false,
    });
  });

  it('detects partial flags', () => {
    expect(detectLethalTrifecta([readOnlyTool, networkTool])).toEqual({
      privateData: true,
      untrustedContent: true,
      outboundNetwork: true,
      isTrifecta: true,
    });
  });

  it('flags trifecta when all three present across toolset', () => {
    const result = detectLethalTrifecta([readOnlyTool, writeTool, networkTool]);
    expect(result.isTrifecta).toBe(true);
  });

  it('returns no trifecta with empty toolset', () => {
    expect(detectLethalTrifecta([])).toEqual({
      privateData: false,
      untrustedContent: false,
      outboundNetwork: false,
      isTrifecta: false,
    });
  });
});

describe('toAiSdkTool', () => {
  it('wraps a HarnessTool with description and schema', () => {
    const wrapped = toAiSdkTool(readOnlyTool, { conversationId: 'test', cwd: '/tmp' });
    expect(wrapped.description).toBe('reads things');
    expect(wrapped.inputSchema).toBeDefined();
  });

  it('rejects propose-then-approve tools when no callback configured', async () => {
    const wrapped = toAiSdkTool(writeTool, { conversationId: 'test', cwd: '/tmp' });
    // Cast around AI SDK's strict typing for test purposes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (wrapped as any).execute;
    const result = await exec({ path: '/tmp/foo' }, {});
    expect(result.error).toBe('permission_required');
  });

  it('approves when callback returns true', async () => {
    const callback = async () => true;
    const wrapped = toAiSdkTool(writeTool, { conversationId: 'test', cwd: '/tmp' }, callback);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (wrapped as any).execute;
    const result = await exec({ path: '/tmp/foo' }, {});
    expect(result).toEqual({ ok: true });
  });

  it('denies when callback returns false', async () => {
    const callback = async () => false;
    const wrapped = toAiSdkTool(writeTool, { conversationId: 'test', cwd: '/tmp' }, callback);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (wrapped as any).execute;
    const result = await exec({ path: '/tmp/foo' }, {});
    expect(result.error).toBe('permission_denied');
  });

  it('returns invalid_input for off-schema input', async () => {
    const wrapped = toAiSdkTool(writeTool, { conversationId: 'test', cwd: '/tmp' }, async () => true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (wrapped as any).execute;
    const result = await exec({ wrongField: 123 }, {});
    expect(result.error).toBe('invalid_input');
  });

  it('returns execution_failed when the tool throws', async () => {
    const throwingTool: HarnessTool = {
      ...readOnlyTool,
      execute: async () => {
        throw new Error('boom');
      },
    };
    const wrapped = toAiSdkTool(throwingTool, { conversationId: 'test', cwd: '/tmp' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec = (wrapped as any).execute;
    const result = await exec({}, {});
    expect(result.error).toBe('execution_failed');
    expect(result.message).toBe('boom');
  });
});
