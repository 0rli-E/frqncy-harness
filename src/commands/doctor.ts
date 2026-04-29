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
    { name: 'CHUTES_API_KEY (DeAI lane)', envVar: 'CHUTES_API_KEY' },
    { name: 'PERPLEXITY_API_KEY (search-grounded lane)', envVar: 'PERPLEXITY_API_KEY' },
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

  // ── SDK provider — Claude Agent SDK package ──────────────────
  // Lazy-imported by src/providers/sdk.ts at first use. Installed → claude-sdk/* lane works.
  try {
    const { isClaudeAgentSdkAvailable } = await import('../providers/sdk.js');
    const present = await isClaudeAgentSdkAvailable();
    checks.push({
      name: '@anthropic-ai/claude-agent-sdk',
      status: present ? 'ok' : 'info',
      message: present
        ? 'installed — enables claude-sdk/* models (in-process agent loop, real per-token cost)'
        : 'not installed — claude-sdk/* models will fail until `npm install @anthropic-ai/claude-agent-sdk`',
    });
  } catch {
    checks.push({
      name: '@anthropic-ai/claude-agent-sdk',
      status: 'info',
      message: 'unable to probe (sdk.ts import failed)',
    });
  }

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

  // ── Hooks (v0.5+) ────────────────────────────────────────────
  try {
    const config = await loadConfig();
    if (config.hooks === undefined) {
      checks.push({
        name: 'Hooks',
        status: 'ok',
        message: 'using defaults: post-agent → auto-commit-traces + macos-notification',
      });
    } else {
      const counts = {
        'pre-agent': config.hooks['pre-agent']?.length ?? 0,
        'post-tool-use': config.hooks['post-tool-use']?.length ?? 0,
        'post-agent': config.hooks['post-agent']?.length ?? 0,
      };
      const total = counts['pre-agent'] + counts['post-tool-use'] + counts['post-agent'];
      checks.push({
        name: 'Hooks',
        status: total > 0 ? 'ok' : 'info',
        message: total > 0
          ? `pre=${counts['pre-agent']} post-tool=${counts['post-tool-use']} post-agent=${counts['post-agent']}`
          : 'configured but empty (no hooks will fire)',
      });
    }
  } catch {
    // Config malformed — already reported above
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

  // ── Wallet + commerce (ERC-8004 + x402) ──────────────────────
  await checkWalletAndCommerce(checks);

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

/**
 * Surface ERC-8004 + x402 readiness:
 *   - viem peer dep installed?
 *   - @coinbase/cdp-sdk peer dep installed?
 *   - any wallet credentials (CDP or private key) discoverable?
 *   - which network are we on, and what are the registry / USDC addresses?
 *
 * All checks are non-fatal — a user who never wants to register an agent or
 * pay an x402 endpoint shouldn't see red here. We surface 'info' when the
 * commerce stack isn't configured, 'warn' for partial configurations, and
 * 'ok' when both creds and the peer dep are present.
 */
async function checkWalletAndCommerce(checks: CheckResult[]): Promise<void> {
  // viem peer dep
  let viemAvailable = false;
  try {
    await import(/* @vite-ignore */ 'viem' as string);
    viemAvailable = true;
    checks.push({ name: 'viem (peer)', status: 'ok', message: 'installed' });
  } catch {
    checks.push({
      name: 'viem (peer)',
      status: 'info',
      message: 'not installed — needed for ERC-8004 + x402 (run: npm install viem)',
    });
  }

  // CDP SDK peer dep
  let cdpAvailable = false;
  try {
    await import(/* @vite-ignore */ '@coinbase/cdp-sdk' as string);
    cdpAvailable = true;
    checks.push({ name: '@coinbase/cdp-sdk (peer)', status: 'ok', message: 'installed' });
  } catch {
    checks.push({
      name: '@coinbase/cdp-sdk (peer)',
      status: 'info',
      message: 'not installed — needed for CDP wallet (run: npm install @coinbase/cdp-sdk)',
    });
  }

  // Wallet credentials
  try {
    const { loadWalletCredentials, resolveNetwork, getNetworkInfo } = await import('../wallet/index.js');
    const creds = await loadWalletCredentials();
    const network = resolveNetwork();
    const info = getNetworkInfo(network);

    const hasCdp = !!(creds.cdpApiKeyId && creds.cdpApiKeySecret && creds.cdpWalletSecret);
    const hasPk = !!creds.privateKey;

    if (hasCdp) {
      checks.push({
        name: 'Wallet (CDP creds)',
        status: cdpAvailable ? 'ok' : 'warn',
        message: cdpAvailable
          ? 'CDP API key + secret + wallet secret present'
          : 'CDP creds present but @coinbase/cdp-sdk not installed',
      });
    } else if (hasPk) {
      checks.push({
        name: 'Wallet (private key)',
        status: viemAvailable ? 'ok' : 'warn',
        message: viemAvailable
          ? 'FRQNCY_AGENT_PRIVATE_KEY present (viem signer)'
          : 'private key present but viem not installed',
      });
    } else {
      checks.push({
        name: 'Wallet credentials',
        status: 'info',
        message:
          'no wallet credentials configured (set CDP_API_KEY_ID/_SECRET/_WALLET_SECRET or FRQNCY_AGENT_PRIVATE_KEY)',
      });
    }

    checks.push({
      name: 'Network (FRQNCY_NETWORK)',
      status: 'info',
      message: `${network} (chainId ${info.chainId})`,
    });
    checks.push({
      name: 'ERC-8004 IdentityRegistry',
      status: 'info',
      message: info.identityRegistry,
    });
    checks.push({
      name: 'USDC contract',
      status: 'info',
      message: info.usdc,
    });
    checks.push({
      name: 'x402 facilitator',
      status: 'info',
      message: info.defaultFacilitatorUrl,
    });
  } catch (err) {
    checks.push({
      name: 'Wallet check',
      status: 'warn',
      message: `failed: ${err instanceof Error ? err.message : String(err)}`,
    });
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
