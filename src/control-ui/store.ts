import type { AgentRuntimeId } from '../agent-runtimes/types.js';
import type { SessionRow } from '../db.js';
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
}

export function isRegisteredFolder(
  runtime: WebTurnDeps,
  folder: string,
): boolean {
  return Object.values(runtime.registeredGroups()).some(
    (g) => g.folder === folder,
  );
}
