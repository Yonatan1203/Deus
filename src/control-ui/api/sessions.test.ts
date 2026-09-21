import { describe, expect, it, vi } from 'vitest';
import { containersForFolder, killSession, listSessions } from './sessions.js';

const snapshot = () => [
  {
    jid: 'a@x',
    active: true,
    idleWaiting: false,
    isTaskContainer: false,
    runningTaskId: null,
    containerName: 'deus-a-1',
    groupFolder: 'a',
    pendingTaskCount: 0,
    retryCount: 0,
  },
];
const runtime = {
  queue: { snapshot },
  registeredGroups: () => ({ 'a@x': { folder: 'a' } }),
} as never;
const row = (f: string) => ({
  id: 1,
  group_folder: f,
  backend: 'claude',
  session_ref: 'abcd1234',
  last_used_at: null,
  orphaned_at: null,
  orphan_reason: null,
  last_compacted_at: null,
  metadata: null,
});

describe('control-ui sessions', () => {
  it('joins rows with the active container', () => {
    const store = {
      listSessionRows: () => [
        row('a'),
        row('b'),
        {
          ...row('a'),
          id: 3,
          orphaned_at: '2026-01-01T00:00:00Z',
          orphan_reason: 'control-ui kill',
        },
      ],
      clearSession: vi.fn(),
      stopContainer: vi.fn(),
      groupFolderPath: (f: string) => f,
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
    const out = listSessions(store, runtime);
    expect(out[0].active_container).toEqual({ name: 'deus-a-1', jid: 'a@x' });
    expect(out[1].active_container).toBeNull();
    expect(out[2].active_container).toBeNull();
  });

  it('kill stops every container for the folder, collects errors, clears all backends, refuses unknown folders', () => {
    const stop = vi.fn((name: string) => {
      if (name === 'deus-a-1') throw new Error('gone');
    });
    const clear = vi.fn();
    const store = {
      listSessionRows: () => [],
      clearSession: clear,
      stopContainer: stop,
      groupFolderPath: (f: string) => f,
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
    const rt = {
      queue: {
        snapshot: () => [
          ...snapshot(),
          { ...snapshot()[0], jid: 'a2@x', containerName: 'deus-a-2' },
        ],
      },
      registeredGroups: () => ({
        'a@x': { folder: 'a' },
        'a2@x': { folder: 'a' },
      }),
    } as never;
    expect(containersForFolder(rt, 'a').map((c) => c.name)).toEqual([
      'deus-a-1',
      'deus-a-2',
    ]);
    expect(killSession(store, rt, 'a')).toEqual({
      stopped: ['deus-a-2'],
      errors: ['deus-a-1: gone'],
      orphaned: true,
    });
    expect(clear).toHaveBeenCalledWith('a', undefined, 'control-ui kill');
    expect(killSession(store, rt, 'zzz')).toBeNull();
  });
});
