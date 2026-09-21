import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { checkUrl, type UrlBlock } from './allowed-url.js';
import { redactSecrets } from './logs.js';
import { readRecordFile } from './workflows.js';

// The artifacts registry: one file, `CONFIG_DIR/control-ui/artifacts.json`,
// `{ v: 1, rev, artifacts: [...] }`, curated by the operator through
// `scripts/artifact-registry.mjs` and two dashboard routes. Anything running
// as the operator can write it, so the read path treats it as input (Phase W
// confinement) and the read-time URL check is the security control; the
// write-time check only keeps unshowable links out.
export const ARTIFACT_ID_RE = /^art-[0-9a-f]{12}$/;
export const ARTIFACT_KINDS = ['app', 'report', 'preview'] as const;
export const ADDED_BY = ['cli', 'dashboard'] as const;
export const TITLE_RE = /^[\p{L}\p{N}][^\p{Cc}\p{Cf}]{0,99}$/u;
export const DESCRIPTION_MAX = 300;
export const ARTIFACTS_MAX = 200;
export const REGISTRY_READ_MAX = 256 * 1024;
export const REGISTRY_WRITE_MAX = 192 * 1024;
export const REGISTRY_FILE = 'artifacts.json';
export const REMOVED_LOG = 'artifacts-removed.jsonl';
export const REMOVED_LOG_MAX = 1024 * 1024;
export const LOCK_STALE_MS = 5000;
const TMP_RE = /^artifacts\.json\.tmp-[0-9a-f]{8}$/;
const TMP_SWEEP_MS = 60 * 60 * 1000;
const STRIP_RE = /[\p{Cc}\p{Cf}]/gu;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export type RegistryReason =
  'unreadable' | 'too-large' | 'not-json' | 'bad-schema';

export interface ArtifactEntry {
  id: string;
  title: string;
  url: string;
  kind: ArtifactKind;
  description?: string;
  added_at: string;
  added_by: (typeof ADDED_BY)[number];
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
  return entry;
}

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
  };
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
): T {
  const lock = path.join(dir, `${REGISTRY_FILE}.lock`);
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
