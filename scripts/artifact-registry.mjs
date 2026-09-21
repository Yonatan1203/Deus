#!/usr/bin/env node
// Registry of the live artifact apps, reports and previews the operator keeps
// at hand; the control UI's Artifacts tab reads only this file. Sessions ask
// the operator before adding anything (AGENTS.md § Publishing artifacts).
//
//   node scripts/artifact-registry.mjs add --title "Supplier Line" --url https://claude.ai/artifact/… --kind app
//   node scripts/artifact-registry.mjs remove art-3f9a2b1c4d5e
//   node scripts/artifact-registry.mjs list [--json]
//
// Exit codes: 0 ok · 2 usage · 3 validation, conflict or busy · 4 not found.
// The server re-checks every URL against its own allow-list when it reads the
// file; the check here only keeps unshowable links out of the registry.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';

const ID_RE = /^art-[0-9a-f]{12}$/;
const KINDS = ['app', 'report', 'preview'];
const ADDED_BY = ['cli', 'dashboard'];
const TITLE_RE = /^[\p{L}\p{N}][^\p{Cc}\p{Cf}]{0,99}$/u;
const DESCRIPTION_MAX = 300;
const ARTIFACTS_MAX = 200;
const READ_MAX = 256 * 1024;
const WRITE_MAX = 192 * 1024;
const REMOVED_LOG_MAX = 1024 * 1024;
const LOCK_STALE_MS = 5000;
const LOCK_RETRIES = 3;
const LOCK_RETRY_MS = 200;
const TMP_SWEEP_MS = 60 * 60 * 1000;
const URL_MAX = 2048;
const FILE = 'artifacts.json';
const USAGE = `usage: artifact-registry.mjs <add|remove|list|validate> [id|file] [options]
  add      --title <text> --url <https://claude.ai/…> --kind <app|report|preview> [--description <text>]
  remove   <id>        (prints the removed entry as JSON; it is also appended to artifacts-removed.jsonl)
  list     [--json]
  validate <file>
  common: --registry <file> (default ~/.config/deus/control-ui/artifacts.json)
  Extra preview hosts come from CONTROL_UI_PREVIEW_HOSTS (exact hostnames, comma-separated).`;

// --- validator: kept in lockstep with src/control-ui/api/artifacts.ts -------
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const SECRET_KEYS = 'api[_-]?key|token|secret|password|passwd|credential|authorization';
const SECRET_QUERY_KEY = new RegExp(`^(?:[^_-]*[_-])?(?:${SECRET_KEYS})(?:[_-][^_-]*)?$`, 'i');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export function checkUrl(raw, extraHosts = []) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX) return { ok: false, shape: true };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, shape: true };
  }
  if (url.username !== '' || url.password !== '') return { ok: false, shape: false, blocked: 'userinfo' };
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') {
    if (host !== 'claude.ai' && !extraHosts.includes(host)) return { ok: false, shape: false, blocked: 'host' };
  } else if (url.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(host)) return { ok: false, shape: false, blocked: 'host' };
  } else return { ok: false, shape: false, blocked: 'protocol' };
  for (const key of url.searchParams.keys()) if (SECRET_QUERY_KEY.test(key)) return { ok: false, shape: false, blocked: 'secret-query' };
  return { ok: true, url: raw, hostname: host };
}
export function validateEntry(raw) {
  if (!isObj(raw)) return null;
  const { id, title, url, kind, description, added_at, added_by } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof title !== 'string' || !TITLE_RE.test(title)) return null;
  const u = checkUrl(url);
  if (!u.ok && u.shape) return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (description !== undefined && (typeof description !== 'string' || description.length > DESCRIPTION_MAX)) return null;
  if (!isIso(added_at)) return null;
  if (typeof added_by !== 'string' || !ADDED_BY.includes(added_by)) return null;
  const entry = { id, title, url, kind, added_at, added_by };
  if (description !== undefined) entry.description = description;
  return entry;
}
export function validateRegistry(raw) {
  if (!isObj(raw) || raw.v !== 1) return { ok: false, reason: 'bad-schema' };
  const { rev, artifacts } = raw;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) return { ok: false, reason: 'bad-schema' };
  if (!Array.isArray(artifacts) || artifacts.length > ARTIFACTS_MAX) return { ok: false, reason: 'bad-schema' };
  const out = [];
  const seen = new Set();
  for (const a of artifacts) {
    const e = validateEntry(a);
    if (!e || seen.has(e.id)) return { ok: false, reason: 'bad-schema' };
    seen.add(e.id);
    out.push(e);
  }
  return { ok: true, registry: { v: 1, rev, artifacts: out } };
}

// --- confined file access ---------------------------------------------------
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
function readFileConfined(file, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'unreadable' };
    if (st.size > maxBytes) return { ok: false, reason: 'too-large' };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    try {
      return { ok: true, raw: JSON.parse(buf.subarray(0, n).toString('utf-8')) };
    } catch {
      return { ok: false, reason: 'not-json' };
    }
  } catch (err) {
    return { ok: false, reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
function readRegistry(file) {
  const r = readFileConfined(file, READ_MAX);
  if (!r.ok) return r.reason === 'missing' ? { ok: true, registry: { v: 1, rev: 0, artifacts: [] } } : r;
  return validateRegistry(r.raw);
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withLock(dir, fn) {
  const lock = path.join(dir, `${FILE}.lock`);
  const nonce = crypto.randomBytes(8).toString('hex');
  const acquire = () => {
    try {
      fs.writeFileSync(lock, nonce, { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return false;
    }
  };
  let held = acquire();
  for (let i = 0; !held && i < LOCK_RETRIES; i++) {
    let stale;
    try {
      stale = Date.now() - fs.lstatSync(lock).mtimeMs > LOCK_STALE_MS;
    } catch {
      stale = true;
    }
    if (stale) {
      try {
        fs.unlinkSync(lock);
      } catch {
        /* someone else broke it */
      }
    } else sleep(LOCK_RETRY_MS);
    held = acquire();
  }
  if (!held) fail(3, 'registry busy: another writer holds artifacts.json.lock; retry in a moment');
  try {
    return fn();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf-8') === nonce) fs.unlinkSync(lock);
    } catch {
      /* not ours */
    }
  }
}
function sweepTmp(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^artifacts\.json\.tmp-[0-9a-f]{8}$/.test(n)) continue;
    const p = path.join(dir, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && st.mtimeMs < Date.now() - TMP_SWEEP_MS) fs.unlinkSync(p);
    } catch {
      /* raced away */
    }
  }
}
function writeRegistry(file, next, expectRev) {
  const dir = path.dirname(file);
  const v = validateRegistry(next);
  if (!v.ok) fail(3, `refusing to write: ${v.reason}`);
  const text = JSON.stringify(v.registry, null, 2) + '\n';
  if (Buffer.byteLength(text) > WRITE_MAX) fail(3, 'registry full: remove entries before adding more');
  sweepTmp(dir);
  const tmp = path.join(dir, `${FILE}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
  const cur = readRegistry(file);
  if (!cur.ok || cur.registry.rev !== expectRev) {
    fs.unlinkSync(tmp);
    fail(3, `registry changed under us (rev ${expectRev}); re-run`);
  }
  fs.renameSync(tmp, file);
}
function logRemoved(dir, entry) {
  const log = path.join(dir, 'artifacts-removed.jsonl');
  try {
    if (fs.lstatSync(log).size > REMOVED_LOG_MAX) fs.renameSync(log, `${log}.1`);
  } catch {
    /* no log yet */
  }
  const fd = fs.openSync(log, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify({ removed_at: new Date().toISOString(), removed_by: 'cli', entry }) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

// --- commands ----------------------------------------------------------------
// Thrown, not exited, so a `finally` (the lock release) still runs.
class Exit extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}
const fail = (code, msg) => {
  throw new Exit(code, msg);
};
function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        registry: { type: 'string' },
        title: { type: 'string' },
        url: { type: 'string' },
        kind: { type: 'string' },
        description: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (err) {
    fail(2, `${err && err.message ? err.message : 'bad arguments'}\n${USAGE}`);
  }
  const { values: o, positionals } = parsed;
  const [cmd, arg] = positionals;
  if (!cmd) fail(2, USAGE);
  if (cmd === 'validate') {
    const r = readFileConfined(arg ?? '', READ_MAX);
    const v = r.ok ? validateRegistry(r.raw) : { ok: false, reason: r.reason };
    console.log(v.ok ? 'ok' : v.reason);
    process.exit(v.ok ? 0 : 3);
  }
  const file = o.registry ?? path.join(os.homedir(), '.config', 'deus', 'control-ui', FILE);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) fail(3, `registry dir is not a directory: ${dir}`);
  const hosts = (process.env.CONTROL_UI_PREVIEW_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const loaded = () => {
    const r = readRegistry(file);
    if (!r.ok) fail(3, `registry unreadable: ${r.reason} — fix or move ${file} on the host`);
    return r.registry;
  };
  switch (cmd) {
    case 'add': {
      if (!o.title || !o.url || !o.kind) fail(2, USAGE);
      const title = o.title.trim();
      if (!TITLE_RE.test(title)) fail(3, '--title: 1-100 characters, starting with a letter or digit, no control characters');
      if (!KINDS.includes(o.kind)) fail(3, `--kind: one of ${KINDS.join(', ')}`);
      const u = checkUrl(o.url, hosts);
      if (!u.ok) fail(3, u.shape ? '--url: not a valid URL (max 2048 characters)' : `--url not allowed: ${u.blocked} (https://claude.ai/… or a host in CONTROL_UI_PREVIEW_HOSTS)`);
      if (o.description !== undefined && o.description.length > DESCRIPTION_MAX) fail(3, `--description: at most ${DESCRIPTION_MAX} characters`);
      withLock(dir, () => {
        const cur = loaded();
        if (cur.artifacts.length >= ARTIFACTS_MAX) fail(3, 'registry full: remove entries before adding more');
        const entry = { id: `art-${crypto.randomBytes(6).toString('hex')}`, title, url: o.url, kind: o.kind, added_at: new Date().toISOString(), added_by: 'cli' };
        if (o.description) entry.description = o.description;
        writeRegistry(file, { v: 1, rev: cur.rev + 1, artifacts: [...cur.artifacts, entry] }, cur.rev);
        process.stdout.write(entry.id + '\n');
      });
      return;
    }
    case 'remove': {
      if (typeof arg !== 'string' || !ID_RE.test(arg)) fail(2, 'remove expects an id like art-<12 hex>');
      withLock(dir, () => {
        const cur = loaded();
        const entry = cur.artifacts.find((a) => a.id === arg);
        if (!entry) fail(4, `no artifact ${arg}`);
        writeRegistry(file, { v: 1, rev: cur.rev + 1, artifacts: cur.artifacts.filter((a) => a.id !== arg) }, cur.rev);
        logRemoved(dir, entry);
        console.log(JSON.stringify(entry));
      });
      return;
    }
    case 'list': {
      const cur = loaded();
      if (o.json) console.log(JSON.stringify(cur, null, 2));
      else for (const a of cur.artifacts) console.log(`${a.id}  ${a.kind.padEnd(7)} ${a.title}  ${a.url}`);
      return;
    }
    default:
      fail(2, USAGE);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof Exit)) throw err;
    console.error(err.message);
    process.exit(err.code);
  }
}
