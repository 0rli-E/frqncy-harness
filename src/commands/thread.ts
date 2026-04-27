/**
 * `frqncy-harness thread` — manage thread + project tags.
 *
 * Threads group related conversations. The "active" thread is auto-attached
 * to every chat / repl / agent call that doesn't pass `--thread <id>`.
 *
 *   frqncy-harness thread list
 *   frqncy-harness thread current
 *   frqncy-harness thread new <id> [--label "..."] [--project <id>]
 *   frqncy-harness thread use <id>
 *   frqncy-harness thread none                      # clear active
 *   frqncy-harness thread rename <old-id> <new-id>
 *   frqncy-harness thread delete <id>
 *   frqncy-harness thread path                      # print store path
 */
import {
  loadThreadStore,
  setActiveThread,
  createThread,
  renameThread,
  deleteThread,
  DEFAULT_THREAD_STORE_PATH,
  type ThreadEntry,
} from '../threads.js';

export type ThreadSubcommand =
  | 'list'
  | 'current'
  | 'new'
  | 'use'
  | 'none'
  | 'rename'
  | 'delete'
  | 'path';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function flagAt(args: string[], names: string[]): string | undefined {
  for (const name of names) {
    const idx = args.indexOf(name);
    if (idx !== -1 && idx + 1 < args.length) {
      const v = args[idx + 1];
      if (v !== undefined && !v.startsWith('-')) return v;
    }
  }
  return undefined;
}

function withoutFlag(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (names.includes(a) && i + 1 < args.length) {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function runThreadCommand(sub: ThreadSubcommand, rawArgs: string[]): Promise<void> {
  switch (sub) {
    case 'path':
      process.stdout.write(DEFAULT_THREAD_STORE_PATH + '\n');
      return;

    case 'list': {
      const store = await loadThreadStore();
      const ids = Object.keys(store.threads).sort();
      if (ids.length === 0) {
        process.stdout.write(`${ANSI.dim}(no threads yet — create one with 'frqncy-harness thread new <id>')${ANSI.reset}\n`);
        return;
      }
      process.stdout.write(`${ANSI.bold}${ANSI.cyan}Threads${ANSI.reset}\n\n`);
      for (const id of ids) {
        const entry = store.threads[id]!;
        const isActive = store.active === id;
        const marker = isActive ? `${ANSI.green}● ${ANSI.reset}` : '  ';
        const label = entry.label ? ` ${ANSI.dim}— ${entry.label}${ANSI.reset}` : '';
        const project = entry.project_id ? ` ${ANSI.dim}[${entry.project_id}]${ANSI.reset}` : '';
        const lastUsed = entry.last_used_at ? ` ${ANSI.dim}(used ${entry.last_used_at.slice(0, 10)})${ANSI.reset}` : '';
        process.stdout.write(`${marker}${ANSI.bold}${id}${ANSI.reset}${project}${label}${lastUsed}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    case 'current': {
      const store = await loadThreadStore();
      if (!store.active) {
        process.stdout.write(`${ANSI.dim}(no active thread)${ANSI.reset}\n`);
        return;
      }
      const entry = store.threads[store.active];
      if (!entry) {
        process.stdout.write(`${ANSI.yellow}active=${store.active} (orphaned — entry missing)${ANSI.reset}\n`);
        return;
      }
      process.stdout.write(formatEntry(entry, true) + '\n');
      return;
    }

    case 'new': {
      const label = flagAt(rawArgs, ['--label']);
      const projectId = flagAt(rawArgs, ['--project']);
      const positional = withoutFlag(rawArgs, ['--label', '--project']);
      const id = positional[0];
      if (!id) {
        throw new Error("Usage: frqncy-harness thread new <id> [--label '...'] [--project <id>]");
      }
      const store = await createThread({
        id,
        ...(label ? { label } : {}),
        ...(projectId ? { projectId } : {}),
      });
      const entry = store.threads[id]!;
      process.stdout.write(`${ANSI.green}+ created${ANSI.reset} ${formatEntry(entry, true)}\n`);
      return;
    }

    case 'use': {
      const id = rawArgs[0];
      if (!id) throw new Error('Usage: frqncy-harness thread use <id>');
      await setActiveThread(id);
      process.stdout.write(`${ANSI.green}● active${ANSI.reset} ${ANSI.bold}${id}${ANSI.reset}\n`);
      return;
    }

    case 'none': {
      await setActiveThread(null);
      process.stdout.write(`${ANSI.dim}active thread cleared${ANSI.reset}\n`);
      return;
    }

    case 'rename': {
      const [oldId, newId] = rawArgs;
      if (!oldId || !newId) throw new Error('Usage: frqncy-harness thread rename <old-id> <new-id>');
      await renameThread(oldId, newId);
      process.stdout.write(`${ANSI.green}renamed${ANSI.reset} ${oldId} → ${ANSI.bold}${newId}${ANSI.reset}\n`);
      return;
    }

    case 'delete': {
      const id = rawArgs[0];
      if (!id) throw new Error('Usage: frqncy-harness thread delete <id>');
      await deleteThread(id);
      process.stdout.write(`${ANSI.dim}deleted thread${ANSI.reset} ${id}\n`);
      return;
    }

    default:
      throw new Error(
        `Unknown thread subcommand: ${sub}. ` +
          `Try: list | current | new | use | none | rename | delete | path`,
      );
  }
}

function formatEntry(entry: ThreadEntry, active: boolean): string {
  const marker = active ? `${ANSI.green}● ${ANSI.reset}` : '';
  const project = entry.project_id ? ` ${ANSI.dim}[${entry.project_id}]${ANSI.reset}` : '';
  const label = entry.label ? ` ${ANSI.dim}— ${entry.label}${ANSI.reset}` : '';
  return `${marker}${ANSI.bold}${entry.id}${ANSI.reset}${project}${label}`;
}
