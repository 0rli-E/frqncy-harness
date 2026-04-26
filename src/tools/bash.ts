/**
 * `bash` tool — execute a shell command inside the sandbox.
 *
 * Per the locked decision (B section in HARNESS-DEFAULTS-REVIEW.md), bash is
 * the headline tool. The Vercel d0 case study showed bash + filesystem alone
 * outperforms hand-tuned tool palettes on capable models. File primitives
 * and web tools come next, but bash is the foundation.
 *
 * Permission tier: propose-then-approve (decision A1) — bash can do anything.
 * Lethal-trifecta flags: outboundNetwork (curl/wget) + privateData (read FS).
 * The user controls untrustedContent by what they let through to the prompt.
 */
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { HarnessTool } from './index.js';

export const BashInputSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute. Runs through `bash -c`.'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(300_000)
    .optional()
    .describe('Timeout in milliseconds. Default: 30000. Max: 300000 (5 min).'),
});

export type BashInput = z.infer<typeof BashInputSchema>;

export interface BashOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  cwd: string;
}

const MAX_OUTPUT_BYTES = 256 * 1024; // 256KB cap per stream

export const bashTool: HarnessTool<BashInput, BashOutput> = {
  name: 'bash',
  description:
    'Execute a shell command inside the agent sandbox. Returns stdout, stderr, exit code, and duration. ' +
    'Use this for reading files, running tests, git operations, package management, anything that has a CLI. ' +
    'Commands run via `bash -c`. The cwd is set to the sandbox directory; absolute paths can escape the sandbox.',
  inputSchema: BashInputSchema,
  flags: {
    privateData: true, // can read anything on the filesystem
    outboundNetwork: true, // curl, wget, etc.
  },
  permission: 'propose-then-approve',
  execute: async ({ command, timeout_ms }, ctx) => {
    const cwd = ctx.cwd;
    const timeout = timeout_ms ?? 30_000;
    const startMs = Date.now();

    return new Promise<BashOutput>((resolve) => {
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: {
          ...process.env,
          PWD: cwd,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
          if (stdoutBytes >= MAX_OUTPUT_BYTES) stdoutTruncated = true;
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
          if (stderrBytes >= MAX_OUTPUT_BYTES) stderrTruncated = true;
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Force kill after grace period
        setTimeout(() => {
          if (!child.killed) child.kill('SIGKILL');
        }, 2000).unref();
      }, timeout);
      timer.unref();

      child.on('close', (exitCode) => {
        clearTimeout(timer);
        stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        stderr = Buffer.concat(stderrChunks).toString('utf-8');
        if (timedOut) {
          stderr = (stderr + `\n[harness] command exceeded ${timeout}ms timeout, killed`).trim();
        }
        ctx.log?.({
          level: timedOut || (exitCode ?? 0) !== 0 ? 'warn' : 'info',
          message: 'bash exec',
          data: { command, exitCode, durationMs: Date.now() - startMs, timedOut, cwd },
        });
        resolve({
          stdout,
          stderr,
          exitCode: exitCode ?? -1,
          durationMs: Date.now() - startMs,
          truncated: stdoutTruncated || stderrTruncated,
          cwd,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: `[harness] failed to spawn bash: ${err.message}`,
          exitCode: -1,
          durationMs: Date.now() - startMs,
          truncated: false,
          cwd,
        });
      });
    });
  },
};
