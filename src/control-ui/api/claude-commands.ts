import fs from 'fs';
import path from 'path';
import { redactSecrets } from './logs.js';

// The slash commands a Claude session in this repo understands, for the
// Claude tab's `/` menu: the project's and the operator's skills and
// commands, then a few built-ins. Only a name and a one-line description
// leave this module.

export interface SlashCommand {
  name: string;
  description: string;
  source: 'built-in' | 'project' | 'personal' | 'amos';
}

const NAME_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const FILE_MAX = 64 * 1024;
const DESC_MAX = 160;
const LIST_MAX = 300;
const TTL_MS = 60_000;

// Confirmed present in Claude Code 2.1.283.
const BUILT_INS: [string, string][] = [
  ['model', 'Switch the model for this session'],
  ['effort', 'Set how hard Claude thinks: low, medium, high, xhigh or max'],
  ['compact', 'Summarise the conversation so far to free up context'],
  ['clear', 'Start a fresh conversation in this session'],
  ['context', 'Show how much of the context window is used'],
];

function safeReal(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Reads a file only when it resolves inside `root` and is small. */
function readInside(root: string, file: string): string | null {
  const real = safeReal(file);
  if (!real || !(real === root || real.startsWith(root + path.sep)))
    return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > FILE_MAX) return null;
    return fs.readFileSync(real, 'utf-8');
  } catch {
    return null;
  }
}

/** Frontmatter `name`/`description` of a skill or command file; null when it is not one to offer. */
export function parseSkillFile(
  body: string,
  fallbackName: string,
): { name: string; description: string } | null {
  let name = fallbackName;
  let description = '';
  let rest = body;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    rest = body.slice(fm[0].length);
    const field = (k: string) =>
      new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm[1])?.[1]?.trim() ?? null;
    if (field('user-invocable') === 'false') return null;
    name = field('name')?.replace(/^["']|["']$/g, '') || name;
    description = field('description')?.replace(/^["']|["']$/g, '') ?? '';
  }
  if (!description)
    description =
      rest
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#')) ?? '';
  description = description.split(/(?<=\.)\s/)[0];
  if (!NAME_RE.test(name)) return null;
  return {
    name,
    description: redactSecrets(description).slice(0, DESC_MAX),
  };
}

function scan(
  base: string,
  source: SlashCommand['source'],
  out: Map<string, SlashCommand>,
) {
  const add = (root: string, file: string, fallback: string) => {
    const body = readInside(root, file);
    if (body === null) return;
    const c = parseSkillFile(body, fallback);
    if (c && !out.has(c.name)) out.set(c.name, { ...c, source });
  };
  const skills = safeReal(path.join(base, '.claude', 'skills'));
  if (skills) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(skills);
    } catch {
      /* unreadable: no skills from here */
    }
    for (const d of dirs.sort()) {
      for (const f of ['SKILL.md', 'skill.md']) {
        const file = path.join(skills, d, f);
        if (fs.existsSync(file)) {
          add(skills, file, d);
          break;
        }
      }
    }
  }
  const commands = safeReal(path.join(base, '.claude', 'commands'));
  if (commands) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(commands);
    } catch {
      /* unreadable: no commands from here */
    }
    for (const f of files.sort())
      if (f.endsWith('.md'))
        add(commands, path.join(commands, f), f.slice(0, -3));
  }
}

let cache: { key: string; at: number; list: SlashCommand[] } | null = null;

export function readSlashCommands(
  repoRoot: string,
  homeDir: string,
  opts: { fresh?: boolean; now?: number } = {},
): SlashCommand[] {
  const now = opts.now ?? Date.now();
  const key = `${repoRoot}\0${homeDir}`;
  if (!opts.fresh && cache && cache.key === key && now - cache.at < TTL_MS)
    return cache.list;
  const out = new Map<string, SlashCommand>();
  scan(repoRoot, 'project', out);
  scan(homeDir, 'personal', out);
  for (const [name, description] of BUILT_INS)
    if (!out.has(name))
      out.set(name, { name, description, source: 'built-in' });
  const list = [...out.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, LIST_MAX);
  cache = { key, at: now, list };
  return list;
}

const SKILL_DIR_MAX = 100;

/**
 * Skills directly under `dir` (`<dir>/<name>/SKILL.md` or `skill.md`), with
 * the same guards as the Claude list. Used for Amos's own container skills.
 */
export function readSkillDir(
  dir: string,
  source: SlashCommand['source'],
): SlashCommand[] {
  const root = safeReal(dir);
  if (!root) return [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = new Map<string, SlashCommand>();
  for (const d of dirs.sort()) {
    for (const f of ['SKILL.md', 'skill.md']) {
      const file = path.join(root, d, f);
      if (!fs.existsSync(file)) continue;
      const body = readInside(root, file);
      const c = body === null ? null : parseSkillFile(body, d);
      if (c && !out.has(c.name)) out.set(c.name, { ...c, source });
      break;
    }
  }
  return [...out.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, SKILL_DIR_MAX);
}
