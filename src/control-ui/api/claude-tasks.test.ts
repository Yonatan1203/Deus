import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createTaskReader,
  sortTasks,
  tasksVersion,
  validateTask,
} from './claude-tasks.js';

const SID = '0123abcd-1111-2222-3333-444455556666';
const task = (
  id: string,
  status: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  subject: `Task ${id}`,
  description: 'why',
  activeForm: `Doing ${id}`,
  status,
  blocks: [],
  blockedBy: [],
  ...over,
});

describe('validateTask', () => {
  it('keeps the fields the panel shows and drops anything else', () => {
    expect(validateTask(task('7', 'pending'))).toEqual({
      id: '7',
      subject: 'Task 7',
      status: 'pending',
      activeForm: 'Doing 7',
    });
    expect(validateTask(task('7', 'pending', { subject: '  ' }))).toBeNull();
    expect(validateTask(task('7', 'done'))).toBeNull();
    expect(
      validateTask(task('7', 'pending', { activeForm: 42 })),
    ).toMatchObject({
      id: '7',
    });
    expect(validateTask(task('', 'pending'))).toBeNull();
    expect(validateTask('nope')).toBeNull();
    expect(
      validateTask(task('7', 'pending', { subject: 'x'.repeat(201) })),
    ).toBeNull();
  });
});

describe('sortTasks / tasksVersion', () => {
  it('orders in_progress, pending, completed, then by numeric id', () => {
    const rows = [
      validateTask(task('10', 'completed'))!,
      validateTask(task('2', 'pending'))!,
      validateTask(task('9', 'in_progress'))!,
      validateTask(task('1', 'pending'))!,
    ];
    expect(sortTasks(rows).map((t) => t.id)).toEqual(['9', '1', '2', '10']);
    const v1 = tasksVersion(sortTasks(rows));
    rows[1].status = 'completed';
    expect(tasksVersion(sortTasks(rows))).not.toBe(v1);
    expect(tasksVersion([])).toBe('0');
  });
});

describe('createTaskReader', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tasks-'));
    const dir = path.join(root, SID);
    fs.mkdirSync(dir, { recursive: true });
    const write = (n: number, t: object) =>
      fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify(t));
    return { root, dir, write };
  };
  it('reads a session store, skips links and oversized files, memoizes on the files', () => {
    const { root, dir, write } = setup();
    try {
      write(1, task('1', 'completed'));
      write(2, task('2', 'in_progress'));
      write(3, task('3', 'pending'));
      fs.writeFileSync(path.join(dir, '.highwatermark'), '3');
      fs.writeFileSync(path.join(dir, '.lock'), '');
      fs.writeFileSync(
        path.join(root, 'outside.json'),
        JSON.stringify(task('9', 'pending')),
      );
      fs.symlinkSync(path.join(root, 'outside.json'), path.join(dir, '4.json'));
      fs.writeFileSync(
        path.join(dir, '5.json'),
        JSON.stringify(
          task('5', 'pending', { description: 'x'.repeat(70 * 1024) }),
        ),
      );
      fs.writeFileSync(path.join(dir, '6.json'), '{not json');
      const read = createTaskReader(root);
      const a = read(SID);
      expect(a && a.tasks.map((t) => `${t.id}:${t.status}`)).toEqual([
        '2:in_progress',
        '3:pending',
        '1:completed',
      ]);
      expect(read(SID)).toBe(a); // memoized
      write(3, task('3', 'completed'));
      fs.utimesSync(
        path.join(dir, '3.json'),
        new Date(),
        new Date(Date.now() + 3000),
      );
      const b = read(SID);
      expect(b).not.toBe(a);
      expect(b && b.version).not.toBe(a && a.version);
      expect(b && b.tasks.map((t) => t.id)).toEqual(['2', '1', '3']);
      // unknown or malformed session ids, a missing store, a symlinked store
      expect(read('../etc')).toBeNull();
      expect(read('ffffffff-1111-2222-3333-444455556666')).toBeNull();
      const other = 'aaaaaaaa-1111-2222-3333-444455556666';
      fs.symlinkSync(dir, path.join(root, other));
      expect(read(other)).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('an empty store is an empty list with version 0', () => {
    const { root } = setup();
    try {
      expect(createTaskReader(root)(SID)).toEqual({ version: '0', tasks: [] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
