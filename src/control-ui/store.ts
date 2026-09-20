import type { AgentRuntimeId } from '../agent-runtimes/types.js';
import type { SessionRow } from '../db.js';
import type { ScheduledTask, TaskRunLog } from '../types.js';
import type { WebTurnDeps } from '../web-turn.js';

/** Host functions the Phase 2 routes need; injected so tests run on fakes. */
export interface ControlStore {
  listSessionRows(limit: number): SessionRow[];
  clearSession(
    folder: string,
    backend: AgentRuntimeId | undefined,
    reason: string,
  ): void;
  stopContainer(name: string): void;
  groupFolderPath(folder: string): string;
  getAllTasks(): ScheduledTask[];
  getTaskById(id: string): ScheduledTask | undefined;
  createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
  updateTask(
    id: string,
    updates: Partial<
      Pick<
        ScheduledTask,
        | 'prompt'
        | 'schedule_type'
        | 'schedule_value'
        | 'next_run'
        | 'status'
        | 'agent_backend'
      >
    >,
  ): void;
  deleteTask(id: string): void;
  getTaskRunLogs(taskId: string, limit: number): TaskRunLog[];
  /** Rewrites the per-group task snapshots, as IPC does after a change. */
  onTasksChanged(): void;
}

export function isRegisteredFolder(
  runtime: WebTurnDeps,
  folder: string,
): boolean {
  return Object.values(runtime.registeredGroups()).some(
    (g) => g.folder === folder,
  );
}
