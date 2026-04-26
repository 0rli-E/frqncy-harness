/**
 * `frqncy-harness config <subcommand>` — manage ~/.frqncy-harness/config.json.
 *
 * Subcommands:
 *   get <path>           print the value at a dot-path
 *   set <path> <value>   set a value, validate, save
 *   list                 print the whole config as JSON
 *   unset <path>         remove a key (resets to schema default)
 *   path                 print the path to the config file
 */
import {
  loadConfig,
  saveConfig,
  getConfigValue,
  setConfigValue,
  DEFAULT_CONFIG_PATH,
  ConfigSchema,
} from '../config.js';

export type ConfigSubcommand = 'get' | 'set' | 'list' | 'unset' | 'path';

export async function runConfigCommand(
  subcommand: ConfigSubcommand,
  args: string[],
): Promise<void> {
  switch (subcommand) {
    case 'list': {
      const config = await loadConfig();
      process.stdout.write(JSON.stringify(config, null, 2) + '\n');
      return;
    }
    case 'path': {
      process.stdout.write(DEFAULT_CONFIG_PATH + '\n');
      return;
    }
    case 'get': {
      const path = args[0];
      if (!path) throw new Error('Usage: frqncy-harness config get <path>');
      const config = await loadConfig();
      const value = getConfigValue(config, path);
      if (value === undefined) {
        process.stderr.write(`(unset)\n`);
        process.exit(1);
      } else {
        process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
      }
      return;
    }
    case 'set': {
      const path = args[0];
      const value = args.slice(1).join(' ');
      if (!path) throw new Error('Usage: frqncy-harness config set <path> <value>');
      if (value === undefined || value === '') throw new Error('Value is required');
      const current = await loadConfig();
      const updated = setConfigValue(current, path, value);
      await saveConfig(updated);
      process.stdout.write(`set ${path} = ${getConfigValue(updated, path)}\n`);
      return;
    }
    case 'unset': {
      const path = args[0];
      if (!path) throw new Error('Usage: frqncy-harness config unset <path>');
      const current = await loadConfig();
      const raw = JSON.parse(JSON.stringify(current));
      const parts = path.split('.');
      let cursor = raw as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        const next = cursor[parts[i]!];
        if (typeof next !== 'object' || next === null) {
          process.stderr.write(`(${path} not found)\n`);
          process.exit(1);
        }
        cursor = next as Record<string, unknown>;
      }
      delete cursor[parts[parts.length - 1]!];
      const reparsed = ConfigSchema.parse(raw);
      await saveConfig(reparsed);
      process.stdout.write(`unset ${path}\n`);
      return;
    }
    default:
      throw new Error(`Unknown config subcommand: ${subcommand}`);
  }
}
