/**
 * Loader for project-level agent instructions (AGENT.md, CLAUDE.md).
 *
 * Used by chat, repl, and agent commands to seed the system prompt with
 * the project's standing instructions whenever the user hasn't passed
 * an explicit --system override.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export const INSTRUCTION_FILES = ['AGENT.md', 'CLAUDE.md'] as const;

export interface LoadedInstructions {
  source: (typeof INSTRUCTION_FILES)[number];
  path: string;
  content: string;
}

export async function loadProjectInstructions(cwd: string): Promise<LoadedInstructions | null> {
  for (const source of INSTRUCTION_FILES) {
    const path = join(cwd, source);
    try {
      const content = await fs.readFile(path, 'utf-8');
      if (content.trim().length === 0) continue;
      return { source, path, content };
    } catch {
      continue;
    }
  }
  return null;
}
