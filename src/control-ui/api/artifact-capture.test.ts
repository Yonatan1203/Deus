import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactCapture } from './artifact-capture.js';
import {
  addCapturedArtifact,
  captureSource,
  startsAsHtml,
  copyPath,
  createRemovedUrls,
  isUnderAny,
  logRemoved,
  readRegistry,
  refreshArtifact,
  removeArtifact,
  validateEntry,
  writeRegistry,
  REMOVED_LOG,
  SESSION_MAX,
  type ArtifactEntry,
} from './artifacts.js';
import { IS_WINDOWS } from '../../platform.js';

const HOSTS = ['claude.ai'];
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const SESSION = { id: 'a1b2c3d4', name: 'Posts fixture' };
const URL1 =
  'https://claude.ai/code/artifact/11111111-1111-4111-8111-111111111111';
let dir: string;
let src: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  src = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-src-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});
const page = (
  name = 'page.html',
  body = '<!doctype html><title>Supplier Line</title><p>hi</p>',
) => {
  const f = path.join(src, name);
  fs.writeFileSync(f, body);
  return f;
};
const good = (file: string) => {
  const r = captureSource(file);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe('captureSource', () => {
  it('reads a real .html the process owns, with its <title>', () => {
    const r = good(page());
    expect(r.title).toBe('Supplier Line');
    expect(r.bytes).toBeGreaterThan(10);
    expect(r.source).toBe(fs.realpathSync(path.join(src, 'page.html')));
  });
  it('refuses a relative path, a non-html extension, a symlink, another hard link, and non-HTML bytes', () => {
    expect(captureSource('page.html')).toMatchObject({ ok: false });
    expect(captureSource(page('notes.txt'))).toMatchObject({
      ok: false,
      reason: 'not an .html file',
    });
    const real = page('real.html');
    if (!IS_WINDOWS) {
      fs.symlinkSync(real, path.join(src, 'link.html'));
      expect(captureSource(path.join(src, 'link.html'))).toMatchObject({
        ok: false,
        reason: 'is a symlink',
      });
      fs.linkSync(real, path.join(src, 'hard.html'));
      expect(captureSource(real)).toMatchObject({
        ok: false,
        reason: 'has other hard links',
      });
    }
    expect(
      captureSource(page('secret.html', 'AKIA... not a page')),
    ).toMatchObject({
      ok: false,
      reason: 'not an HTML document',
    });
    expect(captureSource(path.join(src, 'missing.html'))).toMatchObject({
      ok: false,
      reason: 'no such file',
    });
  });
  it('a title with control characters or entities is cleaned; an unusable one is null', () => {
    expect(
      good(page('a.html', '<html><title>  A &amp; B\u0007 </title>')).title,
    ).toBe('A & B');
    expect(good(page('b.html', '<html><title>   </title>')).title).toBeNull();
    expect(good(page('c.html', '<html><body>no title')).title).toBeNull();
  });
});

describe('startsAsHtml (#53)', () => {
  const ok = (t: string | Buffer) =>
    startsAsHtml(Buffer.isBuffer(t) ? t : Buffer.from(t, 'utf-8'));
  it('accepts documents and the fragments Artifact pages are', () => {
    expect(ok('<!doctype html><title>x</title>')).toBe(true);
    expect(ok('<html lang="en">')).toBe(true);
    expect(
      ok('<title>Newly Story Bank</title>\n<link rel="stylesheet" href="x">'),
    ).toBe(true);
    expect(ok('<style>body{}</style>')).toBe(true);
    expect(ok('\uFEFF<!-- note -->\n  <div class="x">')).toBe(true);
    expect(ok('<!----><div>')).toBe(true);
    expect(ok('<p>hi</p>')).toBe(true);
    expect(ok('<H1>Title</H1>')).toBe(true);
  });
  it('refuses secrets and other formats', () => {
    for (const t of [
      'KEY=value',
      '{"a":1}',
      '-----BEGIN PRIVATE KEY-----',
      '<?xml version="1.0"?>',
      '<foo>',
      'plain text',
      '',
      '<!DOCTYPE plist>',
      '<pre>x</pre>',
      '<param>',
      '<headx>',
      '<svgx>',
      '<!-- never closed <div>',
    ])
      expect([t, ok(t)]).toEqual([t, false]);
  });
  it('refuses a UTF-16 BOM, a leading NUL, and comments that use up the window', () => {
    expect(ok(Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x64, 0x00]))).toBe(false);
    expect(ok(Buffer.from('\0<div>'))).toBe(false);
    expect(ok('<!--' + 'x'.repeat(600) + '--><div>')).toBe(false);
  });
});

describe('addCapturedArtifact', () => {
  it('writes the copy, the entry with local + session and added_by session; the same URL is not added twice', () => {
    const s = good(page());
    const r = addCapturedArtifact(
      dir,
      { title: s.title, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(r.status).toBe(201);
    const id = (r as { id: string }).id;
    expect(fs.statSync(copyPath(dir, id)).size).toBe(s.bytes);
    const reg = readRegistry(dir);
    expect(reg.ok && reg.registry.artifacts[0]).toMatchObject({
      id,
      title: 'Supplier Line',
      url: URL1,
      added_by: 'session',
      session: SESSION,
      local: { source: s.source, bytes: s.bytes },
    });
    const again = addCapturedArtifact(
      dir,
      { title: null, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(again).toEqual({ status: 200, id, existing: true });
  });
  it('a session name outside the name charset is reduced to it; an empty one becomes the id', () => {
    const s = good(page());
    const r = addCapturedArtifact(
      dir,
      {
        title: s.title,
        url: URL1,
        kind: 'app',
        source: s,
        session: { id: 'a1b2c3d4', name: 'Posts (fixture)!' },
      },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(r.status).toBe(201);
    const reg = readRegistry(dir);
    expect(reg.ok && reg.registry.artifacts[0].session).toEqual({
      id: 'a1b2c3d4',
      name: 'Posts fixture',
    });
    const r2 = addCapturedArtifact(
      dir,
      {
        title: s.title,
        url: `${URL1}b`,
        kind: 'app',
        source: good(page('second.html')),
        session: { id: 'b2c3d4e5', name: '((()))' },
      },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(r2.status).toBe(201);
    const reg2 = readRegistry(dir);
    expect(reg2.ok && reg2.registry.artifacts[1].session).toEqual({
      id: 'b2c3d4e5',
      name: 'b2c3d4e5',
    });
  });
  it('falls back to the file name, then "Artifact", when there is no usable title', () => {
    const s = good(page('supplier-line.html', '<html><body>x'));
    const r = addCapturedArtifact(
      dir,
      { title: s.title, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    const reg = readRegistry(dir);
    expect(r.status).toBe(201);
    expect(reg.ok && reg.registry.artifacts[0].title).toBe('supplier-line');
  });
  it('rejects a session that fails the id/name rules and a URL outside the allowed hosts', () => {
    const s = good(page());
    expect(
      addCapturedArtifact(
        dir,
        {
          title: null,
          url: URL1,
          kind: 'app',
          source: s,
          session: { id: 'nope', name: 'x' },
        },
        { hosts: HOSTS },
      ),
    ).toMatchObject({ status: 400 });
    expect(
      addCapturedArtifact(
        dir,
        {
          title: null,
          url: 'https://evil.example/artifact/x',
          kind: 'app',
          source: s,
          session: SESSION,
        },
        { hosts: HOSTS },
      ),
    ).toMatchObject({ status: 400, transient: false });
    expect(readRegistry(dir)).toMatchObject({
      ok: true,
      registry: { artifacts: [] },
    });
  });
  it('the session sub-quota evicts the oldest captured entry (copy unlinked, logged), never a cli entry', () => {
    const cli: ArtifactEntry = {
      id: 'art-ffffffffffff',
      title: 'Kept',
      url: 'https://claude.ai/artifact/cli',
      kind: 'app',
      added_at: '2026-01-01T00:00:00.000Z',
      added_by: 'cli',
    };
    const olds: ArtifactEntry[] = Array.from(
      { length: SESSION_MAX },
      (_, i) => ({
        id: `art-${i.toString(16).padStart(12, '0')}`,
        title: `Old ${i}`,
        url: `https://claude.ai/artifact/old-${i}`,
        kind: 'app' as const,
        added_at: new Date(T0 - (SESSION_MAX - i) * 1000).toISOString(),
        added_by: 'session' as const,
        session: SESSION,
      }),
    );
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    fs.writeFileSync(copyPath(dir, olds[0].id), '<html>old');
    const w = writeRegistry(
      dir,
      { v: 1, rev: 1, artifacts: [cli, ...olds] },
      0,
      () => T0,
    );
    expect(w).toMatchObject({ ok: true });
    const before = readRegistry(dir);
    expect(before.ok && before.registry.artifacts.length).toBe(1 + SESSION_MAX);
    const s = good(page());
    const r = addCapturedArtifact(
      dir,
      { title: s.title, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(r.status).toBe(201);
    expect(
      (r as { evicted: ArtifactEntry[] }).evicted.map((e) => e.id),
    ).toEqual([olds[0].id]);
    expect(fs.existsSync(copyPath(dir, olds[0].id))).toBe(false);
    const reg = readRegistry(dir);
    expect(reg.ok && reg.registry.artifacts.length).toBe(1 + SESSION_MAX);
    expect(reg.ok && reg.registry.artifacts.some((a) => a.id === cli.id)).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(dir, REMOVED_LOG), 'utf-8')).toContain(
      olds[0].url,
    );
  });
});

describe('addCapturedArtifact on an URL already registered', () => {
  const linkOnly: ArtifactEntry = {
    id: 'art-aaaaaaaaaaaa',
    title: 'Supplier Line',
    url: URL1,
    kind: 'report',
    description: 'kept',
    added_at: '2026-09-21T18:42:31.791Z',
    added_by: 'cli',
  };
  it('a link-only entry gains the copy in place: same id, title, kind, origin; local + session set', () => {
    writeRegistry(dir, { v: 1, rev: 1, artifacts: [linkOnly] }, 0, () => T0);
    const s = good(page());
    const r = addCapturedArtifact(
      dir,
      {
        title: 'Other Title',
        url: URL1,
        kind: 'app',
        source: s,
        session: SESSION,
      },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(r).toMatchObject({ status: 201, id: linkOnly.id, evicted: [] });
    const reg = readRegistry(dir);
    expect(reg.ok && reg.registry.artifacts).toHaveLength(1);
    expect(reg.ok && reg.registry.artifacts[0]).toMatchObject({
      id: linkOnly.id,
      title: 'Supplier Line',
      kind: 'report',
      description: 'kept',
      added_by: 'cli',
      local: { source: s.source, bytes: s.bytes },
      session: SESSION,
    });
    expect(fs.statSync(copyPath(dir, linkOnly.id)).size).toBe(s.bytes);
  });
  it('adoption is reported with the entry origin, and a leftover file at the copy path does not block it', () => {
    writeRegistry(dir, { v: 1, rev: 1, artifacts: [linkOnly] }, 0, () => T0);
    fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
    fs.writeFileSync(copyPath(dir, linkOnly.id), 'stale leftover');
    const s = good(page());
    const r = addCapturedArtifact(
      dir,
      { title: null, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    expect(r).toMatchObject({ status: 201, id: linkOnly.id, adopted: 'cli' });
    expect(fs.readFileSync(copyPath(dir, linkOnly.id), 'utf-8')).toBe(
      fs.readFileSync(s.source, 'utf-8'),
    );
  });
  it('an adopted operator entry stops following a source that lands under a refused root', () => {
    writeRegistry(dir, { v: 1, rev: 1, artifacts: [linkOnly] }, 0, () => T0);
    const s = good(page());
    addCapturedArtifact(
      dir,
      { title: null, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    fs.writeFileSync(s.source, '<!doctype html><p>changed</p>');
    fs.utimesSync(s.source, new Date(T0 + 5000), new Date(T0 + 5000));
    expect(
      refreshArtifact(dir, linkOnly.id, {
        readOnly: false,
        now: () => T0 + 6000,
        refuseUnder: () => [src],
      }),
    ).toMatchObject({ status: 200, following: false });
    expect(
      refreshArtifact(dir, linkOnly.id, {
        readOnly: false,
        now: () => T0 + 6000,
        refuseUnder: () => ['/nowhere/at/all'],
      }),
    ).toMatchObject({ status: 200, following: true });
  });
  it('an entry that already has a copy is left as it is', () => {
    writeRegistry(dir, { v: 1, rev: 1, artifacts: [linkOnly] }, 0, () => T0);
    const s = good(page());
    addCapturedArtifact(
      dir,
      { title: null, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    const again = addCapturedArtifact(
      dir,
      {
        title: null,
        url: URL1,
        kind: 'app',
        source: good(page('b.html')),
        session: SESSION,
      },
      { hosts: HOSTS, now: () => T0 + 1 },
    );
    expect(again).toEqual({ status: 200, id: linkOnly.id, existing: true });
  });
  it('a page between 4 MiB and 16 MiB is accepted; over 16 MiB is refused', () => {
    const nine = page(
      'nine.html',
      '<!doctype html>' + ' '.repeat(9 * 1024 * 1024),
    );
    expect(captureSource(nine)).toMatchObject({ ok: true });
    const big = page(
      'big.html',
      '<!doctype html>' + ' '.repeat(16 * 1024 * 1024),
    );
    expect(captureSource(big)).toMatchObject({ ok: false });
  });
});

describe('#49: same file, removed source, no session', () => {
  it('the same file under another link changes nothing and is logged', () => {
    const warns: Record<string, unknown>[] = [];
    const cap = createArtifactCapture(dir, {
      hosts: HOSTS,
      roots: () => [],
      now: () => T0,
      log: { warn: (o) => warns.push(o) },
    });
    const file = page();
    cap.capture({
      key: 'a',
      version: 'v1',
      calls: [{ file_path: file, url: URL1 }],
      session: SESSION,
      readOnly: false,
    });
    const before = readRegistry(dir);
    const r = cap.capture({
      key: 'b',
      version: 'v1',
      calls: [{ file_path: file, url: `${URL1}-other` }],
      session: SESSION,
      readOnly: false,
    });
    expect(r).toMatchObject([{ result: 'exists' }]);
    expect(readRegistry(dir)).toEqual(before);
    expect(
      warns.find((w) => w.event === 'control_ui_artifact_capture_dup_source'),
    ).toMatchObject({ registered_url: URL1, published_url: `${URL1}-other` });
  });
  it('a page removed under one link is not captured again under the other', () => {
    const cap = createArtifactCapture(dir, {
      hosts: HOSTS,
      roots: () => [],
      now: () => T0,
    });
    const file = page();
    const [a] = cap.capture({
      key: 'a',
      version: 'v1',
      calls: [{ file_path: file, url: URL1 }],
      session: SESSION,
      readOnly: false,
    });
    const id = (a as { id: string }).id;
    expect(removeArtifact(dir, id, id, { now: () => T0 + 1 }).status).toBe(204);
    expect(
      cap.capture({
        key: 'b',
        version: 'v1',
        calls: [{ file_path: file, url: `${URL1}-gallery` }],
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'skipped', reason: 'removed by the operator' }]);
  });
  it('a transcript that is not a listed session: no session link, still added_by session, refused root applies, audit names the transcript', () => {
    const warns: Record<string, unknown>[] = [];
    const cap = createArtifactCapture(dir, {
      hosts: HOSTS,
      roots: () => [],
      now: () => T0,
      log: { warn: (o) => warns.push(o) },
    });
    const file = page();
    const [a] = cap.capture({
      key: 'u',
      version: 'v1',
      calls: [{ file_path: file, url: URL1 }],
      session: null,
      readOnly: false,
      transcript: { uuid: '11111111-2222-3333-4444-555555555555', dir: 'proj' },
    });
    const id = (a as { id: string }).id;
    const e = readRegistry(dir);
    expect(e.ok && e.registry.artifacts[0]).toMatchObject({
      id,
      added_by: 'session',
    });
    expect(e.ok && e.registry.artifacts[0].session).toBeUndefined();
    expect(
      warns.find((w) => w.event === 'control_ui_artifact_capture'),
    ).toMatchObject({
      transcript: '11111111-2222-3333-4444-555555555555',
      dir: 'proj',
      session: null,
    });
    fs.writeFileSync(file, '<!doctype html><p>changed</p>');
    fs.utimesSync(file, new Date(T0 + 5000), new Date(T0 + 5000));
    expect(
      refreshArtifact(dir, id, {
        readOnly: false,
        now: () => T0 + 6000,
        refuseUnder: () => [src],
      }),
    ).toMatchObject({ following: false });
  });
  it('without a session, a link-only operator entry is not adopted', () => {
    const linkOnly: ArtifactEntry = {
      id: 'art-bbbbbbbbbbbb',
      title: 'Old',
      url: URL1,
      kind: 'app',
      added_at: '2026-09-21T18:42:31.791Z',
      added_by: 'cli',
    };
    writeRegistry(dir, { v: 1, rev: 1, artifacts: [linkOnly] }, 0, () => T0);
    const s = good(page());
    expect(
      addCapturedArtifact(
        dir,
        { title: null, url: URL1, kind: 'app', source: s, session: null },
        { hosts: HOSTS, now: () => T0 },
      ),
    ).toEqual({ status: 200, id: linkOnly.id, existing: true });
    const e = readRegistry(dir);
    expect(e.ok && e.registry.artifacts[0].local).toBeUndefined();
  });
});

describe('validateEntry with session', () => {
  it('keeps a valid session block and drops a malformed one without dropping the entry', () => {
    const base = {
      id: 'art-0123456789ab',
      title: 'T',
      url: URL1,
      kind: 'app',
      added_at: '2026-09-27T12:00:00.000Z',
      added_by: 'session',
    };
    expect(validateEntry({ ...base, session: SESSION })?.session).toEqual(
      SESSION,
    );
    expect(
      validateEntry({ ...base, session: { id: 'x', name: 'y' } }),
    ).toMatchObject({ id: base.id });
    expect(
      validateEntry({ ...base, session: { id: 'x', name: 'y' } })?.session,
    ).toBeUndefined();
  });
});

describe('isUnderAny / createRemovedUrls / refreshArtifact refusal', () => {
  it('containment is separator-aware and follows a symlinked root', () => {
    const root = path.join(src, 'groups');
    fs.mkdirSync(path.join(root, 'g1'), { recursive: true });
    const inside = fs.realpathSync(path.join(root, 'g1'));
    expect(isUnderAny(path.join(inside, 'page.html'), [root])).toBe(true);
    expect(isUnderAny(fs.realpathSync(root), [root])).toBe(true);
    expect(isUnderAny(path.join(src, 'groups-not', 'p.html'), [root])).toBe(
      false,
    );
    if (!IS_WINDOWS) {
      fs.symlinkSync(root, path.join(src, 'groups-link'));
      expect(
        isUnderAny(path.join(inside, 'p.html'), [
          path.join(src, 'groups-link'),
        ]),
      ).toBe(true);
    }
  });
  it('removed URLs are read from the log and refreshed when it grows', () => {
    const removed = createRemovedUrls(dir);
    expect(removed().urls.has(URL1)).toBe(false);
    const e: ArtifactEntry = {
      id: 'art-0123456789ab',
      title: 'T',
      url: URL1,
      kind: 'app',
      added_at: '2026-09-27T12:00:00.000Z',
      added_by: 'session',
    };
    logRemoved(dir, e, 'dashboard', new Date(T0).toISOString());
    expect(removed().urls.has(URL1)).toBe(true);
  });
  it('a captured entry whose source sits under a refused root stops being followed; a cli entry is not affected', () => {
    const s = good(page());
    const r = addCapturedArtifact(
      dir,
      { title: s.title, url: URL1, kind: 'app', source: s, session: SESSION },
      { hosts: HOSTS, now: () => T0 },
    );
    const id = (r as { id: string }).id;
    fs.writeFileSync(s.source, '<!doctype html><p>changed</p>');
    fs.utimesSync(s.source, new Date(T0 + 5000), new Date(T0 + 5000));
    expect(
      refreshArtifact(dir, id, {
        readOnly: false,
        now: () => T0 + 6000,
        refuseUnder: () => [src],
      }),
    ).toMatchObject({ status: 200, following: false });
    expect(
      refreshArtifact(dir, id, {
        readOnly: false,
        now: () => T0 + 6000,
        refuseUnder: () => ['/nowhere/at/all'],
      }),
    ).toMatchObject({ status: 200, following: true });
  });
});

describe('createArtifactCapture', () => {
  const calls = (file: string) => [{ file_path: file, url: URL1 }];
  it('registers once per transcript version, then reports the entry through lookup', () => {
    const cap = createArtifactCapture(dir, {
      hosts: HOSTS,
      roots: () => [],
      now: () => T0,
    });
    const file = page();
    const a = cap.capture({
      key: 'sid',
      version: 'v1',
      calls: calls(file),
      session: SESSION,
      readOnly: false,
    });
    expect(a).toMatchObject([{ result: 'added' }]);
    expect(
      cap.capture({
        key: 'sid',
        version: 'v1',
        calls: calls(file),
        session: SESSION,
        readOnly: false,
      }),
    ).toEqual([]);
    expect(
      cap.capture({
        key: 'sid',
        version: 'v2',
        calls: calls(file),
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'exists' }]);
    expect(cap.lookup(calls(file))).toEqual([
      { url: URL1, id: (a[0] as { id: string }).id, local: true },
    ]);
  });
  it('skips a failing file for good, a container-writable path, a removed URL, and never writes when read-only', () => {
    const warns: string[] = [];
    const cap = createArtifactCapture(dir, {
      hosts: HOSTS,
      roots: () => [path.join(src, 'groups')],
      now: () => T0,
      log: { warn: (o) => warns.push(String(o.reason)) },
    });
    const bad = page('bad.html', 'plain text');
    expect(
      cap.capture({
        key: 's1',
        version: 'v1',
        calls: calls(bad),
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([
      { result: 'skipped', reason: 'not an HTML document', retry: false },
    ]);
    expect(
      cap.capture({
        key: 's1',
        version: 'v1b',
        calls: calls(bad),
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'skipped', reason: 'failed before' }]);
    fs.writeFileSync(bad, '<!doctype html>fixed'); // the file changed: retried and added
    expect(
      cap.capture({
        key: 's1',
        version: 'v2',
        calls: calls(bad),
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'added' }]);
    fs.mkdirSync(path.join(src, 'groups', 'g1'), { recursive: true });
    const inGroup = path.join(src, 'groups', 'g1', 'p.html');
    fs.writeFileSync(inGroup, '<!doctype html>container-written');
    expect(
      cap.capture({
        key: 's2',
        version: 'v1',
        calls: [{ file_path: inGroup, url: `${URL1}2` }],
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'skipped', reason: 'container-writable path' }]);
    const e: ArtifactEntry = {
      id: 'art-0123456789ab',
      title: 'T',
      url: `${URL1}3`,
      kind: 'app',
      added_at: '2026-09-27T12:00:00.000Z',
      added_by: 'session',
    };
    logRemoved(dir, e, 'dashboard', new Date(T0).toISOString());
    expect(
      cap.capture({
        key: 's3',
        version: 'v1',
        calls: [{ file_path: page('ok.html'), url: `${URL1}3` }],
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'skipped', reason: 'removed by the operator' }]);
    expect(
      cap.capture({
        key: 's4',
        version: 'v1',
        calls: calls(page('ro.html')),
        session: SESSION,
        readOnly: true,
      }),
    ).toEqual([]);
    // only the page fixed after its refusal was added (URL1); nothing else
    const reg = readRegistry(dir);
    expect(reg.ok && reg.registry.artifacts.map((a) => a.url)).toEqual([URL1]);
    expect(warns).toEqual([
      'not an HTML document',
      'undefined', // the fixed page's capture, audited at warn
      'container-writable path',
    ]);
    expect(
      cap.capture({
        key: 's5',
        version: 'v1',
        calls: [{ file_path: page('good.html'), url: `${URL1}5` }],
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'added' }]);
    expect(warns).toHaveLength(4); // the second capture is audited too
  });
  it('a dashboard delete holds: the URL is not captured again on the next transcript version', () => {
    const cap = createArtifactCapture(dir, {
      hosts: HOSTS,
      roots: () => [],
      now: () => T0,
    });
    const file = page();
    const [a] = cap.capture({
      key: 'sid',
      version: 'v1',
      calls: calls(file),
      session: SESSION,
      readOnly: false,
    });
    const id = (a as { id: string }).id;
    expect(removeArtifact(dir, id, id, { now: () => T0 + 1 }).status).toBe(204);
    expect(
      cap.capture({
        key: 'sid',
        version: 'v2',
        calls: calls(file),
        session: SESSION,
        readOnly: false,
      }),
    ).toMatchObject([{ result: 'skipped', reason: 'removed by the operator' }]);
  });
});
