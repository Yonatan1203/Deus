import fs from 'fs';
import path from 'path';
import { checkUrl, type UrlBlock } from './allowed-url.js';
import { redactSecrets } from './logs.js';

// The workflow registry: `CONFIG_DIR/control-ui/workflows/<id>.json`, one
// record per long-running order, written by `scripts/workflow.mjs`. Anything
// running as the operator can write there, so every control is on this read
// path: dirent type + name regex, O_NOFOLLOW open, fstat bound, one parse,
// a fresh literal per record, closed-enum failure reasons.
export const WORKFLOW_ID_RE = /^wf-[0-9a-f]{12}$/;
const FILE_RE = /^wf-[0-9a-f]{12}\.json$/;
export const KINDS = [
  'posts',
  'product_images',
  'site_images',
  'other',
] as const;
export const STATUSES = ['running', 'waiting', 'done', 'failed'] as const;
export const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()/-]{0,79}$/u;
const SESSION_RE = /^[0-9a-f]{8}$/;
export const RECORD_MAX_BYTES = 64 * 1024;
export const SCAN_MAX = 5000;
export const CANDIDATES_MAX = 600;
export const LIST_MAX = 200;
export const FRESH_MS = 24 * 60 * 60 * 1000;
export const OUTPUTS_MAX = 20;
const STEP_MAX = 200;
const MESSAGE_MAX = 500;
const LABEL_MAX = 80;
// Control and format characters (bidi overrides, zero-width joiners) can make
// a label read as a different destination; they carry no meaning in a card.
const STRIP_RE = /[\p{Cc}\p{Cf}]/gu;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Reason =
  | 'unreadable'
  | 'too-large'
  | 'not-json'
  | 'bad-id'
  | 'bad-kind'
  | 'bad-percent'
  | 'bad-url'
  | 'bad-schema';

export interface WorkflowRecord {
  v: 1;
  id: string;
  name: string;
  kind: Kind;
  status: Status;
  percent: number;
  step?: string;
  steps_total?: number;
  message?: string;
  session_id?: string;
  preview_url?: string;
  outputs: { label: string; url: string }[];
  started_at: string;
  updated_at: string;
  finished_at?: string;
  rev: number;
}

export interface WorkflowView {
  id: string;
  name: string;
  kind: Kind;
  status: Status;
  percent: number;
  steps_total?: number;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  step?: string;
  message?: string;
  session_id?: string;
  preview_url?: string | null;
  preview_blocked?: UrlBlock;
  outputs?: { label: string; url: string | null; blocked?: UrlBlock }[];
}
export interface InvalidView {
  id: string;
  invalid: true;
  reason: Reason;
}
export type WorkflowEntry = WorkflowView | InvalidView;

export type ValidateResult =
  { ok: true; record: WorkflowRecord } | { ok: false; reason: Reason };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const optStr = (v: unknown, max: number): v is string | undefined =>
  v === undefined || (typeof v === 'string' && v.length <= max);
const urlShapeOk = (v: unknown): boolean => {
  const c = checkUrl(v);
  return c.ok || !c.shape;
};

/**
 * Builds a fresh literal from a parsed record — never returns or spreads the
 * input, so own `toJSON`/`__proto__`/`constructor` keys go no further. When
 * `expectId` is given (the filename's id) the record must claim exactly it.
 */
export function validateRecord(
  raw: unknown,
  expectId?: string,
): ValidateResult {
  if (!isObj(raw) || raw.v !== 1) return { ok: false, reason: 'bad-schema' };
  const id = raw.id;
  if (typeof id !== 'string' || !WORKFLOW_ID_RE.test(id))
    return { ok: false, reason: 'bad-id' };
  if (expectId !== undefined && id !== expectId)
    return { ok: false, reason: 'bad-id' };
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind))
    return { ok: false, reason: 'bad-kind' };
  if (!isInt(raw.percent, 0, 100)) return { ok: false, reason: 'bad-percent' };
  if (raw.preview_url !== undefined && !urlShapeOk(raw.preview_url))
    return { ok: false, reason: 'bad-url' };
  const outputsRaw = raw.outputs;
  if (!Array.isArray(outputsRaw) || outputsRaw.length > OUTPUTS_MAX)
    return { ok: false, reason: 'bad-schema' };
  const outputs: { label: string; url: string }[] = [];
  for (const o of outputsRaw) {
    if (!isObj(o) || typeof o.label !== 'string' || o.label.length > LABEL_MAX)
      return { ok: false, reason: 'bad-schema' };
    if (!urlShapeOk(o.url)) return { ok: false, reason: 'bad-url' };
    outputs.push({ label: o.label, url: o.url as string });
  }
  const { name, status } = raw;
  if (typeof name !== 'string' || !NAME_RE.test(name))
    return { ok: false, reason: 'bad-schema' };
  if (
    typeof status !== 'string' ||
    !(STATUSES as readonly string[]).includes(status)
  )
    return { ok: false, reason: 'bad-schema' };
  if (!optStr(raw.step, STEP_MAX) || !optStr(raw.message, MESSAGE_MAX))
    return { ok: false, reason: 'bad-schema' };
  if (raw.steps_total !== undefined && !isInt(raw.steps_total, 1, 999))
    return { ok: false, reason: 'bad-schema' };
  if (
    raw.session_id !== undefined &&
    !(typeof raw.session_id === 'string' && SESSION_RE.test(raw.session_id))
  )
    return { ok: false, reason: 'bad-schema' };
  if (!isIso(raw.started_at) || !isIso(raw.updated_at))
    return { ok: false, reason: 'bad-schema' };
  if (raw.finished_at !== undefined && !isIso(raw.finished_at))
    return { ok: false, reason: 'bad-schema' };
  if (!isInt(raw.rev, 1, Number.MAX_SAFE_INTEGER))
    return { ok: false, reason: 'bad-schema' };
  const record: WorkflowRecord = {
    v: 1,
    id,
    name,
    kind: kind as Kind,
    status: status as Status,
    percent: raw.percent,
    outputs,
    started_at: raw.started_at,
    updated_at: raw.updated_at,
    rev: raw.rev,
  };
  if (raw.step !== undefined) record.step = raw.step;
  if (raw.steps_total !== undefined) record.steps_total = raw.steps_total;
  if (raw.message !== undefined) record.message = raw.message;
  if (raw.session_id !== undefined) record.session_id = raw.session_id;
  if (raw.preview_url !== undefined)
    record.preview_url = raw.preview_url as string;
  if (raw.finished_at !== undefined) record.finished_at = raw.finished_at;
  return { ok: true, record };
}

export type ReadResult =
  | { ok: true; raw: unknown; mtimeMs: number }
  | { ok: false; reason: 'unreadable' | 'too-large' | 'not-json' };

const OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW ?? 0) |
  (fs.constants.O_NONBLOCK ?? 0);

/** One open, one fstat, one bounded read from that fd, one parse. */
export function readRecordFile(file: string): ReadResult {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'unreadable' };
    if (st.size > RECORD_MAX_BYTES) return { ok: false, reason: 'too-large' };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    let raw: unknown;
    try {
      raw = JSON.parse(buf.subarray(0, n).toString('utf-8'));
    } catch {
      return { ok: false, reason: 'not-json' };
    }
    return { ok: true, raw, mtimeMs: st.mtimeMs };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

const clean = (s: string): string => redactSecrets(s.replace(STRIP_RE, ''));

/** The wire shape: display strings cleaned, URLs cleared or withheld. */
export function projectRecord(
  r: WorkflowRecord,
  opts: { readOnly: boolean; hosts: string[] },
): WorkflowView {
  const v: WorkflowView = {
    id: r.id,
    name: clean(r.name),
    kind: r.kind,
    status: r.status,
    percent: r.percent,
    started_at: r.started_at,
    updated_at: r.updated_at,
  };
  if (r.steps_total !== undefined) v.steps_total = r.steps_total;
  if (r.finished_at !== undefined) v.finished_at = r.finished_at;
  if (opts.readOnly) return v;
  if (r.step !== undefined) v.step = clean(r.step);
  if (r.message !== undefined) v.message = clean(r.message);
  if (r.session_id !== undefined) v.session_id = r.session_id;
  if (r.preview_url !== undefined) {
    const c = checkUrl(r.preview_url, opts.hosts);
    if (c.ok) v.preview_url = c.url;
    else {
      v.preview_url = null;
      v.preview_blocked = c.shape ? 'host' : c.blocked;
    }
  }
  v.outputs = r.outputs.map((o) => {
    const c = checkUrl(o.url, opts.hosts);
    return c.ok
      ? { label: clean(o.label), url: c.url }
      : {
          label: clean(o.label),
          url: null,
          blocked: c.shape ? 'host' : c.blocked,
        };
  });
  return v;
}

export interface ListOptions {
  readOnly: boolean;
  hosts?: string[];
  now?: () => number;
  scanMax?: number;
  candidatesMax?: number;
  limit?: number;
}
export type ListResult =
  | {
      workflows: WorkflowEntry[];
      scanned: number;
      candidates: number;
      truncated: number;
      reason?: 'too-many';
    }
  | { error: 'registry unavailable' };

/** The registry dir itself must be a real directory — never a symlink. */
export function registryDirOk(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function enumerate(
  dir: string,
): { id: string; file: string; mtimeMs: number }[] {
  const out: { id: string; file: string; mtimeMs: number }[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isFile() || !FILE_RE.test(d.name)) continue;
    const file = path.join(dir, d.name);
    try {
      out.push({
        id: d.name.slice(0, -5),
        file,
        mtimeMs: fs.statSync(file).mtimeMs,
      });
    } catch {
      /* raced away between readdir and stat */
    }
  }
  return out;
}

const isTerminal = (s: Status): boolean => s === 'done' || s === 'failed';

/**
 * Newest 600 by mtime are the only files opened; within them fresh
 * non-terminal records rank first, then terminal (and invalid) ones, then
 * stale non-terminal ones — so a crashed writer's `running` record can never
 * evict finished work — and the list is cut to 200.
 */
export function listWorkflows(dir: string, opts: ListOptions): ListResult {
  if (!registryDirOk(dir)) return { error: 'registry unavailable' };
  const now = opts.now ?? Date.now;
  const scanMax = opts.scanMax ?? SCAN_MAX;
  const limit = opts.limit ?? LIST_MAX;
  let entries: ReturnType<typeof enumerate>;
  try {
    entries = enumerate(dir);
  } catch {
    return { error: 'registry unavailable' };
  }
  const scanned = entries.length;
  if (scanned > scanMax)
    return {
      workflows: [],
      scanned,
      candidates: 0,
      truncated: -1,
      reason: 'too-many',
    };
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = entries.slice(0, opts.candidatesMax ?? CANDIDATES_MAX);
  const fresh: WorkflowEntry[] = [];
  const settled: WorkflowEntry[] = [];
  const stale: WorkflowEntry[] = [];
  const cutoff = now() - FRESH_MS;
  const hosts = opts.hosts ?? [];
  for (const e of candidates) {
    const read = readRecordFile(e.file);
    if (!read.ok) {
      settled.push({ id: e.id, invalid: true, reason: read.reason });
      continue;
    }
    const v = validateRecord(read.raw, e.id);
    if (!v.ok) {
      settled.push({ id: e.id, invalid: true, reason: v.reason });
      continue;
    }
    const view = projectRecord(v.record, { readOnly: opts.readOnly, hosts });
    if (isTerminal(v.record.status)) settled.push(view);
    else if (e.mtimeMs >= cutoff) fresh.push(view);
    else stale.push(view);
  }
  return {
    workflows: [...fresh, ...settled, ...stale].slice(0, limit),
    scanned,
    candidates: candidates.length,
    truncated: Math.max(0, scanned - limit),
  };
}

export type ArchiveResult =
  | { status: 200; archived: number; skipped: number; stale?: boolean }
  | { status: 400 | 404 | 409 | 503; error: string };

/**
 * Moves records into `archive/`. Bulk form: terminal records whose
 * `finished_at` is older than `olderThanDays`, skipping (and counting) any
 * whose archive target already exists. `{ id }` form: that record — terminal,
 * or non-terminal with a file mtime older than 24 h (the remedy for a crashed
 * writer) — refusing an existing target with 409.
 */
export function archiveWorkflows(
  dir: string,
  opts: {
    olderThanDays: number;
    id?: unknown;
    now?: () => number;
    scanMax?: number;
  },
): ArchiveResult {
  if (!registryDirOk(dir))
    return { status: 503, error: 'registry unavailable' };
  const now = opts.now ?? Date.now;
  const archiveDir = path.join(dir, 'archive');
  try {
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(archiveDir).isDirectory())
      return { status: 503, error: 'registry unavailable' };
  } catch {
    return { status: 503, error: 'registry unavailable' };
  }
  const move = (id: string, file: string): 'moved' | 'exists' => {
    const target = path.join(archiveDir, `${id}.json`);
    if (fs.existsSync(target)) return 'exists';
    fs.renameSync(file, target);
    return 'moved';
  };
  if (opts.id !== undefined) {
    const id = opts.id;
    // The only browser string that reaches a path: shape-checked before join.
    if (typeof id !== 'string' || !WORKFLOW_ID_RE.test(id))
      return { status: 400, error: 'invalid id' };
    const file = path.join(dir, `${id}.json`);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      return { status: 404, error: 'not found' };
    }
    if (!st.isFile()) return { status: 404, error: 'not found' };
    const read = readRecordFile(file);
    let stale = false;
    if (read.ok) {
      const v = validateRecord(read.raw, id);
      if (v.ok && !isTerminal(v.record.status)) {
        if (st.mtimeMs > now() - FRESH_MS)
          return { status: 409, error: 'workflow still active' };
        stale = true;
      }
    }
    try {
      if (move(id, file) === 'exists')
        return { status: 409, error: 'already archived' };
    } catch {
      return { status: 503, error: 'registry unavailable' };
    }
    return stale
      ? { status: 200, archived: 1, skipped: 0, stale: true }
      : { status: 200, archived: 1, skipped: 0 };
  }
  let entries: ReturnType<typeof enumerate>;
  try {
    entries = enumerate(dir);
  } catch {
    return { status: 503, error: 'registry unavailable' };
  }
  if (entries.length > (opts.scanMax ?? SCAN_MAX))
    return { status: 503, error: 'too many records' };
  const cutoff = now() - opts.olderThanDays * 24 * 60 * 60 * 1000;
  let archived = 0;
  let skipped = 0;
  for (const e of entries) {
    const read = readRecordFile(e.file);
    if (!read.ok) continue;
    const v = validateRecord(read.raw, e.id);
    if (
      !v.ok ||
      !isTerminal(v.record.status) ||
      v.record.finished_at === undefined
    )
      continue;
    if (Date.parse(v.record.finished_at) >= cutoff) continue;
    try {
      if (move(e.id, e.file) === 'exists') skipped++;
      else archived++;
    } catch {
      skipped++;
    }
  }
  return { status: 200, archived, skipped };
}

export interface WorkflowWatcher {
  close(): void;
  /** `watch` while fs.watch is live, `poll` after a fallback. */
  readonly mode: 'watch' | 'poll';
}

/**
 * Debounced change notification for the registry dir. Refuses a symlinked
 * or missing dir (returns null); on a watcher error falls back to polling and
 * never throws out of the event loop.
 */
export function createWorkflowWatcher(
  dir: string,
  onChange: () => void,
  opts: { debounceMs?: number; pollMs?: number } = {},
): WorkflowWatcher | null {
  if (!registryDirOk(dir)) return null;
  const debounceMs = opts.debounceMs ?? 500;
  const pollMs = opts.pollMs ?? 10_000;
  let timer: NodeJS.Timeout | null = null;
  let poll: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let closed = false;
  let mode: 'watch' | 'poll' = 'watch';
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
    timer.unref();
  };
  const startPoll = () => {
    if (closed || poll) return;
    mode = 'poll';
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    poll = setInterval(() => {
      if (!closed) onChange();
    }, pollMs);
    poll.unref();
  };
  try {
    watcher = fs.watch(dir, { persistent: false }, fire);
    watcher.on('error', startPoll);
  } catch {
    startPoll();
  }
  return {
    get mode() {
      return mode;
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      if (watcher) watcher.close();
    },
  };
}
