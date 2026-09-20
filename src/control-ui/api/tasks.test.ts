import { describe, expect, it, vi } from 'vitest';
import {
  createTaskFromBody,
  listTasks,
  removeTask,
  resolveNextRun,
  runTaskNow,
  updateTaskFromBody,
} from './tasks.js';
import type { ScheduledTask } from '../../types.js';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const runtime = {
  registeredGroups: () => ({
    'main@x': { name: 'Main', folder: 'main', trigger: '@d', added_at: '' },
    'ops@x': { name: 'Ops', folder: 'ops', trigger: '@d', added_at: '' },
  }),
} as never;

function store(initial: ScheduledTask[] = []) {
  const tasks = new Map(initial.map((t) => [t.id, t]));
  return {
    tasks,
    listSessionRows: () => [],
    clearSession: () => {},
    stopContainer: () => {},
    groupFolderPath: (f: string) => f,
    getAllTasks: () => [...tasks.values()],
    getTaskById: (id: string) => tasks.get(id),
    createTask: vi.fn((t: Omit<ScheduledTask, 'last_run' | 'last_result'>) => {
      tasks.set(t.id, { ...t, last_run: null, last_result: null });
    }),
    updateTask: vi.fn((id: string, u: Partial<ScheduledTask>) => {
      const t = tasks.get(id);
      if (t) tasks.set(id, { ...t, ...u });
    }),
    deleteTask: vi.fn((id: string) => {
      tasks.delete(id);
    }),
    getTaskRunLogs: () => [],
    onTasksChanged: vi.fn(),
  };
}

const base = { group_folder: 'main', chat_jid: 'main@x', prompt: 'do it' };

describe('control-ui tasks', () => {
  it('resolves next_run per schedule type and enforces the interval floor', () => {
    expect(resolveNextRun('interval', '60000', NOW)).toEqual({
      ok: true,
      next_run: new Date(NOW + 60_000).toISOString(),
    });
    expect(resolveNextRun('interval', '1000', NOW)).toEqual({
      ok: false,
      error: 'interval must be at least 60000 ms',
    });
    expect(resolveNextRun('interval', 'abc', NOW)).toEqual({
      ok: false,
      error: 'invalid interval',
    });
    expect(resolveNextRun('once', '2030-01-01T00:00:00Z', NOW)).toEqual({
      ok: true,
      next_run: '2030-01-01T00:00:00.000Z',
    });
    expect(resolveNextRun('once', 'never', NOW).ok).toBe(false);
    const cron = resolveNextRun('cron', '0 9 * * *', NOW);
    expect(cron.ok).toBe(true);
    expect(resolveNextRun('cron', 'not a cron', NOW)).toEqual({
      ok: false,
      error: 'invalid cron expression',
    });
    expect(resolveNextRun('weekly', 'x', NOW).ok).toBe(false);
  });

  it('creates a task with an explicit destination and rejects bad input', () => {
    const s = store();
    const r = createTaskFromBody(
      s,
      runtime,
      { ...base, schedule_type: 'interval', schedule_value: '60000' },
      NOW,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.task.id).toMatch(/^task-\d+-[a-z0-9]{6}$/);
    expect(r.task).toMatchObject({
      chat_jid: 'main@x',
      group_folder: 'main',
      status: 'active',
      context_mode: 'isolated',
      agent_backend: null,
    });
    expect(r.task.next_run).toBe(new Date(NOW + 60_000).toISOString());
    expect(s.onTasksChanged).toHaveBeenCalledTimes(1);
    expect(
      createTaskFromBody(
        s,
        runtime,
        {
          ...base,
          group_folder: 'nope',
          schedule_type: 'once',
          schedule_value: '2030-01-01',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 404 });
    expect(
      createTaskFromBody(
        s,
        runtime,
        {
          ...base,
          chat_jid: 'ops@x',
          schedule_type: 'once',
          schedule_value: '2030-01-01',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      createTaskFromBody(
        s,
        runtime,
        {
          group_folder: 'main',
          prompt: 'p',
          schedule_type: 'once',
          schedule_value: '2030-01-01',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      createTaskFromBody(
        s,
        runtime,
        { ...base, schedule_type: 'cron', schedule_value: 'bad' },
        NOW,
      ),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid cron expression',
    });
    expect(
      createTaskFromBody(
        s,
        runtime,
        { ...base, schedule_type: 'interval', schedule_value: '1000' },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      createTaskFromBody(
        s,
        runtime,
        {
          ...base,
          schedule_type: 'once',
          schedule_value: '2030-01-01',
          agent_backend: 'martian',
        },
        NOW,
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      createTaskFromBody(
        s,
        runtime,
        {
          ...base,
          schedule_type: 'once',
          schedule_value: '2030-01-01',
          agent_backend: 'openai',
          context_mode: 'group',
        },
        NOW,
      ),
    ).toMatchObject({
      ok: true,
      task: { agent_backend: 'openai', context_mode: 'group' },
    });
  });

  it('updates with recompute, rejects invalid status, and enforces the floor on update', () => {
    const s = store();
    const created = createTaskFromBody(
      s,
      runtime,
      { ...base, schedule_type: 'interval', schedule_value: '60000' },
      NOW,
    );
    if (!created.ok) throw new Error('x');
    const id = created.task.id;
    const u = updateTaskFromBody(s, id, { schedule_value: '120000' }, NOW);
    expect(u).toMatchObject({
      ok: true,
      task: {
        schedule_value: '120000',
        next_run: new Date(NOW + 120_000).toISOString(),
      },
    });
    expect(
      updateTaskFromBody(s, id, { schedule_value: '1000' }, NOW),
    ).toMatchObject({ ok: false, status: 400 });
    expect(updateTaskFromBody(s, id, { status: 'paused' }, NOW)).toMatchObject({
      ok: true,
      task: { status: 'paused' },
    });
    expect(
      updateTaskFromBody(s, id, { status: 'completed' }, NOW),
    ).toMatchObject({ ok: false, status: 400 });
    expect(updateTaskFromBody(s, id, {}, NOW)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(updateTaskFromBody(s, 'nope', { prompt: 'x' }, NOW)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('run-now moves next_run to now on active tasks only; remove deletes', () => {
    const s = store();
    const created = createTaskFromBody(
      s,
      runtime,
      { ...base, schedule_type: 'cron', schedule_value: '0 9 * * *' },
      NOW,
    );
    if (!created.ok) throw new Error('x');
    const id = created.task.id;
    const run = runTaskNow(s, id, NOW);
    expect(run).toMatchObject({
      ok: true,
      next_run: new Date(NOW).toISOString(),
      chat_jid: 'main@x',
    });
    if (run.ok) expect(run.promptHash).toHaveLength(12);
    updateTaskFromBody(s, id, { status: 'paused' }, NOW);
    expect(runTaskNow(s, id, NOW)).toMatchObject({ ok: false, status: 409 });
    expect(runTaskNow(s, 'nope', NOW)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(listTasks(s)).toHaveLength(1);
    expect(removeTask(s, id)).toBe(true);
    expect(removeTask(s, id)).toBe(false);
    expect(listTasks(s)).toHaveLength(0);
  });
});
