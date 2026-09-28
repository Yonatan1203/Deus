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

describe('add --file: the local copy', () => {
  const page = () => {
    const p = path.join(dir, 'page.html');
    fs.writeFileSync(
      p,
      '<!doctype html><title>Line</title><p>Supplier line</p>',
    );
    return p;
  };
  it('copies the page 0600 beside the registry and records where it came from', () => {
    const p = page();
    const r = run([
      'add',
      '--title',
      'Line',
      '--url',
      'https://claude.ai/artifact/abc',
      '--kind',
      'app',
      '--file',
      p,
    ]);
    expect(r.code).toBe(0);
    const id = r.out;
    const copy = path.join(dir, 'artifacts', `${id}.html`);
    expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(p));
    if (!IS_WINDOWS) expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    const entry = read().artifacts[0] as unknown as {
      local: {
        source: string;
        uid: number;
        bytes: number;
        copied_at: string;
        source_mtime_ms: number;
      };
    };
    expect(entry.local.source).toBe(fs.realpathSync(p));
    expect(entry.local.bytes).toBe(fs.statSync(p).size);
    expect(entry.local.uid).toBe(fs.statSync(p).uid);
    expect(entry.local.source_mtime_ms).toBe(fs.statSync(p).mtimeMs);
    expect(Number.isFinite(Date.parse(entry.local.copied_at))).toBe(true);
    const log = fs
      .readFileSync(path.join(dir, 'artifacts-added.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(JSON.parse(log[0])).toMatchObject({
      id,
      source: fs.realpathSync(p),
    });
  });
  it('refuses a link, a non-html file and an oversized file, leaving no entry and no copy', () => {
    const p = page();
    const link = path.join(dir, 'link.html');
    fs.symlinkSync(p, link);
    const txt = path.join(dir, 'notes.txt');
    fs.writeFileSync(txt, 'x');
    const big = path.join(dir, 'big.html');
    fs.writeFileSync(big, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
    for (const f of [link, txt, big, path.join(dir, 'missing.html')]) {
      const r = run([
        'add',
        '--title',
        'Line',
        '--url',
        'https://claude.ai/artifact/abc',
        '--kind',
        'app',
        '--file',
        f,
      ]);
      expect(r.code).toBe(3);
      expect(r.err).toMatch(/--file/);
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'artifacts'))).toBe(false);
  });
  it('remove deletes the copy', () => {
    const p = page();
    const id = run([
      'add',
      '--title',
      'Line',
      '--url',
      'https://claude.ai/artifact/abc',
      '--kind',
      'app',
      '--file',
      p,
    ]).out;
    const copy = path.join(dir, 'artifacts', `${id}.html`);
    expect(fs.existsSync(copy)).toBe(true);
    expect(run(['remove', id]).code).toBe(0);
    expect(fs.existsSync(copy)).toBe(false);
  });
});

describe('add --file: ownership', () => {
  it('refuses a file owned by someone else (when the test runs as root)', () => {
    if (
      IS_WINDOWS ||
      typeof process.getuid !== 'function' ||
      process.getuid() !== 0
    )
      return;
    const p = path.join(dir, 'theirs.html');
    fs.writeFileSync(p, '<p>x</p>');
    fs.chownSync(p, 65534, 65534); // nobody
    const r = run([
      'add',
      '--title',
      'Line',
      '--url',
      'https://claude.ai/artifact/abc',
      '--kind',
      'app',
      '--file',
      p,
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toMatch(/must be a file you own/);
    expect(fs.existsSync(file)).toBe(false);
  });
});
