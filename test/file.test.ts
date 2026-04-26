import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readTool, writeTool, grepTool, globTool } from '../src/tools/file.js';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `frqncy-harness-file-${randomUUID()}`);
  await fs.mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('readTool', () => {
  it('reads a file relative to ctx.cwd', async () => {
    await fs.writeFile(join(testDir, 'hello.txt'), 'world', 'utf-8');
    const result = await readTool.execute(
      { path: 'hello.txt' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.contents).toBe('world');
    expect(result.bytes_read).toBe(5);
    expect(result.is_inside_cwd).toBe(true);
  });

  it('reads an absolute path and flags it outside cwd', async () => {
    const otherDir = join(tmpdir(), `other-${randomUUID()}`);
    await fs.mkdir(otherDir, { recursive: true });
    const otherFile = join(otherDir, 'other.txt');
    await fs.writeFile(otherFile, 'elsewhere', 'utf-8');
    try {
      const result = await readTool.execute(
        { path: otherFile },
        { conversationId: 'test', cwd: testDir },
      );
      expect(result.contents).toBe('elsewhere');
      expect(result.is_inside_cwd).toBe(false);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it('truncates when file exceeds limit', async () => {
    await fs.writeFile(join(testDir, 'big.txt'), 'x'.repeat(1000), 'utf-8');
    const result = await readTool.execute(
      { path: 'big.txt', limit_bytes: 10 },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.bytes_read).toBe(10);
    expect(result.total_bytes).toBe(1000);
    expect(result.truncated).toBe(true);
  });
});

describe('writeTool', () => {
  it('writes a file in overwrite mode', async () => {
    const result = await writeTool.execute(
      { path: 'out.txt', contents: 'hello', mode: 'overwrite' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.bytes_written).toBe(5);
    expect(result.created).toBe(true);
    const written = await fs.readFile(join(testDir, 'out.txt'), 'utf-8');
    expect(written).toBe('hello');
  });

  it('appends in append mode', async () => {
    await writeTool.execute(
      { path: 'log.txt', contents: 'first\n', mode: 'overwrite' },
      { conversationId: 'test', cwd: testDir },
    );
    await writeTool.execute(
      { path: 'log.txt', contents: 'second\n', mode: 'append' },
      { conversationId: 'test', cwd: testDir },
    );
    const final = await fs.readFile(join(testDir, 'log.txt'), 'utf-8');
    expect(final).toBe('first\nsecond\n');
  });

  it('refuses overwrite in create-only mode if exists', async () => {
    await fs.writeFile(join(testDir, 'exists.txt'), 'original', 'utf-8');
    await expect(
      writeTool.execute(
        { path: 'exists.txt', contents: 'new', mode: 'create-only' },
        { conversationId: 'test', cwd: testDir },
      ),
    ).rejects.toThrow();
  });

  it('creates parent directories as needed', async () => {
    const result = await writeTool.execute(
      { path: 'nested/sub/dir/file.txt', contents: 'hi' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.created).toBe(true);
    const written = await fs.readFile(join(testDir, 'nested/sub/dir/file.txt'), 'utf-8');
    expect(written).toBe('hi');
  });
});

describe('grepTool', () => {
  it('finds a pattern across files', async () => {
    await fs.writeFile(join(testDir, 'a.txt'), 'hello world\nfoo bar\n', 'utf-8');
    await fs.writeFile(join(testDir, 'b.txt'), 'another file\nhello again\n', 'utf-8');
    const result = await grepTool.execute(
      { pattern: 'hello' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.matches.length).toBe(2);
    expect(result.matches.every((m) => m.text.toLowerCase().includes('hello'))).toBe(true);
  });

  it('respects case_insensitive flag', async () => {
    await fs.writeFile(join(testDir, 'a.txt'), 'Hello\nhello\nHELLO\n', 'utf-8');
    const sensitive = await grepTool.execute(
      { pattern: 'hello' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(sensitive.matches.length).toBe(1);
    const insensitive = await grepTool.execute(
      { pattern: 'hello', case_insensitive: true },
      { conversationId: 'test', cwd: testDir },
    );
    expect(insensitive.matches.length).toBe(3);
  });

  it('skips heavy directories', async () => {
    await fs.mkdir(join(testDir, 'node_modules'), { recursive: true });
    await fs.writeFile(join(testDir, 'node_modules', 'big.txt'), 'shouldnotbefound', 'utf-8');
    await fs.writeFile(join(testDir, 'a.txt'), 'shouldnotbefound', 'utf-8');
    const result = await grepTool.execute(
      { pattern: 'shouldnotbefound' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]!.file).not.toContain('node_modules');
  });
});

describe('globTool', () => {
  it('finds files matching a glob', async () => {
    await fs.writeFile(join(testDir, 'a.ts'), '', 'utf-8');
    await fs.writeFile(join(testDir, 'b.ts'), '', 'utf-8');
    await fs.writeFile(join(testDir, 'c.js'), '', 'utf-8');
    const result = await globTool.execute(
      { pattern: '*.ts' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.matches.length).toBe(2);
    expect(result.matches.every((m) => m.endsWith('.ts'))).toBe(true);
  });

  it('handles ** globs across nested dirs', async () => {
    await fs.mkdir(join(testDir, 'src/sub'), { recursive: true });
    await fs.writeFile(join(testDir, 'src/foo.ts'), '', 'utf-8');
    await fs.writeFile(join(testDir, 'src/sub/bar.ts'), '', 'utf-8');
    const result = await globTool.execute(
      { pattern: '**/*.ts' },
      { conversationId: 'test', cwd: testDir },
    );
    expect(result.matches.length).toBe(2);
  });
});

describe('tool flags', () => {
  it('readTool is auto-permission read-only', () => {
    expect(readTool.permission).toBe('auto');
    expect(readTool.flags.privateData).toBe(true);
  });
  it('writeTool requires propose-then-approve', () => {
    expect(writeTool.permission).toBe('propose-then-approve');
  });
  it('grep and glob are auto-permission', () => {
    expect(grepTool.permission).toBe('auto');
    expect(globTool.permission).toBe('auto');
  });
});
