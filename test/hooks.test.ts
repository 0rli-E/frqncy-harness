import { describe, it, expect, vi } from 'vitest';
import { HookManager, type HookContext, type HooksConfig } from '../src/hooks/index.js';

const POST_AGENT_CTX: HookContext = {
  event: 'post-agent',
  conversationId: '550e8400-e29b-41d4-a716-446655440000',
  model: 'openrouter/openrouter/free',
  prompt: 'test prompt',
  text: 'response text',
  status: 'completed',
  usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0 },
  traceFilePath: '/tmp/fake-trace.jsonl',
};

describe('HookManager — defaults', () => {
  it('uses bundled defaults when no user config given', async () => {
    const mgr = new HookManager(undefined);
    // Defaults include 2 post-agent hooks (auto-commit, notification)
    // We don't actually fire them here — just verify the manager constructed with defaults
    // by firing on an event with no user config and checking that something was attempted.
    // The bundled hooks themselves return success even when their side effects fail (e.g., no git repo).
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results.length).toBe(2);
    // Each result has a hookName
    expect(results.every((r) => r.hookName.startsWith('frqncy-harness-bundled:'))).toBe(true);
  });

  it('uses empty config when user explicitly sets `{}`', async () => {
    const mgr = new HookManager({});
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results).toEqual([]);
  });

  it('respects explicit empty array to disable an event', async () => {
    const cfg: HooksConfig = { 'post-agent': [] };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results).toEqual([]);
  });

  it('runs only enabled hooks (enabled: false skipped)', async () => {
    const cfg: HooksConfig = {
      'post-agent': [{ command: 'frqncy-harness-bundled:macos-notification', enabled: false }],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results).toEqual([]);
  });
});

describe('HookManager — bundled dispatch', () => {
  it('returns clear error for unknown bundled hook', async () => {
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:does-not-exist'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results.length).toBe(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain('Unknown bundled hook');
  });
});

describe('HookManager — shell hooks', () => {
  it('runs a shell command and captures success', async () => {
    const cfg: HooksConfig = { 'post-agent': ['true'] }; // /usr/bin/true exits 0
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results.length).toBe(1);
    expect(results[0]!.success).toBe(true);
  });

  it('captures non-zero exit as failure', async () => {
    const cfg: HooksConfig = { 'post-agent': ['exit 7'] };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results.length).toBe(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toContain('7');
  });

  it('respects per-hook timeout', async () => {
    const cfg: HooksConfig = {
      'post-agent': [{ command: 'sleep 5', timeoutMs: 200 }],
    };
    const mgr = new HookManager(cfg);
    const start = Date.now();
    const results = await mgr.fire(POST_AGENT_CTX);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000); // killed before sleep finished
    expect(results.length).toBe(1);
    // sleep was killed; could be either success (no output) or failure depending on signal handling
    // Just verify it didn't hang
  }, 5000);

  it('parses warning JSON from stdout', async () => {
    const cfg: HooksConfig = {
      'post-agent': [`echo '{"warning":"test warning"}'`],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toBe('test warning');
  });
});

describe('Bundled editorial-lint', () => {
  it('flags forbidden patterns in write tool input', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg: HooksConfig = {
      'post-tool-use': ['frqncy-harness-bundled:editorial-lint'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      event: 'post-tool-use',
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      toolName: 'write',
      input: { path: '/tmp/foo.md', contents: 'Welcome to the FRQNCY leaderboard!' },
      output: { path: '/tmp/foo.md', bytes_written: 31 },
      durationMs: 5,
    });
    expect(results.length).toBe(1);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toContain('leaderboard');
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('passes silently when no forbidden patterns', async () => {
    const cfg: HooksConfig = {
      'post-tool-use': ['frqncy-harness-bundled:editorial-lint'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      event: 'post-tool-use',
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      toolName: 'write',
      input: { path: '/tmp/clean.md', contents: 'A practice in cooperation and shared learning.' },
      output: { path: '/tmp/clean.md', bytes_written: 47 },
      durationMs: 5,
    });
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toBeUndefined();
  });

  it('skips non-write tools', async () => {
    const cfg: HooksConfig = {
      'post-tool-use': ['frqncy-harness-bundled:editorial-lint'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      event: 'post-tool-use',
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      toolName: 'bash',
      input: { command: 'echo leaderboard' }, // would be flagged if scanned
      output: { stdout: 'leaderboard\n', exitCode: 0 },
      durationMs: 5,
    });
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toBeUndefined();
  });
});

describe('Bundled auto-commit-traces', () => {
  it('skips gracefully when trace dir is not a git repo', async () => {
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:auto-commit-traces'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      ...POST_AGENT_CTX,
      traceFilePath: '/tmp/non-existent-dir/2026-04-27/test.jsonl',
    });
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toContain('not a git repo');
  });
});

describe('Bundled cost-cap-monitor (v0.7)', () => {
  it('is a no-op when no guardrails fired', async () => {
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:cost-cap-monitor'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toBeUndefined();
  });

  it('emits a warning when soft-warn fired', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:cost-cap-monitor'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      ...POST_AGENT_CTX,
      guardrails: {
        costSoftWarn: true,
        costHardAbort: false,
        trifectaWarn: false,
        cumulativeCostUsd: 5.42,
      },
    });
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toContain('soft warn');
    expect(results[0]!.warning).toContain('5.4200');
    stderrSpy.mockRestore();
  });

  it('escalates message when hard-abort fired', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:cost-cap-monitor'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      ...POST_AGENT_CTX,
      status: 'aborted_cost_cap',
      guardrails: {
        costSoftWarn: true,
        costHardAbort: true,
        trifectaWarn: false,
        cumulativeCostUsd: 25.01,
      },
    });
    expect(results[0]!.warning).toContain('HARD ABORT');
    stderrSpy.mockRestore();
  });
});

describe('Bundled trifecta-monitor (v0.7)', () => {
  it('is a no-op when trifecta did not trigger', async () => {
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:trifecta-monitor'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire(POST_AGENT_CTX);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toBeUndefined();
  });

  it('emits a warning when trifecta triggered', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const cfg: HooksConfig = {
      'post-agent': ['frqncy-harness-bundled:trifecta-monitor'],
    };
    const mgr = new HookManager(cfg);
    const results = await mgr.fire({
      ...POST_AGENT_CTX,
      guardrails: {
        costSoftWarn: false,
        costHardAbort: false,
        trifectaWarn: true,
        cumulativeCostUsd: 0,
      },
    });
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.warning).toContain('trifecta');
    stderrSpy.mockRestore();
  });
});

describe('Bundled macos-notification', () => {
  it('skips on non-macOS platforms', async () => {
    if (process.platform === 'darwin') {
      // On macOS this test is meaningless; just verify it runs without throwing
      const cfg: HooksConfig = {
        'post-agent': ['frqncy-harness-bundled:macos-notification'],
      };
      const mgr = new HookManager(cfg);
      const results = await mgr.fire(POST_AGENT_CTX);
      expect(results.length).toBe(1);
      // Result may succeed or fail depending on osascript availability
    } else {
      const cfg: HooksConfig = {
        'post-agent': ['frqncy-harness-bundled:macos-notification'],
      };
      const mgr = new HookManager(cfg);
      const results = await mgr.fire(POST_AGENT_CTX);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.warning).toContain('not on macOS');
    }
  });
});
