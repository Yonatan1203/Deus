import crypto from 'crypto';

import { parseAgentBackend } from '../../agent-runtimes/types.js';
import { SCHEDULER_POLL_INTERVAL, TIMEZONE } from '../../config.js';
import { parseCronExpression } from '../../cron.js';
import type { ScheduledTask } from '../../types.js';
import type { WebTurnDeps } from '../../web-turn.js';
import type { ControlStore } from '../store.js';

const MAX_PROMPT_CHARS = 32 * 1024;
export const TASK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

type ScheduleType = ScheduledTask['schedule_type'];
const SCHEDULE_TYPES: readonly string[] = ['cron', 'interval', 'once'];
type TaskUpdates = Parameters<ControlStore['updateTask']>[1];

export type NextRun =
  { ok: true; next_run: string } | { ok: false; error: string };

// Mirrors the container's IPC rules (src/ipc.ts schedule_task) with one
// stricter check: intervals below the scheduler poll cannot fire more often
// than the poll anyway, so the dashboard refuses them outright.
export function resolveNextRun(
  type: string,
  value: string,
  now = Date.now(),
): NextRun {
  if (type === 'cron') {
    let iso: string | null;
    try {
      iso = parseCronExpression(value, TIMEZONE).next().toISOString();
    } catch {
      iso = null;
    }
    return iso
      ? { ok: true, next_run: iso }
      : { ok: false, error: 'invalid cron expression' };
  }
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    if (Number.isNaN(ms) || ms <= 0)
      return { ok: false, error: 'invalid interval' };
    if (ms < SCHEDULER_POLL_INTERVAL) {
      return {
        ok: false,
        error: `interval must be at least ${SCHEDULER_POLL_INTERVAL} ms`,
      };
    }
    return { ok: true, next_run: new Date(now + ms).toISOString() };
  }
  if (type === 'once') {
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
      return { ok: false, error: 'invalid timestamp' };
    return { ok: true, next_run: date.toISOString() };
  }
  return { ok: false, error: 'schedule_type must be cron, interval, or once' };
}

export type TaskResult =
  | { ok: true; task: ScheduledTask }
  | { ok: false; status: 400 | 404; error: string };

const bad = (error: string): TaskResult => ({ ok: false, status: 400, error });

const promptHash = (prompt: string) =>
  crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 12);

function backendFrom(
  raw: unknown,
): { ok: true; value: ScheduledTask['agent_backend'] } | { ok: false } {
  if (raw === undefined || raw === null || raw === '')
    return { ok: true, value: null };
  const parsed = parseAgentBackend(raw);
  return parsed ? { ok: true, value: parsed } : { ok: false };
}

export function listTasks(store: ControlStore): ScheduledTask[] {
  return store.getAllTasks().sort((a, b) => {
    if (a.status !== b.status)
      return a.status === 'active' ? -1 : b.status === 'active' ? 1 : 0;
    return (a.next_run ?? '').localeCompare(b.next_run ?? '');
  });
}

export function createTaskFromBody(
  store: ControlStore,
  runtime: WebTurnDeps,
  body: unknown,
  now = Date.now(),
): TaskResult {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.group_folder !== 'string')
    return bad('group_folder is required');
  const groups = runtime.registeredGroups();
  const folder = b.group_folder;
  if (!Object.values(groups).some((g) => g.folder === folder)) {
    return { ok: false, status: 404, error: 'group not found' };
  }
  if (typeof b.chat_jid !== 'string' || !b.chat_jid)
    return bad('chat_jid is required');
  if (groups[b.chat_jid]?.folder !== folder) {
    return bad('chat_jid is not a registered destination of that group');
  }
  if (typeof b.prompt !== 'string' || !b.prompt.trim())
    return bad('prompt is required');
  if (b.prompt.length > MAX_PROMPT_CHARS) return bad('prompt too long');
  const type = typeof b.schedule_type === 'string' ? b.schedule_type : '';
  const value = typeof b.schedule_value === 'string' ? b.schedule_value : '';
  if (!SCHEDULE_TYPES.includes(type))
    return bad('schedule_type must be cron, interval, or once');
  const next = resolveNextRun(type, value, now);
  if (!next.ok) return bad(next.error);
  const backend = backendFrom(b.agent_backend);
  if (!backend.ok) return bad('unknown agent_backend');
  const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
    id: `task-${now}-${crypto.randomBytes(3).toString('hex')}`,
    group_folder: folder,
    chat_jid: b.chat_jid,
    prompt: b.prompt,
    schedule_type: type as ScheduleType,
    schedule_value: value,
    context_mode: b.context_mode === 'group' ? 'group' : 'isolated',
    next_run: next.next_run,
    status: 'active',
    created_at: new Date(now).toISOString(),
    agent_backend: backend.value,
  };
  store.createTask(task);
  store.onTasksChanged();
  return { ok: true, task: { ...task, last_run: null, last_result: null } };
}

export function updateTaskFromBody(
  store: ControlStore,
  id: string,
  body: unknown,
  now = Date.now(),
): TaskResult {
  const task = store.getTaskById(id);
  if (!task) return { ok: false, status: 404, error: 'not found' };
  const b = (body ?? {}) as Record<string, unknown>;
  const updates: TaskUpdates = {};
  if (b.prompt !== undefined) {
    if (typeof b.prompt !== 'string' || !b.prompt.trim())
      return bad('prompt must be a non-empty string');
    if (b.prompt.length > MAX_PROMPT_CHARS) return bad('prompt too long');
    updates.prompt = b.prompt;
  }
  if (b.status !== undefined) {
    if (b.status !== 'active' && b.status !== 'paused')
      return bad('status must be active or paused');
    updates.status = b.status;
  }
  if (b.schedule_type !== undefined || b.schedule_value !== undefined) {
    const type =
      b.schedule_type === undefined ? task.schedule_type : b.schedule_type;
    const value =
      b.schedule_value === undefined ? task.schedule_value : b.schedule_value;
    if (typeof type !== 'string' || !SCHEDULE_TYPES.includes(type)) {
      return bad('schedule_type must be cron, interval, or once');
    }
    if (typeof value !== 'string')
      return bad('schedule_value must be a string');
    const next = resolveNextRun(type, value, now);
    if (!next.ok) return bad(next.error);
    updates.schedule_type = type as ScheduleType;
    updates.schedule_value = value;
    updates.next_run = next.next_run;
  }
  if (b.agent_backend !== undefined) {
    const backend = backendFrom(b.agent_backend);
    if (!backend.ok) return bad('unknown agent_backend');
    updates.agent_backend = backend.value;
  }
  if (Object.keys(updates).length === 0) return bad('no updatable fields');
  store.updateTask(id, updates);
  store.onTasksChanged();
  return { ok: true, task: { ...task, ...updates } };
}

export type RunNowResult =
  | { ok: true; next_run: string; promptHash: string; chat_jid: string }
  | { ok: false; status: 404 | 409; error: string };

export function runTaskNow(
  store: ControlStore,
  id: string,
  now = Date.now(),
): RunNowResult {
  const task = store.getTaskById(id);
  if (!task) return { ok: false, status: 404, error: 'not found' };
  if (task.status !== 'active')
    return { ok: false, status: 409, error: 'task is not active' };
  const next_run = new Date(now).toISOString();
  store.updateTask(id, { next_run });
  store.onTasksChanged();
  return {
    ok: true,
    next_run,
    promptHash: promptHash(task.prompt),
    chat_jid: task.chat_jid,
  };
}

export function removeTask(store: ControlStore, id: string): boolean {
  if (!store.getTaskById(id)) return false;
  store.deleteTask(id);
  store.onTasksChanged();
  return true;
}
