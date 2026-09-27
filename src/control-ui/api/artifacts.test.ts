import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addArtifact,
  listArtifacts,
  readRegistry,
  removeArtifact,
  validateRegistry,
  withLock,
  writeRegistry,
  REGISTRY_FILE,
  REMOVED_LOG,
  type ArtifactEntry,
  type ArtifactView,
} from './artifacts.js';
import { NAME_RE as WORKFLOW_NAME_RE } from './workflows.js';
import { IS_WINDOWS } from '../../platform.js';
import { TITLE_RE } from './artifacts.js';

const FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'artifacts');
const WF_FIXTURES = path.join(import.meta.dirname, '__fixtures__', 'workflows');
const CLI = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'scripts',
  'artifact-registry.mjs',
);
const T0 = Date.parse('2026-09-21T12:00:00.000Z');
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
let seq = 0;
const entry = (over: Partial<ArtifactEntry> = {}): ArtifactEntry => ({
  id: `art-${(seq++).toString(16).padStart(12, '0')}`,
  title: 'Supplier Line',
  url: 'https://claude.ai/artifact/fixture',
  kind: 'app',
  added_at: '2026-09-21T10:00:00.000Z',
  added_by: 'cli',
  ...over,
});
const plant = (artifacts: object[], rev = 1) =>
  fs.writeFileSync(
    path.join(dir, REGISTRY_FILE),
    JSON.stringify({ v: 1, rev, artifacts }),
    { mode: 0o600 },
  );
const opts = { hosts: [] as string[], readOnly: false };
const rows = (r: ReturnType<typeof listArtifacts>) =>
  ('artifacts' in r ? r.artifacts : []) as ArtifactView[];
const file = () =>
  JSON.parse(fs.readFileSync(path.join(dir, REGISTRY_FILE), 'utf-8')) as {
    rev: number;
    artifacts: ArtifactEntry[];
  };

describe('validateRegistry', () => {
  it('agrees with the CLI validator over the shared fixtures', () => {
    const expected = JSON.parse(
      fs.readFileSync(path.join(FIXTURES, 'expected.json'), 'utf-8'),
    ) as Record<string, string>;
    expect(Object.keys(expected)).toHaveLength(8);
    for (const [name, want] of Object.entries(expected)) {
      const f = path.join(FIXTURES, `${name}.json`);
      const v = validateRegistry(JSON.parse(fs.readFileSync(f, 'utf-8')));
      expect(v.ok ? 'ok' : v.reason, name).toBe(want);
      let cli: string;
      try {
        cli = execFileSync(process.execPath, [CLI, 'validate', f], {
          encoding: 'utf-8',
        }).trim();
      } catch (err) {
        cli = String((err as { stdout: string }).stdout).trim();
      }
      expect(cli, `cli ${name}`).toBe(want);
    }
  });

  it('builds a fresh literal and every workflow fixture name passes the title rule', () => {
    const raw = JSON.parse(
      '{"v":1,"rev":3,"artifacts":[{"id":"art-0123456789ab","title":"t","url":"https://claude.ai/x","kind":"app","added_at":"2026-09-21T10:00:00.000Z","added_by":"cli","toJSON":"x","__proto__":{"polluted":1}}],"toJSON":1}',
    ) as unknown;
    const v = validateRegistry(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(Object.keys(v.registry)).toEqual(['v', 'rev', 'artifacts']);
    expect(Object.keys(v.registry.artifacts[0]).sort()).toEqual([
      'added_at',
      'added_by',
      'id',
      'kind',
      'title',
      'url',
    ]);
    for (const f of fs
      .readdirSync(WF_FIXTURES)
      .filter((n) => n.startsWith('valid-'))) {
      const name = (
        JSON.parse(fs.readFileSync(path.join(WF_FIXTURES, f), 'utf-8')) as {
          name: string;
        }
      ).name;
      expect(WORKFLOW_NAME_RE.test(name), f).toBe(true);
      expect(TITLE_RE.test(name), f).toBe(true);
    }
  });
});

describe('listArtifacts', () => {
  it('missing file → empty rev 0; symlink → unreadable and no leak; oversize → too-large', () => {
    expect(listArtifacts(dir, opts)).toEqual({ artifacts: [], rev: 0 });
    const secret = path.join(dir, 'env');
    fs.writeFileSync(secret, 'KEY=hunter2\n');
    fs.symlinkSync(secret, path.join(dir, REGISTRY_FILE));
    const r = listArtifacts(dir, opts);
    expect(r).toEqual({
      artifacts: [],
      rev: 0,
      invalid: true,
      reason: 'unreadable',
    });
    expect(JSON.stringify(r)).not.toContain('hunter2');
    fs.unlinkSync(path.join(dir, REGISTRY_FILE));
    fs.writeFileSync(path.join(dir, REGISTRY_FILE), 'x'.repeat(300 * 1024));
    expect(listArtifacts(dir, opts)).toMatchObject({
      invalid: true,
      reason: 'too-large',
    });
    const link = path.join(dir, 'link');
    fs.symlinkSync(dir, link);
    expect(listArtifacts(link, opts)).toEqual({
      error: 'registry unavailable',
    });
  });

  it('projects urls through the read-time check and withholds in read-only', () => {
    plant(
      [
        entry({ title: 'ok', description: 'password=hunter2 here\u202e' }),
        entry({ title: 'planted', url: 'javascript:alert(1)' }),
        entry({ title: 'ext', url: 'https://preview.example.com/a' }),
        entry({ title: 'tok', url: 'https://claude.ai/a?access_token=S3CR3T' }),
      ],
      7,
    );
    const r = listArtifacts(dir, opts);
    expect(r).toMatchObject({ rev: 7 });
    const [ok, planted, ext, tok] = rows(r);
    expect(ok).toMatchObject({
      title: 'ok',
      url: 'https://claude.ai/artifact/fixture',
      hostname: 'claude.ai',
      description: 'password=[redacted] here',
    });
    expect(planted).toMatchObject({ url: null, blocked: 'protocol' });
    expect(ext).toMatchObject({
      url: null,
      blocked: 'host',
      hostname: 'preview.example.com',
    });
    expect(tok).toMatchObject({ url: null, blocked: 'secret-query' });
    expect(JSON.stringify(r)).not.toContain('S3CR3T');
    expect(JSON.stringify(r)).not.toContain('hunter2');
    expect(
      rows(listArtifacts(dir, { ...opts, hosts: ['preview.example.com'] }))[2]
        .url,
    ).toBe('https://preview.example.com/a');
    const ro = rows(listArtifacts(dir, { ...opts, readOnly: true }));
    for (const v of ro) {
      expect(v).not.toHaveProperty('url');
      expect(v).not.toHaveProperty('blocked');
      expect(v).not.toHaveProperty('description');
      expect(typeof v.hostname).toBe('string');
    }
  });
});

describe('writers', () => {
  it('add validates input, writes rev+1 under a 0600 file, rejects disallowed urls and caps entries', () => {
    const now = () => T0;
    expect(
      addArtifact(
        dir,
        { title: '', url: 'https://claude.ai/x', kind: 'app' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400 });
    expect(
      addArtifact(
        dir,
        { title: 'x'.repeat(101), url: 'https://claude.ai/x', kind: 'app' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400 });
    expect(
      addArtifact(
        dir,
        { title: 'ok', url: 'https://claude.ai/x', kind: 'video' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400 });
    expect(
      addArtifact(
        dir,
        { title: 'ok', url: 'javascript:alert(1)', kind: 'app' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400, blocked: 'protocol' });
    expect(
      addArtifact(
        dir,
        { title: 'ok', url: 'https://evil.example/', kind: 'app' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400, blocked: 'host' });
    expect(
      addArtifact(
        dir,
        { title: 'ok', url: 'https://claude.ai/?api_key=1', kind: 'app' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400, blocked: 'secret-query' });
    expect(
      addArtifact(
        dir,
        { title: 'ok', url: 42, kind: 'app' },
        { hosts: [], now },
      ),
    ).toMatchObject({ status: 400, error: 'url invalid' });
    const a = addArtifact(
      dir,
      {
        title: 'קו ספקים',
        url: 'https://claude.ai/artifact/a',
        kind: 'app',
        description: 'd',
      },
      { hosts: [], now },
    );
    expect(a).toMatchObject({ status: 201, rev: 1 });
    if (!IS_WINDOWS)
      expect(fs.statSync(path.join(dir, REGISTRY_FILE)).mode & 0o777).toBe(
        0o600,
      );
    expect(file()).toMatchObject({ rev: 1 });
    expect(file().artifacts[0]).toMatchObject({
      title: 'קו ספקים',
      added_by: 'dashboard',
      description: 'd',
      added_at: '2026-09-21T12:00:00.000Z',
    });
    expect(
      addArtifact(
        dir,
        { title: 'ext', url: 'https://preview.example.com/', kind: 'preview' },
        { hosts: ['preview.example.com'], now },
      ),
    ).toMatchObject({ status: 201, rev: 2 });
    expect(
      fs
        .readdirSync(dir)
        .filter((n) => n.includes('.tmp-') || n.endsWith('.lock')),
    ).toEqual([]);
    plant(
      Array.from({ length: 200 }, () => entry()),
      5,
    );
    expect(
      addArtifact(
        dir,
        { title: 'one more', url: 'https://claude.ai/x', kind: 'app' },
        { hosts: [], now },
      ),
    ).toEqual({ status: 409, error: 'registry full' });
    // Byte budget: 90 entries of ~2.4 KB (about 220 KB) sit above the 192 KB write budget and below the 256 KB read bound.
    plant(
      Array.from({ length: 90 }, () =>
        entry({
          url: 'https://claude.ai/' + 'a'.repeat(2000),
          description: 'x'.repeat(300),
        }),
      ),
      6,
    );
    expect(
      addArtifact(
        dir,
        {
          title: 'big',
          url: 'https://claude.ai/' + 'a'.repeat(2000),
          kind: 'app',
        },
        { hosts: [], now },
      ),
    ).toEqual({ status: 409, error: 'registry full' });
    expect(file().rev).toBe(6);
    expect(fs.readdirSync(dir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('refuses to write over an invalid registry and honours a rev changed under it', () => {
    fs.writeFileSync(
      path.join(dir, REGISTRY_FILE),
      '{"v":1,"rev":0,"artifacts":[]}',
    );
    expect(
      addArtifact(
        dir,
        { title: 'a', url: 'https://claude.ai/x', kind: 'app' },
        { hosts: [] },
      ),
    ).toEqual({
      status: 503,
      error: 'registry unreadable',
      reason: 'bad-schema',
    });
    expect(removeArtifact(dir, 'art-000000000000', 'art-000000000000')).toEqual(
      { status: 503, error: 'registry unreadable', reason: 'bad-schema' },
    );
    const e = entry();
    plant([e], 3);
    expect(writeRegistry(dir, { v: 1, rev: 4, artifacts: [] }, 2)).toEqual({
      ok: false,
      status: 409,
      error: 'registry changed',
    });
    expect(file().rev).toBe(3);
    expect(writeRegistry(dir, { v: 1, rev: 4, artifacts: [] }, 3)).toEqual({
      ok: true,
      rev: 4,
    });
  });

  it('remove needs the exact id as confirmation, logs the entry, and 409s on a fresh lock', () => {
    const e = entry({ title: 'קו ספקים — Supplier Line' });
    plant([e], 2);
    expect(removeArtifact(dir, '../x', '../x')).toEqual({
      status: 404,
      error: 'not found',
    });
    expect(removeArtifact(dir, e.id, undefined)).toEqual({
      status: 428,
      error: 'confirmation required',
    });
    expect(removeArtifact(dir, e.id, e.title)).toEqual({
      status: 428,
      error: 'confirmation required',
    });
    expect(removeArtifact(dir, 'art-ffffffffffff', 'art-ffffffffffff')).toEqual(
      { status: 404, error: 'not found' },
    );
    const lock = path.join(dir, `${REGISTRY_FILE}.lock`);
    fs.writeFileSync(lock, 'other');
    expect(
      removeArtifact(dir, e.id, e.id, { now: () => Date.now() + 1000 }),
    ).toEqual({ status: 409, error: 'registry busy' });
    expect(fs.readFileSync(lock, 'utf-8')).toBe('other'); // a lock we do not own is left alone
    const old = new Date(Date.now() - 6000);
    fs.utimesSync(lock, old, old);
    const r = removeArtifact(dir, e.id, e.id);
    expect(r).toMatchObject({ status: 204, entry: { id: e.id } });
    expect(file()).toMatchObject({ rev: 3, artifacts: [] });
    expect(fs.existsSync(lock)).toBe(false);
    const log = fs
      .readFileSync(path.join(dir, REMOVED_LOG), 'utf-8')
      .trim()
      .split('\n');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0])).toMatchObject({
      removed_by: 'dashboard',
      entry: { id: e.id, title: e.title },
    });
    // Rotation past 1 MB.
    fs.writeFileSync(path.join(dir, REMOVED_LOG), 'x'.repeat(1024 * 1024 + 1));
    plant([e], 3);
    expect(removeArtifact(dir, e.id, e.id)).toMatchObject({ status: 204 });
    expect(fs.statSync(path.join(dir, `${REMOVED_LOG}.1`)).size).toBe(
      1024 * 1024 + 1,
    );
    expect(
      fs.readFileSync(path.join(dir, REMOVED_LOG), 'utf-8').trim().split('\n'),
    ).toHaveLength(1);
  });

  it('withLock releases only its own nonce', () => {
    const lock = path.join(dir, `${REGISTRY_FILE}.lock`);
    withLock(dir, () => {
      expect(fs.existsSync(lock)).toBe(true);
      fs.writeFileSync(lock, 'stolen');
    });
    expect(fs.readFileSync(lock, 'utf-8')).toBe('stolen');
    expect(readRegistry(dir)).toEqual({
      ok: true,
      registry: { v: 1, rev: 0, artifacts: [] },
    });
  });
});

describe('local copies', () => {
  const entryWith = (local: unknown): ArtifactEntry =>
    ({
      id: 'art-0123456789ab',
      title: 'Line',
      url: 'https://claude.ai/artifact/abc',
      kind: 'app',
      added_at: '2026-09-27T08:00:00.000Z',
      added_by: 'cli',
      ...(local !== undefined ? { local } : {}),
    }) as ArtifactEntry;
  const good = {
    source: '/tmp/page.html',
    uid: 0,
    bytes: 42,
    copied_at: '2026-09-27T08:00:00.000Z',
    source_mtime_ms: 1790000000000,
  };
  it('keeps a well-formed record and drops a malformed one', () => {
    const v = validateRegistry({ v: 1, rev: 1, artifacts: [entryWith(good)] });
    expect(v.ok && v.registry.artifacts[0].local).toEqual(good);
    const bad = validateRegistry({
      v: 1,
      rev: 1,
      artifacts: [entryWith({ ...good, source: 'relative.html' })],
    });
    expect(bad.ok && bad.registry.artifacts[0].local).toBeUndefined();
    expect(bad.ok && bad.registry.artifacts[0].id).toBe('art-0123456789ab');
  });
  it('lists only a boolean, also for read-only viewers, and keeps the record across dashboard writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artloc-'));
    try {
      expect(
        writeRegistry(dir, { v: 1, rev: 1, artifacts: [entryWith(good)] }, 0)
          .ok,
      ).toBe(true);
      const l = listArtifacts(dir, { hosts: [], readOnly: true });
      expect('artifacts' in l && l.artifacts[0]).toMatchObject({ local: true });
      expect('artifacts' in l && JSON.stringify(l.artifacts[0])).not.toContain(
        '/tmp/page.html',
      );
      const added = addArtifact(
        dir,
        {
          title: 'Other',
          url: 'https://claude.ai/artifact/def',
          kind: 'report',
        },
        { hosts: [] },
      );
      expect(added.status).toBe(201);
      const after = readRegistry(dir);
      expect(
        after.ok &&
          after.registry.artifacts.find((a) => a.id === 'art-0123456789ab')
            ?.local,
      ).toEqual(good);
      fs.mkdirSync(path.join(dir, 'artifacts'), { mode: 0o700 });
      fs.writeFileSync(
        path.join(dir, 'artifacts', 'art-0123456789ab.html'),
        '<p>x</p>',
      );
      expect(
        removeArtifact(dir, 'art-0123456789ab', 'art-0123456789ab').status,
      ).toBe(204);
      expect(
        fs.existsSync(path.join(dir, 'artifacts', 'art-0123456789ab.html')),
      ).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
