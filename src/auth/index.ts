/**
 * Auth subsystem.
 *
 * v0.2 ships:
 *   - Stored API keys at ~/.frqncy-harness/auth/keys.json (file mode 0600)
 *   - `frqncy-harness auth status/set/unset` CLI commands
 *   - Provider lookup falls back from env var → stored key
 *
 * v0.3 will add:
 *   - Anthropic OAuth via Claude Max (PKCE flow matching Claude Code)
 *   - Token refresh + secure storage
 *   - `frqncy-harness auth login/logout` for OAuth providers
 *
 * Until then, the user pastes an API key into the auth store. Same security
 * properties as `~/.aws/credentials` or `~/.npmrc` — file mode 0600, no
 * encryption beyond filesystem permissions.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_AUTH_PATH = join(homedir(), '.frqncy-harness', 'auth', 'keys.json');

export const AUTH_PROVIDERS = [
  // LLM providers
  'anthropic',
  'openai',
  'google',
  'openrouter',
  // Web search providers (used by web_search tool)
  'tavily',
  'brave',
] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const ENV_VAR_BY_PROVIDER: Record<AuthProvider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  tavily: 'TAVILY_API_KEY',
  brave: 'BRAVE_SEARCH_API_KEY',
};

export const AuthStoreSchema = z.object({
  /** Stored API keys per provider. Loaded as fallback when env var is unset. */
  apiKeys: z.record(z.enum(AUTH_PROVIDERS), z.string()).default({}),
  /** OAuth token storage placeholder — empty in v0.2; populated by v0.3 OAuth flow */
  oauthTokens: z.record(z.string(), z.unknown()).default({}),
});
export type AuthStore = z.infer<typeof AuthStoreSchema>;

export async function loadAuthStore(path = DEFAULT_AUTH_PATH): Promise<AuthStore> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const json = JSON.parse(raw);
    return AuthStoreSchema.parse(json);
  } catch (err) {
    if (isFileNotFound(err)) {
      return AuthStoreSchema.parse({});
    }
    throw err;
  }
}

export async function saveAuthStore(store: AuthStore, path = DEFAULT_AUTH_PATH): Promise<void> {
  const validated = AuthStoreSchema.parse(store);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Write to a tmp file and rename to atomically update; set 0600
  const tmp = path + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, path);
}

/**
 * Resolve an API key for a provider.
 * Order: env var → stored key → undefined.
 *
 * The harness's provider modules call this; the AI SDK providers honor either
 * an explicit `apiKey` option or the env var, so we set the env var if a stored
 * key is found and the env var is empty (so we don't have to fork every SDK).
 */
export async function resolveApiKey(provider: AuthProvider): Promise<string | undefined> {
  const envVar = ENV_VAR_BY_PROVIDER[provider];
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.length > 0) return fromEnv;

  try {
    const store = await loadAuthStore();
    const stored = store.apiKeys[provider];
    if (stored && stored.length > 0) {
      // Inject into env so the AI SDK provider modules pick it up uniformly
      process.env[envVar] = stored;
      return stored;
    }
  } catch {
    // Auth store unreadable — return undefined; downstream will surface a
    // clean "API key missing" error via the AI SDK.
  }
  return undefined;
}

/**
 * Hydrate all stored API keys into env vars in one shot. Call this at CLI
 * startup so subsequent provider lookups don't need to be async.
 */
export async function hydrateApiKeysIntoEnv(): Promise<void> {
  try {
    const store = await loadAuthStore();
    for (const provider of AUTH_PROVIDERS) {
      const envVar = ENV_VAR_BY_PROVIDER[provider];
      if (!process.env[envVar]) {
        const stored = store.apiKeys[provider];
        if (stored) process.env[envVar] = stored;
      }
    }
  } catch {
    // best-effort
  }
}

function isFileNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
