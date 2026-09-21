import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listGroups, readClaudeMd, writeClaudeMd } from './groups.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-groups-'));
fs.mkdirSync(path.join(root, 'main'));
fs.writeFileSync(path.join(root, 'main', 'CLAUDE.md'), '# hi');
const groups = {
  'm@x': {
    name: 'Main',
    folder: 'main',
    trigger: '@d',
    isControlGroup: true,
    added_at: '',
  },
  'g@x': { name: 'Ghost', folder: 'ghost', trigger: '@d', added_at: '' },
};
const runtime = {
  queue: {
    snapshot: () => [
      {
        jid: 'm@x',
        active: true,
        containerName: 'c1',
        groupFolder: 'main',
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingTaskCount: 0,
        retryCount: 0,
      },
    ],
  },
  registeredGroups: () => groups,
} as never;
const store = {
  listSessionRows: () => [],
  clearSession: () => {},
  stopContainer: () => {},
  groupFolderPath: (f: string) => {
    if (!/^[a-z]+$/.test(f)) throw new Error('bad');
    return path.join(root, f);
  },
  getAllTasks: () => [],
  getTaskById: () => undefined,
  createTask: () => {},
  updateTask: () => {},
  deleteTask: () => {},
  getTaskRunLogs: () => [],
  countMessages: () => 0,
  findMessagesById: () => [],
  dbPing: () => true,
  onTasksChanged: () => {},
};

describe('control-ui groups', () => {
  it('lists registered groups with folder facts and container state', () => {
    const out = listGroups(store, runtime);
    expect(
      out.map((g) => [
        g.folder,
        g.folder_exists,
        g.claude_md_bytes,
        g.container?.containerName ?? null,
      ]),
    ).toEqual([
      ['ghost', false, 0, null],
      ['main', true, 4, 'c1'],
    ]);
    expect(out[1].is_control_group).toBe(true);
  });

  it('reads and writes CLAUDE.md with a backup, refusing unknown folders', () => {
    expect(readClaudeMd(store, runtime, 'nope')).toBeNull();
    expect(readClaudeMd(store, runtime, 'ghost')).toBeNull();
    expect(readClaudeMd(store, runtime, 'main')).toMatchObject({
      content: '# hi',
      bytes: 4,
    });
    expect(writeClaudeMd(store, runtime, 'nope', 'x')).toBeNull();
    const w = writeClaudeMd(store, runtime, 'main', '# new');
    expect(w).toMatchObject({ bytes_before: 4, bytes_after: 5 });
    expect(w?.backup).toMatch(/CLAUDE\.md\.bak-\d{14}-[0-9a-f]{4}$/);
    const w2 = writeClaudeMd(store, runtime, 'main', '# newer');
    expect(w2?.backup).not.toBe(w?.backup);
    for (let i = 0; i < 12; i++)
      writeClaudeMd(store, runtime, 'main', `# v${i}`);
    expect(
      fs
        .readdirSync(path.join(root, 'main'))
        .filter((f) => f.startsWith('CLAUDE.md.bak-')),
    ).toHaveLength(10);
    expect(fs.readFileSync(path.join(root, 'main', 'CLAUDE.md'), 'utf-8')).toBe(
      '# v11',
    );
    expect(writeClaudeMd(store, runtime, 'ghost', 'x')?.backup).toBeNull();
    expect(fs.existsSync(path.join(root, 'ghost', 'CLAUDE.md'))).toBe(true);
  });
});
