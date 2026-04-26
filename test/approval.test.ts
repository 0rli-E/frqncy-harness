import { describe, it, expect } from 'vitest';
import { ApprovalManager } from '../src/approval.js';

describe('ApprovalManager', () => {
  it('auto-approves auto-permission tools without consulting callback', async () => {
    let called = false;
    const manager = new ApprovalManager({
      callback: async () => {
        called = true;
        return false;
      },
    });
    const result = await manager.request({
      toolName: 'read',
      input: {},
      permission: 'auto',
      flags: {},
    });
    expect(result).toBe(true);
    expect(called).toBe(false);
  });

  it('always approves when yolo=true', async () => {
    const manager = new ApprovalManager({ yolo: true });
    const result = await manager.request({
      toolName: 'bash',
      input: {},
      permission: 'propose-then-approve',
      flags: {},
    });
    expect(result).toBe(true);
  });

  it('default-denies propose-then-approve when no callback', async () => {
    const manager = new ApprovalManager();
    const result = await manager.request({
      toolName: 'bash',
      input: {},
      permission: 'propose-then-approve',
      flags: {},
    });
    expect(result).toBe(false);
  });

  it('remembers per-conversation approval', async () => {
    let callCount = 0;
    const manager = new ApprovalManager({
      callback: async () => {
        callCount++;
        return true;
      },
    });

    // First call asks
    await manager.request({ toolName: 'bash', input: {}, permission: 'propose-then-approve', flags: {} });
    expect(callCount).toBe(1);

    // Second call to same tool doesn't ask
    await manager.request({ toolName: 'bash', input: {}, permission: 'propose-then-approve', flags: {} });
    expect(callCount).toBe(1);

    // Different tool asks again
    await manager.request({ toolName: 'write', input: {}, permission: 'propose-then-approve', flags: {} });
    expect(callCount).toBe(2);
  });

  it('preApprove skips the callback', async () => {
    let called = false;
    const manager = new ApprovalManager({
      callback: async () => {
        called = true;
        return false;
      },
    });
    manager.preApprove('bash');
    const result = await manager.request({
      toolName: 'bash',
      input: {},
      permission: 'propose-then-approve',
      flags: {},
    });
    expect(result).toBe(true);
    expect(called).toBe(false);
  });
});
