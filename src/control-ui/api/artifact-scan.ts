import fs from 'fs';
import path from 'path';
import { isUnderAny } from './artifacts.js';
import {
  createArtifactCallCollector,
  TAIL_TRANSCRIPT_BYTES,
  type ArtifactCall,
  type ArtifactCallCollector,
} from './claude-conversation.js';
import { CLAUDE_SESSION_ID_RE } from './claude-sessions.js';

// Recent host transcripts, walked for Artifact publishes so a page appears
// in the Artifacts tab without anyone opening its session. Only the operator's
// own Claude Code sessions write under the projects dir (containers keep
// theirs under DATA_DIR/sessions, a container-writable root); everything
// inside a transcript is still untrusted and goes through the capture's checks.
// What the walk trusts is the file name (a session uuid), the folder name and
// file metadata.
//
// Active transcripts grow by a few KB every few seconds, so each file keeps a
// cursor: a later scan reads only the bytes appended since, feeding complete
// lines to the same collector (a tool_use and its result may arrive in
// different appends). A file that was rewritten (other inode, shrank, or the
// bytes before the cursor changed) is read from its tail again, as new.

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0; // absent on Windows

export const SCAN_MAX_FILES = 40;
export const SCAN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
/** A partial line longer than this is dropped up to its newline. */
export const SCAN_CARRY_MAX = 1024 * 1024;
/** Bytes before the cursor kept to notice an in-place rewrite. */
export const SCAN_PREFIX_BYTES = 64;

export interface ScannedTranscript {
  uuid: string;
  dir: string;
  /** mtime:size — the same form the conversation reader uses. */
  version: string;
  calls: ArtifactCall[];
}

/** Reads up to `length` bytes at `start`; `file` is passed for tests only. */
type RangeReader = (
  fd: number,
  start: number,
  length: number,
  file: string,
) => Buffer;

export const readRange: RangeReader = (fd, start, length) => {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (n === 0) break; // the file shrank under us; the next scan notices
    got += n;
  }
  return got === length ? buf : buf.subarray(0, got);
};

interface Cursor {
  dev: number;
  ino: number;
  /** Bytes consumed; the next read starts here. */
  offset: number;
  /** The partial last line; null while discarding up to the next newline. */
  carry: Buffer | null;
  /** The last ≤ SCAN_PREFIX_BYTES bytes before `offset`. */
  prefix: Buffer;
  collector: ArtifactCallCollector;
  version: string;
}

const NL = 0x0a;
const EMPTY = Buffer.alloc(0);

/** Feeds the complete lines of `chunk` (after `c.carry`) to `c.collector`. */
function feedChunk(c: Cursor, chunk: Buffer): void {
  let at = 0;
  if (c.carry === null) {
    const i = chunk.indexOf(NL);
    if (i < 0) return;
    at = i + 1;
    c.carry = EMPTY;
  }
  for (let i = chunk.indexOf(NL, at); i >= 0; i = chunk.indexOf(NL, at)) {
    const piece = chunk.subarray(at, i);
    const held = c.carry.length;
    const line = held ? Buffer.concat([c.carry, piece]) : piece;
    c.carry = EMPTY;
    at = i + 1;
    if (held && line.length > SCAN_CARRY_MAX) continue; // same cap as the carry
    const text = line.toString('utf-8');
    if (!text.trim()) continue;
    try {
      const v: unknown = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v))
        c.collector.feed(v as Record<string, unknown>);
    } catch {
      /* partial or foreign line: skipped */
    }
  }
  const rest = chunk.subarray(at);
  if (c.carry.length + rest.length > SCAN_CARRY_MAX) c.carry = null;
  else if (rest.length)
    c.carry = c.carry.length
      ? Buffer.concat([c.carry, rest])
      : Buffer.from(rest);
}

const lastBytes = (a: Buffer, b: Buffer): Buffer => {
  if (b.length >= SCAN_PREFIX_BYTES)
    return Buffer.from(b.subarray(b.length - SCAN_PREFIX_BYTES));
  const both = Buffer.concat([a, b]);
  return Buffer.from(
    both.subarray(Math.max(0, both.length - SCAN_PREFIX_BYTES)),
  );
};

export function createArtifactScan(
  projectsDir: string,
  opts: {
    roots: () => string[];
    now?: () => number;
    readRange?: RangeReader;
    maxFiles?: number;
    maxAgeMs?: number;
    budgetBytes?: number;
  },
) {
  const now = opts.now ?? Date.now;
  const read = opts.readRange ?? readRange;
  const maxFiles = opts.maxFiles ?? SCAN_MAX_FILES;
  const maxAge = opts.maxAgeMs ?? SCAN_MAX_AGE_MS;
  const budget = opts.budgetBytes ?? SCAN_BUDGET_BYTES;
  // path → its cursor. Written only after a read and feed completed; a file
  // skipped for budget keeps its cursor untouched and resumes from it.
  const memo = new Map<string, Cursor>();
  const nameRe = new RegExp(
    `^(${CLAUDE_SESSION_ID_RE.source.replace(/^\^|\$$/g, '')})\\.jsonl$`,
  );

  /**
   * Reads what changed since `hit` into a new cursor (never mutating `hit`),
   * or returns null without reading when `left` budget does not cover it.
   */
  function readChanged(
    root: string,
    file: string,
    hit: Cursor | undefined,
    version: string,
    left: number,
  ): { cursor: Cursor; cost: number } | null {
    let real: string;
    try {
      real = fs.realpathSync(file);
    } catch {
      return null;
    }
    if (!real.startsWith(root + path.sep)) return null;
    let fd: number;
    try {
      fd = fs.openSync(real, fs.constants.O_RDONLY | NOFOLLOW);
    } catch {
      return null;
    }
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile()) return null;
      const size = st.size;
      let cost = 0;
      // Appended to the same file: check the bytes before the cursor, then
      // read only what is new.
      if (
        hit &&
        st.ino !== 0 &&
        hit.ino === st.ino &&
        hit.dev === st.dev &&
        size >= hit.offset &&
        size - hit.offset <= TAIL_TRANSCRIPT_BYTES
      ) {
        const plen = Math.min(SCAN_PREFIX_BYTES, hit.offset);
        const grown = size - hit.offset;
        if (plen + grown > left) return null;
        const before = read(fd, hit.offset - plen, plen, real);
        cost += plen;
        // With no partial line held, the cursor sat right after a newline.
        const lineEnd =
          hit.offset === 0 || hit.carry === null || hit.carry.length > 0
            ? true
            : before[before.length - 1] === NL;
        if (before.equals(hit.prefix) && lineEnd) {
          const chunk = read(fd, hit.offset, grown, real);
          cost += chunk.length;
          const cursor: Cursor = {
            dev: st.dev,
            ino: st.ino,
            offset: hit.offset + chunk.length,
            carry: hit.carry === null ? null : Buffer.from(hit.carry),
            prefix: lastBytes(hit.prefix, chunk),
            collector: hit.collector,
            version,
          };
          // The collector is shared with `hit`; it is fed only here, after
          // every read succeeded, and `hit` is replaced by this cursor.
          feedChunk(cursor, chunk);
          return { cursor, cost };
        }
      }
      // New, rewritten, or more than a tail appended: the last 8 MiB, fresh.
      const len = Math.min(size, TAIL_TRANSCRIPT_BYTES);
      if (cost + len > left) return null;
      const start = size - len;
      const chunk = read(fd, start, len, real);
      cost += chunk.length;
      const cursor: Cursor = {
        dev: st.dev,
        ino: st.ino,
        offset: start + chunk.length,
        carry: start > 0 ? null : EMPTY, // the first line is partial
        prefix: lastBytes(EMPTY, chunk),
        collector: createArtifactCallCollector(),
        version,
      };
      feedChunk(cursor, chunk);
      return { cursor, cost };
    } catch {
      return null;
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    scan(): ScannedTranscript[] {
      let root: string;
      try {
        root = fs.realpathSync(projectsDir);
      } catch {
        return [];
      }
      // Fail closed if a container could write into (or above) the projects dir.
      const roots = opts.roots();
      if (
        isUnderAny(root, roots) ||
        roots.some((r) => {
          let rr = path.resolve(r);
          try {
            rr = fs.realpathSync(rr);
          } catch {
            /* compared as given */
          }
          return rr === root || rr.startsWith(root + path.sep);
        })
      )
        return [];
      const found: { file: string; uuid: string; dir: string; st: fs.Stats }[] =
        [];
      let dirs: fs.Dirent[];
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const cutoff = now() - maxAge;
      for (const d of dirs) {
        if (!d.isDirectory()) continue; // a symlinked folder is not a directory entry
        let names: fs.Dirent[];
        try {
          names = fs.readdirSync(path.join(root, d.name), {
            withFileTypes: true,
          });
        } catch {
          continue;
        }
        for (const n of names) {
          const m = nameRe.exec(n.name);
          if (!m || !n.isFile()) continue; // symlinks and sub-folders (subagents/) are skipped
          const file = path.join(root, d.name, n.name);
          let st: fs.Stats;
          try {
            st = fs.lstatSync(file);
          } catch {
            continue;
          }
          if (!st.isFile() || st.mtimeMs < cutoff) continue;
          found.push({ file, uuid: m[1], dir: d.name, st });
        }
      }
      found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      const out: ScannedTranscript[] = [];
      const candidates = found.slice(0, maxFiles);
      let spent = 0;
      for (const f of candidates) {
        const version = `${Math.trunc(f.st.mtimeMs)}:${f.st.size}`;
        const hit = memo.get(f.file);
        let cur: Cursor | undefined = hit;
        if (
          !hit ||
          hit.version !== version ||
          hit.ino !== f.st.ino ||
          hit.dev !== f.st.dev
        ) {
          const next = readChanged(root, f.file, hit, version, budget - spent);
          if (!next) continue; // budget, confinement or I/O: waits for the next call
          spent += next.cost;
          cur = next.cursor;
          memo.delete(f.file);
          memo.set(f.file, cur);
        }
        const calls = cur!.collector.calls();
        if (calls.length)
          out.push({ uuid: f.uuid, dir: f.dir, version: cur!.version, calls });
      }
      // Only this scan's candidates keep a cursor (≤ maxFiles carries held).
      const keep = new Set(candidates.map((c) => c.file));
      for (const k of [...memo.keys()]) if (!keep.has(k)) memo.delete(k);
      return out;
    },
  };
}

export type ArtifactScan = ReturnType<typeof createArtifactScan>;
