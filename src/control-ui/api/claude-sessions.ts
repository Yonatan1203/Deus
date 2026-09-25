import fs from 'fs';
import path from 'path';
import { IS_WINDOWS } from '../../platform.js';
import type { HostCli } from './host-cli.js';
import { redactSecrets, SECRET_KEYS } from './logs.js';

export const CLAUDE_JOB_ID_RE = /^[0-9a-f]{8}$/;
export const CLAUDE_SESSION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Must not start with `-`: the live threat with execFile is option injection.
export const CLAUDE_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
export const PROMPT_MAX = 8192;
export const TAIL_WAITING_BYTES = 256 * 1024;
const SECRET_NAME_RE = new RegExp(SECRET_KEYS, 'i');
const ENV_ALLOW = [
  'PATH',
  'HOME',
  'TERM',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'SHELL',
];

export interface ClaudeSession {
  id: string;
  session_id: string | null;
  name: string;
  kind: 'background' | 'interactive';
  state: 'working' | 'blocked' | 'done' | 'unknown';
  status?: string;
  waiting_on?: string;
  cwd_rel: string;
  started_at: number | null;
  resumable: boolean;
}

export type ListResult =
  { sessions: ClaudeSession[]; dropped: number } | { error: string };

/** Walks PATH without a shell; probes the Windows launcher names too. */
export function resolveClaudeBin(
  pathEnv: string,
  isFile: (p: string) => boolean = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  const names = IS_WINDOWS
    ? ['claude.cmd', 'claude.exe', 'claude']
    : ['claude'];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const full = path.join(dir, n);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// Explicit env for spawned sessions: the allowlist plus DEUS_, ANTHROPIC_ and
// CLAUDE_ prefixes, never a secret-looking name.
export function spawnEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue;
    const allowed =
      ENV_ALLOW.includes(k) ||
      k.startsWith('DEUS_') ||
      k.startsWith('ANTHROPIC_') ||
      k.startsWith('CLAUDE_');
    if (allowed && !SECRET_NAME_RE.test(k)) out[k] = v;
  }
  return out;
}

export function validatePrompt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length < 1 || v.length > PROMPT_MAX || v.includes('\0')) return null;
  return v;
}

function under(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const safeReal = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** `claude agents --json --all --cwd <root>`, filtered on realpath(cwd) — the flag is an optimisation, the filter is the control. */
export async function listClaudeSessions(
  cli: HostCli,
  root: string,
  opts: {
    projectsDir?: string;
    waitingOn?: (sessionId: string) => string | null;
  } = {},
): Promise<ListResult> {
  const r = await cli.run(['agents', '--json', '--all', `--cwd=${root}`]);
  if (!r.ok) return { error: r.error };
  const text = r.stdout.trimStart();
  if (!text.startsWith('[')) return { error: 'unexpected session list output' };
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return { error: 'unexpected session list output' };
  }
  if (!Array.isArray(rows)) return { error: 'unexpected session list output' };
  const realRoot = safeReal(root) ?? root;
  const sessions: ClaudeSession[] = [];
  let dropped = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = String(row.id ?? '');
    const cwd = typeof row.cwd === 'string' ? row.cwd : '';
    const realCwd = safeReal(cwd) ?? cwd;
    if (!CLAUDE_JOB_ID_RE.test(id) || !cwd || !under(realRoot, realCwd)) {
      dropped++;
      continue;
    }
    const sid =
      typeof row.sessionId === 'string' &&
      CLAUDE_SESSION_ID_RE.test(row.sessionId)
        ? row.sessionId
        : null;
    const kind = row.kind === 'interactive' ? 'interactive' : 'background';
    const st = String(row.state ?? '');
    const state =
      st === 'working' || st === 'blocked' || st === 'done' ? st : 'unknown';
    const s: ClaudeSession = {
      id,
      session_id: sid,
      name: redactSecrets(String(row.name ?? id)).slice(0, 80),
      kind,
      state,
      cwd_rel: path.relative(realRoot, realCwd) || '.',
      started_at: typeof row.startedAt === 'number' ? row.startedAt : null,
      resumable: kind === 'background' && sid !== null,
    };
    if (typeof row.status === 'string') s.status = row.status.slice(0, 40);
    if (state === 'blocked' && sid && opts.waitingOn) {
      const w = opts.waitingOn(sid);
      if (w) s.waiting_on = w;
    }
    sessions.push(s);
  }
  return { sessions, dropped };
}

// ---- transcripts -----------------------------------------------------------

/** Reads the last `bytes` of a file; discards the first partial line unless the read started at 0; skips lines that are not JSON. */
export function readTail(
  file: string,
  bytes: number,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines = lines.slice(1);
    const rows: Record<string, unknown>[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const v: unknown = JSON.parse(l);
        if (v && typeof v === 'object') rows.push(v as Record<string, unknown>);
      } catch {
        /* partial or foreign line: skipped, never thrown */
      }
    }
    return { rows, truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Locates `<projectsDir>/<dir>/<sessionId>.jsonl` (exactly that file) confined under the projects dir. */
export function transcriptPath(
  projectsDir: string,
  sessionId: string,
): string | null {
  if (!CLAUDE_SESSION_ID_RE.test(sessionId)) return null;
  const realRoot = safeReal(projectsDir);
  if (!realRoot) return null;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(projectsDir, d, `${sessionId}.jsonl`);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(candidate);
    } catch {
      continue;
    }
    if (!st.isFile() || st.isSymbolicLink()) continue;
    const real = safeReal(candidate);
    if (!real || !under(realRoot, real)) continue;
    return real;
  }
  return null;
}

type Block = { type?: string; text?: string };

/** Last assistant text block, memoized on the file's mtime+size. */
export function createWaitingOnReader(projectsDir: string) {
  const memo = new Map<string, { key: string; value: string | null }>();
  return (sessionId: string): string | null => {
    const file = transcriptPath(projectsDir, sessionId);
    if (!file) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = memo.get(sessionId);
    if (hit && hit.key === key) return hit.value;
    let value: string | null = null;
    const tail = readTail(file, TAIL_WAITING_BYTES);
    for (let i = tail.rows.length - 1; i >= 0 && value === null; i--) {
      const e = tail.rows[i];
      if (e.type !== 'assistant' || e.isSidechain === true) continue;
      const content = (e.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j] as Block;
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          value = redactSecrets(b.text.trim()).slice(0, 500);
          break;
        }
      }
    }
    memo.set(sessionId, { key, value });
    if (memo.size > 500) memo.delete(memo.keys().next().value as string);
    return value;
  };
}

// ---- mutations ---------------------------------------------------------------

/** Exactly one distinct 8-hex value, else null. */
export function parsePrintedId(stdout: string): string | null {
  const ids = new Set(stdout.match(/\b[0-9a-f]{8}\b/g) ?? []);
  return ids.size === 1 ? [...ids][0] : null;
}

/** Auto mode, the same permission mode the operator's terminal sessions use. */
export function startArgv(name: string, prompt: string): string[] {
  return ['--bg', `--name=${name}`, '--permission-mode=auto', '--', prompt];
}

export async function startClaudeSession(
  cli: HostCli,
  name: string,
  prompt: string,
): Promise<
  { id: string } | { unparsed: true; stdout: string } | { error: string }
> {
  if (!CLAUDE_NAME_RE.test(name)) return { error: 'invalid name' };
  if (validatePrompt(prompt) === null) return { error: 'invalid prompt' };
  const r = await cli.run(startArgv(name, prompt));
  if (!r.ok) return { error: r.error };
  const id = parsePrintedId(r.stdout);
  return id
    ? { id }
    : { unparsed: true, stdout: redactSecrets(r.stdout).slice(0, 200) };
}

export async function stopClaudeSession(
  cli: HostCli,
  id: string,
): Promise<{ stopped: true } | { error: string }> {
  if (!CLAUDE_JOB_ID_RE.test(id)) return { error: 'invalid id' };
  const r = await cli.run(['stop', id]);
  return r.ok ? { stopped: true } : { error: r.error };
}

export async function readLogs(
  cli: HostCli,
  id: string,
): Promise<{ lines: string[] } | { error: string }> {
  if (!CLAUDE_JOB_ID_RE.test(id)) return { error: 'invalid id' };
  const r = await cli.run(['logs', id], { maxBuffer: 4 * 1024 * 1024 });
  if (!r.ok) return { error: r.error };
  return {
    lines: `${r.stdout}\n${r.stderr}`
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-500)
      .map(redactSecrets),
  };
}

// ---- dashboard-started ledger (cost guard, not a security control) ------------

export interface Ledger {
  read(): { id: string; started_at: number }[] | null;
  add(entry: { id: string; started_at: number }): boolean;
  prune(liveIds: Set<string>): void;
}

export function createLedger(file: string): Ledger {
  const read = (): { id: string; started_at: number }[] | null => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
    }
    try {
      const v: unknown = JSON.parse(text);
      if (!Array.isArray(v)) return null;
      return v.filter(
        (e): e is { id: string; started_at: number } =>
          !!e &&
          typeof e === 'object' &&
          CLAUDE_JOB_ID_RE.test(String((e as { id?: unknown }).id)) &&
          typeof (e as { started_at?: unknown }).started_at === 'number',
      );
    } catch {
      return null;
    }
  };
  const write = (entries: { id: string; started_at: number }[]): boolean => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
  return {
    read,
    add(entry) {
      const cur = read();
      if (cur === null) return false;
      return write([...cur.filter((e) => e.id !== entry.id), entry]);
    },
    prune(liveIds) {
      const cur = read();
      if (cur === null) return;
      const kept = cur.filter((e) => liveIds.has(e.id));
      if (kept.length !== cur.length) write(kept);
    },
  };
}
