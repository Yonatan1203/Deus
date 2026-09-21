import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveWorkflows,
  createWorkflowWatcher,
  listWorkflows,
  readRecordFile,
  validateRecord,
  type WorkflowRecord,
  type WorkflowView,
} from './workflows.js';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'workflows');
const CLI = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'scripts',
  'workflow.mjs',
);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-09-21T12:00:00.000Z');

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
const mkId = () => `wf-${(seq++).toString(16).padStart(12, '0')}`;
function record(over: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    v: 1,
    id: mkId(),
    name: 'Posts batch',
    kind: 'posts',
    status: 'running',
    percent: 40,
    outputs: [],
    started_at: '2026-09-21T10:00:00.000Z',
    updated_at: '2026-09-21T10:05:00.000Z',
    rev: 1,
    ...over,
  };
}
/** Writes a record file and pins its mtime to `ageMs` before T0. */
function plant(r: object, ageMs = 0, id?: string): string {
  const file = path.join(dir, `${id ?? (r as { id: string }).id}.json`);
  fs.writeFileSync(file, JSON.stringify(r), { mode: 0o600 });
  const t = new Date(T0 - ageMs);
  fs.utimesSync(file, t, t);
  return file;
}
const opts = { readOnly: false, now: () => T0 };
const views = (r: ReturnType<typeof listWorkflows>) =>
  ('workflows' in r ? r.workflows : []) as WorkflowView[];

describe('validateRecord', () => {
  it('agrees with the CLI validator over the shared fixtures', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf-8'),
    ) as Record<string, string>;
    expect(Object.keys(expected)).toHaveLength(12);
    for (const [name, want] of Object.entries(expected)) {
      const file = path.join(FIXTURES, `${name}.json`);
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      const v = validateRecord(raw);
      expect(v.ok ? 'ok' : v.reason, name).toBe(want);
      let cli: string;
      try {
        cli = execFileSync(process.execPath, [CLI, 'validate', file], {
          encoding: 'utf-8',
        }).trim();
      } catch (err) {
        cli = String((err as { stdout: string }).stdout).trim();
      }
      expect(cli, `cli ${name}`).toBe(want);
    }
  });

  it('returns a fresh literal without own toJSON/__proto__ keys and binds the id to the filename', () => {
    const raw = JSON.parse(
      '{"v":1,"id":"wf-0123456789ab","name":"n","kind":"posts","status":"running","percent":1,"outputs":[],"started_at":"2026-09-21T10:00:00.000Z","updated_at":"2026-09-21T10:00:00.000Z","rev":1,"toJSON":"x","__proto__":{"polluted":1},"constructor":"c"}',
    ) as unknown;
    const v = validateRecord(raw, 'wf-0123456789ab');
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(Object.keys(v.record).sort()).toEqual([
      'id',
      'kind',
      'name',
      'outputs',
      'percent',
      'rev',
      'started_at',
      'status',
      'updated_at',
      'v',
    ]);
    expect(Object.prototype.hasOwnProperty.call(v.record, 'toJSON')).toBe(
      false,
    );
    expect(
      (v.record as unknown as { polluted?: number }).polluted,
    ).toBeUndefined();
    expect(validateRecord(raw, 'wf-0123456789ac')).toEqual({
      ok: false,
      reason: 'bad-id',
    });
    expect(validateRecord({ ...(raw as object), preview_url: 42 })).toEqual({
      ok: false,
      reason: 'bad-url',
    });
    expect(
      validateRecord({
        ...(raw as object),
        preview_url: 'https://claude.ai/' + 'a'.repeat(3000),
      }),
    ).toEqual({ ok: false, reason: 'bad-url' });
    // Policy failures are not shape failures: the record stays valid.
    expect(
      validateRecord({
        ...(raw as object),
        preview_url: 'https://claude.ai@evil.example/',
      }).ok,
    ).toBe(true);
  });
});

describe('readRecordFile', () => {
  it('refuses symlinks, oversized files and non-JSON with closed reasons', () => {
    const secret = path.join(dir, 'env');
    fs.writeFileSync(secret, 'API_KEY=hunter2\n');
    fs.symlinkSync(secret, path.join(dir, 'wf-000000000001.json'));
    const r = readRecordFile(path.join(dir, 'wf-000000000001.json'));
    expect(r).toEqual({ ok: false, reason: 'unreadable' });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    fs.writeFileSync(path.join(dir, 'big.json'), 'x'.repeat(70 * 1024));
    expect(readRecordFile(path.join(dir, 'big.json'))).toEqual({
      ok: false,
      reason: 'too-large',
    });
    fs.writeFileSync(
      path.join(dir, 'bad.json'),
      '{"v":1,"id":"wf-000000000001", "secret":"S3CR3T"',
    );
    const bad = readRecordFile(path.join(dir, 'bad.json'));
    expect(bad).toEqual({ ok: false, reason: 'not-json' });
    expect(readRecordFile(path.join(dir, 'missing.json'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

describe('listWorkflows', () => {
  it('lists valid records newest-first, flags invalid ones, projects URLs and strings', () => {
    plant(
      record({
        name: 'old',
        status: 'done',
        percent: 100,
        finished_at: '2026-09-21T11:00:00.000Z',
        preview_url: 'https://claude.ai/artifact/a',
        outputs: [
          { label: 'Drive‮', url: 'https://drive.google.com/x' },
          { label: 'ok', url: 'http://localhost:3017/p' },
        ],
      }),
      2 * HOUR,
    );
    plant(
      record({
        name: 'userinfo',
        preview_url: 'https://claude.ai@evil.example/',
      }),
      HOUR,
    );
    plant(
      record({ name: 'localhost.evil', preview_url: 'http://localhost.evil/' }),
      50 * 60_000,
    );
    plant(
      record({
        name: 'token',
        preview_url: 'https://claude.ai/p?token=S3CR3T',
        step: 'password=hunter2 step',
      }),
      40 * 60_000,
    );
    plant({ ...record(), kind: 'videos' }, 30 * 60_000);
    plant(
      { ...record({ id: 'wf-bbbbbbbbbbbb' }) },
      20 * 60_000,
      'wf-aaaaaaaaaaaa',
    );
    fs.writeFileSync(path.join(dir, 'README.txt'), 'ignored');
    fs.mkdirSync(path.join(dir, 'archive'));
    const r = listWorkflows(dir, opts);
    expect('workflows' in r).toBe(true);
    if (!('workflows' in r)) return;
    expect(r).toMatchObject({ scanned: 6, candidates: 6, truncated: 0 });
    const byName = new Map(
      r.workflows.map((w) => ['name' in w ? w.name : w.reason, w]),
    );
    expect(byName.get('userinfo')).toMatchObject({
      preview_url: null,
      preview_blocked: 'userinfo',
    });
    expect(byName.get('localhost.evil')).toMatchObject({
      preview_url: null,
      preview_blocked: 'host',
    });
    expect(byName.get('token')).toMatchObject({
      preview_url: null,
      preview_blocked: 'secret-query',
      step: 'password=[redacted] step',
    });
    expect(JSON.stringify(r)).not.toContain('S3CR3T');
    expect(JSON.stringify(r)).not.toContain('hunter2');
    const old = byName.get('old') as WorkflowView;
    expect(old.preview_url).toBe('https://claude.ai/artifact/a');
    expect(old.outputs).toEqual([
      { label: 'Drive', url: null, blocked: 'host' },
      { label: 'ok', url: 'http://localhost:3017/p' },
    ]);
    expect(byName.get('bad-kind')).toMatchObject({
      invalid: true,
      reason: 'bad-kind',
    });
    expect(r.workflows.find((w) => w.id === 'wf-aaaaaaaaaaaa')).toMatchObject({
      invalid: true,
      reason: 'bad-id',
    });
    // Fresh non-terminal first (newest first), then terminal/invalid.
    const names = r.workflows.map((w) =>
      'name' in w ? w.name : `!${w.reason}`,
    );
    expect(names.slice(0, 3)).toEqual(['token', 'localhost.evil', 'userinfo']);
    expect(names[names.length - 1]).toBe('old');
  });

  it('withholds session-authored prose in read-only on the data path', () => {
    plant(
      record({
        step: 's',
        message: 'm',
        session_id: 'a1b2c3d4',
        preview_url: 'https://claude.ai/x',
        outputs: [{ label: 'l', url: 'https://claude.ai/y' }],
      }),
    );
    const w = views(listWorkflows(dir, { ...opts, readOnly: true }))[0];
    expect(Object.keys(w).sort()).toEqual([
      'id',
      'kind',
      'name',
      'percent',
      'started_at',
      'status',
      'updated_at',
    ]);
  });

  it('honours operator preview hosts', () => {
    plant(record({ preview_url: 'https://preview.example.com/a' }));
    expect(views(listWorkflows(dir, opts))[0]).toMatchObject({
      preview_url: null,
      preview_blocked: 'host',
    });
    expect(
      views(listWorkflows(dir, { ...opts, hosts: ['preview.example.com'] }))[0]
        .preview_url,
    ).toBe('https://preview.example.com/a');
  });

  it('refuses a symlinked registry dir and a symlinked record', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-real-'));
    const link = path.join(dir, 'link');
    fs.symlinkSync(real, link);
    expect(listWorkflows(link, opts)).toEqual({
      error: 'registry unavailable',
    });
    expect(createWorkflowWatcher(link, () => {})).toBeNull();
    fs.rmSync(real, { recursive: true, force: true });
    const secret = path.join(dir, 'env');
    fs.writeFileSync(secret, 'KEY=value\n');
    fs.symlinkSync(secret, path.join(dir, 'wf-000000000009.json'));
    const r = listWorkflows(dir, opts);
    expect(views(r)).toEqual([]); // a symlink dirent is not isFile()
    expect(JSON.stringify(r)).not.toContain('value');
  });

  it('bounds the scan, the parse set and the list, ranking stale writers last', () => {
    for (let i = 0; i < 250; i++)
      plant(
        record({
          status: 'done',
          percent: 100,
          finished_at: '2026-09-21T11:00:00.000Z',
        }),
        i * 1000,
      );
    let r = listWorkflows(dir, opts);
    expect(r).toMatchObject({ scanned: 250, candidates: 250, truncated: 50 });
    expect(views(r)).toHaveLength(200);
    // A live `waiting` record older than all 200 done ones stays listed.
    plant(record({ name: 'waiting-old', status: 'waiting' }), 3 * HOUR);
    r = listWorkflows(dir, opts);
    expect(views(r)[0].name).toBe('waiting-old');
    // 5 001 entries → refused; 1 000 entries → at most 600 opens.
    const spy = vi.spyOn(fs, 'openSync');
    expect(listWorkflows(dir, { ...opts, scanMax: 250 })).toMatchObject({
      truncated: -1,
      reason: 'too-many',
      workflows: [],
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockClear();
    r = listWorkflows(dir, { ...opts, candidatesMax: 100 });
    expect(spy).toHaveBeenCalledTimes(100);
    expect(r).toMatchObject({ scanned: 251, candidates: 100, truncated: 51 });
    spy.mockRestore();
  });

  it('ranks fresh non-terminal, then terminal, then stale non-terminal by file mtime', () => {
    for (let i = 0; i < 5; i++)
      plant(
        record({
          name: `stale${i}`,
          status: 'running',
          updated_at: '2999-01-01T00:00:00.000Z',
        }),
        25 * HOUR + i * 1000,
      );
    for (let i = 0; i < 2; i++)
      plant(
        record({ name: `done${i}`, status: 'done', percent: 100 }),
        26 * HOUR + i * 1000,
      );
    plant(record({ name: 'fresh', status: 'waiting' }), 23 * HOUR);
    const names = views(listWorkflows(dir, { ...opts, limit: 4 })).map(
      (w) => w.name,
    );
    expect(names).toEqual(['fresh', 'done0', 'done1', 'stale0']);
    // A record outside the newest-N candidate set is simply absent, whatever
    // its tier would have been (here the two oldest files are the done ones).
    const r = listWorkflows(dir, { ...opts, candidatesMax: 6 });
    expect(views(r).map((w) => w.name)).toEqual([
      'fresh',
      'stale0',
      'stale1',
      'stale2',
      'stale3',
      'stale4',
    ]);
    expect(r).toMatchObject({ scanned: 8, candidates: 6, truncated: 0 });
  });
});

describe('archiveWorkflows', () => {
  it('sweeps terminal records older than N days, skipping existing targets', () => {
    const keep = plant(
      record({
        name: 'recent',
        status: 'done',
        percent: 100,
        finished_at: new Date(T0 - 5 * DAY).toISOString(),
      }),
    );
    const a = record({
      name: 'a',
      status: 'done',
      percent: 100,
      finished_at: new Date(T0 - 40 * DAY).toISOString(),
    });
    const b = record({
      name: 'b',
      status: 'failed',
      finished_at: new Date(T0 - 31 * DAY).toISOString(),
    });
    plant(a);
    plant(b);
    plant(record({ name: 'running-forever' }), 60 * DAY);
    fs.mkdirSync(path.join(dir, 'archive'));
    fs.writeFileSync(path.join(dir, 'archive', `${b.id}.json`), '{}');
    expect(archiveWorkflows(dir, { olderThanDays: 30, now: () => T0 })).toEqual(
      { status: 200, archived: 1, skipped: 1 },
    );
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(path.join(dir, `${a.id}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'archive', `${a.id}.json`))).toBe(true);
    expect(fs.existsSync(path.join(dir, `${b.id}.json`))).toBe(true);
    expect(
      fs.readFileSync(path.join(dir, 'archive', `${b.id}.json`), 'utf-8'),
    ).toBe('{}');
    expect(
      views(listWorkflows(dir, opts))
        .map((w) => w.name)
        .sort(),
    ).toEqual(['b', 'recent', 'running-forever']);
  });

  it('archives one record by id with shape check before any path, and the stale remedy', () => {
    const done = record({
      status: 'done',
      percent: 100,
      finished_at: '2026-09-21T11:00:00.000Z',
    });
    plant(done);
    const fresh = record({ status: 'running' });
    plant(fresh, HOUR);
    const stale = record({ status: 'running' });
    plant(stale, 25 * HOUR);
    expect(
      archiveWorkflows(dir, { olderThanDays: 30, id: '../x', now: () => T0 }),
    ).toEqual({ status: 400, error: 'invalid id' });
    expect(
      archiveWorkflows(dir, {
        olderThanDays: 30,
        id: ['wf-aaaaaaaaaaaa'],
        now: () => T0,
      }),
    ).toEqual({ status: 400, error: 'invalid id' });
    expect(
      archiveWorkflows(dir, {
        olderThanDays: 30,
        id: 'wf-aaaaaaaaaaaa',
        now: () => T0,
      }),
    ).toEqual({ status: 404, error: 'not found' });
    expect(
      archiveWorkflows(dir, { olderThanDays: 30, id: fresh.id, now: () => T0 }),
    ).toEqual({ status: 409, error: 'workflow still active' });
    expect(
      archiveWorkflows(dir, { olderThanDays: 30, id: stale.id, now: () => T0 }),
    ).toEqual({ status: 200, archived: 1, skipped: 0, stale: true });
    expect(
      archiveWorkflows(dir, { olderThanDays: 30, id: done.id, now: () => T0 }),
    ).toEqual({ status: 200, archived: 1, skipped: 0 });
    // A re-created id whose archive target exists is refused, not overwritten.
    plant(done);
    expect(
      archiveWorkflows(dir, { olderThanDays: 30, id: done.id, now: () => T0 }),
    ).toEqual({ status: 409, error: 'already archived' });
    // A symlinked source is not a file → 404, and nothing moves.
    fs.symlinkSync(
      path.join(dir, `${fresh.id}.json`),
      path.join(dir, 'wf-cccccccccccc.json'),
    );
    expect(
      archiveWorkflows(dir, {
        olderThanDays: 30,
        id: 'wf-cccccccccccc',
        now: () => T0,
      }),
    ).toEqual({ status: 404, error: 'not found' });
    expect(fs.existsSync(path.join(dir, `${fresh.id}.json`))).toBe(true);
  });
});

describe('createWorkflowWatcher', () => {
  it('debounces writes into one change and falls back to polling on error', async () => {
    const calls: number[] = [];
    const w = createWorkflowWatcher(dir, () => calls.push(Date.now()), {
      debounceMs: 100,
      pollMs: 100,
    });
    expect(w).not.toBeNull();
    if (!w) return;
    for (let i = 0; i < 3; i++) plant(record());
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toHaveLength(1);
    expect(w.mode).toBe('watch');
    w.close();
    const watchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const polled: number[] = [];
    const p = createWorkflowWatcher(dir, () => polled.push(1), {
      debounceMs: 50,
      pollMs: 60,
    });
    watchSpy.mockRestore();
    expect(p?.mode).toBe('poll');
    await new Promise((r) => setTimeout(r, 200));
    expect(polled.length).toBeGreaterThanOrEqual(2);
    p?.close();
  });
});
