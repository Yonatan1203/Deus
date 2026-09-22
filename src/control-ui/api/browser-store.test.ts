import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  allowsTarget,
  capCheck,
  clearAttention,
  countActions,
  getAttention,
  inQuietHours,
  lastActionAt,
  listJobs,
  newJobId,
  projectJob,
  readRules,
  scopeHash,
  setAttention,
  startOfWeek,
  sweepJobs,
  validateJob,
  validateRules,
  writeJob,
  writeRules,
  type JobRecord,
  type JobStatus,
  type Rules,
} from './browser-store.js';
import { normaliseHandle, urlFor } from '../../browser/sites.js';
import { IS_WINDOWS } from '../../platform.js';

const T0 = Date.parse('2026-09-23T12:00:00.000Z'); // a Wednesday
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const baseRules = (over: Record<string, unknown> = {}) => ({
  v: 1,
  site: 'instagram',
  enabled: true,
  autonomous: false,
  weekly_cap: 25,
  daily_cap: 4,
  min_gap_seconds: 45,
  jitter_seconds: 30,
  quiet_hours: null,
  allow: {
    kinds: ['instagram.follow'],
    handles: ['@Ours', 'second.brand'],
    threads: [],
  },
  ...over,
});
const okRules = (over: Record<string, unknown> = {}): Rules => {
  const v = validateRules(baseRules(over), 'instagram');
  if (!v.ok) throw new Error(`fixture invalid: ${v.reason}`);
  return v.rules;
};
let seq = 0;
const job = (over: Partial<JobRecord> = {}): JobRecord => ({
  v: 1,
  id: `bj-${(seq++).toString(16).padStart(12, '0')}`,
  site: 'instagram',
  kind: 'instagram.follow',
  params: { handle: '@ours' },
  status: 'proposed',
  proposed_by: 'cli',
  proposed_at: new Date(T0 - 60_000).toISOString(),
  rev: 1,
  ...over,
});
const plant = (j: JobRecord, mtime = T0) => {
  writeJob(dir, j);
  const f = path.join(dir, 'jobs', `${j.id}.json`);
  const t = new Date(mtime);
  fs.utimesSync(f, t, t);
  return f;
};
const counted = (
  status: JobStatus,
  finishedMs: number,
  over: Partial<JobRecord> = {},
) =>
  plant(
    job({ status, finished_at: new Date(finishedMs).toISOString(), ...over }),
    finishedMs,
  );

// The two performance invariants behind `lastActionAt`. Neither had a test
// until now, and the first of them regressed once already: unbounding the
// enumeration so the sweeper could prune above the scan cap also unbounded this
// walk, which a code review caught rather than a test. Both assertions are
// cheap, so the guard is cheap.
describe('lastActionAt is bounded and only paid for when it is used', () => {
  it('stops at the week boundary instead of reading the whole directory', () => {
    // One genuine action, older than the boundary, behind a wall of records
    // that are not actions. Answering "none" must not cost a full walk.
    const older = startOfWeek(T0) - 31 * 24 * 60 * 60_000;
    counted('done', older);
    for (let i = 0; i < 40; i++) plant(job(), older + i * 1000);
    const opens = vi.spyOn(fs, 'openSync');
    try {
      expect(lastActionAt(dir, 'instagram', T0)).toBeNull();
      expect(opens).not.toHaveBeenCalled();
    } finally {
      opens.mockRestore();
    }
    // The bound cannot hide an action the gap test would have refused: the
    // schema caps `min_gap_seconds` at 3600 and `jitter_seconds` at 600, so the
    // widest window the gap can look back over is 70 minutes, while the
    // boundary sits at least 48 hours back even when `now` is the week's first
    // instant. A recent action is therefore always still seen.
    counted('done', T0 - 30 * 60_000, { id: 'bj-aaaaaaaaaaaa' });
    expect(lastActionAt(dir, 'instagram', T0)).toBe(T0 - 30 * 60_000);
  });

  it('is never invoked when a refusal above the gap test already decided', () => {
    const lastAt = vi.fn(() => T0 - 1000);
    // An inexact count refuses before pacing is consulted, so the walk this
    // thunk would perform must not happen at all.
    expect(
      capCheck(
        { rules: okRules() },
        job(),
        { counts: { day: 0, week: 0 }, exact: false },
        T0,
        { lastAt },
      ),
    ).toEqual({ ok: false, reason: 'counts-unavailable' });
    expect(lastAt).not.toHaveBeenCalled();
    // ...and it IS consulted once the gate reaches the gap test.
    expect(
      capCheck(
        { rules: okRules() },
        job(),
        { counts: { day: 0, week: 0 }, exact: true },
        T0,
        { lastAt, random: () => 0 },
      ),
    ).toEqual({ ok: false, reason: 'too-soon' });
    expect(lastAt).toHaveBeenCalledTimes(1);
  });
});

describe('validateRules', () => {
  it('rejects out-of-range caps, unknown kinds and oversized lists', () => {
    expect(validateRules(baseRules({ daily_cap: 0 }), 'instagram')).toEqual({
      ok: false,
      reason: 'bad-schema',
    });
    expect(validateRules(baseRules({ daily_cap: 26 }), 'instagram')).toEqual({
      ok: false,
      reason: 'bad-schema',
    });
    expect(validateRules(baseRules({ weekly_cap: 501 }), 'instagram')).toEqual({
      ok: false,
      reason: 'bad-schema',
    });
    expect(
      validateRules(
        baseRules({
          allow: { kinds: ['alibaba.reply'], handles: [], threads: [] },
        }),
        'instagram',
      ),
    ).toEqual({ ok: false, reason: 'bad-schema' });
    expect(
      validateRules(
        baseRules({
          allow: {
            kinds: ['follow'],
            handles: Array.from({ length: 600 }, (_, i) => `h${i}`),
            threads: [],
          },
        }),
        'instagram',
      ),
    ).toEqual({ ok: false, reason: 'bad-schema' });
    expect(validateRules(baseRules({ quiet_hours: 22 }), 'instagram')).toEqual({
      ok: false,
      reason: 'bad-schema',
    });
    expect(
      validateRules(baseRules({ quiet_hours: [22, 24] }), 'instagram'),
    ).toEqual({ ok: false, reason: 'bad-schema' });
    // A record cannot be transplanted into another site's path.
    expect(validateRules(baseRules(), 'alibaba')).toEqual({
      ok: false,
      reason: 'bad-schema',
    });
    const ok = validateRules(
      baseRules({ allow: { kinds: ['follow'], handles: ['@a'], threads: [] } }),
      'instagram',
    );
    expect(ok.ok && ok.rules.allow.kinds).toEqual(['instagram.follow']);
  });

  it('honours autonomy only with a confirmation bound to the scope it confirmed', () => {
    // No confirmation at all: a hand-written file cannot grant autonomy.
    const bare = validateRules(baseRules({ autonomous: true }), 'instagram');
    expect(bare.ok && bare.rules.autonomous).toBe(false);
    // Confirmed correctly.
    const confirmed = okRules({ autonomous: false });
    const scope = { ...confirmed, autonomous: true };
    const hash = scopeHash(scope as Rules);
    const good = validateRules(
      {
        ...scope,
        autonomy_confirmed_at: new Date(T0).toISOString(),
        autonomy_scope_sha256: hash,
      },
      'instagram',
    );
    expect(good.ok && good.rules.autonomous).toBe(true);
    // The discriminating case: scope edited after confirmation, stamp kept.
    for (const edit of [
      { weekly_cap: 500, daily_cap: 200 },
      {
        allow: {
          kinds: ['instagram.follow'],
          handles: ['@someone-else'],
          threads: [],
        },
      },
      { enabled: false },
      { min_gap_seconds: 15 },
    ]) {
      const tampered = validateRules(
        {
          ...scope,
          ...edit,
          autonomy_confirmed_at: new Date(T0).toISOString(),
          autonomy_scope_sha256: hash,
        },
        'instagram',
      );
      expect(
        tampered.ok && tampered.rules.autonomous,
        JSON.stringify(edit),
      ).toBe(false);
    }
    // An allowed kind with nothing to aim it at is not permission.
    const empty = {
      ...scope,
      allow: { kinds: ['instagram.follow'], handles: [], threads: [] },
    };
    expect(
      validateRules(
        {
          ...empty,
          autonomy_confirmed_at: new Date(T0).toISOString(),
          autonomy_scope_sha256: scopeHash(empty as Rules),
        },
        'instagram',
      ),
    ).toEqual({ ok: false, reason: 'bad-schema' });
  });

  it('writeRules stamps autonomy only when the route confirms it, and drops any stamp it is handed', () => {
    const forged = {
      ...baseRules({ autonomous: true }),
      autonomy_confirmed_at: new Date(T0).toISOString(),
      autonomy_scope_sha256: 'deadbeef',
    };
    const w = writeRules(dir, 'instagram', forged, { now: () => T0 });
    expect(w.ok && w.rules.autonomous).toBe(false);
    expect(readRules(dir, 'instagram').rules.autonomous).toBe(false);
    const c = writeRules(dir, 'instagram', baseRules({ autonomous: true }), {
      confirmAutonomy: true,
      now: () => T0,
    });
    expect(c.ok && c.rules.autonomous).toBe(true);
    const back = readRules(dir, 'instagram');
    expect(back.rules.autonomous).toBe(true);
    expect(back.rules.autonomy_scope_sha256).toBeTruthy();
    if (!IS_WINDOWS)
      expect(
        fs.statSync(path.join(dir, 'rules', 'instagram.json')).mode & 0o777,
      ).toBe(0o600);
    // An out-of-band cap edit keeps the stamp but loses the grant.
    const file = path.join(dir, 'rules', 'instagram.json');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(file, JSON.stringify({ ...onDisk, weekly_cap: 500 }));
    expect(readRules(dir, 'instagram').rules.autonomous).toBe(false);
  });

  it('a missing file disables the site and an invalid one does not default to permissive', () => {
    expect(readRules(dir, 'instagram')).toMatchObject({
      rules: { enabled: false, autonomous: false },
    });
    fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rules', 'instagram.json'),
      '{"v":1,"site":"instagram"}',
    );
    const v = readRules(dir, 'instagram');
    expect(v).toMatchObject({ invalid: true, reason: 'bad-schema' });
    expect(v.rules.enabled).toBe(false);
  });
});

describe('validateJob', () => {
  it('rejects bad kinds and params, binds the id to the filename and clamps proposed_at', () => {
    expect(
      validateJob({ ...job(), kind: 'instagram.dm' }, undefined, () => T0),
    ).toMatchObject({ ok: false, reason: 'bad-kind' });
    expect(
      validateJob(job({ params: { handle: 'a/b' } }), undefined, () => T0),
    ).toMatchObject({ ok: false, reason: 'bad-params' });
    expect(
      validateJob(
        job({
          kind: 'alibaba.reply',
          site: 'alibaba',
          params: { thread_id: 'T1', body: 'x'.repeat(3000) },
        }),
        undefined,
        () => T0,
      ),
    ).toMatchObject({ ok: false, reason: 'bad-params' });
    const j = job();
    expect(validateJob(j, 'bj-ffffffffffff', () => T0)).toMatchObject({
      ok: false,
      reason: 'bad-id',
    });
    // A future timestamp cannot postpone expiry.
    const future = validateJob(
      job({ proposed_at: new Date(T0 + 3_600_000).toISOString() }),
      undefined,
      () => T0,
    );
    expect(future.ok && Date.parse(future.job.proposed_at)).toBe(T0);
  });

  it('expires a stale proposal at read time without rewriting it', () => {
    const j = job({ proposed_at: new Date(T0 - 25 * 3_600_000).toISOString() });
    const file = plant(j, T0 - 25 * 3_600_000);
    const before = fs.statSync(file).mtimeMs;
    const list = listJobs(dir, { readOnly: false, now: () => T0 });
    expect('jobs' in list && list.jobs[0].status).toBe('expired');
    expect(fs.statSync(file).mtimeMs).toBe(before);
    const v = validateJob(j, j.id, () => T0);
    expect(v.ok && v.job.status).toBe('expired');
    expect(
      capCheck(
        { rules: okRules() },
        v.ok ? v.job : j,
        { counts: { day: 0, week: 0 }, exact: true },
        T0,
      ),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('projectJob withholds params and result in read-only', () => {
    const j = job({
      status: 'done',
      result: 'followed',
      finished_at: new Date(T0).toISOString(),
    });
    expect(projectJob(j, { readOnly: false })).toMatchObject({
      params: { handle: '@ours' },
      result: 'followed',
    });
    const ro = projectJob(j, { readOnly: true });
    expect(ro).not.toHaveProperty('params');
    expect(ro).not.toHaveProperty('result');
    expect(ro.status).toBe('done');
  });
});

describe('countActions', () => {
  it("counts the statuses that consumed an action, by the record's own timestamps", () => {
    counted('done', T0 - 3_600_000);
    counted('maybe-sent', T0 - 7_200_000);
    counted('running', T0 - 600_000);
    counted('failed', T0 - 600_000);
    counted('blocked', T0 - 600_000);
    counted('done', startOfWeek(T0) + 3_600_000); // earlier this week, not today
    counted('done', startOfWeek(T0) - 3_600_000); // last week
    const r = countActions(dir, 'instagram', T0);
    expect(r.exact).toBe(true);
    expect(r.counts.day).toBe(3);
    expect(r.counts.week).toBe(4);
    // Another site's actions never count toward this one.
    plant(
      job({
        site: 'alibaba',
        kind: 'alibaba.list_threads',
        params: {},
        status: 'done',
        finished_at: new Date(T0).toISOString(),
      }),
      T0,
    );
    expect(countActions(dir, 'instagram', T0).counts.day).toBe(3);
  });

  it('reports exact: false rather than a short count when a record cannot be read', () => {
    counted('done', T0 - 3_600_000);
    const bad = path.join(dir, 'jobs', 'bj-ffffffffffff.json');
    fs.writeFileSync(bad, '{"v":1,"id":"bj-ffffffffffff",');
    const t = new Date(T0 - 1_800_000);
    fs.utimesSync(bad, t, t);
    const r = countActions(dir, 'instagram', T0);
    expect(r.exact).toBe(false);
    expect(r.counts.day).toBe(1); // the count is short, which is exactly why it is not exact
    expect(capCheck({ rules: okRules() }, job(), r, T0)).toEqual({
      ok: false,
      reason: 'counts-unavailable',
    });
  });

  it('lastActionAt finds the most recent consumed action', () => {
    counted('done', T0 - 3_600_000);
    counted('done', T0 - 600_000);
    expect(lastActionAt(dir, 'instagram', T0)).toBe(T0 - 600_000);
  });
});

describe('capCheck', () => {
  const exact = (day: number, week: number) => ({
    counts: { day, week },
    exact: true,
  });
  it('refuses on each closed reason and passes just past the gap', () => {
    const rules = okRules();
    const j = job();
    expect(
      capCheck({ rules: okRules({ enabled: false }) }, j, exact(0, 0), T0),
    ).toEqual({ ok: false, reason: 'disabled' });
    expect(
      capCheck(
        { rules, invalid: true, reason: 'bad-schema' },
        j,
        exact(0, 0),
        T0,
      ),
    ).toEqual({ ok: false, reason: 'rules-invalid' });
    expect(
      capCheck({ rules }, j, exact(0, 0), T0, { attention: true }),
    ).toEqual({ ok: false, reason: 'needs-attention' });
    expect(
      capCheck(
        { rules },
        job({ params: { handle: '@stranger' } }),
        exact(0, 0),
        T0,
      ),
    ).toEqual({ ok: false, reason: 'not-allowed' });
    expect(capCheck({ rules }, j, exact(4, 10), T0)).toEqual({
      ok: false,
      reason: 'daily-cap',
    });
    // The weekly cap binds even when today is quiet — the Monday-boundary case.
    expect(capCheck({ rules }, j, exact(0, 25), T0)).toEqual({
      ok: false,
      reason: 'weekly-cap',
    });
    expect(
      capCheck({ rules }, j, { counts: { day: 0, week: 0 }, exact: false }, T0),
    ).toEqual({ ok: false, reason: 'counts-unavailable' });
    // Pacing: one second short, then just past it.
    const lastAt = T0 - 44_000;
    expect(
      capCheck({ rules }, j, exact(0, 0), T0, { lastAt, random: () => 0 }),
    ).toEqual({ ok: false, reason: 'too-soon' });
    expect(
      capCheck({ rules }, j, exact(0, 0), T0, {
        lastAt: T0 - 46_000,
        random: () => 0,
      }),
    ).toEqual({ ok: true });
    expect(
      capCheck({ rules }, j, exact(0, 0), T0, {
        lastAt: T0 - 46_000,
        random: () => 1,
      }),
    ).toEqual({ ok: false, reason: 'too-soon' });
  });

  it('handles a quiet window that wraps midnight', () => {
    const rules = okRules({ quiet_hours: [22, 7] });
    const at = (h: number) => {
      const d = new Date(T0);
      d.setHours(h, 0, 0, 0);
      return d.getTime();
    };
    expect(inQuietHours(at(23), rules.quiet_hours)).toBe(true);
    expect(inQuietHours(at(3), rules.quiet_hours)).toBe(true);
    expect(inQuietHours(at(12), rules.quiet_hours)).toBe(false);
    expect(
      capCheck(
        { rules },
        job(),
        { counts: { day: 0, week: 0 }, exact: true },
        at(23),
      ),
    ).toEqual({ ok: false, reason: 'quiet-hours' });
  });

  it('compares handles the same way the URL builder does', () => {
    const rules = okRules();
    for (const handle of ['@ours', 'OURS', '@OuRs']) {
      expect(allowsTarget(rules, job({ params: { handle } })), handle).toBe(
        true,
      );
      expect(urlFor('instagram.follow', { handle })).toBe(
        'https://www.instagram.com/ours/',
      );
    }
    expect(
      allowsTarget(rules, job({ params: { handle: '@second.brand' } })),
    ).toBe(true);
    expect(allowsTarget(rules, job({ params: { handle: '@stranger' } }))).toBe(
      false,
    );
    expect(normaliseHandle('@Ours')).toBe(normaliseHandle('ours'));
  });

  // Locks the ordering `lastActionAt` documents its safety against: an inexact
  // count must refuse before the pacing gap is consulted at all. Without this
  // order, a record too corrupt to read could shorten the gap instead of
  // stopping the action, and the only thing catching it today is that the same
  // record also makes the count inexact.
  it('refuses on an inexact count before it ever consults the pacing gap', () => {
    const rules = okRules({ min_gap_seconds: 3600, jitter_seconds: 0 });
    const inexact = { counts: { day: 0, week: 0 }, exact: false };
    expect(
      capCheck({ rules }, job(), inexact, T0, { lastAt: T0 - 1000 }),
    ).toEqual({ ok: false, reason: 'counts-unavailable' });
  });
});

describe('urlFor', () => {
  it('never leaves the site and refuses dot-only segments', () => {
    expect(urlFor('instagram.follow', { handle: '@a.b' })).toBe(
      'https://www.instagram.com/a.b/',
    );
    expect(urlFor('instagram.follow', { handle: '.' })).toBeNull();
    expect(urlFor('instagram.follow', { handle: '..' })).toBeNull();
    expect(urlFor('instagram.follow', { handle: '' })).toBeNull();
    expect(urlFor('alibaba.reply', { thread_id: 'T-1_2' })).toBe(
      'https://message.alibaba.com/thread/T-1_2/',
    );
    expect(urlFor('alibaba.list_threads')).toBe('https://message.alibaba.com/');
    expect(urlFor('instagram.dm', { handle: 'x' })).toBeNull();
    for (const kind of [
      'instagram.follow',
      'alibaba.reply',
      'alibaba.list_threads',
    ] as const) {
      const u = urlFor(kind, { handle: 'someone', thread_id: 'T1' });
      expect(u && new URL(u).origin).toBe(
        kind.startsWith('instagram')
          ? 'https://www.instagram.com'
          : 'https://message.alibaba.com',
      );
    }
  });
});

describe('attention and sweeping', () => {
  it('sets, reads and clears the marker only for known sites', () => {
    expect(getAttention(dir, 'instagram')).toBe(false);
    setAttention(dir, 'instagram', 'challenge', T0);
    expect(getAttention(dir, 'instagram')).toBe(true);
    expect(getAttention(dir, 'alibaba')).toBe(false);
    setAttention(dir, '../escape', 'challenge', T0);
    expect(fs.existsSync(path.join(dir, 'attention', '..', 'escape'))).toBe(
      false,
    );
    clearAttention(dir, 'instagram');
    expect(getAttention(dir, 'instagram')).toBe(false);
  });

  it('prunes expired proposals after a week and terminal records after 30 days', () => {
    const day = 24 * 3_600_000;
    const keepFresh = plant(job(), T0 - 3_600_000);
    const oldProposal = plant(
      job({ proposed_at: new Date(T0 - 8 * day).toISOString() }),
      T0 - 8 * day,
    );
    const oldDone = counted('done', T0 - 31 * day);
    const recentDone = counted('done', T0 - 2 * day);
    expect(sweepJobs(dir, T0).removed).toBe(2);
    expect(fs.existsSync(keepFresh)).toBe(true);
    expect(fs.existsSync(recentDone)).toBe(true);
    expect(fs.existsSync(oldProposal)).toBe(false);
    expect(fs.existsSync(oldDone)).toBe(false);
  });

  it('newJobId is the shape the store validates', () => {
    expect(newJobId()).toMatch(/^bj-[0-9a-f]{12}$/);
  });
});
