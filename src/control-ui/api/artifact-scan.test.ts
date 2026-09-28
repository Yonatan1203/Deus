import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArtifactScan } from './artifact-scan.js';
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
const spyReader = () => {
  const reads: string[] = [];
  return {
    reads,
    read: (file: string) => {
      reads.push(file);
      return fs
        .readFileSync(file, 'utf-8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
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
        read: s.read,
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
      read: s.read,
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
      read: s.read,
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
        read: s.read,
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
        read: s.read,
      }).scan(),
    ).toEqual([]);
    expect(
      createArtifactScan(root, {
        roots: () => [path.join(root, 'proj-a')],
        now: () => T0,
        read: s.read,
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
    const reads: string[] = [];
    const scan = createArtifactScan(root, {
      roots: () => [],
      now: () => T0,
      read: (file) => {
        reads.push(file);
        return [];
      },
    });
    scan.scan();
    expect(reads).toHaveLength(8);
    scan.scan();
    expect(reads).toHaveLength(10);
  });
});
