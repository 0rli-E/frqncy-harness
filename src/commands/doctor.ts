/**
 * `frqncy-harness doctor` — health check for setup.
 *
 * Verifies:
 *  - Node version
 *  - Provider API keys present (informational, doesn't test live calls in v0.1)
 *  - Trace directory writable
 *  - Config file readable (or absent — both fine)
 *  - gtr installed (advisory — needed in v0.2+ for sandbox)
 *  - git installed
 */
import { promises as fs } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../config.js';
import { DEFAULT_TRACE_DIR } from '../trace.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
}

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const STATUS_GLYPH: Record<CheckResult['status'], string> = {
  ok: `${ANSI.green}✓${ANSI.reset}`,
  warn: `${ANSI.yellow}!${ANSI.reset}`,
  fail: `${ANSI.red}✗${ANSI.reset}`,
  info: `${ANSI.dim}·${ANSI.reset}`,
};

export async function runDoctorCommand(): Promise<void> {
  const checks: CheckResult[] = [];

  // ── Node version ─────────────────────────────────────────────
  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split('.')[0]);
  checks.push({
    name: 'Node version',
    status: major >= 20 ? 'ok' : 'fail',
    message: `v${nodeVersion}${major >= 20 ? '' : ' (need >= 20)'}`,
  });

  // ── Provider API keys ────────────────────────────────────────
  const keyChecks = [
    { name: 'ANTHROPIC_API_KEY', envVar: 'ANTHROPIC_API_KEY' },
    { name: 'OPENAI_API_KEY', envVar: 'OPENAI_API_KEY' },
    { name: 'GOOGLE_GENERATIVE_AI_API_KEY', envVar: 'GOOGLE_GENERATIVE_AI_API_KEY' },
    { name: 'OPENROUTER_API_KEY', envVar: 'OPENROUTER_API_KEY' },
    { name: 'TAVILY_API_KEY (web_search)', envVar: 'TAVILY_API_KEY' },
    { name: 'BRAVE_SEARCH_API_KEY (web_search)', envVar: 'BRAVE_SEARCH_API_KEY' },
  ];
  for (const check of keyChecks) {
    const value = process.env[check.envVar];
    checks.push({
      name: check.name,
      status: value ? 'ok' : 'info',
      message: value ? 'set' : 'not set (only needed if you use this provider)',
    });
  }

  // ── External tools ───────────────────────────────────────────
  checks.push(checkCommand('git', 'git --version', 'needed for trace repo sync'));
  checks.push(checkCommand('gtr', 'git gtr version 2>/dev/null || gtr version', 'needed for v0.2 bash sandbox'));

  // ── Subscription provider CLIs ───────────────────────────────
  // If installed, the harness can use them via subprocess (claude-code/* and codex/*
  // model strings) — this draws on your $200/mo Claude Max / ChatGPT Pro
  // subscription quota instead of API tokens.
  checks.push(
    checkCommand('claude (Claude Code CLI)', 'claude --version', 'enables claude-code/* models — uses Claude Max subscription'),
  );
  checks.push(
    checkCommand('codex (OpenAI Codex CLI)', 'codex --version', 'enables codex/* models — uses ChatGPT Pro subscription'),
  );

  // ── Config file ──────────────────────────────────────────────
  try {
    await loadConfig();
    const exists = await fileExists(DEFAULT_CONFIG_PATH);
    checks.push({
      name: 'Config file',
      status: 'ok',
      message: exists ? `loaded from ${DEFAULT_CONFIG_PATH}` : 'using defaults (no config file yet)',
    });
  } catch (err) {
    checks.push({
      name: 'Config file',
      status: 'fail',
      message: `malformed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ── Trace directory writable ─────────────────────────────────
  try {
    await fs.mkdir(DEFAULT_TRACE_DIR, { recursive: true });
    const probe = join(DEFAULT_TRACE_DIR, '.frqncy-harness-doctor-probe');
    await fs.writeFile(probe, '');
    await fs.unlink(probe);
    checks.push({
      name: 'Trace directory writable',
      status: 'ok',
      message: DEFAULT_TRACE_DIR,
    });
  } catch (err) {
    checks.push({
      name: 'Trace directory writable',
      status: 'fail',
      message: `${DEFAULT_TRACE_DIR} — ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // ── Trace repo git remote ────────────────────────────────────
  try {
    const traceGitDir = join(DEFAULT_TRACE_DIR, '.git');
    const isRepo = await fileExists(traceGitDir);
    if (isRepo) {
      try {
        const remote = execSync(`git -C "${DEFAULT_TRACE_DIR}" remote get-url origin 2>/dev/null`, {
          encoding: 'utf-8',
        }).trim();
        checks.push({
          name: 'Trace git remote',
          status: 'ok',
          message: remote,
        });
      } catch {
        checks.push({
          name: 'Trace git remote',
          status: 'warn',
          message: 'trace dir is a git repo but no `origin` remote set',
        });
      }
    } else {
      checks.push({
        name: 'Trace git remote',
        status: 'info',
        message: `${DEFAULT_TRACE_DIR} is not a git repo yet (see HARNESS-PLAN.md decision 7)`,
      });
    }
  } catch {
    // ignore
  }

  // ── Print ────────────────────────────────────────────────────
  process.stdout.write(`\n${ANSI.bold}${ANSI.cyan}@frqncy-network/harness doctor${ANSI.reset}\n\n`);
  for (const check of checks) {
    process.stdout.write(`  ${STATUS_GLYPH[check.status]}  ${check.name.padEnd(48)} ${ANSI.dim}${check.message}${ANSI.reset}\n`);
  }
  process.stdout.write('\n');

  const failures = checks.filter((c) => c.status === 'fail');
  if (failures.length > 0) {
    process.stdout.write(`${ANSI.red}${failures.length} check(s) failed${ANSI.reset}\n`);
    process.exit(1);
  } else {
    process.stdout.write(`${ANSI.green}all checks passed${ANSI.reset}\n`);
  }
}

function checkCommand(displayName: string, command: string, helpText: string): CheckResult {
  try {
    const out = execSync(command, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { name: displayName, status: 'ok', message: out.split('\n')[0] ?? 'installed' };
  } catch {
    return { name: displayName, status: 'warn', message: `not installed (${helpText})` };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
