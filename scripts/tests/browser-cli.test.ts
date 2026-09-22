import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../../src/platform.js';
import {
  readRules,
  validateJob,
  validateRules,
} from '../../src/control-ui/api/browser-store.js';

// The two CLIs carry their own copies of the shape rules (they are .mjs and
// cannot import the TypeScript store). These tests are the agreement: whatever
// a CLI writes must be accepted by the store that reads it, and whatever a CLI
// refuses must be something the store would also refuse.
const JOB_CLI = path.join(import.meta.dirname, '..', 'browser-job.mjs');
const RULES_CLI = path.join(import.meta.dirname, '..', 'browser-rules.mjs');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bcli-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (cli: string, args: string[]) => {
  const r = spawnSync(process.execPath, [cli, ...args, '--dir', dir], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '' },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const rulesFile = (body: object) => {
  const f = path.join(dir, 'input.json');
  fs.writeFileSync(f, JSON.stringify(body));
  return f;
};
const setRules = (body: object, site = 'instagram') =>
  run(RULES_CLI, ['set', '--site', site, '--file', rulesFile(body)]);
const goodRules = {
  enabled: true,
  weekly_cap: 25,
  allow: { kinds: ['follow'], handles: ['@Ours'] },
};

describe('browser-rules.mjs', () => {
  it('writes rules the store accepts, defaulting the daily cap from the weekly one', () => {
    expect(setRules(goodRules).code).toBe(0);
    const file = path.join(dir, 'rules', 'instagram.json');
    if (!IS_WINDOWS) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(onDisk).toMatchObject({
      v: 1,
      site: 'instagram',
      weekly_cap: 25,
      daily_cap: 4,
    });
    const v = validateRules(onDisk, 'instagram');
    expect(v.ok).toBe(true);
    expect(readRules(dir, 'instagram')).toMatchObject({
      rules: { enabled: true, weekly_cap: 25 },
    });
  });

  it('cannot enable autonomy, however it is asked to', () => {
    const r = setRules({
      ...goodRules,
      autonomous: true,
      autonomy_confirmed_at: new Date().toISOString(),
      autonomy_scope_sha256: 'deadbeef',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('autonomy was NOT enabled');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, 'rules', 'instagram.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(onDisk.autonomous).toBe(false);
    expect(onDisk.autonomy_confirmed_at).toBeUndefined();
    expect(onDisk.autonomy_scope_sha256).toBeUndefined();
    expect(readRules(dir, 'instagram').rules.autonomous).toBe(false);
  });

  it('refuses exactly what the store would refuse', () => {
    const cases: [object, string][] = [
      [{ ...goodRules, weekly_cap: 501 }, 'weekly_cap'],
      [{ ...goodRules, weekly_cap: 10, daily_cap: 20 }, 'exceeds'],
      [
        { ...goodRules, allow: { kinds: ['dm'], handles: ['@a'] } },
        'unknown kind',
      ],
      [
        { ...goodRules, allow: { kinds: [], handles: [] } },
        'at least one kind',
      ],
      [{ ...goodRules, quiet_hours: [22, 24] }, 'quiet_hours'],
      [
        {
          ...goodRules,
          allow: {
            kinds: ['follow'],
            handles: Array.from({ length: 600 }, (_, i) => `h${i}`),
          },
        },
        'allow lists',
      ],
    ];
    for (const [body, needle] of cases) {
      const r = setRules(body);
      expect(r.code, JSON.stringify(body).slice(0, 60)).toBe(3);
      expect(r.err).toContain(needle);
      expect(fs.existsSync(path.join(dir, 'rules', 'instagram.json'))).toBe(
        false,
      );
      // And the store agrees these are not valid rules.
      const v = validateRules(
        { v: 1, site: 'instagram', autonomous: false, ...body },
        'instagram',
      );
      expect(v.ok, `store should refuse ${needle}`).toBe(false);
    }
    expect(
      run(RULES_CLI, [
        'set',
        '--site',
        'twitter',
        '--file',
        rulesFile(goodRules),
      ]).code,
    ).toBe(3);
    expect(run(RULES_CLI, ['show', '--site', 'instagram']).out).toContain(
      'no rules',
    );
  });
});

describe('browser-job.mjs', () => {
  beforeEach(() => {
    setRules({
      ...goodRules,
      allow: { kinds: ['follow'], handles: ['@Ours'] },
    });
  });

  it('proposes a job the store accepts, with a status it alone can write', () => {
    const r = run(JOB_CLI, [
      'propose',
      '--site',
      'instagram',
      '--kind',
      'follow',
      '--handle',
      '@ours',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^bj-[0-9a-f]{12}$/);
    const file = path.join(dir, 'jobs', `${r.out}.json`);
    if (!IS_WINDOWS) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(onDisk).toMatchObject({
      status: 'proposed',
      proposed_by: 'cli',
      kind: 'instagram.follow',
    });
    const v = validateJob(onDisk, r.out);
    expect(v.ok && v.job.status).toBe('proposed');
    expect(run(JOB_CLI, ['list']).out).toContain(r.out);
    expect(JSON.parse(run(JOB_CLI, ['show', r.out]).out)).toMatchObject({
      id: r.out,
    });
  });

  it("refuses a target outside the operator's allow-list, and bad shapes", () => {
    const outside = run(JOB_CLI, [
      'propose',
      '--site',
      'instagram',
      '--kind',
      'follow',
      '--handle',
      '@stranger',
    ]);
    expect(outside.code).toBe(3);
    expect(outside.err).toContain('allow-list');
    expect(
      run(JOB_CLI, [
        'propose',
        '--site',
        'instagram',
        '--kind',
        'follow',
        '--handle',
        'a/b',
      ]).code,
    ).toBe(3);
    expect(
      run(JOB_CLI, [
        'propose',
        '--site',
        'instagram',
        '--kind',
        'dm',
        '--handle',
        '@ours',
      ]).code,
    ).toBe(3);
    expect(
      run(JOB_CLI, ['propose', '--site', 'instagram', '--kind', 'follow']).code,
    ).toBe(3);
    expect(run(JOB_CLI, ['show', 'nope']).code).toBe(2);
    expect(run(JOB_CLI, ['show', 'bj-000000000000']).code).toBe(4);
    expect(fs.existsSync(path.join(dir, 'jobs'))).toBe(false);
  });

  it('refuses everything for a site with no rules at all', () => {
    const r = run(JOB_CLI, [
      'propose',
      '--site',
      'alibaba',
      '--kind',
      'list_threads',
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('no rules');
  });

  it('enforces the reply body bounds the store enforces', () => {
    setRules(
      {
        enabled: true,
        weekly_cap: 10,
        allow: { kinds: ['reply'], threads: ['T1'] },
      },
      'alibaba',
    );
    const ok = run(JOB_CLI, [
      'propose',
      '--site',
      'alibaba',
      '--kind',
      'reply',
      '--thread',
      'T1',
      '--body',
      'hello',
    ]);
    expect(ok.code).toBe(0);
    const tooLong = run(JOB_CLI, [
      'propose',
      '--site',
      'alibaba',
      '--kind',
      'reply',
      '--thread',
      'T1',
      '--body',
      'x'.repeat(2001),
    ]);
    expect(tooLong.code).toBe(3);
    expect(
      validateJob(
        {
          v: 1,
          id: 'bj-000000000001',
          site: 'alibaba',
          kind: 'alibaba.reply',
          params: { thread_id: 'T1', body: 'x'.repeat(2001) },
          status: 'proposed',
          proposed_by: 'cli',
          proposed_at: new Date().toISOString(),
          rev: 1,
        },
        'bj-000000000001',
      ),
    ).toMatchObject({ ok: false, reason: 'bad-params' });
  });
});
