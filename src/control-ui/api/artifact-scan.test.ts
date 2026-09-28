import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtifactScan, readRange } from './artifact-scan.js';
import { IS_WINDOWS } from '../../platform.js';

const T0 = Date.parse('2026-09-28T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const uuid = () =>
  `${(n++).toString(16).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;
const publishRows = (file: string, url: string) =>
  [
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Artifact',
            input: { file_path: file },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: `Published: ${url}`,
          },
        ],
      },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n') + '\n';
function transcript(
  dir: string,
  ageMs: number,
  body = publishRows('/p/page.html', 'https://claude.ai/code/artifact/x1'),
  id = uuid(),
) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  const f = path.join(root, dir, `${id}.jsonl`);
  fs.writeFileSync(f, body);
  const t = new Date(T0 - ageMs);
  fs.utimesSync(f, t, t);
  return { f, id };
}
// Records each file read (once per scan visit) and every range read.
const spyReader = () => {
  const reads: string[] = [];
  const ranges: { file: string; start: number; length: number }[] = [];
  return {
    reads,
    ranges,
    bytes: () => ranges.reduce((a, r) => a + r.length, 0),
    readRange: (fd: number, start: number, length: number, file: string) => {
      if (reads[reads.length - 1] !== file || ranges.length === 0)
        reads.push(file);
      ranges.push({ file, start, length });
      return readRange(fd, start, length, file);
    },
  };
};

describe('createArtifactScan', () => {
  it('returns the publishes of a recent transcript with its file-name uuid and folder', () => {
    const { id } = transcript('proj-a', DAY);
    const r = createArtifactScan(root, {
      roots: () => [],
      now: () => T0,
    }).scan();
    expect(r).toEqual([
      expect.objectContaining({
        uuid: id,
        dir: 'proj-a',
        calls: [
          {
            file_path: '/p/page.html',
            url: 'https://claude.ai/code/artifact/x1',
          },
        ],
      }),
    ]);
  });
  it('(a) a transcript older than 14 days is not read', () => {
    transcript('proj-a', 15 * DAY);
    const s = spyReader();
    expect(
      createArtifactScan(root, {
        roots: () => [],
        now: () => T0,
        readRange: s.readRange,
      }).scan(),
    ).toEqual([]);
    expect(s.reads).toHaveLength(0);
  });
  it('(b) with 45 eligible transcripts over 3 folders, exactly the 40 newest are visited', () => {
    const made: { f: string; age: number }[] = [];
    for (let i = 0; i < 45; i++)
      made.push({ f: transcript(`proj-${i % 3}`, (i + 1) * 60_000).f, age: i });
    const s = spyReader();
    createArtifactScan(root, {
      roots: () => [],
      now: () => T0,
      readRange: s.readRange,
    }).scan();
    expect(s.reads).toHaveLength(40);
    const newest40 = new Set(
      made.slice(0, 40).map((m) => fs.realpathSync(m.f)),
    );
    expect(s.reads.every((r) => newest40.has(r))).toBe(true);
  });
  it('(c) a second call with nothing changed reads nothing', () => {
    transcript('proj-a', DAY);
    transcript('proj-b', DAY);
    const s = spyReader();
    const scan = createArtifactScan(root, {
      roots: () => [],
      now: () => T0,
      readRange: s.readRange,
    });
    expect(scan.scan()).toHaveLength(2);
    expect(scan.scan()).toHaveLength(2);
    expect(s.reads).toHaveLength(2);
  });
  it.skipIf(IS_WINDOWS)(
    '(d) symlinked folders and files, non-uuid names and subagents/ are never read',
    () => {
      const real = transcript('proj-a', DAY).f;
      fs.symlinkSync(path.join(root, 'proj-a'), path.join(root, 'proj-link'));
      fs.symlinkSync(real, path.join(root, 'proj-a', `${uuid()}.jsonl`));
      fs.writeFileSync(
        path.join(root, 'proj-a', 'notes.jsonl'),
        publishRows('/p/x.html', 'https://claude.ai/code/artifact/x2'),
      );
      const sub = path.join(root, 'proj-a', uuid(), 'subagents');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(
        path.join(sub, `${uuid()}.jsonl`),
        publishRows('/p/y.html', 'https://claude.ai/code/artifact/x3'),
      );
      const s = spyReader();
      createArtifactScan(root, {
        roots: () => [],
        now: () => T0,
        readRange: s.readRange,
      }).scan();
      expect(s.reads).toEqual([fs.realpathSync(real)]);
    },
  );
  it('(e) fails closed when the projects dir overlaps a container-writable root', () => {
    transcript('proj-a', DAY);
    const s = spyReader();
    expect(
      createArtifactScan(root, {
        roots: () => [path.dirname(root)],
        now: () => T0,
        readRange: s.readRange,
      }).scan(),
    ).toEqual([]);
    expect(
      createArtifactScan(root, {
        roots: () => [path.join(root, 'proj-a')],
        now: () => T0,
        readRange: s.readRange,
      }).scan(),
    ).toEqual([]);
    expect(s.reads).toHaveLength(0);
  });
  it('(f) ten 8 MiB transcripts: the first call reads 8 (64 MiB), the rest on the next call', () => {
    for (let i = 0; i < 10; i++) {
      const { f } = transcript('proj-a', (i + 1) * 60_000);
      fs.truncateSync(f, 8 * 1024 * 1024); // sparse; size is what the budget counts
      const t = new Date(T0 - (i + 1) * 60_000);
      fs.utimesSync(f, t, t);
    }
    const s = spyReader();
    const scan = createArtifactScan(root, {
      roots: () => [],
      now: () => T0,
      readRange: s.readRange,
    });
    scan.scan();
    expect(new Set(s.reads).size).toBe(8);
    expect(s.bytes()).toBe(64 * 1024 * 1024);
    scan.scan();
    expect(new Set(s.reads).size).toBe(10);
  });
});

const useRow = (id: string, file: string) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name: 'Artifact', input: { file_path: file } },
      ],
    },
  }) + '\n';
const resultRow = (id: string, url: string, pad = '') =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: `Published: ${url}${pad && ` ${pad}`}`,
        },
      ],
    },
  }) + '\n';
const U = (k: string) => `https://claude.ai/code/artifact/${k}`;
function append(f: string, text: string | Buffer, ageMs = 1000) {
  fs.appendFileSync(f, text);
  const t = new Date(T0 - ageMs);
  fs.utimesSync(f, t, t);
}
const callsOf = (r: { calls: unknown[] }[]) => r.flatMap((x) => x.calls);

describe('createArtifactScan — reads only what a transcript gained', () => {
  const mk = (s: ReturnType<typeof spyReader>, extra = {}) =>
    createArtifactScan(root, {
      roots: () => [],
      now: () => T0,
      readRange: s.readRange,
      ...extra,
    });

  it('(a) 100 appended bytes cost the 100 bytes (plus the 64-byte check), not the tail', () => {
    const { f } = transcript('proj-a', DAY);
    const s = spyReader();
    const scan = mk(s);
    scan.scan();
    const size = fs.statSync(f).size;
    s.ranges.length = 0;
    append(f, JSON.stringify({ type: 'note', x: 'y'.repeat(77) }) + '\n');
    expect(fs.statSync(f).size - size).toBe(100);
    scan.scan();
    expect(s.ranges).toEqual([
      { file: fs.realpathSync(f), start: size - 64, length: 64 },
      { file: fs.realpathSync(f), start: size, length: 100 },
    ]);
  });
  it('(b) a tool_use in one append and its result in the next pair into one call', () => {
    const { f } = transcript('proj-a', DAY, useRow('u1', '/p/one.html'));
    const s = spyReader();
    const scan = mk(s);
    expect(scan.scan()).toEqual([]);
    append(f, resultRow('u1', U('b1')));
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/one.html', url: U('b1') },
    ]);
  });
  it('(c) a line split across two appends is parsed once, whole', () => {
    const { f } = transcript('proj-a', DAY, useRow('u1', '/p/one.html'));
    const scan = mk(spyReader());
    scan.scan();
    const line = resultRow('u1', U('c1'));
    append(f, line.slice(0, 40));
    expect(scan.scan()).toEqual([]);
    append(f, line.slice(40));
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/one.html', url: U('c1') },
    ]);
    append(f, '\n');
    expect(callsOf(scan.scan())).toHaveLength(1);
  });
  it('(d) a file rewritten shorter is read again from its tail with a fresh collector', () => {
    const { f } = transcript(
      'proj-a',
      DAY,
      useRow('u1', '/p/old.html') + resultRow('u1', U('d1'), 'x'.repeat(300)),
    );
    const s = spyReader();
    const scan = mk(s);
    expect(callsOf(scan.scan())).toHaveLength(1);
    fs.writeFileSync(f, useRow('u2', '/p/new.html') + resultRow('u2', U('d2')));
    fs.utimesSync(f, new Date(T0 - 500), new Date(T0 - 500));
    s.ranges.length = 0;
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/new.html', url: U('d2') },
    ]);
    expect(s.ranges.at(-1)).toMatchObject({ start: 0 });
  });
  it('(e) more than 8 MiB appended: the last 8 MiB are read, with a fresh collector', () => {
    const { f } = transcript('proj-a', DAY);
    const s = spyReader();
    const scan = mk(s);
    expect(callsOf(scan.scan())).toHaveLength(1);
    const pad = Buffer.alloc(9 * 1024 * 1024, 0x20);
    pad[pad.length - 1] = 0x0a;
    append(
      f,
      Buffer.concat([
        pad,
        Buffer.from(useRow('u9', '/p/late.html') + resultRow('u9', U('e1'))),
      ]),
    );
    s.ranges.length = 0;
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/late.html', url: U('e1') },
    ]);
    const size = fs.statSync(f).size;
    expect(s.ranges).toEqual([
      expect.objectContaining({
        start: size - 8 * 1024 * 1024,
        length: 8 * 1024 * 1024,
      }),
    ]);
  });
  it('(h) truncated and regrown past the old cursor on the same inode: a fresh collector (C2)', () => {
    const { f } = transcript('proj-a', DAY);
    const scan = mk(spyReader());
    expect(callsOf(scan.scan())).toHaveLength(1);
    const ino = fs.statSync(f).ino;
    const fd = fs.openSync(f, 'r+');
    fs.ftruncateSync(fd, 0);
    fs.writeSync(
      fd,
      useRow('z1', '/p/other.html') + resultRow('z1', U('h1'), 'q'.repeat(400)),
      0,
    );
    fs.closeSync(fd);
    fs.utimesSync(f, new Date(T0 - 500), new Date(T0 - 500));
    expect(fs.statSync(f).ino).toBe(ino);
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/other.html', url: U('h1') },
    ]);
  });
  it('(i) a line over 1 MiB split across appends is dropped; later rows still parse (C3)', () => {
    const { f } = transcript('proj-a', DAY, useRow('u1', '/p/big.html'));
    const scan = mk(spyReader());
    scan.scan();
    const big = resultRow('u1', U('i1'), 'p'.repeat(1400 * 1024));
    append(f, big.slice(0, 700 * 1024));
    scan.scan();
    append(
      f,
      big.slice(700 * 1024) +
        useRow('u2', '/p/next.html') +
        resultRow('u2', U('i2')),
    );
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/next.html', url: U('i2') },
    ]);
  });
  it('(j) a multibyte character split across two appends parses (C3)', () => {
    const { f } = transcript('proj-a', DAY, '');
    const scan = mk(spyReader());
    scan.scan();
    const line = Buffer.from(useRow('u1', '/p/דף.html'), 'utf-8');
    const cut = line.indexOf(Buffer.from('ד', 'utf-8')) + 1; // inside the 2-byte letter
    append(f, line.subarray(0, cut));
    scan.scan();
    append(
      f,
      Buffer.concat([
        line.subarray(cut),
        Buffer.from(resultRow('u1', U('j1'))),
      ]),
    );
    expect(callsOf(scan.scan())).toEqual([
      { file_path: '/p/דף.html', url: U('j1') },
    ]);
  });
  it('(k) a file that leaves the candidates loses its cursor: when it returns it is read from its tail (C4)', () => {
    const a = transcript('proj-a', 3 * DAY).f;
    const s = spyReader();
    const scan = mk(s, { maxFiles: 1 });
    scan.scan();
    transcript('proj-b', 2 * DAY); // newer: now the only candidate
    scan.scan();
    append(a, JSON.stringify({ type: 'note' }) + '\n', 100); // newest again
    s.ranges.length = 0;
    expect(callsOf(scan.scan())).toHaveLength(1);
    expect(s.ranges).toEqual([
      { file: fs.realpathSync(a), start: 0, length: fs.statSync(a).size },
    ]);
  });
  it('(l) a file skipped for budget keeps its cursor and the next scan reads exactly [old offset, size)', () => {
    const A = transcript('proj-a', 2000).f;
    const B = transcript('proj-b', 3000).f;
    const s = spyReader();
    const scan = mk(s, { budgetBytes: 1000 });
    expect(callsOf(scan.scan())).toHaveLength(2);
    const oldB = fs.statSync(B).size;
    append(A, JSON.stringify({ type: 'note', x: 'a'.repeat(600) }) + '\n', 100);
    append(B, useRow('b2', '/p/b2.html') + resultRow('b2', U('l2')), 200);
    s.ranges.length = 0;
    const second = scan.scan();
    expect(s.ranges.every((r) => r.file === fs.realpathSync(A))).toBe(true);
    expect(second.map((x) => x.dir)).toEqual(['proj-a']);
    s.ranges.length = 0;
    const third = scan.scan();
    expect(s.ranges).toEqual([
      { file: fs.realpathSync(B), start: oldB - 64, length: 64 },
      {
        file: fs.realpathSync(B),
        start: oldB,
        length: fs.statSync(B).size - oldB,
      },
    ]);
    expect(third.find((x) => x.dir === 'proj-b')?.calls).toEqual([
      { file_path: '/p/page.html', url: 'https://claude.ai/code/artifact/x1' },
      { file_path: '/p/b2.html', url: U('l2') },
    ]);
  });
  it('(n) without inode numbers (ino 0) a changed file is read as a fresh tail', () => {
    const zero = <T extends fs.Stats>(st: T): T =>
      Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: 0 });
    const lst = fs.lstatSync;
    const fst = fs.fstatSync;
    const l = vi
      .spyOn(fs, 'lstatSync')
      .mockImplementation(((p: fs.PathLike) =>
        zero(lst(p))) as typeof fs.lstatSync);
    const fs2 = vi
      .spyOn(fs, 'fstatSync')
      .mockImplementation(((fd: number) =>
        zero(fst(fd))) as typeof fs.fstatSync);
    try {
      const { f } = transcript('proj-a', DAY);
      const s = spyReader();
      const scan = mk(s);
      scan.scan();
      append(f, useRow('n2', '/p/n2.html') + resultRow('n2', U('n2')));
      s.ranges.length = 0;
      expect(callsOf(scan.scan())).toHaveLength(2);
      expect(s.ranges).toEqual([
        expect.objectContaining({ start: 0, length: fs.statSync(f).size }),
      ]);
    } finally {
      l.mockRestore();
      fs2.mockRestore();
    }
  });
});
