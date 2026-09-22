#!/usr/bin/env node
// Propose a browser job for the operator to approve. This is the session-facing
// CLI: it can write one thing, a record whose status is `proposed`, and the
// dashboard decides whether it ever runs. It cannot approve, cannot touch
// rules, and cannot make anything happen on a website by itself.
//
//   node scripts/browser-job.mjs propose --site instagram --kind follow --handle @someone
//   node scripts/browser-job.mjs propose --site alibaba --kind reply --thread T123 --body "..."
//   node scripts/browser-job.mjs list [--json] · show <id>
//
// Exit codes: 0 ok · 2 usage · 3 refused (shape, rules or allow-list) · 4 not found.
// A non-zero exit is bookkeeping: it never means the order itself failed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';

const KINDS = {
  instagram: { follow: 'instagram.follow' },
  alibaba: { reply: 'alibaba.reply', list_threads: 'alibaba.list_threads' },
};
const ID_RE = /^bj-[0-9a-f]{12}$/;
const HANDLE_RE = /^@?[A-Za-z0-9._]{1,30}$/;
const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BODY_MAX = 2000;
const FILE_MAX = 64 * 1024;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const USAGE = `usage: browser-job.mjs <propose|list|show|validate> [id|file] [options]
  propose --site <instagram|alibaba> --kind <follow|reply|list_threads>
          [--handle @name] [--thread <id>] [--body <text>]
  list [--json] · show <id> · validate <file>
  common: --dir <config dir> (default ~/.config/deus/browser)
Rules decide what may be proposed; the operator decides what runs.`;

const fail = (code, msg) => {
  console.error(msg);
  process.exit(code);
};

function readJson(file, max) {
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'unreadable' };
    if (st.size > max) return { ok: false, reason: 'too-large' };
    const buf = Buffer.alloc(st.size);
    const n = fs.readSync(fd, buf, 0, st.size, 0);
    try {
      return {
        ok: true,
        raw: JSON.parse(buf.subarray(0, n).toString('utf-8')),
      };
    } catch {
      return { ok: false, reason: 'not-json' };
    }
  } catch (err) {
    return {
      ok: false,
      reason: err && err.code === 'ENOENT' ? 'missing' : 'unreadable',
    };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

// The param shapes below are kept in lockstep with
// src/control-ui/api/browser-store.ts, and that agreement is asserted in
// scripts/tests/browser-cli.test.ts over shared fixtures. `checkAllowed` is a
// deliberately partial mirror of `capCheck` — it covers `enabled`, the kind and
// the target lists, and does NOT evaluate caps, quiet hours or pacing, which
// depend on state only the server walks. The server re-checks all of it.
const norm = (h) => String(h).trim().replace(/^@/, '').toLowerCase();
function checkParams(kind, o) {
  if (kind === 'instagram.follow') {
    if (!o.handle || !HANDLE_RE.test(o.handle))
      return { error: '--handle: 1-30 of letters, digits, dot or underscore' };
    return { params: { handle: o.handle } };
  }
  if (kind === 'alibaba.reply') {
    if (!o.thread || !THREAD_RE.test(o.thread))
      return { error: '--thread: 1-64 of letters, digits, dash or underscore' };
    if (!o.body || o.body.length === 0 || o.body.length > BODY_MAX)
      return { error: `--body: 1-${BODY_MAX} characters` };
    return { params: { thread_id: o.thread, body: o.body } };
  }
  return { params: {} };
}

/** The allow-list is the operator's, so a proposal outside it is refused here
 *  too — the dashboard would refuse it anyway, but failing early is clearer. */
function checkAllowed(dir, site, kind, params) {
  const r = readJson(path.join(dir, 'rules', `${site}.json`), FILE_MAX);
  if (!r.ok)
    return r.reason === 'missing'
      ? `no rules for ${site}: ask the operator to set them in the dashboard`
      : `rules for ${site} are unreadable (${r.reason})`;
  const rules = r.raw;
  if (!rules || typeof rules !== 'object' || !rules.allow)
    return `rules for ${site} are not usable`;
  // A switched-off site refuses at approval anyway, but a proposal written
  // against one sits in the operator's queue saying "waiting for you" until
  // they act on something that could never run. Refuse it here instead.
  if (rules.enabled !== true)
    return `${site} is switched off in the operator's rules`;
  const kinds = Array.isArray(rules.allow.kinds)
    ? rules.allow.kinds.map((k) =>
        String(k).includes('.') ? String(k) : `${site}.${k}`,
      )
    : [];
  if (!kinds.includes(kind)) return `rules for ${site} do not allow ${kind}`;
  if (kind === 'instagram.follow') {
    const list = Array.isArray(rules.allow.handles)
      ? rules.allow.handles.map(norm)
      : [];
    if (!list.includes(norm(params.handle)))
      return `${params.handle} is not on the operator's allow-list for ${site}`;
  }
  if (kind === 'alibaba.reply') {
    const list = Array.isArray(rules.allow.threads)
      ? rules.allow.threads.map((t) => String(t).trim())
      : [];
    if (!list.includes(params.thread_id))
      return `thread ${params.thread_id} is not on the operator's allow-list for ${site}`;
  }
  return null;
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        dir: { type: 'string' },
        site: { type: 'string' },
        kind: { type: 'string' },
        handle: { type: 'string' },
        thread: { type: 'string' },
        body: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (err) {
    fail(2, `${err && err.message ? err.message : 'bad arguments'}\n${USAGE}`);
  }
  const { values: o, positionals } = parsed;
  const [cmd, arg] = positionals;
  if (!cmd) fail(2, USAGE);
  const dir = o.dir ?? path.join(os.homedir(), '.config', 'deus', 'browser');
  const jobs = path.join(dir, 'jobs');

  if (cmd === 'validate') {
    const r = readJson(arg ?? '', FILE_MAX);
    console.log(r.ok ? 'ok' : r.reason);
    process.exit(r.ok ? 0 : 3);
  }
  if (cmd === 'propose') {
    if (!o.site || !o.kind) fail(2, USAGE);
    const kind =
      KINDS[o.site]?.[o.kind] ?? (String(o.kind).includes('.') ? o.kind : null);
    if (!kind || !Object.values(KINDS[o.site] ?? {}).includes(kind))
      fail(3, `unknown kind for ${o.site}: ${o.kind}`);
    const checked = checkParams(kind, o);
    if (checked.error) fail(3, checked.error);
    const refusal = checkAllowed(dir, o.site, kind, checked.params);
    if (refusal) fail(3, refusal);
    fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
    const id = `bj-${crypto.randomBytes(6).toString('hex')}`;
    const job = {
      v: 1,
      id,
      site: o.site,
      kind,
      params: checked.params,
      status: 'proposed', // the only status this CLI can write
      proposed_by: 'cli',
      proposed_at: new Date().toISOString(),
      rev: 1,
    };
    const tmp = path.join(
      jobs,
      `${id}.json.tmp-${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(tmp, path.join(jobs, `${id}.json`));
    process.stdout.write(id + '\n');
    return;
  }
  if (cmd === 'show') {
    if (typeof arg !== 'string' || !ID_RE.test(arg))
      fail(2, 'show expects an id like bj-<12 hex>');
    const r = readJson(path.join(jobs, `${arg}.json`), FILE_MAX);
    if (!r.ok)
      fail(r.reason === 'missing' ? 4 : 3, `cannot read ${arg}: ${r.reason}`);
    console.log(JSON.stringify(r.raw, null, 2));
    return;
  }
  if (cmd === 'list') {
    let names = [];
    try {
      names = fs.readdirSync(jobs);
    } catch {
      names = [];
    }
    const rows = [];
    for (const n of names) {
      if (!/^bj-[0-9a-f]{12}\.json$/.test(n)) continue;
      const r = readJson(path.join(jobs, n), FILE_MAX);
      rows.push(
        r.ok ? r.raw : { id: n.slice(0, -5), invalid: true, reason: r.reason },
      );
    }
    rows.sort((a, b) =>
      String(b.proposed_at ?? '').localeCompare(String(a.proposed_at ?? '')),
    );
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else
      for (const r of rows)
        console.log(
          r.invalid
            ? `${r.id}  INVALID (${r.reason})`
            : `${r.id}  ${String(r.status).padEnd(9)} ${r.kind}  ${JSON.stringify(r.params)}`,
        );
    return;
  }
  fail(2, USAGE);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
