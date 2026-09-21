#!/usr/bin/env node
// Progress registry for long-running orders (posts, product images, site
// images…). Sessions and pipeline scripts call this; the control UI's
// Workflows tab reads only the records it writes. See AGENTS.md § Reporting
// long-running work.
//
//   WF=$(node scripts/workflow.mjs start --name "Posts batch 12" --kind posts)
//   node scripts/workflow.mjs progress "$WF" --percent 40 --step "3/7 rendering"
//   node scripts/workflow.mjs finish "$WF" --preview https://claude.ai/artifact/…
//   node scripts/workflow.mjs fail "$WF" --message "Shopify API 500"
//
// Exit codes: 0 ok · 2 usage · 3 validation or conflict · 4 not found.
// A non-zero exit is bookkeeping — never a reason to abort the order itself.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';

const ID_RE = /^wf-[0-9a-f]{12}$/;
const KINDS = ['posts', 'product_images', 'site_images', 'other'];
const STATUSES = ['running', 'waiting', 'done', 'failed'];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()/-]{0,79}$/u;
const SESSION_RE = /^[0-9a-f]{8}$/;
const RECORD_MAX_BYTES = 64 * 1024;
const URL_MAX = 2048;
const OUTPUTS_MAX = 20;
const TMP_SWEEP_MS = 60 * 60 * 1000;
const USAGE = `usage: workflow.mjs <start|progress|finish|fail|show|list|validate> [id] [options]
  start    --name <text> --kind <posts|product_images|site_images|other> [--session <8-hex>] [--steps-total N] [--step <text>]
  progress <id> [--percent N] [--step <text>] [--message <text>] [--waiting|--running]
  finish   <id> [--preview <url>] [--output <label>=<url>]... [--message <text>]
  fail     <id> --message <text>
  show     <id> · list · validate <file>
  common: --registry <dir> (default ~/.config/deus/control-ui/workflows)`;

// --- validator: kept in lockstep with src/control-ui/api/workflows.ts -------
// (agreement test: src/control-ui/api/workflows.test.ts over shared fixtures)
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isInt = (v, min, max) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const optStr = (v, max) => v === undefined || (typeof v === 'string' && v.length <= max);
function urlShapeOk(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > URL_MAX) return false;
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}
export function validateRecord(raw, expectId) {
  if (!isObj(raw) || raw.v !== 1) return { ok: false, reason: 'bad-schema' };
  const id = raw.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: 'bad-id' };
  if (expectId !== undefined && id !== expectId) return { ok: false, reason: 'bad-id' };
  const kind = raw.kind;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return { ok: false, reason: 'bad-kind' };
  if (!isInt(raw.percent, 0, 100)) return { ok: false, reason: 'bad-percent' };
  if (raw.preview_url !== undefined && !urlShapeOk(raw.preview_url)) return { ok: false, reason: 'bad-url' };
  if (!Array.isArray(raw.outputs) || raw.outputs.length > OUTPUTS_MAX) return { ok: false, reason: 'bad-schema' };
  const outputs = [];
  for (const o of raw.outputs) {
    if (!isObj(o) || typeof o.label !== 'string' || o.label.length > 80) return { ok: false, reason: 'bad-schema' };
    if (!urlShapeOk(o.url)) return { ok: false, reason: 'bad-url' };
    outputs.push({ label: o.label, url: o.url });
  }
  const { name, status } = raw;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, reason: 'bad-schema' };
  if (typeof status !== 'string' || !STATUSES.includes(status)) return { ok: false, reason: 'bad-schema' };
  if (!optStr(raw.step, 200) || !optStr(raw.message, 500)) return { ok: false, reason: 'bad-schema' };
  if (raw.steps_total !== undefined && !isInt(raw.steps_total, 1, 999)) return { ok: false, reason: 'bad-schema' };
  if (raw.session_id !== undefined && !(typeof raw.session_id === 'string' && SESSION_RE.test(raw.session_id)))
    return { ok: false, reason: 'bad-schema' };
  if (!isIso(raw.started_at) || !isIso(raw.updated_at)) return { ok: false, reason: 'bad-schema' };
  if (raw.finished_at !== undefined && !isIso(raw.finished_at)) return { ok: false, reason: 'bad-schema' };
  if (!isInt(raw.rev, 1, Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'bad-schema' };
  const record = {
    v: 1, id, name, kind, status, percent: raw.percent, outputs,
    started_at: raw.started_at, updated_at: raw.updated_at, rev: raw.rev,
  };
  if (raw.step !== undefined) record.step = raw.step;
  if (raw.steps_total !== undefined) record.steps_total = raw.steps_total;
  if (raw.message !== undefined) record.message = raw.message;
  if (raw.session_id !== undefined) record.session_id = raw.session_id;
  if (raw.preview_url !== undefined) record.preview_url = raw.preview_url;
  if (raw.finished_at !== undefined) record.finished_at = raw.finished_at;
  return { ok: true, record };
}

// --- confined file access ---------------------------------------------------
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
function readRecordFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'unreadable' };
    if (st.size > RECORD_MAX_BYTES) return { ok: false, reason: 'too-large' };
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
function writeAtomic(dir, id, record) {
  const tmp = path.join(dir, `${id}.json.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return tmp;
}
function sweepTmp(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^wf-[0-9a-f]{12}\.json\.tmp-[0-9a-f]{8}$/.test(n)) continue;
    const p = path.join(dir, n);
    try {
      if (fs.lstatSync(p).isFile() && fs.lstatSync(p).mtimeMs < now - TMP_SWEEP_MS) fs.unlinkSync(p);
    } catch {
      /* raced away */
    }
  }
}

// --- commands ----------------------------------------------------------------
const fail = (code, msg) => {
  console.error(msg);
  process.exit(code);
};
const nowIso = () => new Date().toISOString();

function loadRecord(dir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail(2, `invalid id: expected wf-<12 hex>`);
  const file = path.join(dir, `${id}.json`);
  const read = readRecordFile(file);
  if (!read.ok) fail(read.reason === 'missing' ? 4 : 3, `cannot read ${id}: ${read.reason}`);
  const v = validateRecord(read.raw, id);
  if (!v.ok) fail(3, `record ${id} is invalid: ${v.reason}`);
  return { file, record: v.record };
}

/** Validates the patched literal, then re-checks `rev` right before the rename. */
function commit(dir, file, current, next) {
  const v = validateRecord(next, current.id);
  if (!v.ok) fail(3, `refusing to write: ${v.reason}`);
  const tmp = writeAtomic(dir, current.id, v.record);
  const again = readRecordFile(file);
  if (!again.ok || !isObj(again.raw) || again.raw.rev !== current.rev) {
    fs.unlinkSync(tmp);
    fail(3, `record ${current.id} changed under us (rev ${current.rev}); re-read and retry`);
  }
  fs.renameSync(tmp, file);
}

function parseOutputs(list) {
  return (list ?? []).map((s) => {
    const i = s.indexOf('=');
    if (i <= 0) fail(2, `--output expects <label>=<url>: ${s}`);
    return { label: s.slice(0, i), url: s.slice(i + 1) };
  });
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      registry: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string' },
      session: { type: 'string' },
      'steps-total': { type: 'string' },
      step: { type: 'string' },
      percent: { type: 'string' },
      message: { type: 'string' },
      preview: { type: 'string' },
      output: { type: 'string', multiple: true },
      waiting: { type: 'boolean' },
      running: { type: 'boolean' },
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
    const read = readRecordFile(arg ?? '');
    const v = read.ok ? validateRecord(read.raw) : { ok: false, reason: read.reason };
    console.log(v.ok ? 'ok' : v.reason);
    process.exit(v.ok ? 0 : 3);
  }
  const dir = o.registry ?? path.join(os.homedir(), '.config', 'deus', 'control-ui', 'workflows');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) fail(3, `registry is not a directory: ${dir}`);
  sweepTmp(dir, Date.now());
  const ts = nowIso();
  const intOpt = (k, min, max) => {
    if (o[k] === undefined) return undefined;
    const n = Number(o[k]);
    if (!Number.isInteger(n) || n < min || n > max) fail(2, `--${k} must be an integer ${min}..${max}`);
    return n;
  };

  switch (cmd) {
    case 'start': {
      if (!o.name || !o.kind) fail(2, USAGE);
      if (!NAME_RE.test(o.name))
        fail(3, '--name: 1-80 characters; letters, digits, spaces and . _ ( ) / - only, not starting with punctuation');
      if (!KINDS.includes(o.kind)) fail(3, `--kind: one of ${KINDS.join(', ')}`);
      const id = `wf-${crypto.randomBytes(6).toString('hex')}`;
      const record = {
        v: 1, id, name: o.name, kind: o.kind, status: 'running', percent: 0, outputs: [],
        started_at: ts, updated_at: ts, rev: 1,
      };
      if (o['steps-total'] !== undefined) record.steps_total = intOpt('steps-total', 1, 999);
      if (o.step !== undefined) record.step = o.step;
      if (o.session !== undefined) record.session_id = o.session; // explicit only — never guessed
      const v = validateRecord(record, id);
      if (!v.ok) fail(3, `refusing to write: ${v.reason}`);
      fs.renameSync(writeAtomic(dir, id, v.record), path.join(dir, `${id}.json`));
      process.stdout.write(id + '\n');
      return;
    }
    case 'progress': {
      const { file, record } = loadRecord(dir, arg);
      if (record.status === 'done' || record.status === 'failed') fail(3, `${record.id} is already ${record.status}`);
      const next = { ...record, updated_at: ts, rev: record.rev + 1 };
      const percent = intOpt('percent', 0, 100);
      if (percent !== undefined) next.percent = percent;
      if (o.step !== undefined) next.step = o.step;
      if (o.message !== undefined) next.message = o.message;
      if (o.waiting) next.status = 'waiting';
      if (o.running) next.status = 'running';
      commit(dir, file, record, next);
      return;
    }
    case 'finish':
    case 'fail': {
      const { file, record } = loadRecord(dir, arg);
      const outputs = parseOutputs(o.output);
      const terminal = record.status === 'done' || record.status === 'failed';
      const next = { ...record, updated_at: ts, rev: record.rev + 1, outputs: [...record.outputs, ...outputs] };
      if (terminal) {
        // A re-run may only add outputs to a finished record.
        if (o.preview !== undefined || o.message !== undefined || outputs.length === 0)
          fail(3, `${record.id} is already ${record.status}; only --output may be added`);
      } else {
        next.status = cmd === 'finish' ? 'done' : 'failed';
        next.finished_at = ts;
        if (cmd === 'finish') next.percent = 100;
        if (cmd === 'fail' && o.message === undefined) fail(2, 'fail requires --message');
        if (o.preview !== undefined) next.preview_url = o.preview;
        if (o.message !== undefined) next.message = o.message;
      }
      commit(dir, file, record, next);
      return;
    }
    case 'show': {
      const { record } = loadRecord(dir, arg);
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    case 'list': {
      const rows = [];
      for (const n of fs.readdirSync(dir)) {
        if (!/^wf-[0-9a-f]{12}\.json$/.test(n)) continue;
        const read = readRecordFile(path.join(dir, n));
        const v = read.ok ? validateRecord(read.raw, n.slice(0, -5)) : { ok: false, reason: read.reason };
        rows.push(v.ok ? v.record : { id: n.slice(0, -5), invalid: true, reason: v.reason });
      }
      if (o.json) console.log(JSON.stringify(rows, null, 2));
      else for (const r of rows) console.log(r.invalid ? `${r.id}  INVALID (${r.reason})` : `${r.id}  ${r.status.padEnd(7)} ${String(r.percent).padStart(3)}%  ${r.name}`);
      return;
    }
    default:
      fail(2, USAGE);
  }
}

// Import-safe for the agreement test; runs only as a script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
