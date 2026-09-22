// Independent, blind oracle for Phase E1 ("browser agent, control plane").
// Authored by oracle-author from
// docs/superpowers/plans/2026-09-21-browser-agent-phaseE1.md ALONE, before
// `src/browser/` or `src/control-ui/api/browser-store.ts` exist. No
// implementation for this change was read while writing this file.
//
// It MUST fail on import right now (the modules below don't exist) — that
// is the expected red. Once Task 1 lands, this file runs unmodified
// alongside the implementer's own `browser-store.test.ts`.
//
// ASSUMPTIONS this file had to make because the plan describes behavior in
// prose, not exact signatures. Each is called out again at its test site.
// If red-green surfaces a mismatch against the real implementation, treat
// these — not the four fail-closed autonomy cases, which don't depend on
// them — as the first thing to reconcile:
//   (A1) `readRules(dir, site)` and `writeRules` exist as named exports,
//        per the plan's own Design bullet ("`validateRules`/`readRules`/
//        `writeRules`"); `readRules(dir, site)` returns the rules-shaped
//        value directly (never an ok/reason wrapper) per Global
//        Constraints — used only for the missing/invalid-*file*-level
//        cases (unreadable/too-large/not-json), which `validateRules`
//        alone (given already-parsed input) cannot exercise.
//   (A2) `validateRules`/`validateJob` return `{ ok: true; rules|job } |
//        { ok: false; reason }`, matching `validateRegistry`/
//        `validateRecord`'s existing convention in this same API
//        directory (artifacts.ts:110, workflows.ts).
//   (A3) `urlFor(kind, params)` returns `{ ok: true; url: string } |
//        { ok: false }`, matching every other fallible call in this
//        module family instead of throwing.
//   (A4) `capCheck`'s `counts` parameter is the whole `countActions`
//        result (`{ counts: { day, week }, exact }`) plus a last-action
//        timestamp the gap check needs and the plan never names — guessed
//        here as `lastActionAt` (ISO string) and passed via a loosely
//        typed variable so a real, differently-named field doesn't produce
//        a compile error, only a legitimate assertion failure. This is the
//        single weakest-pinned point in this file (see "Not covered").
//   (A5) The positive "intact confirmation reads as autonomous: true" case
//        needs *a* valid `autonomy_scope_sha256`. The plan pins the scope
//        (whole record minus the two confirmation fields) but not the
//        byte-level canonicalization. This file computes one reasonable
//        canonical form (recursively key-sorted JSON, sha256 hex) — see
//        `scopeHash()` below — and flags it inline. The four
//        fail-closed variants (missing field(s), garbage hash, tampered
//        field with a stale hash) do NOT depend on this guess being right.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  afterEach,
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  validateRules,
  readRules as realReadRules,
  countActions as realCountActions,
  capCheck as realCapCheck,
  validateJob,
  projectJob,
} from './browser-store.js';
import { getSite, urlFor as realUrlFor } from '../../browser/sites.js';

const T0 = Date.parse('2026-09-23T15:00:00.000Z'); // Wednesday, UTC
const now = () => T0;
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let origTz: string | undefined;
beforeAll(() => {
  origTz = process.env.TZ;
  process.env.TZ = 'UTC'; // "local midnight"/"local Monday" must be pinned to be testable
});
afterAll(() => {
  if (origTz === undefined) delete process.env.TZ;
  else process.env.TZ = origTz;
});

let dir: string;
let rulesDir: string;
let jobsDir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-oracle-'));
  rulesDir = path.join(dir, 'rules');
  jobsDir = path.join(dir, 'jobs');
  fs.mkdirSync(rulesDir);
  fs.mkdirSync(jobsDir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- fixtures --------------------------------------------------------

/** A fully-specified, otherwise-valid rules record (not yet autonomous). */
function baseRules(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 1,
    site: 'instagram',
    enabled: true,
    autonomous: false,
    weekly_cap: 25,
    daily_cap: 4, // ceil(25/7)
    min_gap_seconds: 60,
    jitter_seconds: 30,
    quiet_hours: null,
    allow: { kinds: ['instagram.follow'], handles: ['jdoe'], threads: [] },
    ...over,
  };
}

// (A5) one reasonable canonicalization for the autonomy scope hash.
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as unknown as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify((v as unknown as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
function scopeHash(rules: Record<string, unknown>): string {
  const { autonomy_confirmed_at, autonomy_scope_sha256, ...scoped } = rules;
  void autonomy_confirmed_at;
  void autonomy_scope_sha256;
  return crypto
    .createHash('sha256')
    .update(stableStringify(scoped))
    .digest('hex');
}

let seq = 0;
const mkJobId = () => `bj-${(seq++).toString(16).padStart(12, '0')}`;

function baseJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = mkJobId();
  return {
    v: 1,
    id,
    site: 'instagram',
    kind: 'instagram.follow',
    params: { handle: 'jdoe' },
    status: 'proposed',
    proposed_by: 'session:abc12345',
    proposed_at: iso(T0 - 1000),
    rev: 1,
    ...over,
  };
}

function plantJob(dirPath: string, job: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(dirPath, `${job.id as string}.json`),
    JSON.stringify(job),
    { mode: 0o600 },
  );
}

// ---- reconciliation shims (written by the IMPLEMENTER, not the oracle) ---
//
// Red-green surfaced exactly the three signature guesses this file's header
// called out (A1, A3 by absence, A4) plus one path-convention guess. None of
// them is a behavioural disagreement, so the assertions below are untouched
// and the adaptation is confined to these three wrappers. Each says what the
// real signature is and why the translation is faithful.
//
//  * (A1) `readRules(dir, site)` returns a *view* — `{ rules, invalid?,
//    reason?, mtimeMs?, sha256? }` — not the rules record itself, and `dir`
//    is the browser root (it joins `rules/` itself). The view is flattened
//    here so `r.enabled` / `r.reason` read as the oracle wrote them. The
//    reason vocabulary the oracle guessed — unreadable / too-large /
//    not-json / bad-schema — is the implementation's `RulesReason` exactly.
//  * `countActions(dir, site, now)` takes the browser root and a `now`
//    number, not the jobs directory and a clock function.
//  * (A4) `capCheck(view, job, counts, now, opts)` takes an already-validated
//    rules view and job record, the last-action timestamp as `opts.lastAt`
//    (epoch ms, from the store's own `lastActionAt`), and `random` as
//    `opts.random`. The shim runs the same two validators the server route
//    runs before it, so the 24-hour expiry projection the oracle asserts on
//    a *raw* proposed record is reached the way production reaches it.
type RawRec = Record<string, unknown>;
type OracleCounts = {
  counts: { day: number; week: number };
  exact: boolean;
  lastActionAt?: string;
};

function readRules(_rulesDir: string, site: string): RawRec {
  const view = realReadRules(dir, site);
  return { ...view.rules, invalid: view.invalid, reason: view.reason };
}

function countActions(_jobsDir: string, site: string, at: () => number) {
  return realCountActions(dir, site, at());
}

// (A3) `urlFor(kind, params)` returns `string | null`, not `{ ok, url }`.
// Wrapping it restores the oracle's guessed shape; note that until this shim
// existed the fifth urlFor case ("uses the same normalisation as
// capCheck.allow.handles membership") was passing VACUOUSLY, comparing
// `undefined` to `undefined`. The shim gives it back its teeth.
function urlFor(kind: string, params: Record<string, unknown>) {
  const u = realUrlFor(kind, params);
  return u === null ? { ok: false } : { ok: true, url: u };
}

// Coverage this shim forecloses, stated rather than left implicit: the
// capCheck wrapper below throws on an invalid rules fixture instead of
// building a view with `invalid: true`, so `capCheck`'s
// `view.invalid -> 'rules-invalid'` branch is unreachable from this file. The
// oracle never asserted on it, so nothing here was weakened — but
// `rules-invalid` is a live `RefuseReason` the propose route branches on, and
// its coverage now lives in the implementer's own browser-store.test.ts.
function capCheck(
  rulesRaw: RawRec,
  jobRaw: RawRec,
  counts: OracleCounts,
  at: () => number,
  random: () => number,
) {
  const at0 = at();
  const v = validateRules(rulesRaw, rulesRaw.site as string);
  if (!v.ok) throw new Error(`shim: rules fixture rejected (${v.reason})`);
  const j = validateJob(jobRaw, jobRaw.id as string, () => at0);
  if (!j.ok) throw new Error(`shim: job fixture rejected (${j.reason})`);
  return realCapCheck({ rules: v.rules }, j.job, counts, at0, {
    lastAt: counts.lastActionAt ? Date.parse(counts.lastActionAt) : null,
    random,
  });
}

// ---- validateRules -----------------------------------------------------

describe('validateRules', () => {
  // @oracle: Rules row — "returns a fresh literal"
  it('returns a fresh literal, not an alias of the input', () => {
    const raw = JSON.parse(JSON.stringify(baseRules()));
    const r = validateRules(raw, 'instagram') as unknown as {
      ok: true;
      rules: Record<string, unknown>;
    };
    expect(r.ok).toBe(true);
    raw.weekly_cap = 999;
    (raw.allow as { handles: string[] }).handles.push('mutated');
    expect(r.rules.weekly_cap).toBe(25);
    expect((r.rules.allow as { handles: string[] }).handles).toEqual(['jdoe']);
  });

  // @oracle: Rules row — "rejects daily_cap: 0"
  it('rejects daily_cap: 0', () => {
    const r = validateRules(baseRules({ daily_cap: 0 }), 'instagram') as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Rules row — "rejects daily_cap > weekly_cap"
  it('rejects daily_cap > weekly_cap', () => {
    const r = validateRules(
      baseRules({ weekly_cap: 10, daily_cap: 11 }),
      'instagram',
    ) as { ok: false; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Rules row — "rejects weekly_cap: 501"
  it('rejects weekly_cap: 501 (above the 1..500 range)', () => {
    const r = validateRules(
      baseRules({ weekly_cap: 501, daily_cap: 200 }),
      'instagram',
    ) as { ok: false; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Rules row — "rejects an unknown kind"
  it('rejects an unknown kind in allow.kinds', () => {
    const r = validateRules(
      baseRules({
        allow: {
          kinds: ['instagram.unfollow'],
          handles: ['jdoe'],
          threads: [],
        },
      }),
      'instagram',
    ) as { ok: false; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Rules row — "rejects a 600-entry handle list"
  it('rejects a 600-entry allow.handles list (cap is 500)', () => {
    const handles = Array.from({ length: 600 }, (_, i) => `h${i}`);
    const r = validateRules(
      baseRules({
        allow: { kinds: ['instagram.follow'], handles, threads: [] },
      }),
      'instagram',
    ) as { ok: false; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Rules row — "rejects a non-array quiet_hours"
  it('rejects a non-array quiet_hours', () => {
    const r = validateRules(
      baseRules({ quiet_hours: '22-6' }),
      'instagram',
    ) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Global Constraints — "record.site must equal the filename's site"
  it('rejects a record whose site differs from the one it was read for', () => {
    const r = validateRules(baseRules({ site: 'alibaba' }), 'instagram') as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: Global Constraints — "autonomous: true with an empty ... target
  // list for an allowed kind is invalid rules, not permission for anything"
  it('rejects autonomous: true with an empty handles list for the allowed kind', () => {
    const raw = baseRules({
      autonomous: true,
      allow: { kinds: ['instagram.follow'], handles: [], threads: [] },
      autonomy_confirmed_at: iso(T0 - DAY),
    });
    (raw as unknown as Record<string, unknown>).autonomy_scope_sha256 =
      scopeHash(raw);
    const r = validateRules(raw, 'instagram') as { ok: false; reason: string };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  describe('autonomy binding (the load-bearing case)', () => {
    // @oracle: Global Constraints — "autonomous: true without
    // autonomy_confirmed_at reads as autonomous: false" (no hash needed —
    // does not depend on assumption A5)
    it('reads autonomous: false when neither confirmation field is present', () => {
      const r = validateRules(
        baseRules({ autonomous: true }),
        'instagram',
      ) as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
    });

    // @oracle: same case, missing only the hash (does not depend on A5)
    it('reads autonomous: false when autonomy_scope_sha256 is missing', () => {
      const raw = baseRules({
        autonomous: true,
        autonomy_confirmed_at: iso(T0 - DAY),
      });
      const r = validateRules(raw, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
    });

    // @oracle: same case, missing only the timestamp (does not depend on A5)
    it('reads autonomous: false when autonomy_confirmed_at is missing', () => {
      const raw = baseRules({ autonomous: true });
      (raw as unknown as Record<string, unknown>).autonomy_scope_sha256 =
        scopeHash(raw);
      const r = validateRules(raw, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
    });

    // @oracle: both fields present but the hash cannot possibly verify
    // (does not depend on A5 — this string is not a hash of anything)
    it('reads autonomous: false when both fields are present but the hash is garbage', () => {
      const raw = baseRules({
        autonomous: true,
        autonomy_confirmed_at: iso(T0 - DAY),
        autonomy_scope_sha256: 'f'.repeat(64),
      });
      const r = validateRules(raw, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
    });

    // @oracle: Verification row — "the same record with both confirmation
    // fields intact reads as true" (depends on assumption A5's hash form)
    it('reads autonomous: true when both confirmation fields are intact', () => {
      const raw = baseRules({
        autonomous: true,
        autonomy_confirmed_at: iso(T0 - DAY),
      });
      (raw as unknown as Record<string, unknown>).autonomy_scope_sha256 =
        scopeHash(raw);
      const r = validateRules(raw, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(true);
    });

    // @oracle: Verification row — "a record whose caps ... were edited
    // after confirmation, keeping autonomy_confirmed_at and its old
    // autonomy_scope_sha256, reads as autonomous: false"
    it('reads autonomous: false once weekly_cap is edited after confirmation, hash left stale', () => {
      const confirmedAt = iso(T0 - DAY);
      const original = baseRules({
        autonomous: true,
        autonomy_confirmed_at: confirmedAt,
      });
      const hash = scopeHash(original);
      const tampered = {
        ...original,
        weekly_cap: 500,
        autonomy_scope_sha256: hash,
      };
      const r = validateRules(tampered, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
    });

    // @oracle: same tamper case over allow.handles (swap the target list)
    it('reads autonomous: false once allow.handles is swapped after confirmation', () => {
      const confirmedAt = iso(T0 - DAY);
      const original = baseRules({
        autonomous: true,
        autonomy_confirmed_at: confirmedAt,
      });
      const hash = scopeHash(original);
      const tampered = {
        ...original,
        allow: {
          kinds: ['instagram.follow'],
          handles: ['someone-else'],
          threads: [],
        },
        autonomy_scope_sha256: hash,
      };
      const r = validateRules(tampered, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
    });

    // @oracle: Global Constraints — "enabled ... covered by construction":
    // a site paused and re-enabled must not resume at full confirmed scope
    it('reads autonomous: false once enabled is flipped after confirmation', () => {
      const confirmedAt = iso(T0 - DAY);
      const original = baseRules({
        autonomous: true,
        autonomy_confirmed_at: confirmedAt,
      });
      const hash = scopeHash(original);
      const tampered = {
        ...original,
        enabled: false,
        autonomy_scope_sha256: hash,
      };
      let r = validateRules(tampered, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.ok).toBe(true);
      expect(r.rules.autonomous).toBe(false);
      // Expectation inverted below (implementer), reason: this is the one
      // place where the oracle and the implementation genuinely disagree, and
      // it is recorded here rather than deleted.
      //
      // The oracle read the plan's own justification for hashing the whole
      // record, which says `enabled` is covered because "a site paused and
      // then flipped back by any writer would otherwise resume at full
      // confirmed scope", and asserted that pausing therefore burns the
      // confirmation for good. Hash coverage cannot deliver that property:
      // flipping `enabled` back restores the scope bytes exactly, so the hash
      // matches again whether or not `enabled` is inside it. What coverage
      // actually buys is that autonomy is inert *while* the site is paused,
      // which the assertion above tests and the implementation satisfies.
      // The plan sentence is a mis-stated justification for a correct choice;
      // it has been corrected in the plan in this same change.
      //
      // The invariant the implementation does hold: the rules in force are
      // byte-identical to the rules the operator confirmed. Flip-back
      // satisfies it; the two tamper cases above do not, which is why those
      // assertions stand untouched. Against the plan's own phrase "any
      // writer" the property holds anyway, because every writer here destroys
      // the confirmation: writeRules deletes both fields from its input, the
      // PUT route re-stamps them only behind the typed site name, and
      // browser-rules.mjs rebuilds the record without them. Only a raw
      // hand-edit preserving both fields can round-trip a pause, and no
      // mechanism available here closes that — a counter or nonce outside the
      // hashed scope is equally hand-writable. Recorded as a named residual
      // in docs/KNOWN_LIMITATIONS.md and in the ADR.
      const flippedBack = { ...tampered, enabled: true };
      r = validateRules(flippedBack, 'instagram') as unknown as {
        ok: true;
        rules: Record<string, unknown>;
      };
      expect(r.rules.autonomous).toBe(true);
    });
  });
});

// ---- readRules (file-level reasons validateRules-on-a-raw-value can't reach) --

describe('readRules (file-level: missing/unreadable/too-large/not-json)', () => {
  // @oracle: Global Constraints — "a missing file reads as { enabled: false
  // }, not an error"  [assumption A1]
  it('reads a missing rules file as { enabled: false } rather than throwing', () => {
    const r = readRules(rulesDir, 'instagram') as { enabled: boolean };
    expect(() => readRules(rulesDir, 'instagram')).not.toThrow();
    expect(r.enabled).toBe(false);
  });

  // @oracle: Verification row — "an invalid file reads as { enabled: false,
  // invalid: true, reason }" — not-json case  [assumption A1]
  it('disables the site (does not throw, does not default permissive) on a not-JSON file', () => {
    fs.writeFileSync(path.join(rulesDir, 'instagram.json'), '{not valid json', {
      mode: 0o600,
    });
    const r = readRules(rulesDir, 'instagram') as {
      enabled: boolean;
      invalid?: boolean;
      reason?: string;
    };
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe('not-json');
  });

  // @oracle: same row — too-large case (64 KB bound reused per Design
  // section: "Reads via readRecordFile(file, 64 KB)")
  it('disables the site on an oversized rules file', () => {
    const bloated = baseRules({ padding: 'x'.repeat(200 * 1024) });
    fs.writeFileSync(
      path.join(rulesDir, 'instagram.json'),
      JSON.stringify(bloated),
      {
        mode: 0o600,
      },
    );
    const r = readRules(rulesDir, 'instagram') as {
      enabled: boolean;
      reason?: string;
    };
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe('too-large');
  });

  // @oracle: same row — bad-schema surfaces through the file-read path too
  it('disables the site on a schema-invalid rules file (daily_cap: 0)', () => {
    fs.writeFileSync(
      path.join(rulesDir, 'instagram.json'),
      JSON.stringify(baseRules({ daily_cap: 0 })),
      { mode: 0o600 },
    );
    const r = readRules(rulesDir, 'instagram') as {
      enabled: boolean;
      reason?: string;
    };
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe('bad-schema');
  });

  // @oracle: same row — unreadable case: not a regular file at the expected path
  it('disables the site when the rules path is not a regular file', () => {
    fs.mkdirSync(path.join(rulesDir, 'instagram.json'));
    const r = readRules(rulesDir, 'instagram') as {
      enabled: boolean;
      reason?: string;
    };
    expect(r.enabled).toBe(false);
    expect(r.reason).toBe('unreadable');
  });
});

// ---- countActions --------------------------------------------------------

describe('countActions', () => {
  // @oracle: Caps row — "done + running + maybe-sent ... since local
  // midnight / since the most recent local Monday 00:00"; "failed and
  // blocked do not count"
  it('counts done/running/maybe-sent since local midnight and since Monday, excluding failed/blocked', () => {
    // today (counts toward day and week)
    plantJob(
      jobsDir,
      baseJob({ status: 'done', finished_at: iso(T0 - 3 * 60 * 60 * 1000) }),
    );
    plantJob(
      jobsDir,
      baseJob({ status: 'running', started_at: iso(T0 - 60 * 60 * 1000) }),
    );
    plantJob(
      jobsDir,
      baseJob({ status: 'maybe-sent', finished_at: iso(T0 - 30 * 60 * 1000) }),
    );
    // yesterday but still this week (counts toward week only)
    plantJob(
      jobsDir,
      baseJob({ status: 'done', finished_at: iso(T0 - DAY - 60 * 60 * 1000) }),
    );
    // last week (Sunday, before Monday boundary) — counts toward neither
    plantJob(
      jobsDir,
      baseJob({ status: 'done', finished_at: '2026-09-20T10:00:00.000Z' }),
    );
    // terminal but excluded regardless of timing
    plantJob(
      jobsDir,
      baseJob({ status: 'failed', finished_at: iso(T0 - 1000) }),
    );
    plantJob(
      jobsDir,
      baseJob({ status: 'blocked', finished_at: iso(T0 - 1000) }),
    );
    // a different site entirely must not be counted
    // Fixture corrected (implementer), reason: the oracle's own comment says
    // "a different site entirely", but it left `kind: 'instagram.follow'` on
    // an `alibaba` record. `validateJob` is right to reject that cross-site
    // combination, which made this test fail on `exact` rather than on the
    // site filter it was written to exercise. The kind now matches the site,
    // so the assertion tests what its comment says it tests.
    plantJob(
      jobsDir,
      baseJob({
        site: 'alibaba',
        kind: 'alibaba.list_threads',
        params: {},
        status: 'done',
        finished_at: iso(T0 - 1000),
      }),
    );

    const r = countActions(jobsDir, 'instagram', now) as {
      counts: { day: number; week: number };
      exact: boolean;
    };
    expect(r.exact).toBe(true);
    expect(r.counts.day).toBe(3);
    expect(r.counts.week).toBe(4);
  });

  // @oracle: Caps row — "exact is false ... if a record ... fails to read"
  it('reports exact: false when a record inside the counted window is corrupt', () => {
    plantJob(jobsDir, baseJob({ status: 'done', finished_at: iso(T0 - 1000) }));
    fs.writeFileSync(path.join(jobsDir, 'bj-badbadbadbad.json'), '{not json', {
      mode: 0o600,
    });
    const r = countActions(jobsDir, 'instagram', now) as { exact: boolean };
    expect(r.exact).toBe(false);
  });

  // @oracle: Caps row — "with 5 000 job files it returns exact: false"
  it('reports exact: false once the jobs directory exceeds the scan cap (5,000 files)', () => {
    for (let i = 0; i < 5000; i++) {
      fs.writeFileSync(
        path.join(jobsDir, `bj-${i.toString(16).padStart(12, '0')}.json`),
        JSON.stringify(baseJob({ site: 'alibaba', status: 'proposed' })),
        { mode: 0o600 },
      );
    }
    const r = countActions(jobsDir, 'instagram', now) as { exact: boolean };
    expect(r.exact).toBe(false);
  }, 20000);

  // @oracle: Caps row — "a directory where the newest 600 are all proposed
  // while older done records carry the real count": an implementation that
  // truncates the mtime-descending walk must never report a short count as
  // exact — it must either find the true records or say exact: false.
  it('never reports an exact count that omits done records behind 650 proposed ones', () => {
    for (let i = 0; i < 650; i++) {
      const j = baseJob({ status: 'proposed' });
      plantJob(jobsDir, j);
    }
    const doneIds = ['bj-true0true001', 'bj-true0true002', 'bj-true0true003'];
    for (const id of doneIds) {
      const j = baseJob({ id, status: 'done', finished_at: iso(T0 - 1000) });
      plantJob(jobsDir, j);
      const old = new Date(T0 - 30 * 60 * 1000);
      fs.utimesSync(path.join(jobsDir, `${id}.json`), old, old);
    }
    const r = countActions(jobsDir, 'instagram', now) as {
      counts: { day: number; week: number };
      exact: boolean;
    };
    if (r.exact) {
      expect(r.counts.day).toBeGreaterThanOrEqual(3);
      expect(r.counts.week).toBeGreaterThanOrEqual(3);
    }
  });
});

// ---- capCheck --------------------------------------------------------

describe('capCheck', () => {
  const okCounts = {
    counts: { day: 0, week: 0 },
    exact: true,
  } as unknown as Parameters<typeof capCheck>[2];
  const random0 = () => 0;

  // @oracle: baseline — nothing refuses
  it('allows a job with headroom, an allowed target, no gap violation and no expiry', () => {
    const rules = baseRules();
    const job = baseJob();
    const r = capCheck(rules, job, okCounts, now, random0);
    expect(r.ok).toBe(true);
  });

  // @oracle: Caps row — "refuses on disabled"
  it('refuses disabled rules', () => {
    const rules = baseRules({ enabled: false });
    const job = baseJob();
    const r = capCheck(rules, job, okCounts, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('disabled');
  });

  // @oracle: Caps row — "inside quiet_hours including a window that wraps midnight"
  it('refuses inside a midnight-wrapping quiet window', () => {
    const rules = baseRules({ quiet_hours: [22, 6] });
    const job = baseJob();
    const lateNight = () => Date.parse('2026-09-23T23:30:00.000Z');
    const earlyMorning = () => Date.parse('2026-09-23T03:00:00.000Z');
    const midday = () => Date.parse('2026-09-23T12:00:00.000Z');
    expect(
      (
        capCheck(rules, job, okCounts, lateNight, random0) as {
          ok: false;
          reason: string;
        }
      ).reason,
    ).toBe('quiet-hours');
    expect(
      (
        capCheck(rules, job, okCounts, earlyMorning, random0) as {
          ok: false;
          reason: string;
        }
      ).reason,
    ).toBe('quiet-hours');
    expect(capCheck(rules, job, okCounts, midday, random0).ok).toBe(true);
  });

  // @oracle: Caps row — non-wrapping quiet window still applies
  it('refuses inside a non-wrapping quiet window and allows outside it', () => {
    const rules = baseRules({ quiet_hours: [1, 5] });
    const job = baseJob();
    const inside = () => Date.parse('2026-09-23T03:00:00.000Z');
    const outside = () => Date.parse('2026-09-23T10:00:00.000Z');
    expect(
      (
        capCheck(rules, job, okCounts, inside, random0) as {
          ok: false;
          reason: string;
        }
      ).reason,
    ).toBe('quiet-hours');
    expect(capCheck(rules, job, okCounts, outside, random0).ok).toBe(true);
  });

  // @oracle: Caps row — "at daily_cap"
  it('refuses at daily_cap even with weekly headroom', () => {
    const rules = baseRules({ daily_cap: 4, weekly_cap: 25 });
    const job = baseJob();
    const atCap = {
      counts: { day: 4, week: 5 },
      exact: true,
    } as unknown as Parameters<typeof capCheck>[2];
    const underCap = {
      counts: { day: 3, week: 5 },
      exact: true,
    } as unknown as Parameters<typeof capCheck>[2];
    expect(
      (
        capCheck(rules, job, atCap, now, random0) as {
          ok: false;
          reason: string;
        }
      ).reason,
    ).toBe('daily-cap');
    expect(capCheck(rules, job, underCap, now, random0).ok).toBe(true);
  });

  // @oracle: Caps row — "at weekly_cap with the daily count still low"
  // (the Monday-boundary discriminating case)
  it('refuses at weekly_cap even while the daily count is still low', () => {
    const rules = baseRules({ daily_cap: 10, weekly_cap: 20 });
    const job = baseJob();
    const counts = {
      counts: { day: 1, week: 20 },
      exact: true,
    } as unknown as Parameters<typeof capCheck>[2];
    const r = capCheck(rules, job, counts, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('weekly-cap');
  });

  // @oracle: Caps row — "when the last action finished min_gap_seconds - 1
  // ago" / "passes just past the gap with random: () => 0"
  // [assumption A4: the last-action timestamp is carried as
  // `lastActionAt` on the object passed as `counts` — the plan does not
  // name this field; see file header]
  it('refuses just under min_gap_seconds since the last action and allows just at it (random: () => 0)', () => {
    const rules = baseRules({ min_gap_seconds: 60, jitter_seconds: 30 });
    const job = baseJob();
    const tooSoon = {
      counts: { day: 0, week: 0 },
      exact: true,
      lastActionAt: iso(T0 - 59_000),
    } as unknown as Parameters<typeof capCheck>[2];
    const justPast = {
      counts: { day: 0, week: 0 },
      exact: true,
      lastActionAt: iso(T0 - 60_000),
    } as unknown as Parameters<typeof capCheck>[2];
    const soon = capCheck(rules, job, tooSoon, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(soon.ok).toBe(false);
    expect(soon.reason).toBe('too-soon');
    expect(capCheck(rules, job, justPast, now, random0).ok).toBe(true);
  });

  // @oracle: same contract — random(...) actually scales jitter_seconds
  // into the required gap, rather than being ignored [assumption A4]
  it('extends the required gap by random() * jitter_seconds', () => {
    const rules = baseRules({ min_gap_seconds: 60, jitter_seconds: 30 });
    const job = baseJob();
    const counts89 = {
      counts: { day: 0, week: 0 },
      exact: true,
      lastActionAt: iso(T0 - 89_000),
    } as unknown as Parameters<typeof capCheck>[2];
    const counts90 = {
      counts: { day: 0, week: 0 },
      exact: true,
      lastActionAt: iso(T0 - 90_000),
    } as unknown as Parameters<typeof capCheck>[2];
    const randomMax = () => 1; // 100% of jitter_seconds => required gap 90s
    const r89 = capCheck(rules, job, counts89, now, randomMax) as {
      ok: false;
      reason: string;
    };
    expect(r89.ok).toBe(false);
    expect(r89.reason).toBe('too-soon');
    expect(capCheck(rules, job, counts90, now, randomMax).ok).toBe(true);
  });

  // @oracle: Global Constraints — "maybe-sent counts ... in the gap — an
  // action nobody can prove did not happen must not be free" [assumption A4]
  it('treats a maybe-sent outcome as the last action for gap purposes', () => {
    const rules = baseRules({ min_gap_seconds: 60, jitter_seconds: 0 });
    const job = baseJob();
    const counts = {
      counts: { day: 0, week: 0 },
      exact: true,
      lastActionAt: iso(T0 - 10_000), // 10s ago, from a maybe-sent record
    } as unknown as Parameters<typeof capCheck>[2];
    const r = capCheck(rules, job, counts, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too-soon');
  });

  // @oracle: Caps row — "for a target outside allow.handles (not-allowed)"
  // — normalised: leading '@' and case are ignored
  it('refuses a handle outside allow.handles, honouring @ and case normalisation', () => {
    const rules = baseRules({
      allow: { kinds: ['instagram.follow'], handles: ['JDoe'], threads: [] },
    });
    const allowed = baseJob({ params: { handle: '@jdoe' } });
    const notAllowed = baseJob({ params: { handle: 'someoneelse' } });
    expect(capCheck(rules, allowed, okCounts, now, random0).ok).toBe(true);
    const r = capCheck(rules, notAllowed, okCounts, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-allowed');
  });

  // @oracle: same contract, alibaba.reply thread membership (no @/case rule — opaque ids)
  it('refuses a thread_id outside allow.threads', () => {
    const rules = baseRules({
      site: 'alibaba',
      allow: { kinds: ['alibaba.reply'], handles: [], threads: ['th-100'] },
    });
    const allowed = baseJob({
      site: 'alibaba',
      kind: 'alibaba.reply',
      params: { thread_id: 'th-100', body: 'hi' },
    });
    const notAllowed = baseJob({
      site: 'alibaba',
      kind: 'alibaba.reply',
      params: { thread_id: 'th-999', body: 'hi' },
    });
    expect(capCheck(rules, allowed, okCounts, now, random0).ok).toBe(true);
    const r = capCheck(rules, notAllowed, okCounts, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.reason).toBe('not-allowed');
  });

  // @oracle: Caps row — "when counts.exact is false"
  it('refuses with counts-unavailable when the counter could not be exact', () => {
    const rules = baseRules();
    const job = baseJob();
    const notExact = {
      counts: { day: 0, week: 0 },
      exact: false,
    } as unknown as Parameters<typeof capCheck>[2];
    const r = capCheck(rules, job, notExact, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('counts-unavailable');
  });

  // @oracle: Jobs row — "a proposed record 25 h old ... capCheck refuses it
  // with expired"
  it('refuses a proposed job older than 24 hours with expired', () => {
    const rules = baseRules();
    const oldJob = baseJob({
      status: 'proposed',
      proposed_at: iso(T0 - 25 * 60 * 60 * 1000),
    });
    const freshJob = baseJob({
      status: 'proposed',
      proposed_at: iso(T0 - 23 * 60 * 60 * 1000),
    });
    const r = capCheck(rules, oldJob, okCounts, now, random0) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('expired');
    expect(capCheck(rules, freshJob, okCounts, now, random0).ok).toBe(true);
  });
});

// ---- validateJob -----------------------------------------------------

describe('validateJob', () => {
  // Assertions relaxed from `toBe('bad-schema')` to set-membership
  // (implementer), reason: the plan's Jobs row freezes THAT these records are
  // rejected and never pins the reason vocabulary; the oracle guessed one flat
  // name for all four. The implementation answers with a finer closed set.
  // Membership still fails on an accepted record and on an unrecognised
  // reason, so the behavioural claim the oracle was making is intact.
  const REJECTS = ['bad-schema', 'bad-id', 'bad-kind', 'bad-params'];

  // @oracle: Jobs row — "rejects an unknown kind"
  it('rejects an unknown kind', () => {
    const job = baseJob({ kind: 'instagram.unfollow' });
    const r = validateJob(job, job.id as string) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(REJECTS).toContain(r.reason);
  });

  // @oracle: Jobs row — "rejects a handle with a slash"
  it('rejects a handle containing a slash', () => {
    const job = baseJob({ params: { handle: 'jdoe/x' } });
    const r = validateJob(job, job.id as string) as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(REJECTS).toContain(r.reason);
  });

  // @oracle: Jobs row — "rejects a 3000-char body" (and accepts the 2000 boundary)
  it('rejects a reply body over 2000 chars and accepts exactly 2000', () => {
    const tooLong = baseJob({
      site: 'alibaba',
      kind: 'alibaba.reply',
      params: { thread_id: 'th-1', body: 'x'.repeat(2001) },
    });
    const atLimit = baseJob({
      site: 'alibaba',
      kind: 'alibaba.reply',
      params: { thread_id: 'th-1', body: 'x'.repeat(2000) },
    });
    const rBad = validateJob(tooLong, tooLong.id as string) as {
      ok: false;
      reason: string;
    };
    expect(rBad.ok).toBe(false);
    expect(REJECTS).toContain(rBad.reason);
    expect(validateJob(atLimit, atLimit.id as string).ok).toBe(true);
  });

  // @oracle: Jobs row — "rejects an id that differs from its filename"
  it('rejects a record whose id differs from the expected id', () => {
    const job = baseJob();
    const r = validateJob(job, 'bj-000000000999') as {
      ok: false;
      reason: string;
    };
    expect(r.ok).toBe(false);
    expect(REJECTS).toContain(r.reason);
  });

  // @oracle: Global Constraints — "proposed_at written by the CLI path is
  // clamped to min(value, now)"
  it('clamps a future proposed_at to now', () => {
    const before = Date.now();
    const job = baseJob({
      proposed_at: new Date(before + 60 * 60 * 1000).toISOString(),
    });
    const r = validateJob(job, job.id as string) as unknown as {
      ok: true;
      job: Record<string, unknown>;
    };
    const after = Date.now();
    expect(r.ok).toBe(true);
    const clamped = Date.parse(r.job.proposed_at as string);
    expect(clamped).toBeGreaterThanOrEqual(before);
    expect(clamped).toBeLessThanOrEqual(after);
  });

  // @oracle: a well-formed job validates and round-trips its fields
  it('accepts a well-formed job unchanged', () => {
    const job = baseJob();
    const r = validateJob(job, job.id as string) as unknown as {
      ok: true;
      job: Record<string, unknown>;
    };
    expect(r.ok).toBe(true);
    expect(r.job.kind).toBe('instagram.follow');
    expect((r.job.params as { handle: string }).handle).toBe('jdoe');
  });
});

// ---- projectJob --------------------------------------------------------

describe('projectJob', () => {
  // @oracle: Jobs row — "projectJob withholds params/result in read-only"
  it('withholds params and result when read-only, keeps them otherwise', () => {
    const job = baseJob({ result: { detail: 'followed' } });
    const readOnlyView = projectJob(job as never, {
      readOnly: true,
    }) as unknown as Record<string, unknown>;
    const fullView = projectJob(job as never, {
      readOnly: false,
    }) as unknown as Record<string, unknown>;
    expect(readOnlyView).not.toHaveProperty('params');
    expect(readOnlyView).not.toHaveProperty('result');
    expect(fullView).toHaveProperty('params');
    expect(fullView).toHaveProperty('result');
  });
});

// ---- urlFor (src/browser/sites.ts) --------------------------------------

describe('urlFor', () => {
  // @oracle: URLs row — "the built URL's origin always equals SITES[site].baseUrl"
  it('builds a URL whose origin equals the site baseUrl', () => {
    const site = getSite('instagram') as { baseUrl: string };
    const r = urlFor('instagram.follow', { handle: 'jdoe' }) as {
      ok: true;
      url: string;
    };
    expect(r.ok).toBe(true);
    expect(new URL(r.url).origin).toBe(new URL(site.baseUrl).origin);
  });

  // @oracle: URLs row — "'.' and '..' handles are rejected"
  it('rejects dot-only handle segments', () => {
    const dot = urlFor('instagram.follow', { handle: '.' }) as { ok: false };
    const dotdot = urlFor('instagram.follow', { handle: '..' }) as {
      ok: false;
    };
    expect(dot.ok).toBe(false);
    expect(dotdot.ok).toBe(false);
  });

  // @oracle: URLs row — "a handle differing only by a leading @ or by case
  // produces the same URL as the allow-list membership test accepts (one
  // normalisation, asserted on both paths)"
  it('normalises a leading @ and case identically for URL-building', () => {
    const a = urlFor('instagram.follow', { handle: '@JDoe' }) as {
      ok: true;
      url: string;
    };
    const b = urlFor('instagram.follow', { handle: 'jdoe' }) as {
      ok: true;
      url: string;
    };
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.url).toBe(b.url);
  });

  // @oracle: URLs row, cross-checked against capCheck's own membership test
  // — one normalisation used on both paths, not two that could diverge
  it('uses the same normalisation as capCheck.allow.handles membership', () => {
    const rules = baseRules({
      allow: { kinds: ['instagram.follow'], handles: ['JDoe'], threads: [] },
    });
    const job = baseJob({ params: { handle: '@jdoe' } });
    const counts = {
      counts: { day: 0, week: 0 },
      exact: true,
    } as unknown as Parameters<typeof capCheck>[2];
    expect(capCheck(rules, job, counts, now, () => 0).ok).toBe(true);
    const viaAllowListForm = urlFor('instagram.follow', { handle: 'JDoe' }) as {
      ok: true;
      url: string;
    };
    // Self-guard added by the implementer, reason: this case compares two
    // built URLs, so without asserting both were built it would go vacuous
    // again the moment either side returned nothing — which is exactly how it
    // was passing before the shim landed.
    expect(viaAllowListForm.ok).toBe(true);
    const viaJobForm = urlFor('instagram.follow', { handle: '@jdoe' }) as {
      ok: true;
      url: string;
    };
    expect(viaJobForm.url).toBe(viaAllowListForm.url);
  });

  // @oracle: URLs row — "over every kind": alibaba.reply builds too
  it('builds an alibaba.reply URL on the alibaba site', () => {
    const site = getSite('alibaba') as { baseUrl: string };
    const r = urlFor('alibaba.reply', { thread_id: 'th-100', body: 'hi' }) as {
      ok: true;
      url: string;
    };
    expect(r.ok).toBe(true);
    expect(new URL(r.url).origin).toBe(new URL(site.baseUrl).origin);
  });
});
