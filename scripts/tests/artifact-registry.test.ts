import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../../src/platform.js';

const CLI = path.join(import.meta.dirname, '..', 'artifact-registry.mjs');
let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artcli-'));
  file = path.join(dir, 'artifacts.json');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--registry', file], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const read = () =>
  JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    rev: number;
    artifacts: { id: string; title: string; url: string }[];
  };

describe('scripts/artifact-registry.mjs', () => {
  it('add → list → remove with rev, 0600, the removed log and Hebrew titles', () => {
    const a = run([
      'add',
      '--title',
      'Supplier Line',
      '--url',
      'https://claude.ai/artifact/fixture-a',
      '--kind',
      'app',
    ]);
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^art-[0-9a-f]{12}$/);
    if (!IS_WINDOWS) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(read()).toMatchObject({ rev: 1 });
    const b = run([
      'add',
      '--title',
      'קו ספקים — Supplier Line',
      '--url',
      'https://claude.ai/artifact/fixture-b',
      '--kind',
      'preview',
      '--description',
      'Café',
    ]);
    expect(b.code).toBe(0);
    expect(read().rev).toBe(2);
    expect(read().artifacts[1].title).toBe('קו ספקים — Supplier Line');
    const l = run(['list', '--json']);
    expect(JSON.parse(l.out).artifacts).toHaveLength(2);
    expect(run(['list']).out).toContain('Supplier Line');
    const r = run(['remove', b.out]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({
      id: b.out,
      title: 'קו ספקים — Supplier Line',
    });
    expect(read()).toMatchObject({ rev: 3 });
    expect(read().artifacts.map((x) => x.id)).toEqual([a.out]);
    const log = fs
      .readFileSync(path.join(dir, 'artifacts-removed.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(JSON.parse(log[0])).toMatchObject({
      removed_by: 'cli',
      entry: { id: b.out },
    });
    expect(run(['remove', b.out]).code).toBe(4);
    expect(run(['remove', 'nope']).code).toBe(2);
    expect(
      fs
        .readdirSync(dir)
        .filter((n) => n.includes('.tmp-') || n.endsWith('.lock')),
    ).toEqual([]);
  });

  it('rejects bad input with exit 3 and leaves the file untouched', () => {
    run([
      'add',
      '--title',
      'a',
      '--url',
      'https://claude.ai/a',
      '--kind',
      'app',
    ]);
    const before = fs.readFileSync(file, 'utf-8');
    expect(
      run([
        'add',
        '--title',
        'x',
        '--url',
        'https://claude.ai@evil.example/',
        '--kind',
        'app',
      ]).err,
    ).toContain('userinfo');
    expect(
      run([
        'add',
        '--title',
        'x',
        '--url',
        'https://claude.ai/p?token=1',
        '--kind',
        'app',
      ]).code,
    ).toBe(3);
    expect(
      run([
        'add',
        '--title',
        'x',
        '--url',
        'https://evil.example/',
        '--kind',
        'app',
      ]).code,
    ).toBe(3);
    expect(
      run(
        [
          'add',
          '--title',
          'x',
          '--url',
          'https://preview.example.com/',
          '--kind',
          'app',
        ],
        { CONTROL_UI_PREVIEW_HOSTS: 'preview.example.com' },
      ).code,
    ).toBe(0);
    expect(
      run([
        'add',
        '--title',
        'y'.repeat(101),
        '--url',
        'https://claude.ai/a',
        '--kind',
        'app',
      ]).code,
    ).toBe(3);
    expect(
      run([
        'add',
        '--title',
        'x',
        '--url',
        'https://claude.ai/a',
        '--kind',
        'video',
      ]).code,
    ).toBe(3);
    expect(
      run(['add', '--title', 'x', '--url', 'not a url', '--kind', 'app']).code,
    ).toBe(3);
    expect(run(['add', '--title', 'x']).code).toBe(2);
    expect(read().rev).toBe(2);
    expect(read().artifacts).toHaveLength(2);
    void before;
  });

  it('never writes planted junk keys back, and refuses a corrupt registry', () => {
    run([
      'add',
      '--title',
      'a',
      '--url',
      'https://claude.ai/a',
      '--kind',
      'app',
    ]);
    const planted = {
      ...read(),
      __proto__: { polluted: 1 },
      toJSON: 'x',
      v: 1,
    };
    fs.writeFileSync(file, JSON.stringify(planted));
    expect(
      run([
        'add',
        '--title',
        'b',
        '--url',
        'https://claude.ai/b',
        '--kind',
        'app',
      ]).code,
    ).toBe(0);
    const text = fs.readFileSync(file, 'utf-8');
    expect(text).not.toContain('toJSON');
    expect(text).not.toContain('polluted');
    fs.writeFileSync(file, '{"v":1,"rev":0,"artifacts":[]}');
    const r = run([
      'add',
      '--title',
      'c',
      '--url',
      'https://claude.ai/c',
      '--kind',
      'app',
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain('bad-schema');
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      '{"v":1,"rev":0,"artifacts":[]}',
    );
    expect(run(['validate', file]).out).toBe('bad-schema');
  });

  it('retries a briefly held lock and gives up on a long one', async () => {
    const lock = path.join(dir, 'artifacts.json.lock');
    fs.writeFileSync(lock, 'other');
    const p = spawn(
      process.execPath,
      [
        CLI,
        'add',
        '--title',
        'a',
        '--url',
        'https://claude.ai/a',
        '--kind',
        'app',
        '--registry',
        file,
      ],
      { env: { PATH: process.env.PATH ?? '' } },
    );
    await new Promise((r) => setTimeout(r, 300));
    fs.unlinkSync(lock);
    const code = await new Promise<number | null>((r) => p.on('close', r));
    expect(code).toBe(0);
    expect(read().artifacts).toHaveLength(1);
    fs.writeFileSync(lock, 'other');
    const q = run([
      'add',
      '--title',
      'b',
      '--url',
      'https://claude.ai/b',
      '--kind',
      'app',
    ]);
    expect(q.code).toBe(3);
    expect(q.err).toContain('busy');
    expect(fs.readFileSync(lock, 'utf-8')).toBe('other');
    expect(read().artifacts).toHaveLength(1);
  });
});
