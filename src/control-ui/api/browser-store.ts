import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readRecordFile, registryDirOk } from './workflows.js';
import { withLock } from './artifacts.js';
import {
  getSite,
  JOB_KINDS,
  normaliseHandle,
  normaliseThreadId,
  siteOfKind,
  type JobKind,
} from '../../browser/sites.js';

// The browser agent's control plane: the operator's rules, the job queue and
// the counting that bounds both. Everything here is read back as untrusted
// input — the same host uid writes these files through the CLIs — so every
// read rebuilds a fresh literal and every failure is a closed reason.
//
// Phase E1 holds no credential and starts no browser on any production path;
// the adapter tests do launch one, against local fixtures only. `capCheck` is
// the gate the approve route and (in E2) the runner both call.

export const RULES_DIR = 'rules';
export const JOBS_DIR = 'jobs';
export const ATTENTION_DIR = 'attention';
export const JOB_ID_RE = /^bj-[0-9a-f]{12}$/;
export const HANDLE_RE = /^@?[A-Za-z0-9._]{1,30}$/;
export const THREAD_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const BODY_MAX = 2000;
export const FILE_MAX = 64 * 1024;
export const SCAN_MAX = 5000;
export const ALLOW_MAX = 500;
export const PROPOSAL_TTL_MS = 24 * 60 * 60_000;
export const TERMINAL_TTL_MS = 30 * 24 * 60 * 60_000;
export const EXPIRED_TTL_MS = 7 * 24 * 60 * 60_000;
/** Both walks — the counter and the pacing lookup — stop at the week boundary,
 *  but only after this margin, so ordinary mtime skew cannot truncate the
 *  window. */
// Sized for clock skew between a record's own timestamps and its file mtime,
// which orders and bounds the walk. A record written long *after* the action it
// describes stays inside the walk, because a newer mtime is never excluded. The
// undercount direction needs an mtime older than the record's own timestamp,
// which takes a deliberate `utimes` backdate at this uid — the same-uid case
// the plan already places out of scope.
export const WALK_MARGIN_MS = 48 * 60 * 60_000;

export type RulesReason =
  'unreadable' | 'too-large' | 'not-json' | 'bad-schema';
export type RefuseReason =
  | 'disabled'
  | 'quiet-hours'
  | 'daily-cap'
  | 'weekly-cap'
  | 'too-soon'
  | 'not-allowed'
  | 'rules-invalid'
  | 'needs-attention'
  | 'expired'
  | 'counts-unavailable';
export type JobStatus =
  | 'proposed'
  | 'approved'
  | 'running'
  | 'done'
  | 'failed'
  | 'maybe-sent'
  | 'blocked'
  | 'rejected'
  | 'expired';
const STATUSES: readonly string[] = [
  'proposed',
  'approved',
  'running',
  'done',
  'failed',
  'maybe-sent',
  'blocked',
  'rejected',
  'expired',
];
/** Statuses that consumed an action: an outcome nobody can disprove counts. */
const COUNTED: readonly JobStatus[] = ['done', 'running', 'maybe-sent'];
const TERMINAL: readonly JobStatus[] = [
  'done',
  'failed',
  'blocked',
  'rejected',
  'maybe-sent',
];

export interface Rules {
  v: 1;
  site: string;
  enabled: boolean;
  autonomous: boolean;
  weekly_cap: number;
  daily_cap: number;
  min_gap_seconds: number;
  jitter_seconds: number;
  quiet_hours: [number, number] | null;
  allow: { kinds: JobKind[]; handles: string[]; threads: string[] };
  autonomy_confirmed_at?: string;
  autonomy_scope_sha256?: string;
}
export interface JobRecord {
  v: 1;
  id: string;
  site: string;
  kind: JobKind;
  params: Record<string, string>;
  status: JobStatus;
  proposed_by: string;
  proposed_at: string;
  approved_by?: string;
  approved_at?: string;
  approved_rev?: number;
  params_sha256?: string;
  rules_mtime?: number;
  rules_sha256?: string;
  started_at?: string;
  finished_at?: string;
  result?: string;
  reason?: string;
  shot?: string;
  rev: number;
}
export type RulesResult =
  { ok: true; rules: Rules } | { ok: false; reason: RulesReason };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isIso = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const strList = (v: unknown, max: number): string[] | null => {
  if (!Array.isArray(v) || v.length > ALLOW_MAX) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || x.length === 0 || x.length > max) return null;
    out.push(x);
  }
  return out;
};

/** Canonical JSON (keys sorted at every level) so a hash is stable. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObj(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export const sha256 = (s: string): string =>
  crypto.createHash('sha256').update(s).digest('hex');

/**
 * The hash covers the whole validated record except the two confirmation
 * fields — deny by default. An enumerated subset would silently fail to cover
 * whatever field the next phase adds, and `enabled` alone is enough to matter:
 * pausing a site and flipping it back would otherwise resume full autonomy.
 */
export function scopeHash(rules: Rules): string {
  const rest: Record<string, unknown> = { ...rules };
  delete rest.autonomy_confirmed_at;
  delete rest.autonomy_scope_sha256;
  return sha256(canonical(rest));
}

/**
 * Builds a fresh literal. `autonomous` is honoured only when the record
 * carries a confirmation whose scope hash still matches what it confirmed —
 * otherwise it reads as false, the same fail-closed posture as an invalid
 * file. `site` must match the site the record was read for, so a confirmed
 * record cannot be transplanted into another site's path.
 */
export function validateRules(raw: unknown, site: string): RulesResult {
  if (!isObj(raw) || raw.v !== 1) return { ok: false, reason: 'bad-schema' };
  if (raw.site !== site) return { ok: false, reason: 'bad-schema' };
  if (typeof raw.enabled !== 'boolean' || typeof raw.autonomous !== 'boolean')
    return { ok: false, reason: 'bad-schema' };
  if (!isInt(raw.weekly_cap, 1, 500) || !isInt(raw.daily_cap, 1, 200))
    return { ok: false, reason: 'bad-schema' };
  if (raw.daily_cap > raw.weekly_cap)
    return { ok: false, reason: 'bad-schema' };
  if (
    !isInt(raw.min_gap_seconds, 15, 3600) ||
    !isInt(raw.jitter_seconds, 0, 600)
  )
    return { ok: false, reason: 'bad-schema' };
  let quiet: [number, number] | null = null;
  if (raw.quiet_hours !== null && raw.quiet_hours !== undefined) {
    if (!Array.isArray(raw.quiet_hours) || raw.quiet_hours.length !== 2)
      return { ok: false, reason: 'bad-schema' };
    const [a, b] = raw.quiet_hours as unknown[];
    if (!isInt(a, 0, 23) || !isInt(b, 0, 23))
      return { ok: false, reason: 'bad-schema' };
    quiet = [a, b];
  }
  if (!isObj(raw.allow)) return { ok: false, reason: 'bad-schema' };
  const kindsRaw = raw.allow.kinds;
  if (!Array.isArray(kindsRaw) || kindsRaw.length === 0)
    return { ok: false, reason: 'bad-schema' };
  const siteKinds = getSite(site)?.kinds ?? [];
  const kinds: JobKind[] = [];
  for (const k of kindsRaw) {
    if (typeof k !== 'string') return { ok: false, reason: 'bad-schema' };
    const full = (k.includes('.') ? k : `${site}.${k}`) as JobKind;
    if (!siteKinds.includes(full)) return { ok: false, reason: 'bad-schema' };
    kinds.push(full);
  }
  const handles = strList(raw.allow.handles ?? [], 64);
  const threads = strList(raw.allow.threads ?? [], 64);
  if (handles === null || threads === null)
    return { ok: false, reason: 'bad-schema' };
  const rules: Rules = {
    v: 1,
    site,
    enabled: raw.enabled,
    autonomous: raw.autonomous,
    weekly_cap: raw.weekly_cap,
    daily_cap: raw.daily_cap,
    min_gap_seconds: raw.min_gap_seconds,
    jitter_seconds: raw.jitter_seconds,
    quiet_hours: quiet,
    allow: { kinds, handles, threads },
  };
  if (rules.autonomous) {
    // An allowed kind with nothing to aim it at is not permission for anything.
    for (const k of kinds) {
      const list = k === 'instagram.follow' ? handles : threads;
      if (list.length === 0) return { ok: false, reason: 'bad-schema' };
    }
    const confirmedAt = raw.autonomy_confirmed_at;
    const confirmedScope = raw.autonomy_scope_sha256;
    const confirmed =
      isIso(confirmedAt) &&
      typeof confirmedScope === 'string' &&
      confirmedScope === scopeHash(rules);
    if (confirmed) {
      rules.autonomy_confirmed_at = confirmedAt;
      rules.autonomy_scope_sha256 = confirmedScope;
    } else {
      rules.autonomous = false;
    }
  }
  return { ok: true, rules };
}

export const defaultRules = (site: string): Rules => ({
  v: 1,
  site,
  enabled: false,
  autonomous: false,
  weekly_cap: 25,
  daily_cap: 4,
  min_gap_seconds: 45,
  jitter_seconds: 30,
  quiet_hours: null,
  allow: { kinds: getSite(site)?.kinds ?? [], handles: [], threads: [] },
});

export interface RulesView {
  rules: Rules;
  invalid?: true;
  reason?: RulesReason;
  mtimeMs?: number;
  sha256?: string;
}

/** A missing file is "not configured", not an error; an invalid one disables. */
export function readRules(dir: string, site: string): RulesView {
  const file = path.join(dir, RULES_DIR, `${site}.json`);
  let mtimeMs: number | undefined;
  try {
    mtimeMs = fs.lstatSync(file).mtimeMs;
  } catch {
    return { rules: defaultRules(site) };
  }
  const r = readRecordFile(file, FILE_MAX);
  if (!r.ok)
    return {
      rules: defaultRules(site),
      invalid: true,
      reason: r.reason,
      mtimeMs,
    };
  const v = validateRules(r.raw, site);
  if (!v.ok)
    return {
      rules: defaultRules(site),
      invalid: true,
      reason: v.reason,
      mtimeMs,
    };
  return { rules: v.rules, mtimeMs, sha256: sha256(canonical(v.rules)) };
}

function writeAtomic(dir: string, name: string, body: object): void {
  const tmp = path.join(
    dir,
    `${name}.tmp-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(tmp, path.join(dir, name));
}

export type WriteRulesResult =
  | { ok: true; rules: Rules }
  | { ok: false; reason: 'bad-schema' | 'unavailable' | 'busy' };

/**
 * `confirmAutonomy` is the route's privilege, never the CLI's: only a request
 * that carried the operator's typed site name may stamp the confirmation, and
 * the stamp is bound to the scope it confirmed.
 */
export function writeRules(
  dir: string,
  site: string,
  raw: unknown,
  opts: { confirmAutonomy?: boolean; now?: () => number } = {},
): WriteRulesResult {
  const now = opts.now ?? Date.now;
  const rulesDir = path.join(dir, RULES_DIR);
  try {
    fs.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!isObj(raw)) return { ok: false, reason: 'bad-schema' };
  // Both confirmation fields are dropped from any input: they are earned here
  // or not at all, so a stale confirmation can never be carried forward.
  const input: Record<string, unknown> = { ...raw, v: 1, site };
  delete input.autonomy_confirmed_at;
  delete input.autonomy_scope_sha256;
  const wantsAutonomy = input.autonomous === true;
  const check = validateRules({ ...input, autonomous: false }, site);
  if (!check.ok) return { ok: false, reason: 'bad-schema' };
  const next: Rules = {
    ...check.rules,
    autonomous: wantsAutonomy && Boolean(opts.confirmAutonomy),
  };
  if (next.autonomous) {
    const verify = validateRules({ ...next, autonomous: true }, site);
    if (!verify.ok) return { ok: false, reason: 'bad-schema' };
    next.autonomy_confirmed_at = new Date(now()).toISOString();
    next.autonomy_scope_sha256 = scopeHash(next);
  }
  try {
    return withLock(
      rulesDir,
      () => {
        writeAtomic(rulesDir, `${site}.json`, next);
        return { ok: true as const, rules: next };
      },
      now,
      site,
    );
  } catch {
    return { ok: false, reason: 'busy' };
  }
}

// --- jobs --------------------------------------------------------------------

export type JobResult =
  { ok: true; job: JobRecord } | { ok: false; reason: string };

export function validateJob(
  raw: unknown,
  expectId: string | undefined,
  now: () => number = Date.now,
): JobResult {
  if (!isObj(raw) || raw.v !== 1) return { ok: false, reason: 'bad-schema' };
  const { id, kind, status, proposed_by } = raw;
  if (typeof id !== 'string' || !JOB_ID_RE.test(id))
    return { ok: false, reason: 'bad-id' };
  if (expectId !== undefined && id !== expectId)
    return { ok: false, reason: 'bad-id' };
  if (
    typeof kind !== 'string' ||
    !(JOB_KINDS as readonly string[]).includes(kind)
  )
    return { ok: false, reason: 'bad-kind' };
  const site = siteOfKind(kind as JobKind);
  if (raw.site !== site) return { ok: false, reason: 'bad-schema' };
  if (typeof status !== 'string' || !STATUSES.includes(status))
    return { ok: false, reason: 'bad-schema' };
  if (typeof proposed_by !== 'string' || proposed_by.length > 64)
    return { ok: false, reason: 'bad-schema' };
  if (!isObj(raw.params)) return { ok: false, reason: 'bad-schema' };
  const params: Record<string, string> = {};
  if (kind === 'instagram.follow') {
    const h = raw.params.handle;
    if (typeof h !== 'string' || !HANDLE_RE.test(h))
      return { ok: false, reason: 'bad-params' };
    params.handle = h;
  } else if (kind === 'alibaba.reply') {
    const t = raw.params.thread_id;
    const b = raw.params.body;
    if (typeof t !== 'string' || !THREAD_RE.test(t))
      return { ok: false, reason: 'bad-params' };
    if (typeof b !== 'string' || b.length === 0 || b.length > BODY_MAX)
      return { ok: false, reason: 'bad-params' };
    params.thread_id = t;
    params.body = b;
  }
  if (!isIso(raw.proposed_at)) return { ok: false, reason: 'bad-schema' };
  if (!isInt(raw.rev, 1, Number.MAX_SAFE_INTEGER))
    return { ok: false, reason: 'bad-schema' };
  // A timestamp in the future would postpone expiry, so it is clamped rather
  // than trusted: the CLI path writes this field itself.
  const proposedAt = Math.min(Date.parse(raw.proposed_at), now());
  const job: JobRecord = {
    v: 1,
    id,
    site,
    kind: kind as JobKind,
    params,
    status: status as JobStatus,
    proposed_by,
    proposed_at: new Date(proposedAt).toISOString(),
    rev: raw.rev,
  };
  for (const k of [
    'approved_by',
    'approved_at',
    'started_at',
    'finished_at',
    'result',
    'reason',
    'shot',
    'rules_sha256',
    'params_sha256',
  ] as const) {
    const v = raw[k];
    if (typeof v === 'string' && v.length <= 2100) job[k] = v;
  }
  if (isInt(raw.approved_rev, 1, Number.MAX_SAFE_INTEGER))
    job.approved_rev = raw.approved_rev;
  if (typeof raw.rules_mtime === 'number' && Number.isFinite(raw.rules_mtime))
    job.rules_mtime = raw.rules_mtime;
  // Expiry is a read-time projection: nothing is rewritten, so a listing never
  // mutates the queue it is reading.
  if (job.status === 'proposed' && now() - proposedAt > PROPOSAL_TTL_MS)
    job.status = 'expired';
  return { ok: true, job };
}

export function jobsDir(dir: string): string {
  return path.join(dir, JOBS_DIR);
}

export function readJob(
  dir: string,
  id: string,
  now: () => number = Date.now,
): JobResult {
  if (!JOB_ID_RE.test(id)) return { ok: false, reason: 'bad-id' };
  const r = readRecordFile(path.join(jobsDir(dir), `${id}.json`), FILE_MAX);
  if (!r.ok) return { ok: false, reason: r.reason };
  return validateJob(r.raw, id, now);
}

export function writeJob(dir: string, job: JobRecord): { ok: boolean } {
  const d = jobsDir(dir);
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    writeAtomic(d, `${job.id}.json`, job);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export interface JobView {
  id: string;
  site: string;
  kind: JobKind;
  status: JobStatus;
  proposed_by: string;
  proposed_at: string;
  approved_by?: string;
  approved_at?: string;
  finished_at?: string;
  reason?: string;
  params?: Record<string, string>;
  result?: string;
}

/** One projection for the REST list and the SSE frame, so read-only cannot
 *  withhold on one path and leak on the other. */
export function projectJob(
  job: JobRecord,
  opts: { readOnly: boolean },
): JobView {
  const v: JobView = {
    id: job.id,
    site: job.site,
    kind: job.kind,
    status: job.status,
    proposed_by: job.proposed_by,
    proposed_at: job.proposed_at,
  };
  for (const k of [
    'approved_by',
    'approved_at',
    'finished_at',
    'reason',
  ] as const) {
    if (job[k] !== undefined) v[k] = job[k];
  }
  if (opts.readOnly) return v;
  v.params = { ...job.params };
  if (job.result !== undefined) v.result = job.result;
  return v;
}

interface Entry {
  id: string;
  file: string;
  mtimeMs: number;
}
const JOB_FILE_RE = /^bj-[0-9a-f]{12}\.json$/;
/** `writeAtomic`'s own in-flight file; the only non-record this dir may hold. */
const TMP_RE = /\.tmp-[0-9a-f]{8}$/;
function enumerateJobs(dir: string): { entries: Entry[]; exact: boolean } {
  const d = jobsDir(dir);
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return { entries: [], exact: true }; // no jobs yet is an exact zero
  }
  const entries: Entry[] = [];
  let exact = true;
  for (const n of names) {
    if (!n.isFile() || !JOB_FILE_RE.test(n.name)) {
      // Anything in here that is not a job record is either this module's own
      // in-flight temporary or something we cannot account for. A record we
      // cannot see *by name* is exactly as invisible to the caps as one we
      // cannot read *by content*, which already degrades exactness below — so
      // it degrades the count too rather than being dropped in silence. The
      // `isFile` arm is inside the same branch on purpose: a directory or a
      // symlink wearing a well-formed job name must not be skipped for free.
      if (!TMP_RE.test(n.name)) exact = false;
      continue;
    }
    const file = path.join(d, n.name);
    try {
      entries.push({
        id: n.name.slice(0, -5),
        file,
        mtimeMs: fs.statSync(file).mtimeMs,
      });
    } catch {
      exact = false; // vanished between readdir and stat: we cannot say
    }
  }
  // Over the cap the count is no longer trustworthy, but the entries are
  // handed back anyway: the sweeper consumes this same helper, and returning
  // nothing meant a directory that crossed the cap could never be pruned back
  // under it — every cap check refusing `counts-unavailable` forever while the
  // one thing that could clear the wedge saw an empty directory. The walk
  // below already built and sorted these, so passing them on costs nothing.
  const exactOrCapped = exact && entries.length <= SCAN_MAX;
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { entries, exact: exactOrCapped };
}

export const startOfDay = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const startOfWeek = (now: number): number => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // Monday, matching the operator's sheet, in the process's own timezone.
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
};

export interface Counts {
  counts: { day: number; week: number };
  exact: boolean;
}

/**
 * The single source of the numbers both the gate and the tab use. Counting
 * from the UI's bounded listing would fail open — a truncated list reads as
 * headroom, and terminal records are exactly what falls out of it first — so
 * this walks the directory itself and reports `exact: false` on any doubt.
 */
export function countActions(dir: string, site: string, now: number): Counts {
  const { entries, exact: enumExact } = enumerateJobs(dir);
  let exact = enumExact;
  const dayStart = startOfDay(now);
  const weekStart = startOfWeek(now);
  const stopAt = weekStart - WALK_MARGIN_MS;
  let day = 0;
  let week = 0;
  for (const e of entries) {
    if (e.mtimeMs < stopAt) break; // ordered walk: everything older is outside
    const r = readRecordFile(e.file, FILE_MAX);
    if (!r.ok) {
      exact = false; // a record we cannot read may be an action we cannot see
      continue;
    }
    const v = validateJob(r.raw, e.id, () => now);
    if (!v.ok) {
      exact = false;
      continue;
    }
    const job = v.job;
    if (job.site !== site || !COUNTED.includes(job.status)) continue;
    const when = Date.parse(
      job.finished_at ?? job.started_at ?? job.proposed_at,
    );
    if (!Number.isFinite(when)) {
      exact = false;
      continue;
    }
    if (when >= weekStart) week++;
    if (when >= dayStart) day++;
  }
  return { counts: { day, week }, exact };
}

/**
 * The newest action for a site, for pacing. This skips a record it cannot read
 * rather than reporting its own exactness, which is safe only because of an
 * ordering `capCheck` guarantees: it refuses on `!counts.exact` before it ever
 * reaches the gap test, and any record corrupt enough to shorten the gap is
 * newer than `countActions`'s walk boundary, so it makes that count inexact
 * first. E2 must preserve that order or give this function its own exactness —
 * `browser-store.test.ts` asserts the ordering so a reshuffle fails loudly.
 *
 * It also answers `null` for "no action inside roughly the last 48 hours"
 * rather than searching further back, which is verdict-equivalent only because
 * `capCheck` is the single consumer and the widest gap it can test is 70
 * minutes. An E2 caller that wanted to *display* a last-action time would need
 * its own unbounded lookup; this one would silently show nothing.
 */
export function lastActionAt(
  dir: string,
  site: string,
  now: number,
): number | null {
  const { entries } = enumerateJobs(dir);
  // Same boundary as `countActions`. Without it this walk became unbounded the
  // moment the over-cap guard started returning entries, and a site with no
  // recent action would read every file in the directory to answer "none". An
  // action older than the boundary cannot fail a gap measured in seconds, so
  // stopping there and answering `null` is the same answer, reached sooner.
  const stopAt = startOfWeek(now) - WALK_MARGIN_MS;
  for (const e of entries) {
    if (e.mtimeMs < stopAt) break;
    const r = readRecordFile(e.file, FILE_MAX);
    if (!r.ok) continue;
    const v = validateJob(r.raw, e.id, () => now);
    if (!v.ok || v.job.site !== site || !COUNTED.includes(v.job.status))
      continue;
    const when = Date.parse(v.job.finished_at ?? v.job.started_at ?? '');
    if (Number.isFinite(when)) return when;
  }
  return null;
}

export const inQuietHours = (
  now: number,
  quiet: [number, number] | null,
): boolean => {
  if (!quiet) return false;
  const [from, to] = quiet;
  const h = new Date(now).getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
};

export function allowsTarget(rules: Rules, job: JobRecord): boolean {
  if (!rules.allow.kinds.includes(job.kind)) return false;
  if (job.kind === 'instagram.follow') {
    const want = normaliseHandle(job.params.handle);
    return (
      want !== null &&
      rules.allow.handles.some((h) => normaliseHandle(h) === want)
    );
  }
  const want = normaliseThreadId(job.params.thread_id);
  if (job.kind === 'alibaba.list_threads') return true;
  return (
    want !== null &&
    rules.allow.threads.some((t) => normaliseThreadId(t) === want)
  );
}

export type CapResult = { ok: true } | { ok: false; reason: RefuseReason };

/** Caps and the allow-list, in one place both callers use. */
export function capCheck(
  view: RulesView,
  job: JobRecord,
  counts: Counts,
  now: number,
  opts: {
    /** A thunk is preferred: every refusal above the gap test then costs no
     *  directory walk at all, which matters most in the over-cap case where
     *  `counts-unavailable` refuses and the walk would be pure waste. */
    lastAt?: number | null | (() => number | null);
    attention?: boolean;
    random?: () => number;
  } = {},
): CapResult {
  if (view.invalid) return { ok: false, reason: 'rules-invalid' };
  const rules = view.rules;
  if (!rules.enabled) return { ok: false, reason: 'disabled' };
  if (opts.attention) return { ok: false, reason: 'needs-attention' };
  if (job.status === 'expired') return { ok: false, reason: 'expired' };
  if (!allowsTarget(rules, job)) return { ok: false, reason: 'not-allowed' };
  if (inQuietHours(now, rules.quiet_hours))
    return { ok: false, reason: 'quiet-hours' };
  if (!counts.exact) return { ok: false, reason: 'counts-unavailable' };
  if (counts.counts.week >= rules.weekly_cap)
    return { ok: false, reason: 'weekly-cap' };
  if (counts.counts.day >= rules.daily_cap)
    return { ok: false, reason: 'daily-cap' };
  const last =
    (typeof opts.lastAt === 'function' ? opts.lastAt() : opts.lastAt) ?? null;
  if (last !== null) {
    const random = opts.random ?? Math.random;
    const gap =
      rules.min_gap_seconds * 1000 +
      Math.floor(random() * rules.jitter_seconds * 1000);
    if (now - last < gap) return { ok: false, reason: 'too-soon' };
  }
  return { ok: true };
}

// --- attention ---------------------------------------------------------------

const attentionFile = (dir: string, site: string): string =>
  path.join(dir, ATTENTION_DIR, `${site}`);

export function getAttention(dir: string, site: string): boolean {
  if (!getSite(site)) return false;
  try {
    return fs.lstatSync(attentionFile(dir, site)).isFile();
  } catch {
    return false;
  }
}
export function setAttention(
  dir: string,
  site: string,
  reason: string,
  now: number,
): void {
  if (!getSite(site)) return;
  const d = path.join(dir, ATTENTION_DIR);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    attentionFile(dir, site),
    `${new Date(now).toISOString()} ${reason}\n`,
    {
      mode: 0o600,
    },
  );
}
export function clearAttention(dir: string, site: string): void {
  if (!getSite(site)) return;
  try {
    fs.unlinkSync(attentionFile(dir, site));
  } catch {
    /* already clear */
  }
}

// --- listing and sweeping ----------------------------------------------------

export interface ListResult {
  jobs: JobView[];
  scanned: number;
  truncated: number;
  reason?: 'too-many';
}

export function listJobs(
  dir: string,
  opts: {
    readOnly: boolean;
    now?: () => number;
    limit?: number;
    candidatesMax?: number;
  },
): ListResult | { error: 'registry unavailable' } {
  if (!registryDirOk(dir)) return { error: 'registry unavailable' };
  const now = opts.now ?? Date.now;
  const { entries } = enumerateJobs(dir);
  const scanned = entries.length;
  if (scanned === 0 && !registryDirOk(jobsDir(dir)))
    return { jobs: [], scanned: 0, truncated: 0 };
  const limit = opts.limit ?? 200;
  const candidates = entries.slice(0, opts.candidatesMax ?? 600);
  const jobs: JobView[] = [];
  for (const e of candidates) {
    const r = readRecordFile(e.file, FILE_MAX);
    if (!r.ok) continue; // a corrupt record must not hide the queue
    const v = validateJob(r.raw, e.id, now);
    if (!v.ok) continue;
    jobs.push(projectJob(v.job, { readOnly: opts.readOnly }));
  }
  return {
    jobs: jobs.slice(0, limit),
    scanned,
    truncated: Math.max(0, scanned - limit),
  };
}

/** Prunes what the queue no longer needs: expired proposals after a week and
 *  terminal records after 30 days, so the directory cannot grow until the scan
 *  cap makes every cap check refuse. Never runs on a read-only path. */
export function sweepJobs(dir: string, now: number): { removed: number } {
  const { entries } = enumerateJobs(dir);
  let removed = 0;
  for (const e of entries) {
    const r = readRecordFile(e.file, FILE_MAX);
    if (!r.ok) continue;
    const v = validateJob(r.raw, e.id, () => now);
    if (!v.ok) continue;
    const job = v.job;
    const when = Date.parse(job.finished_at ?? job.proposed_at);
    if (!Number.isFinite(when)) continue;
    const age = now - when;
    const stale =
      (job.status === 'expired' && age > EXPIRED_TTL_MS) ||
      (TERMINAL.includes(job.status) && age > TERMINAL_TTL_MS);
    if (!stale) continue;
    try {
      fs.unlinkSync(e.file);
      removed++;
    } catch {
      /* raced away */
    }
  }
  return { removed };
}

export function newJobId(): string {
  return `bj-${crypto.randomBytes(6).toString('hex')}`;
}
export const paramsHash = (params: Record<string, string>): string =>
  sha256(canonical(params));
