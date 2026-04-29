/**
 * `frqncy-harness compress-memory <target> [--model <m>] [--dry-run] [--force] [--json]`
 *
 * Rewrite the harness's stable agent inputs (CLAUDE.md, AGENT.md, skill READMEs,
 * persona blocks — anything that gets re-injected into the prompt every turn)
 * into compressed form while preserving a human-readable original at
 * `<file>.original.md`. Saves 40-60% on every iteration forever.
 *
 * Per `proposals/SELF-IMPROVING-HARNESS.md` Tier B.4 — borrowed from
 * juliusbrussee/caveman. The corpus is loud about *trace* hygiene and *output*
 * shaping but mostly silent on the *inputs* that get paid for every iteration.
 * A loop running 25 iterations against a 4000-token CLAUDE.md pays 100K tokens
 * just for the standing context. Compress that to 2000 tokens once and save
 * 50K tokens per loop, every loop.
 *
 * Idempotency:
 *   - Each compressed file gets a hash of its source committed to YAML front-matter
 *   - Re-running on an already-compressed file with no source changes is a no-op
 *   - If the source `.original.md` changes (hash mismatches), the compression
 *     is regenerated automatically — nothing stale ever ships
 *
 * Safety:
 *   - Inoculation sentence in the system prompt (per Anthropic Nov 2025)
 *   - Cost cap inherited from config — won't run away on a large directory
 *   - Refuses files outside the target directory
 *   - Refuses files that are already compressed unless --force
 *   - Original is ALWAYS preserved at `<file>.original.md` — the human edit-path
 */
import { promises as fs } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chat as defaultChat } from '../chat.js';
import { loadConfig } from '../config.js';
import { INOCULATION_SENTENCE } from './codify.js';
import type { ChatInput, ChatResult, ModelString } from '../types.js';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

const DEFAULT_MIN_BYTES = 1500; // don't bother compressing files under 1.5KB

const COMPRESS_FRONTMATTER_KEY = 'compressed_from_hash';

export const COMPRESS_SYSTEM_PROMPT = `You are a token-compression specialist. ${INOCULATION_SENTENCE}

Your job: rewrite the user-supplied Markdown text so an LLM agent can extract the same meaning from it with substantially fewer tokens, while keeping it human-readable enough that a future operator can still skim it.

Hard rules:
- Preserve every fact, instruction, schema, file path, code identifier, and named decision verbatim — nothing factual is allowed to drift
- Drop articles (the/a/an), filler ("just", "really", "basically"), hedging ("might", "could potentially"), and pleasantries
- Keep code blocks unchanged — they are technical content, not prose
- Keep heading structure (H1/H2/H3) unchanged so the document remains navigable
- Keep ordered/unordered lists unchanged in count and order
- If the source contains explicit "do not modify this" markers (e.g. AGENT.md "Locked architectural decisions"), preserve those sections unchanged
- Output ONLY the compressed Markdown — no commentary, no explanation, no wrapping fences

Target: 40-60% byte reduction. If the source is already terse, output it unchanged with a leading comment \`<!-- already terse -->\` and stop.`;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type CompressStatus = 'compressed' | 'unchanged' | 'skipped' | 'failed';

export interface CompressFileResult {
  sourcePath: string;
  originalPath: string;
  status: CompressStatus;
  originalBytes: number;
  compressedBytes: number;
  reductionPct: number;
  reason?: string;
}

export interface CompressMemoryCommandOptions {
  /** Override the target. Default: process.cwd(). */
  cwd?: string;
  /** Override the LLM. Defaults to config.defaultModel. */
  model?: string;
  /** Print proposed changes, don't write. */
  dryRun?: boolean;
  /** Recompress files that are already marked as compressed. */
  force?: boolean;
  /** Skip files smaller than this many bytes. Default 1500. */
  minBytes?: number;
  /** Emit JSON instead of human-readable status. */
  json?: boolean;
  // Test seams ─────────────────────────────────────────────
  /** Substitute the chat function. */
  chatFn?: (input: ChatInput) => Promise<ChatResult>;
}

export interface CompressMemoryResult {
  target: string;
  filesProcessed: number;
  filesCompressed: number;
  filesSkipped: number;
  filesFailed: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  totalReductionPct: number;
  files: CompressFileResult[];
}

// ────────────────────────────────────────────────────────────────────
// Main entry
// ────────────────────────────────────────────────────────────────────

export async function runCompressMemoryCommand(
  target: string,
  options: CompressMemoryCommandOptions = {},
): Promise<CompressMemoryResult> {
  const config = await loadConfig();
  const cwd = options.cwd ?? process.cwd();
  const chatFn = options.chatFn ?? defaultChat;
  const model = (options.model ?? config.defaultModel ?? 'anthropic/claude-sonnet-4-6') as ModelString;
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;

  const absoluteTarget = resolveTarget(target, cwd);

  const banner = (msg: string): void => {
    if (!options.json) process.stdout.write(msg);
  };

  // 1. Collect candidate files (.md files, recursive)
  const candidates = await collectMarkdownFiles(absoluteTarget);

  banner(
    `${ANSI.bold}${ANSI.cyan}compress-memory${ANSI.reset} ` +
      `${ANSI.dim}target=${absoluteTarget}${ANSI.reset}\n` +
      `${ANSI.dim}found ${candidates.length} markdown file(s); model=${model}; min-bytes=${minBytes}${ANSI.reset}\n\n`,
  );

  // 2. Process each
  const results: CompressFileResult[] = [];
  let totalOriginalBytes = 0;
  let totalCompressedBytes = 0;

  for (const filePath of candidates) {
    const result = await processFile(filePath, {
      chatFn,
      model,
      minBytes,
      dryRun: options.dryRun ?? false,
      force: options.force ?? false,
      costCap: config.costCap,
    });
    results.push(result);
    totalOriginalBytes += result.originalBytes;
    if (result.status === 'compressed' || result.status === 'unchanged') {
      totalCompressedBytes += result.compressedBytes;
    } else {
      totalCompressedBytes += result.originalBytes; // skipped/failed: no savings
    }

    if (!options.json) {
      const statusColor =
        result.status === 'compressed' ? ANSI.green : result.status === 'failed' ? ANSI.yellow : ANSI.dim;
      const relPath = relative(cwd, result.sourcePath);
      banner(
        `  ${statusColor}${result.status.padEnd(11)}${ANSI.reset} ${relPath}` +
          `  ${ANSI.dim}${result.originalBytes}b → ${result.compressedBytes}b ` +
          `(${result.reductionPct >= 0 ? '-' : '+'}${Math.abs(result.reductionPct).toFixed(1)}%)${ANSI.reset}` +
          (result.reason ? `  ${ANSI.dim}(${result.reason})${ANSI.reset}` : '') +
          '\n',
      );
    }
  }

  const totalReductionPct =
    totalOriginalBytes === 0 ? 0 : ((totalOriginalBytes - totalCompressedBytes) / totalOriginalBytes) * 100;

  const summary: CompressMemoryResult = {
    target: absoluteTarget,
    filesProcessed: results.length,
    filesCompressed: results.filter((r) => r.status === 'compressed').length,
    filesSkipped: results.filter((r) => r.status === 'skipped' || r.status === 'unchanged').length,
    filesFailed: results.filter((r) => r.status === 'failed').length,
    totalOriginalBytes,
    totalCompressedBytes,
    totalReductionPct,
    files: results,
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return summary;
  }

  banner(
    `\n${ANSI.bold}summary${ANSI.reset}\n` +
      `${ANSI.dim}  processed: ${summary.filesProcessed}${ANSI.reset}\n` +
      `${ANSI.dim}  compressed: ${summary.filesCompressed}${ANSI.reset}\n` +
      `${ANSI.dim}  skipped: ${summary.filesSkipped}${ANSI.reset}\n` +
      `${ANSI.dim}  failed: ${summary.filesFailed}${ANSI.reset}\n` +
      `${ANSI.green}  total: ${summary.totalOriginalBytes}b → ${summary.totalCompressedBytes}b (-${summary.totalReductionPct.toFixed(1)}%)${ANSI.reset}\n` +
      (options.dryRun ? `${ANSI.yellow}note:${ANSI.reset} dry-run, nothing was written\n` : ''),
  );
  return summary;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testing)
// ────────────────────────────────────────────────────────────────────

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16);
}

export function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { frontmatter: {}, body: raw };
  const closeIdx = raw.indexOf('\n---', 4);
  if (closeIdx === -1) return { frontmatter: {}, body: raw };
  const fmRaw = raw.slice(4, closeIdx);
  const body = raw.slice(closeIdx + 4).replace(/^\n+/, '');
  const frontmatter: Record<string, string> = {};
  for (const line of fmRaw.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/);
    if (m && m[1] && m[2] !== undefined) {
      frontmatter[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { frontmatter, body };
}

export function isAlreadyCompressed(raw: string): boolean {
  const { frontmatter } = parseFrontmatter(raw);
  return frontmatter[COMPRESS_FRONTMATTER_KEY] !== undefined;
}

export function getCompressedSourceHash(raw: string): string | null {
  const { frontmatter } = parseFrontmatter(raw);
  return frontmatter[COMPRESS_FRONTMATTER_KEY] ?? null;
}

export function buildCompressedFile(compressedBody: string, sourceHash: string): string {
  return [`---`, `${COMPRESS_FRONTMATTER_KEY}: ${sourceHash}`, `compressed_at: ${new Date().toISOString()}`, `---`, ``, compressedBody.trimEnd(), ``].join(
    '\n',
  );
}

// ────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────

interface ProcessFileArgs {
  chatFn: (input: ChatInput) => Promise<ChatResult>;
  model: ModelString;
  minBytes: number;
  dryRun: boolean;
  force: boolean;
  costCap: { softWarnUsd?: number; hardAbortUsd?: number };
}

async function processFile(filePath: string, args: ProcessFileArgs): Promise<CompressFileResult> {
  const originalPath = filePath + '.original.md';
  const fileExists = async (p: string): Promise<boolean> => {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  };

  // Skip our own .original.md sidecars
  if (filePath.endsWith('.original.md')) {
    const originalBytes = (await fs.stat(filePath)).size;
    return {
      sourcePath: filePath,
      originalPath,
      status: 'skipped',
      originalBytes,
      compressedBytes: originalBytes,
      reductionPct: 0,
      reason: 'is a .original.md sidecar',
    };
  }

  let liveRaw: string;
  try {
    liveRaw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      sourcePath: filePath,
      originalPath,
      status: 'failed',
      originalBytes: 0,
      compressedBytes: 0,
      reductionPct: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // The "canonical source" is the sidecar if it exists, else the live file.
  // We size-check against the canonical source — otherwise a second pass on an
  // already-compressed file would skip itself (compressed file is small).
  let sourceForCompression = liveRaw;
  let sidecarExists = false;
  if (await fileExists(originalPath)) {
    sourceForCompression = await fs.readFile(originalPath, 'utf-8');
    sidecarExists = true;
  }
  const originalBytes = Buffer.byteLength(sourceForCompression, 'utf-8');

  if (originalBytes < args.minBytes) {
    return {
      sourcePath: filePath,
      originalPath,
      status: 'skipped',
      originalBytes,
      compressedBytes: originalBytes,
      reductionPct: 0,
      reason: `under min-bytes (${args.minBytes})`,
    };
  }

  // Idempotency check: if the live file is already-compressed AND its
  // source hash still matches the sidecar, skip. Unless --force.
  if (sidecarExists) {
    const sidecarHash = hashContent(sourceForCompression);
    const liveSourceHash = getCompressedSourceHash(liveRaw);
    if (liveSourceHash && liveSourceHash === sidecarHash && !args.force) {
      const liveBytes = Buffer.byteLength(liveRaw, 'utf-8');
      return {
        sourcePath: filePath,
        originalPath,
        status: 'unchanged',
        originalBytes,
        compressedBytes: liveBytes,
        reductionPct: ((originalBytes - liveBytes) / originalBytes) * 100,
        reason: 'already compressed; source unchanged',
      };
    }
  }
  const raw = sourceForCompression;

  // Call the LLM
  let result: ChatResult;
  try {
    result = await args.chatFn({
      model: args.model,
      messages: [{ role: 'user', content: raw }],
      system: COMPRESS_SYSTEM_PROMPT,
      costCap: args.costCap,
    });
  } catch (err) {
    return {
      sourcePath: filePath,
      originalPath,
      status: 'failed',
      originalBytes,
      compressedBytes: 0,
      reductionPct: 0,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let compressed = result.text.trim();

  // The LLM may emit "<!-- already terse -->" — accept that gracefully
  if (compressed.startsWith('<!-- already terse -->')) {
    return {
      sourcePath: filePath,
      originalPath,
      status: 'unchanged',
      originalBytes,
      compressedBytes: originalBytes,
      reductionPct: 0,
      reason: 'model declared already terse',
    };
  }

  // Don't accept compressions that grew the file (some models do this)
  const compressedBytes = Buffer.byteLength(compressed, 'utf-8');
  if (compressedBytes >= originalBytes) {
    return {
      sourcePath: filePath,
      originalPath,
      status: 'unchanged',
      originalBytes,
      compressedBytes,
      reductionPct: ((originalBytes - compressedBytes) / originalBytes) * 100,
      reason: 'compression did not reduce size',
    };
  }

  const sourceHash = hashContent(raw);
  const finalContent = buildCompressedFile(compressed, sourceHash);

  if (args.dryRun) {
    return {
      sourcePath: filePath,
      originalPath,
      status: 'compressed',
      originalBytes,
      compressedBytes: Buffer.byteLength(finalContent, 'utf-8'),
      reductionPct: ((originalBytes - Buffer.byteLength(finalContent, 'utf-8')) / originalBytes) * 100,
      reason: 'dry-run',
    };
  }

  // Write sidecar (only if doesn't exist — preserves the FIRST original)
  if (!(await fileExists(originalPath))) {
    await fs.writeFile(originalPath, raw, 'utf-8');
  }
  // Write the compressed version over the live file
  await fs.writeFile(filePath, finalContent, 'utf-8');

  return {
    sourcePath: filePath,
    originalPath,
    status: 'compressed',
    originalBytes,
    compressedBytes: Buffer.byteLength(finalContent, 'utf-8'),
    reductionPct: ((originalBytes - Buffer.byteLength(finalContent, 'utf-8')) / originalBytes) * 100,
  };
}

async function collectMarkdownFiles(root: string): Promise<string[]> {
  const stat = await fs.stat(root);
  if (stat.isFile()) {
    return root.endsWith('.md') && !root.endsWith('.original.md') ? [root] : [];
  }
  const out: string[] = [];
  await walkDir(root, out);
  return out.sort();
}

async function walkDir(dir: string, accumulator: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkDir(full, accumulator);
    } else if (e.isFile() && e.name.endsWith('.md') && !e.name.endsWith('.original.md')) {
      accumulator.push(full);
    }
  }
}

function resolveTarget(target: string, cwd: string): string {
  if (target.startsWith('/')) return target;
  return resolve(join(cwd, target));
}
