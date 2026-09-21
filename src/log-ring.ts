import { Writable } from 'stream';

export interface LogEntry {
  seq: number;
  time: number;
  level: number;
  msg: string;
  fields: Record<string, unknown>;
  /** Sanitized re-serialization, capped so a runaway line cannot pin memory. */
  line: string;
}

export interface LogRing {
  stream: Writable;
  entries(): LogEntry[];
  onEntry(fn: (e: LogEntry) => void): () => void;
}

const LINE_CAP = 4096;
const MIN_LEVEL = 30; // info — debug/trace carry agent stderr and never enter the ring
const SECRET_FIELD_RE =
  /^(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|session|private[_-]?key)$/i;
const DROPPED_FIELDS = new Set(['time', 'level', 'msg', 'pid', 'hostname']);

/** Replaces every value under a secret-looking key, at any depth. */
export function redactFields(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactFields(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_FIELD_RE.test(k)
      ? '[redacted]'
      : redactFields(v, depth + 1);
  }
  return out;
}

/**
 * In-process ring of the newest `size` info+ log lines, fed by pino through
 * `multistream`. Entries are parsed and sanitized once, on write: the host
 * name and pid never enter, secret-looking fields are redacted structurally.
 */
export function createLogRing(size = 1000): LogRing {
  const buf: LogEntry[] = [];
  const listeners = new Set<(e: LogEntry) => void>();
  let seq = 0;
  let pending = '';

  const push = (raw: string) => {
    let parsed: Record<string, unknown> = {};
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v))
        parsed = v as Record<string, unknown>;
    } catch {
      parsed = { msg: raw.slice(0, LINE_CAP) };
    }
    const level = typeof parsed.level === 'number' ? parsed.level : 30;
    if (level < MIN_LEVEL) return;
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed))
      if (!DROPPED_FIELDS.has(k)) fields[k] = v;
    const clean = redactFields(fields) as Record<string, unknown>;
    const entry: LogEntry = {
      seq: ++seq,
      time: typeof parsed.time === 'number' ? parsed.time : Date.now(),
      level,
      msg: typeof parsed.msg === 'string' ? parsed.msg : '',
      fields: clean,
      line: '',
    };
    entry.line = JSON.stringify({
      time: entry.time,
      level,
      msg: entry.msg,
      ...clean,
    }).slice(0, LINE_CAP);
    buf.push(entry);
    if (buf.length > size) buf.shift();
    for (const fn of listeners) fn(entry);
  };

  const stream = new Writable({
    decodeStrings: false,
    write(chunk, _enc, cb) {
      pending += typeof chunk === 'string' ? chunk : String(chunk);
      let idx;
      while ((idx = pending.indexOf('\n')) !== -1) {
        const raw = pending.slice(0, idx).trim();
        pending = pending.slice(idx + 1);
        if (raw) push(raw);
      }
      cb();
    },
  });

  return {
    stream,
    entries: () => buf.slice(),
    onEntry(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
