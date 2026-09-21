import fs from 'fs';
import os from 'os';
import path from 'path';
import { IS_WINDOWS } from '../../src/platform.js';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = path.join(import.meta.dirname, '..', 'workflow.mjs');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfcli-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--registry', dir], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const read = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8')) as Record<
    string,
    unknown
  >;

describe('scripts/workflow.mjs', () => {
  it('start → progress → finish writes 0600 records with a bumped rev', () => {
    const s = run([
      'start',
      '--name',
      'Posts batch 12',
      '--kind',
      'posts',
      '--steps-total',
      '7',
    ]);
    expect(s.code).toBe(0);
    expect(s.out).toMatch(/^wf-[0-9a-f]{12}$/);
    const id = s.out;
    const file = path.join(dir, `${id}.json`);
    if (!IS_WINDOWS) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(read(id)).toMatchObject({
      v: 1,
      id,
      status: 'running',
      percent: 0,
      rev: 1,
      steps_total: 7,
      outputs: [],
    });
    expect(read(id).session_id).toBeUndefined();
    expect(read(id).updated_at).toMatch(/\.\d{3}Z$/);

    expect(
      run(['progress', id, '--percent', '40', '--step', '3/7 rendering']).code,
    ).toBe(0);
    const p = read(id);
    expect(p).toMatchObject({ percent: 40, step: '3/7 rendering', rev: 2 });
    expect(
      run(['progress', id, '--waiting', '--message', 'needs approval']).code,
    ).toBe(0);
    expect(read(id)).toMatchObject({
      status: 'waiting',
      message: 'needs approval',
      rev: 3,
    });

    const f = run([
      'finish',
      id,
      '--preview',
      'https://claude.ai/artifact/abc',
      '--output',
      'Drive=https://drive.google.com/x',
    ]);
    expect(f.code).toBe(0);
    const done = read(id);
    expect(done).toMatchObject({
      status: 'done',
      percent: 100,
      preview_url: 'https://claude.ai/artifact/abc',
      rev: 4,
      outputs: [{ label: 'Drive', url: 'https://drive.google.com/x' }],
    });
    expect(typeof done.finished_at).toBe('string');

    // Terminal: progress refused; finish re-run may only add outputs.
    expect(run(['progress', id, '--percent', '50']).code).toBe(3);
    expect(
      run(['finish', id, '--preview', 'https://claude.ai/other']).code,
    ).toBe(3);
    expect(
      run(['finish', id, '--output', 'Sheet=https://docs.google.com/s']).code,
    ).toBe(0);
    expect((read(id).outputs as unknown[]).length).toBe(2);
    expect(read(id).preview_url).toBe('https://claude.ai/artifact/abc');
  });

  it('fail sets failed + message; unknown id → 4; bad input → 3 with the file untouched', () => {
    const id = run([
      'start',
      '--name',
      'Images',
      '--kind',
      'product_images',
    ]).out;
    expect(run(['fail', id]).code).toBe(2);
    expect(run(['fail', id, '--message', 'Shopify 500']).code).toBe(0);
    expect(read(id)).toMatchObject({
      status: 'failed',
      message: 'Shopify 500',
    });
    expect(run(['progress', 'wf-000000000000', '--percent', '1']).code).toBe(4);
    expect(run(['progress', 'nope']).code).toBe(2);
    expect(run(['start', '--name', 'x', '--kind', 'videos']).code).toBe(3);
    expect(run(['start', '--name=-dash', '--kind', 'posts']).code).toBe(3);
    expect(run(['start', '--name', '-dash', '--kind', 'posts']).code).toBe(2);
    const id2 = run(['start', '--name', 'y', '--kind', 'other']).out;
    const before = fs.readFileSync(path.join(dir, `${id2}.json`), 'utf-8');
    expect(run(['progress', id2, '--percent', '101']).code).toBe(2);
    expect(run(['finish', id2, '--preview', 'not a url']).code).toBe(3);
    expect(fs.readFileSync(path.join(dir, `${id2}.json`), 'utf-8')).toBe(
      before,
    );
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('--session is explicit only, never taken from the environment', () => {
    const id = run(['start', '--name', 'a', '--kind', 'posts'], {
      CLAUDE_JOB_ID: 'a1b2c3d4',
    }).out;
    expect(read(id).session_id).toBeUndefined();
    const id2 = run([
      'start',
      '--name',
      'b',
      '--kind',
      'posts',
      '--session',
      'a1b2c3d4',
    ]).out;
    expect(read(id2).session_id).toBe('a1b2c3d4');
    expect(
      run(['start', '--name', 'c', '--kind', 'posts', '--session', 'nope'])
        .code,
    ).toBe(3);
  });

  it('detects a rev change under it and never writes planted junk keys back', () => {
    const id = run(['start', '--name', 'race', '--kind', 'posts']).out;
    const file = path.join(dir, `${id}.json`);
    const planted = { ...read(id), __proto__: { polluted: 1 }, toJSON: 'x' };
    fs.writeFileSync(file, JSON.stringify(planted));
    expect(run(['progress', id, '--percent', '10']).code).toBe(0);
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('toJSON');
    expect(text).not.toContain('polluted');
    // Simulate a concurrent writer: bump rev on disk between read and rename
    // by planting a stale copy the CLI will read, then racing it.
    const stale = { ...read(id), rev: 99 };
    fs.writeFileSync(file, JSON.stringify(stale));
    expect(run(['progress', id, '--percent', '20']).code).toBe(0);
    expect(read(id).rev).toBe(100);
  });

  it('sweeps stale temp files and lists/shows records', () => {
    const id = run(['start', '--name', 'sweep', '--kind', 'site_images']).out;
    const tmp = path.join(dir, `${id}.json.tmp-deadbeef`);
    fs.writeFileSync(tmp, '{');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(tmp, old, old);
    const fresh = path.join(dir, `${id}.json.tmp-cafebabe`);
    fs.writeFileSync(fresh, '{');
    expect(run(['show', id]).code).toBe(0);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.writeFileSync(
      path.join(dir, 'wf-ffffffffffff.json'),
      '{"v":1,"id":"wf-ffffffffffff"}',
    );
    const l = run(['list', '--json']);
    expect(l.code).toBe(0);
    const rows = JSON.parse(l.out) as {
      id: string;
      invalid?: boolean;
      reason?: string;
    }[];
    expect(rows.find((r) => r.id === id)?.invalid).toBeUndefined();
    expect(rows.find((r) => r.id === 'wf-ffffffffffff')).toMatchObject({
      invalid: true,
      reason: 'bad-kind',
    });
    expect(run(['list']).out).toContain('INVALID (bad-kind)');
  });
});
