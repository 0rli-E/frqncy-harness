/**
 * Thread + project tagging (v0.5).
 *
 * A "thread" is a long-lived conversation grouping that spans many runs of
 * chat / repl / agent. Tagging every trace record + index entry with a
 * `thread_id` (and optional `project_id`) turns the flat append-only trace
 * into a proto-context-graph: subsequent agents can scope their reads to a
 * single thread, and the dataset becomes searchable along the dimensions
 * that matter — *what work was this part of*, not just *when did it run*.
 *
 * Store lives at `~/.frqncy-harness/threads.json`. The "active" thread (if
 * set) is auto-attached to every conversation that doesn't pass an explicit
 * `threadId`. Set the active thread via `frqncy-harness thread use <id>`
 * (or `thread new <id>` which creates + activates atomically).
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { z } from 'zod';

export const DEFAULT_THREAD_STORE_PATH = join(homedir(), '.frqncy-harness', 'threads.json');

const THREAD_ID_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;

export const ThreadIdSchema = z
  .string()
  .regex(THREAD_ID_RE, 'thread ids must be kebab-case slugs (a–z, 0–9, dash; 1–50 chars; must start with a letter or digit)');

export const ThreadEntrySchema = z.object({
  id: ThreadIdSchema,
  label: z.string().max(200).optional(),
  project_id: ThreadIdSchema.optional(),
  created_at: z.string().datetime(),
  last_used_at: z.string().datetime().optional(),
});
export type ThreadEntry = z.infer<typeof ThreadEntrySchema>;

export const ThreadStoreSchema = z.object({
  active: ThreadIdSchema.nullable().default(null),
  threads: z.record(ThreadIdSchema, ThreadEntrySchema).default({}),
});
export type ThreadStore = z.infer<typeof ThreadStoreSchema>;

export async function loadThreadStore(path = DEFAULT_THREAD_STORE_PATH): Promise<ThreadStore> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return ThreadStoreSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (isFileNotFound(err)) return ThreadStoreSchema.parse({});
    throw err;
  }
}

export async function saveThreadStore(store: ThreadStore, path = DEFAULT_THREAD_STORE_PATH): Promise<void> {
  const validated = ThreadStoreSchema.parse(store);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(validated, null, 2) + '\n', 'utf-8');
}

export interface CreateThreadInput {
  id: string;
  label?: string;
  projectId?: string;
}

/**
 * Create a thread, set it active, persist. Throws if the id already exists.
 */
export async function createThread(input: CreateThreadInput, path = DEFAULT_THREAD_STORE_PATH): Promise<ThreadStore> {
  const id = ThreadIdSchema.parse(input.id);
  const store = await loadThreadStore(path);
  if (store.threads[id]) {
    throw new Error(`thread "${id}" already exists`);
  }
  const entry: ThreadEntry = {
    id,
    created_at: new Date().toISOString(),
    ...(input.label ? { label: input.label } : {}),
    ...(input.projectId ? { project_id: ThreadIdSchema.parse(input.projectId) } : {}),
  };
  store.threads[id] = entry;
  store.active = id;
  await saveThreadStore(store, path);
  return store;
}

export async function setActiveThread(id: string | null, path = DEFAULT_THREAD_STORE_PATH): Promise<ThreadStore> {
  const store = await loadThreadStore(path);
  if (id !== null) {
    const validId = ThreadIdSchema.parse(id);
    if (!store.threads[validId]) {
      throw new Error(`thread "${validId}" does not exist (use 'thread new ${validId}' to create it)`);
    }
    store.active = validId;
  } else {
    store.active = null;
  }
  await saveThreadStore(store, path);
  return store;
}

export async function renameThread(oldId: string, newId: string, path = DEFAULT_THREAD_STORE_PATH): Promise<ThreadStore> {
  const validOld = ThreadIdSchema.parse(oldId);
  const validNew = ThreadIdSchema.parse(newId);
  if (validOld === validNew) return loadThreadStore(path);
  const store = await loadThreadStore(path);
  const entry = store.threads[validOld];
  if (!entry) throw new Error(`thread "${validOld}" does not exist`);
  if (store.threads[validNew]) throw new Error(`thread "${validNew}" already exists`);
  delete store.threads[validOld];
  store.threads[validNew] = { ...entry, id: validNew };
  if (store.active === validOld) store.active = validNew;
  await saveThreadStore(store, path);
  return store;
}

export async function deleteThread(id: string, path = DEFAULT_THREAD_STORE_PATH): Promise<ThreadStore> {
  const validId = ThreadIdSchema.parse(id);
  const store = await loadThreadStore(path);
  if (!store.threads[validId]) throw new Error(`thread "${validId}" does not exist`);
  delete store.threads[validId];
  if (store.active === validId) store.active = null;
  await saveThreadStore(store, path);
  return store;
}

/**
 * Mark the active thread as just-used. No-op if there's no active thread.
 * Called from chat/stream once per conversation start.
 */
export async function touchActiveThread(path = DEFAULT_THREAD_STORE_PATH): Promise<void> {
  const store = await loadThreadStore(path);
  if (!store.active) return;
  const entry = store.threads[store.active];
  if (!entry) return;
  entry.last_used_at = new Date().toISOString();
  await saveThreadStore(store, path);
}

/**
 * Resolve thread/project ids to attach to a conversation.
 *
 * Precedence: explicit input > active thread store > undefined.
 * If `threadId` is given but has no entry in the store, we still accept it
 * (callers can tag a one-off conversation with an unregistered thread).
 */
export interface ResolvedTags {
  threadId?: string;
  projectId?: string;
}

export async function resolveTags(
  explicit: { threadId?: string | undefined; projectId?: string | undefined },
  path = DEFAULT_THREAD_STORE_PATH,
): Promise<ResolvedTags> {
  if (explicit.threadId) {
    const validId = ThreadIdSchema.parse(explicit.threadId);
    const store = await loadThreadStore(path);
    const entry = store.threads[validId];
    const projectId = explicit.projectId ?? entry?.project_id;
    return {
      threadId: validId,
      ...(projectId ? { projectId: ThreadIdSchema.parse(projectId) } : {}),
    };
  }
  // No explicit thread — fall back to active
  const store = await loadThreadStore(path);
  if (!store.active) {
    return explicit.projectId ? { projectId: ThreadIdSchema.parse(explicit.projectId) } : {};
  }
  const entry = store.threads[store.active];
  const projectId = explicit.projectId ?? entry?.project_id;
  return {
    threadId: store.active,
    ...(projectId ? { projectId: ThreadIdSchema.parse(projectId) } : {}),
  };
}

function isFileNotFound(err: unknown): boolean {
  return (
    err !== null && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT'
  );
}
