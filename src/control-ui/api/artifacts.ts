import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { checkUrl, type UrlBlock } from './allowed-url.js';
import { redactSecrets } from './logs.js';
import { readRecordFile } from './workflows.js';
import { CLAUDE_JOB_ID_RE, CLAUDE_NAME_RE } from './claude-sessions.js';

// The artifacts registry: one file, `CONFIG_DIR/control-ui/artifacts.json`,
// `{ v: 1, rev, artifacts: [...] }`, curated by the operator through
// `scripts/artifact-registry.mjs` and two dashboard routes. Anything running
// as the operator can write it, so the read path treats it as input (Phase W
// confinement) and the read-time URL check is the security control; the
// write-time check only keeps unshowable links out.
export const ARTIFACT_ID_RE = /^art-[0-9a-f]{12}$/;
export const ARTIFACT_KINDS = ['app', 'report', 'preview'] as const;
export const ADDED_BY = ['cli', 'dashboard', 'session'] as const;
/** Entries the dashboard captured from a session's transcript are capped on their own. */
export const SESSION_MAX = 100;
export const SNIFF_BYTES = 512;
export const TITLE_SCAN_BYTES = 4096;
export const TITLE_RE = /^[\p{L}\p{N}][^\p{Cc}\p{Cf}]{0,99}$/u;
export const DESCRIPTION_MAX = 300;
export const ARTIFACTS_MAX = 200;
export const REGISTRY_READ_MAX = 256 * 1024;
export const REGISTRY_WRITE_MAX = 192 * 1024;
export const REGISTRY_FILE = 'artifacts.json';
export const REMOVED_LOG = 'artifacts-removed.jsonl';
export const REMOVED_LOG_MAX = 1024 * 1024;
export const COPY_MAX = 4 * 1024 * 1024;
export const COPY_DIR = 'artifacts';
export const LOCK_STALE_MS = 5000;
const TMP_RE = /^artifacts\.json\.tmp-[0-9a-f]{8}$/;
const TMP_SWEEP_MS = 60 * 60 * 1000;
const STRIP_RE = /[\p{Cc}\p{Cf}]/gu;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type RegistryReason =
  'unreadable' | 'too-large' | 'not-json' | 'bad-schema';

/** The local copy the dashboard shows beside a conversation (CLI `add --file`). */
export interface ArtifactLocal {
  source: string;
  uid: number;
  bytes: number;
  copied_at: string;
  source_mtime_ms: number;
}
/** The session whose transcript proved the publish (captured entries only). */
export interface ArtifactSession {
  id: string;
  name: string;
}
export interface ArtifactEntry {
  id: string;
  title: string;
  url: string;
  kind: ArtifactKind;
  description?: string;
  added_at: string;
  added_by: (typeof ADDED_BY)[number];
  local?: ArtifactLocal;
  session?: ArtifactSession;
}
export interface Registry {
  v: 1;
  rev: number;
  artifacts: ArtifactEntry[];
}
/** Three link states: `url` a string, `url: null` + `blocked`, or absent (read-only). */
export interface ArtifactView {
  id: string;
  title: string;
  kind: ArtifactKind;
  hostname: string;
  description?: string;
  added_at: string;
  added_by: string;
  /** A local copy exists, so the pane can show it; never the path. */
  local: boolean;
  session?: ArtifactSession;
  url?: string | null;
  blocked?: UrlBlock;
}
export interface ArtifactList {
  artifacts: ArtifactView[];
  rev: number;
  invalid?: true;
  reason?: RegistryReason;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));

export function validateEntry(raw: unknown): ArtifactEntry | null {
  if (!isObj(raw)) return null;
  const { id, title, url, kind, description, added_at, added_by } = raw;
  if (typeof id !== 'string' || !ARTIFACT_ID_RE.test(id)) return null;
  if (typeof title !== 'string' || !TITLE_RE.test(title)) return null;
  const u = checkUrl(url);
  if (!u.ok && u.shape) return null;
  if (
    typeof kind !== 'string' ||
    !(ARTIFACT_KINDS as readonly string[]).includes(kind)
  )
    return null;
  if (
    description !== undefined &&
    (typeof description !== 'string' || description.length > DESCRIPTION_MAX)
  )
    return null;
  if (!isIso(added_at)) return null;
  if (
    typeof added_by !== 'string' ||
    !(ADDED_BY as readonly string[]).includes(added_by)
  )
    return null;
  const entry: ArtifactEntry = {
    id,
    title,
    url: url as string,
    kind: kind as ArtifactKind,
    added_at,
    added_by: added_by as ArtifactEntry['added_by'],
  };
  if (description !== undefined) entry.description = description;
  const local = validateLocal(raw.local);
  if (local) entry.local = local;
  const session = validateSession(raw.session);
  if (session) entry.session = session;
  return entry;
}

/** Kept in lockstep with scripts/artifact-registry.mjs. A malformed record is dropped; the entry stays. */
export function validateSession(raw: unknown): ArtifactSession | null {
  if (!isObj(raw)) return null;
  const { id, name } = raw;
  if (typeof id !== 'string' || !CLAUDE_JOB_ID_RE.test(id)) return null;
  if (typeof name !== 'string' || !CLAUDE_NAME_RE.test(name)) return null;
  return { id, name };
}

/** Kept in lockstep with scripts/artifact-registry.mjs. A malformed record is dropped; the entry stays. */
export function validateLocal(raw: unknown): ArtifactLocal | null {
  if (!isObj(raw)) return null;
  const { source, uid, bytes, copied_at, source_mtime_ms } = raw;
  if (
    typeof source !== 'string' ||
    !path.isAbsolute(source) ||
    source.length > 1024
  )
    return null;
  if (!Number.isInteger(uid) || (uid as number) < 0) return null;
  if (
    !Number.isInteger(bytes) ||
    (bytes as number) < 1 ||
    (bytes as number) > COPY_MAX
  )
    return null;
  if (!isIso(copied_at)) return null;
  if (
    typeof source_mtime_ms !== 'number' ||
    !Number.isFinite(source_mtime_ms) ||
    source_mtime_ms < 0
  )
    return null;
  return {
    source,
    uid: uid as number,
    bytes: bytes as number,
    copied_at: copied_at as string,
    source_mtime_ms,
  };
}

/** Where an artifact's local copy lives. */
export const copyPath = (dir: string, id: string): string =>
  path.join(dir, COPY_DIR, `${id}.html`);

/** Fresh literal, closed reason; duplicate ids are a schema failure. */
export function validateRegistry(
  raw: unknown,
): { ok: true; registry: Registry } | { ok: false; reason: RegistryReason } {
  if (!isObj(raw) || raw.v !== 1) return { ok: false, reason: 'bad-schema' };
  const { rev, artifacts } = raw;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1)
    return { ok: false, reason: 'bad-schema' };
  if (!Array.isArray(artifacts) || artifacts.length > ARTIFACTS_MAX)
    return { ok: false, reason: 'bad-schema' };
  const out: ArtifactEntry[] = [];
  const seen = new Set<string>();
  for (const a of artifacts) {
    const e = validateEntry(a);
    if (!e || seen.has(e.id)) return { ok: false, reason: 'bad-schema' };
    seen.add(e.id);
    out.push(e);
  }
  return { ok: true, registry: { v: 1, rev, artifacts: out } };
}

export function registryDirOk(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch {
    return false;
  }
}

type ReadRegistry =
  { ok: true; registry: Registry } | { ok: false; reason: RegistryReason };

/** Missing file → empty registry (rev 0); a symlink fails as `unreadable`. */
export function readRegistry(dir: string): ReadRegistry {
  const file = path.join(dir, REGISTRY_FILE);
  try {
    fs.lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, registry: { v: 1, rev: 0, artifacts: [] } };
    return { ok: false, reason: 'unreadable' };
  }
  const r = readRecordFile(file, REGISTRY_READ_MAX);
  if (!r.ok) return { ok: false, reason: r.reason };
  return validateRegistry(r.raw);
}

const clean = (s: string): string => redactSecrets(s.replace(STRIP_RE, ''));
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export function projectEntry(
  e: ArtifactEntry,
  opts: { hosts: string[]; readOnly: boolean },
): ArtifactView {
  const v: ArtifactView = {
    id: e.id,
    title: clean(e.title),
    kind: e.kind,
    hostname: hostOf(e.url),
    added_at: e.added_at,
    added_by: e.added_by,
    local: e.local !== undefined,
  };
  if (e.session) v.session = { id: e.session.id, name: clean(e.session.name) };
  if (opts.readOnly) return v;
  if (e.description !== undefined) v.description = clean(e.description);
  const c = checkUrl(e.url, opts.hosts);
  if (c.ok) v.url = c.url;
  else {
    v.url = null;
    v.blocked = c.shape ? 'protocol' : c.blocked;
  }
  return v;
}

export function listArtifacts(
  dir: string,
  opts: { hosts: string[]; readOnly: boolean },
): ArtifactList | { error: 'registry unavailable' } {
  if (!registryDirOk(dir)) return { error: 'registry unavailable' };
  const r = readRegistry(dir);
  if (!r.ok) return { artifacts: [], rev: 0, invalid: true, reason: r.reason };
  return {
    artifacts: r.registry.artifacts.map((e) => projectEntry(e, opts)),
    rev: r.registry.rev,
  };
}

// --- writers -----------------------------------------------------------------

export class RegistryBusy extends Error {}

/**
 * `artifacts.json.lock` held with a nonce for the read-modify-write; a stale
 * lock (lstat mtime older than 5 s) is broken once; release only if the file
 * still holds our nonce. The `rev` compare in writeRegistry is the backstop.
 */
export function withLock<T>(
  dir: string,
  fn: () => T,
  now: () => number = Date.now,
  // The lock is named after the file it guards: other registries live in their
  // own directories and must not serialise behind (or litter) this one's name.
  lockFor: string = REGISTRY_FILE,
): T {
  const lock = path.join(dir, `${lockFor}.lock`);
  const nonce = crypto.randomBytes(8).toString('hex');
  const acquire = (): boolean => {
    try {
      fs.writeFileSync(lock, nonce, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      return false;
    }
  };
  if (!acquire()) {
    let stale: boolean;
    try {
      stale = now() - fs.lstatSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = true; // vanished between attempts
    }
    if (stale) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* someone else broke it first */
      }
    }
    if (!stale || !acquire()) throw new RegistryBusy('registry busy');
  }
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf-8') === nonce) fs.unlinkSync(lock);
    } catch {
      /* not ours any more */
    }
  }
}

export function sweepTmp(dir: string, now: () => number = Date.now): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!TMP_RE.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.mtimeMs < now() - TMP_SWEEP_MS) fs.unlinkSync(p);
    } catch {
      /* raced away */
    }
  }
}

export type WriteResult =
  | { ok: true; rev: number }
  | {
      ok: false;
      status: 409 | 503;
      error:
        | 'registry full'
        | 'registry changed'
        | 'registry busy'
        | 'registry unavailable';
    };

/**
 * Serialises `next` (validated, `rev` bumped by the caller), refuses past the
 * byte budget, writes a `wx` temp file, re-reads and compares `rev` right
 * before the rename, and unlinks its own temp on any failure.
 */
export function writeRegistry(
  dir: string,
  next: Registry,
  expectRev: number,
  now: () => number = Date.now,
): WriteResult {
  const v = validateRegistry(next);
  if (!v.ok) return { ok: false, status: 503, error: 'registry unavailable' };
  const text = JSON.stringify(v.registry, null, 2) + '\n';
  if (Buffer.byteLength(text) > REGISTRY_WRITE_MAX)
    return { ok: false, status: 409, error: 'registry full' };
  sweepTmp(dir, now);
  const tmp = path.join(
    dir,
    `${REGISTRY_FILE}.tmp-${crypto.randomBytes(4).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  } catch {
    return { ok: false, status: 503, error: 'registry unavailable' };
  }
  try {
    const current = readRegistry(dir);
    if (!current.ok || current.registry.rev !== expectRev) {
      fs.unlinkSync(tmp);
      return { ok: false, status: 409, error: 'registry changed' };
    }
    fs.renameSync(tmp, path.join(dir, REGISTRY_FILE));
    return { ok: true, rev: v.registry.rev };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    return { ok: false, status: 503, error: 'registry unavailable' };
  }
}

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** The copy the pane frames: its bytes, or why there are none. Never the source. */
export type CopyRead =
  | { status: 200; body: Buffer }
  | { status: 404; error: 'not found' | 'no-local' | 'no-copy' }
  | { status: 503; error: 'registry unavailable' };

export function readArtifactCopy(dir: string, id: unknown): CopyRead {
  if (typeof id !== 'string' || !ARTIFACT_ID_RE.test(id))
    return { status: 404, error: 'not found' };
  const cur = readRegistry(dir);
  if (!cur.ok) return { status: 503, error: 'registry unavailable' };
  const entry = cur.registry.artifacts.find((a) => a.id === id);
  if (!entry) return { status: 404, error: 'not found' };
  if (!entry.local) return { status: 404, error: 'no-local' };
  const body = readBounded(copyPath(dir, id));
  if (!body) return { status: 404, error: 'no-copy' };
  return { status: 200, body };
}

/** A regular file, opened without following a link, at most COPY_MAX bytes. */
function readBounded(file: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > COPY_MAX) return null;
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** The copy's version, what the pane polls: its mtime and size. */
export function copyVersion(dir: string, id: string): string | null {
  try {
    const st = fs.lstatSync(copyPath(dir, id));
    if (!st.isFile()) return null;
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return null;
  }
}

const SOURCE_RE = /\.html?$/i;

type SourceCheck =
  | { ok: true; changed: false }
  | { ok: true; changed: true; data: Buffer; mtimeMs: number }
  | { ok: false };

/**
 * The source is re-read only here, on the open handle: a real `.html`, not a
 * link, one link, the uid and realpath recorded at `add`, the fd's dev/ino
 * equal to a stat taken after the open, within the size bound. Any mismatch
 * keeps the existing copy.
 */
function checkSource(local: ArtifactLocal): SourceCheck {
  if (!SOURCE_RE.test(local.source)) return { ok: false };
  let fd: number | null = null;
  try {
    fd = fs.openSync(local.source, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== local.uid)
      return { ok: false };
    if (st.size < 1 || st.size > COPY_MAX) return { ok: false };
    if (fs.realpathSync(local.source) !== local.source) return { ok: false };
    const again = fs.statSync(local.source);
    if (again.dev !== st.dev || again.ino !== st.ino) return { ok: false };
    if (st.mtimeMs <= local.source_mtime_ms)
      return { ok: true, changed: false };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    return {
      ok: true,
      changed: true,
      data: buf.subarray(0, n),
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return { ok: false };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export type RefreshResult =
  | { status: 200; version: string; following: boolean }
  | { status: 404; error: 'not found' | 'no-local' | 'no-copy' }
  | { status: 503; error: 'registry unavailable' | 'registry busy' };

/**
 * The refresh step: re-copies the source (temp + rename, 0600) when it passes
 * every check and is newer than the copy, and reports the copy's version.
 * `following` is false when the source is gone or failed a check, and always
 * on a read-only server, which never writes.
 */
/**
 * Path containment for the container-writable roots: the source's realpath
 * equals a root or lies below it (separator-aware); roots that exist are
 * resolved through realpath first so a symlinked root still matches.
 */
export function isUnderAny(real: string, roots: string[]): boolean {
  for (const r of roots) {
    let root = path.resolve(r);
    try {
      root = fs.realpathSync(root);
    } catch {
      /* an absent root is compared as given */
    }
    if (real === root || real.startsWith(root + path.sep)) return true;
  }
  return false;
}

export function refreshArtifact(
  dir: string,
  id: unknown,
  opts: {
    readOnly: boolean;
    now?: () => number;
    /** Captured entries (`added_by: 'session'`) stop following a source under one of these. */
    refuseUnder?: () => string[];
  },
): RefreshResult {
  const now = opts.now ?? Date.now;
  if (typeof id !== 'string' || !ARTIFACT_ID_RE.test(id))
    return { status: 404, error: 'not found' };
  if (!registryDirOk(dir))
    return { status: 503, error: 'registry unavailable' };
  const cur = readRegistry(dir);
  if (!cur.ok) return { status: 503, error: 'registry unavailable' };
  const entry = cur.registry.artifacts.find((a) => a.id === id);
  if (!entry) return { status: 404, error: 'not found' };
  if (!entry.local) return { status: 404, error: 'no-local' };
  const version = copyVersion(dir, id);
  if (!version) return { status: 404, error: 'no-copy' };
  if (opts.readOnly) return { status: 200, version, following: false };
  if (
    entry.added_by === 'session' &&
    opts.refuseUnder &&
    isUnderAny(entry.local.source, opts.refuseUnder())
  )
    return { status: 200, version, following: false };
  const src = checkSource(entry.local);
  if (!src.ok) return { status: 200, version, following: false };
  if (!src.changed) return { status: 200, version, following: true };
  try {
    return withLock(
      dir,
      (): RefreshResult => {
        const again = readRegistry(dir);
        if (!again.ok) return { status: 503, error: 'registry unavailable' };
        const e = again.registry.artifacts.find((a) => a.id === id);
        if (!e || !e.local) return { status: 404, error: 'not found' };
        const file = copyPath(dir, id);
        const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
        const fd = fs.openSync(
          tmp,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            NOFOLLOW,
          0o600,
        );
        try {
          fs.writeSync(fd, src.data);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        try {
          fs.renameSync(tmp, file);
        } catch (err) {
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* already gone */
          }
          throw err;
        }
        const local: ArtifactLocal = {
          ...e.local,
          bytes: src.data.length,
          copied_at: new Date(now()).toISOString(),
          source_mtime_ms: src.mtimeMs,
        };
        // A failed registry write leaves the fresh copy in place; the stale
        // source_mtime_ms only means the next poll copies once more.
        writeRegistry(
          dir,
          {
            v: 1,
            rev: again.registry.rev + 1,
            artifacts: again.registry.artifacts.map((a) =>
              a.id === id ? { ...a, local } : a,
            ),
          },
          again.registry.rev,
          now,
        );
        return {
          status: 200,
          version: copyVersion(dir, id) ?? version,
          following: true,
        };
      },
      now,
    );
  } catch (err) {
    if (err instanceof RegistryBusy)
      return { status: 503, error: 'registry busy' };
    return { status: 200, version, following: false };
  }
}

/** Append-only record of removals; rotates to `.1` past 1 MB; never follows a symlink. */
export function logRemoved(
  dir: string,
  entry: ArtifactEntry,
  by: string,
  at: string,
): void {
  const file = path.join(dir, REMOVED_LOG);
  try {
    const st = fs.lstatSync(file);
    if (st.size > REMOVED_LOG_MAX) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet */
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_APPEND |
    fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeSync(
      fd,
      JSON.stringify({ removed_at: at, removed_by: by, entry }) + '\n',
    );
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The URLs in the removals log, so an operator's delete (or an eviction)
 * holds across restarts and polls: re-read only when the log's size or
 * mtime changed, else served from memory.
 */
export function createRemovedUrls(dir: string) {
  let memo: { version: string; urls: Set<string> } | null = null;
  const parse = (file: string, into: Set<string>) => {
    let text: string;
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > REMOVED_LOG_MAX * 2) return;
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as { entry?: { url?: unknown } };
        if (typeof rec?.entry?.url === 'string') into.add(rec.entry.url);
      } catch {
        /* a torn line */
      }
    }
  };
  return (): Set<string> => {
    const file = path.join(dir, REMOVED_LOG);
    let version = 'none';
    try {
      const st = fs.lstatSync(file);
      version = `${Math.trunc(st.mtimeMs)}:${st.size}`;
    } catch {
      /* no log yet */
    }
    if (memo && memo.version === version) return memo.urls;
    const urls = new Set<string>();
    parse(`${file}.1`, urls);
    parse(file, urls);
    memo = { version, urls };
    return urls;
  };
}

export type CaptureSource =
  | {
      ok: true;
      source: string;
      uid: number;
      bytes: number;
      mtimeMs: number;
      data: Buffer;
      /** From the page's `<title>` when there is one, cleaned; else null. */
      title: string | null;
    }
  | { ok: false; reason: string };

const HTML_START_RE = /<!doctype\s+html|<html[\s>]/i;
const TITLE_TAG_RE = /<title[^>]*>([^<]{1,400})<\/title>/i;

/**
 * The checks `scripts/artifact-registry.mjs add --file` makes, plus a content
 * sniff: a real `.html` the caller owns, not a link, no other hard links,
 * 1..COPY_MAX bytes, dev/ino equal to a stat after the open, and the bytes
 * start with `<!doctype html` or `<html` within the first 512. Absolute
 * paths only. Nothing is copied here.
 */
export function captureSource(file: unknown): CaptureSource {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 1024)
    return { ok: false, reason: 'not an absolute path' };
  if (!SOURCE_RE.test(file)) return { ok: false, reason: 'not an .html file' };
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (typeof process.getuid === 'function' && st.uid !== process.getuid())
      return { ok: false, reason: 'not owned by this user' };
    if (st.nlink !== 1) return { ok: false, reason: 'has other hard links' };
    if (st.size < 1 || st.size > COPY_MAX)
      return { ok: false, reason: `not within 1-${COPY_MAX} bytes` };
    const source = fs.realpathSync(file);
    const rs = fs.statSync(source);
    if (rs.dev !== st.dev || rs.ino !== st.ino)
      return { ok: false, reason: 'changed while reading' };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    const data = buf.subarray(0, n);
    if (!HTML_START_RE.test(data.subarray(0, SNIFF_BYTES).toString('utf-8')))
      return { ok: false, reason: 'not an HTML document' };
    const head = data.subarray(0, TITLE_SCAN_BYTES).toString('utf-8');
    const t = TITLE_TAG_RE.exec(head)?.[1];
    const title = t ? cleanTitle(t) : null;
    return {
      ok: true,
      source,
      uid: st.uid,
      bytes: n,
      mtimeMs: st.mtimeMs,
      data,
      title,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason:
        code === 'ENOENT'
          ? 'no such file'
          : code === 'ELOOP'
            ? 'is a symlink'
            : 'unreadable',
    };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Control characters stripped, HTML entities for the common few, trimmed, clamped to 100; null when TITLE_RE still fails. */
export function cleanTitle(raw: string): string | null {
  const t = raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(STRIP_RE, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return TITLE_RE.test(t) ? t : null;
}

/** `{ id, name }` the registry accepts, or null when the id itself is wrong. */
export function sessionForEntry(raw: ArtifactSession): ArtifactSession | null {
  if (typeof raw.id !== 'string' || !CLAUDE_JOB_ID_RE.test(raw.id)) return null;
  const name =
    typeof raw.name === 'string'
      ? raw.name
          .replace(STRIP_RE, '')
          .replace(/[^\p{L}\p{N} ._-]+/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60)
      : '';
  return { id: raw.id, name: CLAUDE_NAME_RE.test(name) ? name : raw.id };
}

export type CapturedAdd =
  | { status: 201; id: string; rev: number; evicted: ArtifactEntry[] }
  | { status: 200; id: string; existing: true }
  | { status: 400 | 409 | 503; error: string; transient: boolean };

/**
 * The write path the auto-capture uses (the dashboard's `addArtifact` never
 * copies): under the registry lock the URL is checked again, the session
 * sub-quota evicts the oldest captured entry, the copy is written `wx` 0600,
 * the registry is written with the rev check — and on a failed write the copy
 * just written is unlinked. Evicted copies are unlinked only after the
 * registry write succeeded; each eviction goes to the removals log.
 */
export function addCapturedArtifact(
  dir: string,
  input: {
    title: string | null;
    url: string;
    kind: ArtifactKind;
    source: Extract<CaptureSource, { ok: true }>;
    session: ArtifactSession;
  },
  opts: { hosts: string[]; now?: () => number },
): CapturedAdd {
  const now = opts.now ?? Date.now;
  const fallback = path.basename(input.source.source).replace(/\.html?$/i, '');
  const title = input.title ?? cleanTitle(fallback) ?? 'Artifact';
  const checked = validateAddInput(
    { title, url: input.url, kind: input.kind },
    opts.hosts,
  );
  if (!checked.ok)
    return { status: 400, error: checked.error, transient: false };
  const { title: entryTitle, url, kind } = checked; // narrowed once; the nested commit() cannot see the guard
  // The session's name comes from the CLI's list and may carry characters the
  // registry's name rule does not (parentheses, say): it is reduced to that
  // charset, and the id stands in when nothing usable is left.
  const sessionOrNull = sessionForEntry(input.session);
  if (!sessionOrNull)
    return { status: 400, error: 'session invalid', transient: false };
  const session: ArtifactSession = sessionOrNull;
  if (!registryDirOk(dir))
    return { status: 503, error: 'registry unavailable', transient: true };
  try {
    return withLock(
      dir,
      (): CapturedAdd => {
        const cur = readRegistry(dir);
        if (!cur.ok)
          return { status: 503, error: 'registry unreadable', transient: true };
        const dup = cur.registry.artifacts.find((a) => a.url === url);
        if (dup) return { status: 200, id: dup.id, existing: true };
        let kept = cur.registry.artifacts;
        const evicted: ArtifactEntry[] = [];
        const captured = kept
          .filter((a) => a.added_by === 'session')
          .sort((a, b) => a.added_at.localeCompare(b.added_at));
        for (let i = 0; captured.length - i >= SESSION_MAX; i++)
          evicted.push(captured[i]);
        if (evicted.length) kept = kept.filter((a) => !evicted.includes(a));
        // Full is a state of the registry, not of the file: retried next time.
        if (kept.length >= ARTIFACTS_MAX)
          return { status: 409, error: 'registry full', transient: true };
        const id = `art-${crypto.randomBytes(6).toString('hex')}`;
        fs.mkdirSync(path.join(dir, COPY_DIR), {
          recursive: true,
          mode: 0o700,
        });
        const file = copyPath(dir, id);
        const fd = fs.openSync(
          file,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            NOFOLLOW,
          0o600,
        );
        // From here a throw (ENOSPC, say) or a failed registry write must not
        // leave the copy behind.
        let committed = false;
        try {
          try {
            fs.writeSync(fd, input.source.data);
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          const at = new Date(now()).toISOString();
          const entry: ArtifactEntry = {
            id,
            title: entryTitle,
            url,
            kind,
            added_at: at,
            added_by: 'session',
            local: {
              source: input.source.source,
              uid: input.source.uid,
              bytes: input.source.bytes,
              copied_at: at,
              source_mtime_ms: input.source.mtimeMs,
            },
            session,
          };
          const w = writeRegistry(
            dir,
            { v: 1, rev: cur.registry.rev + 1, artifacts: [...kept, entry] },
            cur.registry.rev,
            now,
          );
          if (!w.ok)
            return { status: w.status, error: w.error, transient: true };
          committed = true;
          for (const e of evicted) {
            logRemoved(dir, e, 'session-quota', at);
            try {
              fs.unlinkSync(copyPath(dir, e.id));
            } catch {
              /* no copy */
            }
          }
          return { status: 201, id, rev: w.rev, evicted };
        } finally {
          if (!committed)
            try {
              fs.unlinkSync(file);
            } catch {
              /* already gone */
            }
        }
      },
      now,
    );
  } catch (err) {
    if (err instanceof RegistryBusy)
      return { status: 409, error: 'registry busy', transient: true };
    return { status: 503, error: 'registry unavailable', transient: true };
  }
}

export type AddInput = {
  title?: unknown;
  url?: unknown;
  kind?: unknown;
  description?: unknown;
};
export type AddResult =
  | { status: 201; id: string; rev: number }
  | {
      status: 400 | 409 | 503;
      error: string;
      blocked?: UrlBlock;
      reason?: RegistryReason;
    };

export type AddCheck =
  | {
      ok: true;
      title: string;
      url: string;
      kind: ArtifactKind;
      description?: string;
    }
  | { ok: false; status: 400; error: string; blocked?: UrlBlock };

/**
 * Shape and policy checks alone — routes run this before their limiter so
 * invalid input never spends budget.
 */
export function validateAddInput(input: AddInput, hosts: string[]): AddCheck {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!TITLE_RE.test(title))
    return {
      ok: false,
      status: 400,
      error: 'title: 1-100 characters, starting with a letter or digit',
    };
  if (
    typeof input.kind !== 'string' ||
    !(ARTIFACT_KINDS as readonly string[]).includes(input.kind)
  )
    return {
      ok: false,
      status: 400,
      error: `kind: one of ${ARTIFACT_KINDS.join(', ')}`,
    };
  const url = checkUrl(input.url, hosts);
  if (!url.ok)
    return url.shape
      ? { ok: false, status: 400, error: 'url invalid' }
      : {
          ok: false,
          status: 400,
          error: 'url not allowed',
          blocked: url.blocked,
        };
  const out: AddCheck = {
    ok: true,
    title,
    url: url.url,
    kind: input.kind as ArtifactKind,
  };
  if (input.description !== undefined && input.description !== '') {
    if (
      typeof input.description !== 'string' ||
      input.description.length > DESCRIPTION_MAX
    )
      return {
        ok: false,
        status: 400,
        error: `description: at most ${DESCRIPTION_MAX} characters`,
      };
    out.description = input.description;
  }
  return out;
}

export function addArtifact(
  dir: string,
  input: AddInput,
  opts: { hosts: string[]; now?: () => number; by?: ArtifactEntry['added_by'] },
): AddResult {
  const now = opts.now ?? Date.now;
  const checked = validateAddInput(input, opts.hosts);
  if (!checked.ok)
    return checked.blocked
      ? { status: 400, error: checked.error, blocked: checked.blocked }
      : { status: 400, error: checked.error };
  const { title, url, kind, description } = checked;
  if (!registryDirOk(dir))
    return { status: 503, error: 'registry unavailable' };
  try {
    return withLock(
      dir,
      () => {
        const cur = readRegistry(dir);
        if (!cur.ok)
          return {
            status: 503,
            error: 'registry unreadable',
            reason: cur.reason,
          };
        if (cur.registry.artifacts.length >= ARTIFACTS_MAX)
          return { status: 409, error: 'registry full' };
        const entry: ArtifactEntry = {
          id: `art-${crypto.randomBytes(6).toString('hex')}`,
          title,
          url,
          kind,
          added_at: new Date(now()).toISOString(),
          added_by: opts.by ?? 'dashboard',
        };
        if (description !== undefined) entry.description = description;
        const w = writeRegistry(
          dir,
          {
            v: 1,
            rev: cur.registry.rev + 1,
            artifacts: [...cur.registry.artifacts, entry],
          },
          cur.registry.rev,
          now,
        );
        if (!w.ok) return { status: w.status, error: w.error };
        return { status: 201, id: entry.id, rev: w.rev };
      },
      now,
    );
  } catch (err) {
    if (err instanceof RegistryBusy)
      return { status: 409, error: 'registry busy' };
    return { status: 503, error: 'registry unavailable' };
  }
}

export type RemoveResult =
  | { status: 204; entry: ArtifactEntry }
  | { status: 404 | 409 | 428 | 503; error: string; reason?: RegistryReason };

export function removeArtifact(
  dir: string,
  id: unknown,
  confirmId: unknown,
  opts: { now?: () => number; by?: string } = {},
): RemoveResult {
  const now = opts.now ?? Date.now;
  if (typeof id !== 'string' || !ARTIFACT_ID_RE.test(id))
    return { status: 404, error: 'not found' };
  if (confirmId !== id) return { status: 428, error: 'confirmation required' };
  if (!registryDirOk(dir))
    return { status: 503, error: 'registry unavailable' };
  try {
    return withLock(
      dir,
      () => {
        const cur = readRegistry(dir);
        if (!cur.ok)
          return {
            status: 503,
            error: 'registry unreadable',
            reason: cur.reason,
          };
        const entry = cur.registry.artifacts.find((a) => a.id === id);
        if (!entry) return { status: 404, error: 'not found' };
        const w = writeRegistry(
          dir,
          {
            v: 1,
            rev: cur.registry.rev + 1,
            artifacts: cur.registry.artifacts.filter((a) => a.id !== id),
          },
          cur.registry.rev,
          now,
        );
        if (!w.ok) return { status: w.status, error: w.error };
        logRemoved(
          dir,
          entry,
          opts.by ?? 'dashboard',
          new Date(now()).toISOString(),
        );
        try {
          fs.unlinkSync(copyPath(dir, id));
        } catch {
          /* no copy */
        }
        return { status: 204, entry };
      },
      now,
    );
  } catch (err) {
    if (err instanceof RegistryBusy)
      return { status: 409, error: 'registry busy' };
    return { status: 503, error: 'registry unavailable' };
  }
}
