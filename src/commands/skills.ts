/**
 * `frqncy-harness skills <subcmd> [args]` — manage skill packs.
 *
 * Subcommands:
 *   list             List all skills under ~/.frqncy-harness/skills/
 *   show <name>      Print a skill's full body
 *   path             Print the skills directory path
 *   match <prompt>   Show which skills would match a given prompt
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  loadSkills,
  matchSkills,
  DEFAULT_SKILLS_DIR,
} from '../skills/index.js';

export type SkillsSubcommand = 'list' | 'show' | 'path' | 'match';

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export async function runSkillsCommand(sub: SkillsSubcommand, args: string[]): Promise<void> {
  switch (sub) {
    case 'list':
      await listSkills();
      return;
    case 'show':
      await showSkill(args[0]);
      return;
    case 'path':
      await printPath();
      return;
    case 'match':
      await matchPrompt(args.join(' '));
      return;
    default:
      throw new Error(`Unknown skills subcommand: ${sub}. Try: list | show | path | match`);
  }
}

async function listSkills(): Promise<void> {
  const skills = await loadSkills();
  if (skills.length === 0) {
    process.stdout.write(
      `${ANSI.dim}No skills installed. Drop a directory containing SKILL.md into:${ANSI.reset}\n` +
        `  ${DEFAULT_SKILLS_DIR}\n\n` +
        `${ANSI.dim}Each SKILL.md needs YAML frontmatter:${ANSI.reset}\n` +
        `  ---\n  name: my-skill\n  description: One-line description of when to use this\n  keywords: [optional, terms]\n  always: false\n  ---\n` +
        `\n  # Skill body in markdown\n`,
    );
    return;
  }
  process.stdout.write(`${ANSI.bold}${ANSI.cyan}Installed skills (${skills.length})${ANSI.reset}\n\n`);
  for (const s of skills) {
    const flag = s.always ? `${ANSI.yellow}always${ANSI.reset} ` : '';
    process.stdout.write(`  ${ANSI.bold}${s.name}${ANSI.reset}  ${flag}${ANSI.dim}${s.description}${ANSI.reset}\n`);
    if (s.keywords.length > 0) {
      process.stdout.write(`    ${ANSI.dim}keywords: ${s.keywords.join(', ')}${ANSI.reset}\n`);
    }
    process.stdout.write(`    ${ANSI.dim}path: ${s.path}${ANSI.reset}\n\n`);
  }
}

async function showSkill(name: string | undefined): Promise<void> {
  if (!name) throw new Error('Usage: frqncy-harness skills show <name>');
  const skills = await loadSkills();
  const found = skills.find((s) => s.name === name);
  if (!found) {
    const known = skills.map((s) => s.name).join(', ') || '(none)';
    throw new Error(`Skill "${name}" not found. Installed: ${known}`);
  }
  process.stdout.write(`${ANSI.bold}${found.name}${ANSI.reset}  ${ANSI.dim}${found.description}${ANSI.reset}\n`);
  if (found.keywords.length > 0) {
    process.stdout.write(`${ANSI.dim}keywords: ${found.keywords.join(', ')}${ANSI.reset}\n`);
  }
  if (found.always) {
    process.stdout.write(`${ANSI.yellow}always: true${ANSI.reset}\n`);
  }
  process.stdout.write(`${ANSI.dim}path: ${found.path}${ANSI.reset}\n\n`);
  process.stdout.write(found.body + '\n');
}

async function printPath(): Promise<void> {
  await fs.mkdir(DEFAULT_SKILLS_DIR, { recursive: true });
  // Drop a README the first time to make the convention obvious.
  const readme = join(DEFAULT_SKILLS_DIR, 'README.md');
  try {
    await fs.access(readme);
  } catch {
    await fs.writeFile(
      readme,
      `# frqncy-harness skills\n\nDrop one directory per skill in this folder. Each directory must contain a \`SKILL.md\` file with YAML frontmatter:\n\n\`\`\`markdown\n---\nname: my-skill\ndescription: One-line description of when to use this\nkeywords: [optional, terms]\nalways: false\n---\n\n# Skill body in markdown\n\`\`\`\n\nSkills are auto-injected into chat / repl / agent system prompts when the user prompt matches the skill's keywords or description.\n`,
      'utf-8',
    );
  }
  process.stdout.write(DEFAULT_SKILLS_DIR + '\n');
}

async function matchPrompt(prompt: string): Promise<void> {
  if (!prompt.trim()) throw new Error('Usage: frqncy-harness skills match "your prompt here"');
  const skills = await loadSkills();
  if (skills.length === 0) {
    process.stdout.write(`${ANSI.dim}No skills installed.${ANSI.reset}\n`);
    return;
  }
  const matched = matchSkills(prompt, skills);
  if (matched.length === 0) {
    process.stdout.write(`${ANSI.dim}No skills matched.${ANSI.reset}\n`);
    return;
  }
  process.stdout.write(`${ANSI.bold}Matched ${matched.length} skill(s):${ANSI.reset}\n\n`);
  for (const s of matched) {
    process.stdout.write(`  ${ANSI.green}✓${ANSI.reset} ${ANSI.bold}${s.name}${ANSI.reset}  ${ANSI.dim}${s.description}${ANSI.reset}\n`);
  }
}
