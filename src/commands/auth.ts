/**
 * `frqncy-harness auth <subcommand>` — manage stored API keys.
 *
 * v0.2 subcommands:
 *   status                 show which providers have keys (env or stored), without revealing them
 *   set <provider> <key>   store an API key for a provider
 *   unset <provider>       remove a stored key
 *   path                   print the auth store path
 *
 * v0.3 will add:
 *   login <provider>       OAuth login (Anthropic Claude Max first)
 *   logout <provider>      revoke + remove OAuth tokens
 */
import {
  AUTH_PROVIDERS,
  ENV_VAR_BY_PROVIDER,
  DEFAULT_AUTH_PATH,
  loadAuthStore,
  saveAuthStore,
  type AuthProvider,
} from '../auth/index.js';

export type AuthSubcommand = 'status' | 'set' | 'unset' | 'path' | 'login' | 'logout';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const STATUS_GLYPH = {
  env: `${ANSI.green}env${ANSI.reset}`,
  stored: `${ANSI.cyan}stored${ANSI.reset}`,
  missing: `${ANSI.dim}missing${ANSI.reset}`,
};

function maskKey(key: string): string {
  if (key.length < 8) return '***';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

function isAuthProvider(s: string): s is AuthProvider {
  return (AUTH_PROVIDERS as readonly string[]).includes(s);
}

export async function runAuthCommand(subcommand: AuthSubcommand, args: string[]): Promise<void> {
  switch (subcommand) {
    case 'path':
      process.stdout.write(DEFAULT_AUTH_PATH + '\n');
      return;

    case 'status': {
      const store = await loadAuthStore();
      process.stdout.write(`\n${ANSI.bold}${ANSI.cyan}@frqncy-network/harness auth status${ANSI.reset}\n\n`);
      for (const provider of AUTH_PROVIDERS) {
        const envVar = ENV_VAR_BY_PROVIDER[provider];
        const envVal = process.env[envVar];
        const storedVal = store.apiKeys[provider];
        let glyph: string;
        let detail: string;
        if (envVal && envVal.length > 0) {
          glyph = STATUS_GLYPH.env;
          detail = `${envVar}=${maskKey(envVal)}`;
        } else if (storedVal && storedVal.length > 0) {
          glyph = STATUS_GLYPH.stored;
          detail = `(${maskKey(storedVal)})`;
        } else {
          glyph = STATUS_GLYPH.missing;
          detail = `set with: frqncy-harness auth set ${provider} <key>`;
        }
        process.stdout.write(`  ${glyph.padEnd(30)} ${ANSI.bold}${provider}${ANSI.reset.padEnd(0)} ${ANSI.dim}${detail}${ANSI.reset}\n`);
      }
      process.stdout.write(`\n${ANSI.dim}env > stored. To override a stored key, just export the env var.${ANSI.reset}\n`);
      process.stdout.write(
        `${ANSI.dim}OAuth login is NOT supported (Anthropic ToS prohibits OAuth tokens from Free/Pro/Max accounts in third-party tools).${ANSI.reset}\n\n`,
      );
      return;
    }

    case 'set': {
      const provider = args[0];
      const key = args[1];
      if (!provider || !key) {
        throw new Error('Usage: frqncy-harness auth set <provider> <key>');
      }
      if (!isAuthProvider(provider)) {
        throw new Error(`Unknown provider: ${provider}. Known: ${AUTH_PROVIDERS.join(', ')}`);
      }
      const store = await loadAuthStore();
      store.apiKeys[provider] = key;
      await saveAuthStore(store);
      process.stdout.write(`stored ${provider} key (${maskKey(key)}). File mode 0600 at ${DEFAULT_AUTH_PATH}.\n`);
      return;
    }

    case 'unset': {
      const provider = args[0];
      if (!provider) throw new Error('Usage: frqncy-harness auth unset <provider>');
      if (!isAuthProvider(provider)) {
        throw new Error(`Unknown provider: ${provider}. Known: ${AUTH_PROVIDERS.join(', ')}`);
      }
      const store = await loadAuthStore();
      if (!store.apiKeys[provider]) {
        process.stderr.write(`${ANSI.dim}(no stored key for ${provider})${ANSI.reset}\n`);
        return;
      }
      delete store.apiKeys[provider];
      await saveAuthStore(store);
      process.stdout.write(`unset ${provider}\n`);
      return;
    }

    case 'login':
    case 'logout':
      throw new Error(
        `'${subcommand}' is not supported. Anthropic's 2026 Authentication and credential use policy ` +
          `prohibits using OAuth tokens from Claude Free/Pro/Max accounts in third-party tools. ` +
          `Use API keys instead: 'frqncy-harness auth set <provider> <api-key>' (or set the env var). ` +
          `Anthropic API keys come from console.anthropic.com — Claude Max users have these too, billed separately from chat usage.`,
      );

    default:
      throw new Error(`Unknown auth subcommand: ${subcommand}`);
  }
}
