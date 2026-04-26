/**
 * Config loader.
 *
 * Lives at ~/.frqncy-harness/config.json. Validated against a Zod schema —
 * malformed configs throw on load rather than corrupting silently.
 *
 * Used by the CLI's `frqncy-harness config get/set/list/unset` commands.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';
import { ModelStringSchema } from './types.js';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.frqncy-harness', 'config.json');

export const ConfigSchema = z.object({
  /** Default model used when CLI commands don't specify one */
  defaultModel: ModelStringSchema.default('anthropic/claude-sonnet-4-6'),

  /** Cost guardrails per conversation (locked decision 10) */
  costCap: z
    .object({
      softWarnUsd: z.number().nonnegative().default(5),
      hardAbortUsd: z.number().nonnegative().default(25),
    })
    .default({}),

  /** Notification settings (locked decision C3) */
  notifications: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),

  /** Where to write conversation traces (locked decision 7) */
  traceDir: z.string().default(join(homedir(), '.frqncy-harness', 'traces')),

  /** Whether to push traces to GitHub after each conversation */
  autoPushTraces: z.boolean().default(false),

  /** Model rate overrides — fill in if your billing differs from DEFAULT_RATES */
  pricing: z.record(z.string(), z.object({
    inputUsdPerM: z.number().nonnegative(),
    outputUsdPerM: z.number().nonnegative(),
    cachedInputUsdPerM: z.number().nonnegative().optional(),
    notes: z.string().optional(),
  })).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Load config from disk. If the file doesn't exist, returns defaults.
 * If the file exists but is malformed, throws (we refuse to silently use defaults).
 */
export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const json = JSON.parse(raw);
    return ConfigSchema.parse(json);
  } catch (err) {
    if (isFileNotFoundError(err)) {
      // No config file yet — return defaults
      return ConfigSchema.parse({});
    }
    throw err;
  }
}

/**
 * Write config back to disk, creating the parent directory if needed.
 */
export async function saveConfig(config: Config, configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  const validated = ConfigSchema.parse(config);
  await fs.mkdir(dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

/**
 * Get a value at a dot-path within the config (e.g., "costCap.softWarnUsd").
 * Returns undefined if the path doesn't exist.
 */
export function getConfigValue(config: Config, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = config;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value at a dot-path within the config. Returns the modified config.
 * Coerces simple types (numbers, booleans) from string values.
 * Validates the result against the schema — throws if the new value is invalid.
 */
export function setConfigValue(config: Config, path: string, value: string): Config {
  const parts = path.split('.');
  if (parts.length === 0) throw new Error(`Empty config path`);

  // Coerce common primitive types
  const coerced = coerceValue(value);

  // Build the nested object structure
  const result = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  let cursor: Record<string, unknown> = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof cursor[key] !== 'object' || cursor[key] === null) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = coerced;

  // Validate the new shape
  return ConfigSchema.parse(result);
}

function coerceValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function isFileNotFoundError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
