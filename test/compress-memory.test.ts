import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runCompressMemoryCommand,
  hashContent,
  parseFrontmatter,
  isAlreadyCompressed,
  getCompressedSourceHash,
  buildCompressedFile,
  COMPRESS_SYSTEM_PROMPT,
  type CompressMemoryCommandOptions,
} from '../src/commands/compress-memory.js';
import type { ChatInput, ChatResult } from '../src/types.js';

// ────────────────────────────────────────────────────────────────────
// Pure-helper tests
// ────────────────────────────────────────────────────────────────────

describe('hashContent', () => {
  it('returns a stable 16-char hash', () => {
    expect(hashContent('hello')).toBe(hashContent('hello'));
    expect(hashContent('hello').length).toBe(16);
  });

  it('returns different hashes for different content', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('parseFrontmatter', () => {
  it('parses key: value frontmatter', () => {
    const raw = `---\nfoo: bar\nbaz: 42\n---\n\nbody here`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.foo).toBe('bar');
    expect(frontmatter.baz).toBe('42');
    expect(body).toBe('body here');
  });

  it('returns empty frontmatter when none present', () => {
    const { frontmatter, body } = parseFrontmatter('# just a heading\n\nbody');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# just a heading\n\nbody');
  });

  it('strips quoted values', () => {
    const raw = `---\nname: "quoted"\n---\nbody`;
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe('quoted');
  });

  it('handles missing closing fence gracefully', () => {
    const raw = `---\nfoo: bar\nno closing fence`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe(raw);
  });
});

describe('isAlreadyCompressed + getCompressedSourceHash', () => {
  it('detects compressed files by frontmatter key', () => {
    const raw = `---\ncompressed_from_hash: abc123\n---\n\ncompressed body`;
    expect(isAlreadyCompressed(raw)).toBe(true);
    expect(getCompressedSourceHash(raw)).toBe('abc123');
  });

  it('returns false/null when frontmatter is missing', () => {
    expect(isAlreadyCompressed('plain markdown')).toBe(false);
    expect(getCompressedSourceHash('plain markdown')).toBeNull();
  });
});

describe('buildCompressedFile', () => {
  it('emits valid frontmatter with the source hash', () => {
    const out = buildCompressedFile('compressed body', 'abc123');
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('compressed_from_hash: abc123');
    expect(out).toContain('compressed_at:');
    expect(out).toContain('compressed body');
  });
});

describe('COMPRESS_SYSTEM_PROMPT', () => {
  it('includes the inoculation sentence', () => {
    expect(COMPRESS_SYSTEM_PROMPT.toLowerCase()).toMatch(/reward.hacking/);
  });

  it('forbids drift on factual content', () => {
    expect(COMPRESS_SYSTEM_PROMPT.toLowerCase()).toMatch(/preserve every fact/i);
  });

  it('preserves heading structure', () => {
    expect(COMPRESS_SYSTEM_PROMPT.toLowerCase()).toMatch(/heading structure/);
  });

  it('preserves code blocks unchanged', () => {
    expect(COMPRESS_SYSTEM_PROMPT.toLowerCase()).toMatch(/code blocks unchanged/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Integration tests
// ────────────────────────────────────────────────────────────────────

describe('runCompressMemoryCommand', () => {
  let cwd: string;
  let stdoutBuffer: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'compress-test-'));
    stdoutBuffer = '';
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuffer += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await rm(cwd, { recursive: true, force: true });
  });

  function makeStubChat(compressionFn: (input: string) => string): NonNullable<CompressMemoryCommandOptions['chatFn']> {
    return async (input: ChatInput): Promise<ChatResult> => {
      // Defensive: inoculation sentence must be present
      if (!input.system?.toLowerCase().includes('reward hacking')) {
        throw new Error('compress chat invocation missing inoculation sentence');
      }
      const userText = input.messages[0]?.content ?? '';
      return {
        text: compressionFn(userText),
        conversationId: 'stub',
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costUsd: 0.001 },
        model: input.model,
        provider: 'anthropic',
        finishReason: 'stop',
      };
    };
  }

  // A simple stub compressor: just keep the first half of the input
  const halfStub = (text: string): string => text.slice(0, Math.floor(text.length / 2));

  it('compresses a markdown file and writes a .original.md sidecar', async () => {
    const filePath = join(cwd, 'AGENT.md');
    const original = '# Big doc\n\n' + 'Lots of words. '.repeat(200);
    await writeFile(filePath, original, 'utf-8');

    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.filesCompressed).toBe(1);
    expect(result.totalReductionPct).toBeGreaterThan(0);

    // The .original.md sidecar contains the unchanged source
    const sidecar = await readFile(filePath + '.original.md', 'utf-8');
    expect(sidecar).toBe(original);

    // The live file is now compressed (with frontmatter + reduced body)
    const live = await readFile(filePath, 'utf-8');
    expect(live).toMatch(/^---\ncompressed_from_hash:/);
    expect(live.length).toBeLessThan(original.length);
  });

  it('skips files smaller than minBytes', async () => {
    await writeFile(join(cwd, 'small.md'), 'tiny\n', 'utf-8');
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    expect(result.filesSkipped).toBe(1);
    expect(result.files[0]!.status).toBe('skipped');
    expect(result.files[0]!.reason).toMatch(/min-bytes/);
  });

  it('does not write when --dry-run is set', async () => {
    const filePath = join(cwd, 'doc.md');
    await writeFile(filePath, 'X'.repeat(2000), 'utf-8');
    await runCompressMemoryCommand(cwd, {
      dryRun: true,
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    // Original file is unchanged
    const after = await readFile(filePath, 'utf-8');
    expect(after).toBe('X'.repeat(2000));
    // No sidecar written
    await expect(access(filePath + '.original.md')).rejects.toThrow();
  });

  it('skips re-compression when source hash matches (idempotency)', async () => {
    const filePath = join(cwd, 'doc.md');
    const original = '# Doc\n\n' + 'word '.repeat(500);
    await writeFile(filePath, original, 'utf-8');

    // First pass — compresses
    const r1 = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    expect(r1.filesCompressed).toBe(1);

    // Second pass — should be unchanged (sidecar matches live source hash)
    const r2 = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    expect(r2.filesCompressed).toBe(0);
    expect(r2.files[0]!.status).toBe('unchanged');
    expect(r2.files[0]!.reason).toMatch(/already compressed/);
  });

  it('regenerates compression when --force is set', async () => {
    const filePath = join(cwd, 'doc.md');
    await writeFile(filePath, 'X'.repeat(2000), 'utf-8');
    await runCompressMemoryCommand(cwd, { chatFn: makeStubChat(halfStub), json: true });
    const r2 = await runCompressMemoryCommand(cwd, {
      force: true,
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    expect(r2.filesCompressed).toBe(1);
  });

  it('marks unchanged when the model declares "already terse"', async () => {
    const filePath = join(cwd, 'terse.md');
    await writeFile(filePath, 'X'.repeat(2000), 'utf-8');
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(() => '<!-- already terse -->\n'),
      json: true,
    });
    expect(result.files[0]!.status).toBe('unchanged');
    expect(result.files[0]!.reason).toMatch(/already terse/);
  });

  it('marks unchanged when compressed output grew the file', async () => {
    const filePath = join(cwd, 'doc.md');
    await writeFile(filePath, 'X'.repeat(2000), 'utf-8');
    // Stub returns a longer string than input
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat((text) => text + 'A'.repeat(5000)),
      json: true,
    });
    expect(result.files[0]!.status).toBe('unchanged');
    expect(result.files[0]!.reason).toMatch(/did not reduce/);
  });

  it('skips .original.md sidecars on subsequent runs', async () => {
    await writeFile(join(cwd, 'doc.md'), 'X'.repeat(2000), 'utf-8');
    await writeFile(join(cwd, 'doc.md.original.md'), 'X'.repeat(2000), 'utf-8');
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    // doc.md was processed once; doc.md.original.md was filtered out by the file walker
    expect(result.filesProcessed).toBe(1);
    expect(result.files[0]!.sourcePath).toMatch(/doc\.md$/);
    expect(result.files[0]!.sourcePath).not.toMatch(/\.original\.md$/);
  });

  it('walks subdirectories and compresses .md files inside', async () => {
    await mkdir(join(cwd, 'sub'), { recursive: true });
    await writeFile(join(cwd, 'a.md'), 'A'.repeat(2000), 'utf-8');
    await writeFile(join(cwd, 'sub', 'b.md'), 'B'.repeat(2000), 'utf-8');
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    expect(result.filesProcessed).toBe(2);
    expect(result.filesCompressed).toBe(2);
  });

  it('skips node_modules and dist directories', async () => {
    await mkdir(join(cwd, 'node_modules'), { recursive: true });
    await mkdir(join(cwd, 'dist'), { recursive: true });
    await writeFile(join(cwd, 'a.md'), 'A'.repeat(2000), 'utf-8');
    await writeFile(join(cwd, 'node_modules', 'README.md'), 'B'.repeat(2000), 'utf-8');
    await writeFile(join(cwd, 'dist', 'README.md'), 'C'.repeat(2000), 'utf-8');
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    expect(result.filesProcessed).toBe(1);
    expect(result.files[0]!.sourcePath).toMatch(/a\.md$/);
  });

  it('returns failed when the chat function throws', async () => {
    await writeFile(join(cwd, 'doc.md'), 'X'.repeat(2000), 'utf-8');
    const failing: NonNullable<CompressMemoryCommandOptions['chatFn']> = async (input) => {
      if (!input.system?.toLowerCase().includes('reward hacking')) throw new Error('missing inoculation');
      throw new Error('rate limit');
    };
    const result = await runCompressMemoryCommand(cwd, {
      chatFn: failing,
      json: true,
    });
    expect(result.filesFailed).toBe(1);
    expect(result.files[0]!.reason).toMatch(/rate limit/);
  });

  it('emits JSON summary on --json', async () => {
    await writeFile(join(cwd, 'doc.md'), 'X'.repeat(2000), 'utf-8');
    const result = await runCompressMemoryCommand(cwd, {
      json: true,
      chatFn: makeStubChat(halfStub),
    });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed.filesProcessed).toBe(1);
    expect(parsed.totalReductionPct).toBe(result.totalReductionPct);
  });

  it('preserves the FIRST original on subsequent compressions', async () => {
    const filePath = join(cwd, 'doc.md');
    const firstOriginal = 'A'.repeat(2000);
    await writeFile(filePath, firstOriginal, 'utf-8');
    await runCompressMemoryCommand(cwd, { chatFn: makeStubChat(halfStub), json: true });

    // Manually edit the live file (simulate user edits to the compressed copy)
    await writeFile(filePath, 'manually edited content (still bigger than minBytes) ' + 'X'.repeat(2000), 'utf-8');

    // Force a re-compression — sidecar should still be the FIRST original
    await runCompressMemoryCommand(cwd, {
      force: true,
      chatFn: makeStubChat(halfStub),
      json: true,
    });
    const sidecar = await readFile(filePath + '.original.md', 'utf-8');
    expect(sidecar).toBe(firstOriginal);
  });
});
