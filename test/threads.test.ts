import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadThreadStore,
  saveThreadStore,
  createThread,
  setActiveThread,
  renameThread,
  deleteThread,
  touchActiveThread,
  resolveTags,
  ThreadIdSchema,
} from '../src/threads.js';

describe('threads', () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'threads-test-'));
    storePath = join(dir, 'threads.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('ThreadIdSchema', () => {
    it('accepts kebab-case slugs', () => {
      expect(() => ThreadIdSchema.parse('feature-thread-tagging')).not.toThrow();
      expect(() => ThreadIdSchema.parse('v05')).not.toThrow();
      expect(() => ThreadIdSchema.parse('a')).not.toThrow();
    });
    it('rejects uppercase, spaces, slashes', () => {
      expect(() => ThreadIdSchema.parse('Bad-Slug')).toThrow();
      expect(() => ThreadIdSchema.parse('has space')).toThrow();
      expect(() => ThreadIdSchema.parse('a/b')).toThrow();
      expect(() => ThreadIdSchema.parse('-leading-dash')).toThrow();
      expect(() => ThreadIdSchema.parse('')).toThrow();
    });
    it('rejects > 50 chars', () => {
      expect(() => ThreadIdSchema.parse('x'.repeat(51))).toThrow();
      expect(() => ThreadIdSchema.parse('x'.repeat(50))).not.toThrow();
    });
  });

  describe('loadThreadStore', () => {
    it('returns empty defaults when file is missing', async () => {
      const store = await loadThreadStore(storePath);
      expect(store).toEqual({ active: null, threads: {} });
    });
  });

  describe('createThread', () => {
    it('creates and activates atomically', async () => {
      const store = await createThread({ id: 't1', label: 'first' }, storePath);
      expect(store.active).toBe('t1');
      expect(store.threads['t1']?.label).toBe('first');
      expect(store.threads['t1']?.created_at).toBeTruthy();
    });
    it('persists to disk', async () => {
      await createThread({ id: 't1' }, storePath);
      const raw = await readFile(storePath, 'utf-8');
      expect(JSON.parse(raw).active).toBe('t1');
    });
    it('throws on duplicate id', async () => {
      await createThread({ id: 't1' }, storePath);
      await expect(createThread({ id: 't1' }, storePath)).rejects.toThrow(/already exists/);
    });
    it('attaches optional project_id', async () => {
      const store = await createThread({ id: 't1', projectId: 'proj-a' }, storePath);
      expect(store.threads['t1']?.project_id).toBe('proj-a');
    });
  });

  describe('setActiveThread', () => {
    it('switches active when id exists', async () => {
      await createThread({ id: 't1' }, storePath);
      await createThread({ id: 't2' }, storePath);
      const store = await setActiveThread('t1', storePath);
      expect(store.active).toBe('t1');
    });
    it('throws when id does not exist', async () => {
      await expect(setActiveThread('ghost', storePath)).rejects.toThrow(/does not exist/);
    });
    it('clears active when given null', async () => {
      await createThread({ id: 't1' }, storePath);
      const store = await setActiveThread(null, storePath);
      expect(store.active).toBeNull();
    });
  });

  describe('renameThread', () => {
    it('renames entry and migrates active pointer', async () => {
      await createThread({ id: 't1', label: 'one' }, storePath);
      const store = await renameThread('t1', 't1-renamed', storePath);
      expect(store.threads['t1']).toBeUndefined();
      expect(store.threads['t1-renamed']?.label).toBe('one');
      expect(store.active).toBe('t1-renamed');
    });
    it('throws on conflict', async () => {
      await createThread({ id: 't1' }, storePath);
      await createThread({ id: 't2' }, storePath);
      await expect(renameThread('t1', 't2', storePath)).rejects.toThrow(/already exists/);
    });
    it('no-op on same id', async () => {
      await createThread({ id: 't1' }, storePath);
      await expect(renameThread('t1', 't1', storePath)).resolves.toBeDefined();
    });
  });

  describe('deleteThread', () => {
    it('removes entry and clears active when matching', async () => {
      await createThread({ id: 't1' }, storePath);
      const store = await deleteThread('t1', storePath);
      expect(store.threads['t1']).toBeUndefined();
      expect(store.active).toBeNull();
    });
    it('keeps active when deleting a non-active thread', async () => {
      await createThread({ id: 't1' }, storePath);
      await createThread({ id: 't2' }, storePath); // t2 becomes active
      await setActiveThread('t1', storePath);
      const store = await deleteThread('t2', storePath);
      expect(store.active).toBe('t1');
    });
  });

  describe('touchActiveThread', () => {
    it('updates last_used_at when active is set', async () => {
      await createThread({ id: 't1' }, storePath);
      const before = (await loadThreadStore(storePath)).threads['t1']?.last_used_at;
      expect(before).toBeUndefined();
      await touchActiveThread(storePath);
      const after = (await loadThreadStore(storePath)).threads['t1']?.last_used_at;
      expect(after).toBeTruthy();
    });
    it('is a no-op when there is no active thread', async () => {
      await touchActiveThread(storePath);
      const store = await loadThreadStore(storePath);
      expect(store.active).toBeNull();
    });
  });

  describe('resolveTags', () => {
    it('returns nothing when no explicit + no active', async () => {
      const tags = await resolveTags({}, storePath);
      expect(tags).toEqual({});
    });
    it('uses active thread when no explicit threadId', async () => {
      await createThread({ id: 't1', projectId: 'proj-x' }, storePath);
      const tags = await resolveTags({}, storePath);
      expect(tags).toEqual({ threadId: 't1', projectId: 'proj-x' });
    });
    it('explicit threadId overrides active and inherits its project', async () => {
      await createThread({ id: 't1', projectId: 'proj-a' }, storePath);
      await createThread({ id: 't2', projectId: 'proj-b' }, storePath); // active=t2
      const tags = await resolveTags({ threadId: 't1' }, storePath);
      expect(tags).toEqual({ threadId: 't1', projectId: 'proj-a' });
    });
    it('explicit projectId wins over inherited project', async () => {
      await createThread({ id: 't1', projectId: 'proj-a' }, storePath);
      const tags = await resolveTags({ projectId: 'override' }, storePath);
      expect(tags).toEqual({ threadId: 't1', projectId: 'override' });
    });
    it('accepts a threadId that has no entry in the store', async () => {
      const tags = await resolveTags({ threadId: 'one-off' }, storePath);
      expect(tags).toEqual({ threadId: 'one-off' });
    });
  });

  describe('saveThreadStore', () => {
    it('refuses to write a malformed store', async () => {
      // @ts-expect-error — testing runtime validation
      await expect(saveThreadStore({ active: 'BAD slug', threads: {} }, storePath)).rejects.toThrow();
    });
  });
});
