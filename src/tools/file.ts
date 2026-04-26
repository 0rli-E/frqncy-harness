/**
 * File primitive tools — read, write, grep, glob.
 *
 * Per HARNESS-DEFAULTS-REVIEW.md decision B (tool surface), file primitives sit
 * alongside `bash` for capable models that prefer typed file ops. They run in
 * the sandbox cwd by default; absolute paths are allowed but tagged as private-data
 * access.
 *
 * Permission tiers:
 *   - read, grep, glob → auto (read-only, no state mutation)
 *   - write → propose-then-approve (mutates filesystem)
 */
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve, relative } from 'node:path';
import { z } from 'zod';
import type { HarnessTool } from './index.js';

// Hard cap to avoid jamming the model context with megabytes of file content
const READ_BYTE_LIMIT = 256 * 1024;
const GREP_MATCH_LIMIT = 200;
const GLOB_RESULT_LIMIT = 500;

function resolvePath(rawPath: string, cwd: string): { absolute: string; isInsideCwd: boolean } {
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
  const rel = relative(cwd, absolute);
  const isInsideCwd = !rel.startsWith('..') && !isAbsolute(rel);
  return { absolute, isInsideCwd };
}

// ────────────────────────────────────────────────────────────────────
// read
// ────────────────────────────────────────────────────────────────────

export const ReadInputSchema = z.object({
  path: z.string().describe('Absolute path or path relative to the sandbox cwd'),
  offset_bytes: z.number().int().nonnegative().optional().describe('Skip this many bytes from the start'),
  limit_bytes: z.number().int().positive().optional().describe(`Max bytes to read. Default ${READ_BYTE_LIMIT}.`),
});
export type ReadInput = z.infer<typeof ReadInputSchema>;

export interface ReadOutput {
  path: string;
  contents: string;
  bytes_read: number;
  total_bytes: number;
  truncated: boolean;
  is_inside_cwd: boolean;
}

export const readTool: HarnessTool<ReadInput, ReadOutput> = {
  name: 'read',
  description: 'Read a UTF-8 file. Returns contents up to a byte limit. Prefer this over `bash cat` for structured access.',
  inputSchema: ReadInputSchema,
  flags: { privateData: true },
  permission: 'auto',
  execute: async ({ path, offset_bytes, limit_bytes }, ctx) => {
    const { absolute, isInsideCwd } = resolvePath(path, ctx.cwd);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);

    const limit = Math.min(limit_bytes ?? READ_BYTE_LIMIT, READ_BYTE_LIMIT);
    const offset = offset_bytes ?? 0;
    const fh = await fs.open(absolute, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const { bytesRead } = await fh.read(buf, 0, limit, offset);
      const contents = buf.subarray(0, bytesRead).toString('utf-8');
      return {
        path: absolute,
        contents,
        bytes_read: bytesRead,
        total_bytes: stat.size,
        truncated: offset + bytesRead < stat.size,
        is_inside_cwd: isInsideCwd,
      };
    } finally {
      await fh.close();
    }
  },
};

// ────────────────────────────────────────────────────────────────────
// write
// ────────────────────────────────────────────────────────────────────

export const WriteInputSchema = z.object({
  path: z.string().describe('Absolute path or path relative to sandbox cwd'),
  contents: z.string().describe('UTF-8 contents to write'),
  mode: z.enum(['overwrite', 'append', 'create-only']).optional().describe('Default: overwrite'),
});
export type WriteInput = z.infer<typeof WriteInputSchema>;

export interface WriteOutput {
  path: string;
  bytes_written: number;
  mode: 'overwrite' | 'append' | 'create-only';
  is_inside_cwd: boolean;
  created: boolean;
}

export const writeTool: HarnessTool<WriteInput, WriteOutput> = {
  name: 'write',
  description: 'Write a UTF-8 file. Modes: overwrite (default), append, create-only (fails if exists).',
  inputSchema: WriteInputSchema,
  flags: { privateData: true },
  permission: 'propose-then-approve',
  execute: async ({ path, contents, mode }, ctx) => {
    const { absolute, isInsideCwd } = resolvePath(path, ctx.cwd);
    const effectiveMode = mode ?? 'overwrite';

    let existed = false;
    try {
      await fs.stat(absolute);
      existed = true;
    } catch {
      existed = false;
    }

    if (effectiveMode === 'create-only' && existed) {
      throw new Error(`File exists and mode=create-only: ${absolute}`);
    }

    // Ensure parent dir exists (best-effort)
    const parent = absolute.slice(0, absolute.lastIndexOf('/'));
    if (parent) {
      await fs.mkdir(parent, { recursive: true });
    }

    if (effectiveMode === 'append') {
      await fs.appendFile(absolute, contents, 'utf-8');
    } else {
      await fs.writeFile(absolute, contents, 'utf-8');
    }

    return {
      path: absolute,
      bytes_written: Buffer.byteLength(contents, 'utf-8'),
      mode: effectiveMode,
      is_inside_cwd: isInsideCwd,
      created: !existed,
    };
  },
};

// ────────────────────────────────────────────────────────────────────
// grep — line-based pattern search via ripgrep-style behavior
// ────────────────────────────────────────────────────────────────────

export const GrepInputSchema = z.object({
  pattern: z.string().describe('Regex pattern to search for'),
  path: z.string().optional().describe('Directory or file. Default: sandbox cwd.'),
  glob: z.string().optional().describe('Filter file paths matching this glob (e.g. "*.ts")'),
  case_insensitive: z.boolean().optional().describe('Default: false'),
  max_matches: z.number().int().positive().optional().describe(`Cap matches. Default ${GREP_MATCH_LIMIT}.`),
});
export type GrepInput = z.infer<typeof GrepInputSchema>;

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepOutput {
  matches: GrepMatch[];
  truncated: boolean;
  files_scanned: number;
}

export const grepTool: HarnessTool<GrepInput, GrepOutput> = {
  name: 'grep',
  description:
    'Search files for a regex pattern. Returns matching {file, line, text} entries. Respects sandbox cwd.',
  inputSchema: GrepInputSchema,
  flags: { privateData: true },
  permission: 'auto',
  execute: async ({ pattern, path, glob, case_insensitive, max_matches }, ctx) => {
    const root = path ? resolvePath(path, ctx.cwd).absolute : ctx.cwd;
    const limit = max_matches ?? GREP_MATCH_LIMIT;
    const flags = case_insensitive ? 'i' : '';
    const re = new RegExp(pattern, flags);
    const globRe = glob ? globToRegex(glob) : null;

    const matches: GrepMatch[] = [];
    let filesScanned = 0;
    let truncated = false;

    await walk(root, async (filePath) => {
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
      if (globRe && !globRe.test(filePath)) return true;
      filesScanned++;
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > READ_BYTE_LIMIT) return true; // skip huge files
        const text = await fs.readFile(filePath, 'utf-8');
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            matches.push({ file: filePath, line: i + 1, text: lines[i]!.slice(0, 500) });
            if (matches.length >= limit) {
              truncated = true;
              return false;
            }
          }
        }
      } catch {
        // skip unreadable files
      }
      return true;
    });

    return { matches, truncated, files_scanned: filesScanned };
  },
};

// ────────────────────────────────────────────────────────────────────
// glob — filename pattern search
// ────────────────────────────────────────────────────────────────────

export const GlobInputSchema = z.object({
  pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.json")'),
  path: z.string().optional().describe('Root dir to search from. Default: sandbox cwd.'),
  max_results: z.number().int().positive().optional().describe(`Cap results. Default ${GLOB_RESULT_LIMIT}.`),
});
export type GlobInput = z.infer<typeof GlobInputSchema>;

export interface GlobOutput {
  matches: string[];
  truncated: boolean;
}

export const globTool: HarnessTool<GlobInput, GlobOutput> = {
  name: 'glob',
  description: 'Find files matching a glob pattern. Returns absolute paths.',
  inputSchema: GlobInputSchema,
  flags: { privateData: true },
  permission: 'auto',
  execute: async ({ pattern, path, max_results }, ctx) => {
    const root = path ? resolvePath(path, ctx.cwd).absolute : ctx.cwd;
    const limit = max_results ?? GLOB_RESULT_LIMIT;
    const re = globToRegex(pattern);
    const matches: string[] = [];
    let truncated = false;

    await walk(root, async (filePath) => {
      if (matches.length >= limit) {
        truncated = true;
        return false;
      }
      const rel = relative(root, filePath);
      if (re.test(rel) || re.test(filePath)) {
        matches.push(filePath);
        if (matches.length >= limit) {
          truncated = true;
          return false;
        }
      }
      return true;
    });

    return { matches, truncated };
  },
};

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
]);

/**
 * Walk a directory tree, calling visit() on each file.
 * If visit returns false, walking stops.
 */
async function walk(root: string, visit: (filePath: string) => Promise<boolean>): Promise<void> {
  let stop = false;
  async function recurse(dir: string): Promise<void> {
    if (stop) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (stop) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await recurse(full);
      } else if (entry.isFile()) {
        const cont = await visit(full);
        if (cont === false) {
          stop = true;
          return;
        }
      }
    }
  }
  await recurse(root);
}

/**
 * Convert a glob pattern to a regex.
 * Supports: * (any chars except /), ** (any chars), ? (single char).
 */
function globToRegex(glob: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (glob[i] === '/') i++; // **/ matches zero or more dirs
      } else {
        regex += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      regex += '[^/]';
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += '\\' + c;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  return new RegExp('^' + regex + '$');
}
