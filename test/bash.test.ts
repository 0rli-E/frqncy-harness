import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { bashTool } from '../src/tools/bash.js';

describe('bashTool.execute', () => {
  it('runs a simple echo command', async () => {
    const result = await bashTool.execute(
      { command: 'echo hello world' },
      { conversationId: 'test', cwd: tmpdir() },
    );
    expect(result.stdout.trim()).toBe('hello world');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await bashTool.execute(
      { command: 'echo to-stderr 1>&2 && echo to-stdout' },
      { conversationId: 'test', cwd: tmpdir() },
    );
    expect(result.stdout.trim()).toBe('to-stdout');
    expect(result.stderr.trim()).toBe('to-stderr');
  });

  it('reports non-zero exit codes', async () => {
    const result = await bashTool.execute(
      { command: 'exit 42' },
      { conversationId: 'test', cwd: tmpdir() },
    );
    expect(result.exitCode).toBe(42);
  });

  it('runs in the given cwd', async () => {
    const result = await bashTool.execute(
      { command: 'pwd' },
      { conversationId: 'test', cwd: tmpdir() },
    );
    // tmpdir() may have a /private/ prefix on macOS; just check it ends right
    expect(result.stdout.trim()).toContain('tmp');
  });

  it('enforces timeout', async () => {
    const result = await bashTool.execute(
      { command: 'sleep 10', timeout_ms: 200 },
      { conversationId: 'test', cwd: tmpdir() },
    );
    // exitCode is non-zero (kill signal); stderr should mention timeout
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('timeout');
    expect(result.durationMs).toBeLessThan(2000);
  });

  it('declares the trifecta flags it carries', () => {
    expect(bashTool.flags.privateData).toBe(true);
    expect(bashTool.flags.outboundNetwork).toBe(true);
  });

  it('requires propose-then-approve', () => {
    expect(bashTool.permission).toBe('propose-then-approve');
  });
});
