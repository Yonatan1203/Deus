#!/usr/bin/env node
// Read or set the browser rules for a site. **This is an operator tool, not a
// session one**: it is deliberately absent from AGENTS.md, because everything
// documented there is an instruction the assistant executes, and these rules
// are what bounds the assistant. A session that wants something proposed uses
// scripts/browser-job.mjs; a session that wants the rules changed asks.
//
//   node scripts/browser-rules.mjs show --site instagram
//   node scripts/browser-rules.mjs set --site instagram --file rules.json
//
// `set` can write caps and allow-lists. It cannot turn autonomy on: the two
// confirmation fields are dropped from whatever it is given, and only the
// dashboard route that asks the operator to type the site name writes them.
// Changing caps or the allow-list therefore costs one re-confirmation there —
// which is the point, since the confirmation is bound to the scope it covered.
//
// Exit codes: 0 ok · 2 usage · 3 refused.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';

const SITE_KINDS = {
  instagram: ['instagram.follow'],
  alibaba: ['alibaba.reply', 'alibaba.list_threads'],
};
const FILE_MAX = 64 * 1024;
const ALLOW_MAX = 500;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const USAGE = `usage: browser-rules.mjs <show|set> --site <instagram|alibaba> [--file rules.json]
  show  prints the effective rules
  set   writes caps and allow-lists from a JSON file (never autonomy)
  common: --dir <config dir> (default ~/.config/deus/browser)`;

const fail = (code, msg) => {
  console.error(msg);
  process.exit(code);
};
const isInt = (v, min, max) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

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

const strList = (v, max) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > ALLOW_MAX) return null;
  for (const x of v)
    if (typeof x !== 'string' || x.length === 0 || x.length > max) return null;
  return v.slice();
};

// Kept in lockstep with validateRules in src/control-ui/api/browser-store.ts;
// the agreement is asserted in scripts/tests/browser-cli.test.ts.
function buildRules(raw, site) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'not an object' };
  const kindsRaw = Array.isArray(raw.allow?.kinds) ? raw.allow.kinds : [];
  if (kindsRaw.length === 0)
    return { error: 'allow.kinds must list at least one kind' };
  const kinds = [];
  for (const k of kindsRaw) {
    const full = String(k).includes('.') ? String(k) : `${site}.${k}`;
    if (!(SITE_KINDS[site] ?? []).includes(full))
      return { error: `unknown kind for ${site}: ${k}` };
    kinds.push(full);
  }
  const handles = strList(raw.allow?.handles, 64);
  const threads = strList(raw.allow?.threads, 64);
  if (handles === null || threads === null)
    return {
      error: `allow lists must be arrays of at most ${ALLOW_MAX} short strings`,
    };
  const weekly = raw.weekly_cap;
  if (!isInt(weekly, 1, 500))
    return {
      error: 'weekly_cap: 1..500 — the number from your plan, per week',
    };
  const daily = raw.daily_cap ?? Math.ceil(weekly / 7);
  if (!isInt(daily, 1, 200)) return { error: 'daily_cap: 1..200' };
  if (daily > weekly)
    return { error: `daily_cap ${daily} exceeds weekly_cap ${weekly}` };
  const gap = raw.min_gap_seconds ?? 45;
  const jitter = raw.jitter_seconds ?? 30;
  if (!isInt(gap, 15, 3600)) return { error: 'min_gap_seconds: 15..3600' };
  if (!isInt(jitter, 0, 600)) return { error: 'jitter_seconds: 0..600' };
  let quiet = null;
  if (raw.quiet_hours !== undefined && raw.quiet_hours !== null) {
    if (
      !Array.isArray(raw.quiet_hours) ||
      raw.quiet_hours.length !== 2 ||
      !isInt(raw.quiet_hours[0], 0, 23) ||
      !isInt(raw.quiet_hours[1], 0, 23)
    )
      return { error: 'quiet_hours: [startHour, endHour] or null' };
    quiet = [raw.quiet_hours[0], raw.quiet_hours[1]];
  }
  return {
    rules: {
      v: 1,
      site,
      enabled: raw.enabled === true,
      autonomous: false, // never from a file: the dashboard confirms autonomy
      weekly_cap: weekly,
      daily_cap: daily,
      min_gap_seconds: gap,
      jitter_seconds: jitter,
      quiet_hours: quiet,
      allow: { kinds, handles, threads },
    },
  };
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
        file: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (err) {
    fail(2, `${err && err.message ? err.message : 'bad arguments'}\n${USAGE}`);
  }
  const { values: o, positionals } = parsed;
  const [cmd] = positionals;
  if (!cmd || !o.site) fail(2, USAGE);
  if (!SITE_KINDS[o.site]) fail(3, `unknown site: ${o.site}`);
  const dir = o.dir ?? path.join(os.homedir(), '.config', 'deus', 'browser');
  const rulesDir = path.join(dir, 'rules');
  const file = path.join(rulesDir, `${o.site}.json`);

  if (cmd === 'show') {
    const r = readJson(file, FILE_MAX);
    if (!r.ok) {
      if (r.reason === 'missing') {
        console.log(`no rules for ${o.site}: the site is disabled`);
        return;
      }
      fail(3, `rules for ${o.site} are unreadable (${r.reason})`);
    }
    console.log(JSON.stringify(r.raw, null, 2));
    return;
  }
  if (cmd === 'set') {
    if (!o.file) fail(2, USAGE);
    const input = readJson(o.file, FILE_MAX);
    if (!input.ok) fail(3, `cannot read ${o.file}: ${input.reason}`);
    const built = buildRules(input.raw, o.site);
    if (built.error) fail(3, built.error);
    fs.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      rulesDir,
      `${o.site}.json.tmp-${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.writeFileSync(tmp, JSON.stringify(built.rules, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    const had =
      input.raw &&
      (input.raw.autonomous === true ||
        input.raw.autonomy_confirmed_at ||
        input.raw.autonomy_scope_sha256);
    console.log(
      `wrote ${file}` +
        (had
          ? '\nautonomy was NOT enabled: this tool cannot grant it, by design.' +
            `\nIt is confirmed only by PUT /api/v1/browser/sites/${o.site}/rules` +
            '\nwith the site name typed back in an X-Confirm header.' +
            '\nNo dashboard control for it ships in this phase.'
          : ''),
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
