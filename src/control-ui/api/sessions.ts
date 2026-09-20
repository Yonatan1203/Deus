import type { SessionRow } from '../../db.js';
import type { GroupSnapshot } from '../../group-queue.js';
import type { WebTurnDeps } from '../../web-turn.js';
import { isRegisteredFolder, type ControlStore } from '../store.js';

export type SessionView = SessionRow & {
  active_container: { name: string; jid: string } | null;
};

export interface ContainerRef {
  name: string;
  jid: string;
  isTaskContainer: boolean;
  runningTaskId: string | null;
}

export interface KillResult {
  stopped: string[];
  errors: string[];
  orphaned: true;
}

const activeFor = (snapshot: GroupSnapshot[], folder: string) =>
  snapshot.filter(
    (s) => s.groupFolder === folder && s.active && s.containerName,
  );

export function listSessions(
  store: ControlStore,
  runtime: WebTurnDeps,
): SessionView[] {
  const snapshot = runtime.queue.snapshot();
  return store.listSessionRows(200).map((row) => {
    // An orphaned row no longer owns anything; the folder's container belongs to a newer session.
    const c = row.orphaned_at
      ? undefined
      : activeFor(snapshot, row.group_folder)[0];
    return {
      ...row,
      active_container: c
        ? { name: c.containerName as string, jid: c.jid }
        : null,
    };
  });
}

/** What a kill would stop — shown in the confirmation dialog before it happens. */
export function containersForFolder(
  runtime: WebTurnDeps,
  folder: string,
): ContainerRef[] {
  return activeFor(runtime.queue.snapshot(), folder).map((s) => ({
    name: s.containerName as string,
    jid: s.jid,
    isTaskContainer: s.isTaskContainer,
    runningTaskId: s.runningTaskId,
  }));
}

// One container serves a jid regardless of backend, and several jids can share
// a folder (Linear dispatches), so kill is keyed by folder: every active
// container for it is stopped and every backend's session row is orphaned.
export function killSession(
  store: ControlStore,
  runtime: WebTurnDeps,
  folder: string,
): KillResult | null {
  if (!isRegisteredFolder(runtime, folder)) return null;
  const stopped: string[] = [];
  const errors: string[] = [];
  for (const c of containersForFolder(runtime, folder)) {
    try {
      store.stopContainer(c.name);
      stopped.push(c.name);
    } catch (err) {
      errors.push(
        `${c.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  store.clearSession(folder, undefined, 'control-ui kill');
  return { stopped, errors, orphaned: true };
}
