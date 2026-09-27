import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CLAUDE_SESSION_ID_RE } from './claude-sessions.js';

// Claude Code's own task list for a session — the ✻/■/□ tree the terminal
// draws — read from `~/.claude/tasks/<session uuid>/<n>.json`. Read-only; the
// conversation view shows it beside the messages. Same file discipline as the
// transcript reader: a real directory, real files, no links, bounded sizes.

export const TASK_STATUSES = ['in_progress', 'pending', 'completed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export interface SessionTask {
  id: string;
  subject: string;
  status: TaskStatus;
  activeForm?: string;
}
export interface SessionTasks {
  version: string;
  tasks: SessionTask[];
}

const FILE_RE = /^\d{1,6}\.json$/;
const FILE_MAX = 64 * 1024;
const FILES_MAX = 200;
const MEMO_MAX = 8;
const ORDER: Record<TaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** One task file's content, or null when it is not a task. */
export function validateTask(raw: unknown): SessionTask | null {
  if (!isObj(raw)) return null;
  const { id, subject, status, activeForm } = raw;
  if (typeof id !== 'string' || id.length < 1 || id.length > 32) return null;
  if (typeof subject !== 'string') return null;
  const subj = subject.trim();
  if (subj.length < 1 || subj.length > 200) return null;
  if (
    typeof status !== 'string' ||
    !(TASK_STATUSES as readonly string[]).includes(status)
  )
    return null;
  const t: SessionTask = { id, subject: subj, status: status as TaskStatus };
  if (typeof activeForm === 'string' && activeForm.trim()) {
    const a = activeForm.trim();
    if (a.length <= 200) t.activeForm = a;
  }
  return t;
}

const numericId = (t: SessionTask): number => {
  const n = Number(t.id);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** in_progress → pending → completed, then by numeric id. */
export function sortTasks(tasks: SessionTask[]): SessionTask[] {
  return [...tasks].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      numericId(a) - numericId(b) ||
      a.id.localeCompare(b.id),
  );
}

/** A stable version of what the panel shows; changes only when a row would. */
export function tasksVersion(tasks: SessionTask[]): string {
  if (!tasks.length) return '0';
  const h = crypto.createHash('sha1');
  for (const t of tasks)
    h.update(
      `${t.id}\u0000${t.status}\u0000${t.subject}\u0000${t.activeForm ?? ''}\u0001`,
    );
  return h.digest('hex').slice(0, 16);
}

function readTaskFile(file: string): SessionTask | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > FILE_MAX) return null;
  try {
    return validateTask(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    return null;
  }
}

/**
 * Reader for one tasks store; memoized per session on the directory's mtime
 * plus the sum of the files' mtimes (a status change rewrites a file, a new
 * task adds one), evicting the oldest past MEMO_MAX like the transcript reader.
 */
export function createTaskReader(tasksDir: string) {
  const memo = new Map<string, { key: string; value: SessionTasks }>();
  return (sessionId: string): SessionTasks | null => {
    if (!CLAUDE_SESSION_ID_RE.test(sessionId)) return null;
    const dir = path.join(tasksDir, sessionId);
    let dst: fs.Stats;
    try {
      dst = fs.lstatSync(dir);
    } catch {
      return null;
    }
    if (!dst.isDirectory() || dst.isSymbolicLink()) return null;
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n));
    } catch {
      return null;
    }
    names.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
    names = names.slice(-FILES_MAX); // the newest, if a session ever has more
    let mtimes = 0;
    for (const n of names) {
      try {
        mtimes += fs.lstatSync(path.join(dir, n)).mtimeMs;
      } catch {
        /* vanished between readdir and stat: the key just differs */
      }
    }
    const key = `${Math.trunc(dst.mtimeMs)}:${Math.trunc(mtimes)}:${names.length}`;
    const hit = memo.get(sessionId);
    if (hit && hit.key === key) return hit.value;
    const tasks = sortTasks(
      names
        .map((n) => readTaskFile(path.join(dir, n)))
        .filter((t): t is SessionTask => t !== null),
    );
    const value = { version: tasksVersion(tasks), tasks };
    memo.delete(sessionId);
    memo.set(sessionId, { key, value });
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
    return value;
  };
}
