import fs from 'fs';
import path from 'path';
import { CLAUDE_JOB_ID_RE } from './claude-sessions.js';
import { INTEGRATION_NAME_RE } from './integrations.js';

// Integrations being set up by a session the dashboard started. One at a
// time: the add-* skills edit the same files and may restart the service.

export const SETUPS_MAX = 20;
export const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
export const SETUP_GRACE_MS = 30_000; // a just-started session may not be listed yet
export const SETUPS_FILE = 'integration-setups.json';

export interface Setup {
  id: string;
  name: string;
  started_at: number;
}

const isSetup = (v: unknown): v is Setup => {
  const s = v as Partial<Setup> | null;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.id === 'string' &&
    CLAUDE_JOB_ID_RE.test(s.id) &&
    typeof s.name === 'string' &&
    INTEGRATION_NAME_RE.test(s.name) &&
    typeof s.started_at === 'number' &&
    Number.isFinite(s.started_at)
  );
};

/** A personal or plugin skill with this name would shadow the repo's. */
export function shadowedBy(homeDir: string, name: string): string | null {
  if (!INTEGRATION_NAME_RE.test(name)) return null;
  const personal = [
    path.join(homeDir, '.claude', 'skills', name, 'SKILL.md'),
    path.join(homeDir, '.claude', 'skills', name, 'skill.md'),
    path.join(homeDir, '.claude', 'commands', `${name}.md`),
  ];
  for (const p of personal) if (fs.existsSync(p)) return p;
  // Plugin caches: <cache>/<marketplace>/<plugin>/<version>/(.claude/)?skills/<name>
  const cache = path.join(homeDir, '.claude', 'plugins', 'cache');
  const walk = (dir: string, depth: number): string | null => {
    if (depth > 5) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(dir, e.name);
      if (e.name === 'skills') {
        const hit = path.join(full, name);
        if (fs.existsSync(path.join(hit, 'SKILL.md'))) return hit;
        continue;
      }
      const found = walk(full, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(cache, 0);
}

export function createSetups(file: string) {
  const read = (): Setup[] => {
    try {
      const v: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(v) ? v.filter(isSetup) : [];
    } catch {
      return [];
    }
  };
  const write = (list: Setup[]): boolean => {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
      return true;
    } catch {
      fs.rmSync(tmp, { force: true });
      return false;
    }
  };
  return {
    list: read,
    add(s: Setup): boolean {
      if (!isSetup(s)) return false;
      const list = read().filter((x) => x.id !== s.id);
      list.push(s);
      return write(list.slice(-SETUPS_MAX));
    },
    /** Keeps only setups whose session is still listed (or just started) and not a day old. */
    prune(o: { listedIds: Set<string>; now: number }): Setup[] {
      const before = read();
      const kept = before.filter(
        (s) =>
          (o.listedIds.has(s.id) || o.now - s.started_at < SETUP_GRACE_MS) &&
          o.now - s.started_at < SETUP_TTL_MS,
      );
      if (kept.length !== before.length) write(kept);
      return kept;
    },
  };
}

export type Setups = ReturnType<typeof createSetups>;
