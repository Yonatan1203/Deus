import type { MessageTrace } from '../../db.js';
import type { GroupSnapshot } from '../../group-queue.js';
import type { Channel } from '../../types.js';
import type { ControlStore } from '../store.js';
import type { WebTurnDeps } from '../../web-turn.js';
import type { DockerRunner } from './docker.js';
import type { EventHub } from '../events.js';

export const MESSAGE_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;

export interface DebugDeps {
  docker: DockerRunner;
  store?: ControlStore;
  runtime?: WebTurnDeps;
  channels?: () => Channel[];
  hub: EventHub;
  buildRunning: () => boolean;
}

export async function debugHealth(deps: DebugDeps) {
  const v = await deps.docker.cached('version', 30_000, [
    'version',
    '--format',
    '{{.Server.Version}}',
  ]);
  return {
    docker: v.ok
      ? { ok: true, version: v.stdout.trim() }
      : { ok: false, error: v.error },
    db: { ok: deps.store ? deps.store.dbPing() : false },
    channels: (deps.channels?.() ?? []).map((c) => ({
      name: c.name,
      connected: safeConnected(c),
    })),
    sse_clients: deps.hub.clientCount(),
    build_running: deps.buildRunning(),
    uptime_s: Math.round(process.uptime()),
  };
}

function safeConnected(c: Channel): boolean {
  try {
    return c.isConnected();
  } catch {
    return false;
  }
}

export function debugCounts(deps: DebugDeps) {
  const tasks = deps.store?.getAllTasks() ?? [];
  const snap: GroupSnapshot[] = deps.runtime?.queue.snapshot() ?? [];
  return {
    groups: deps.runtime
      ? Object.keys(deps.runtime.registeredGroups()).length
      : 0,
    tasks: {
      active: tasks.filter((t) => t.status === 'active').length,
      paused: tasks.filter((t) => t.status === 'paused').length,
    },
    sessions: deps.store?.listSessionRows(1000).length ?? 0,
    containers_active: snap.filter((s) => s.active).length,
    messages: deps.store?.countMessages() ?? 0,
    sse_clients: deps.hub.clientCount(),
  };
}

export function debugTrace(
  deps: DebugDeps,
  messageId: string,
): {
  messages: MessageTrace[];
  queue?: GroupSnapshot;
  session?: {
    backend: string | null;
    last_used_at: string | null;
    orphaned_at: string | null;
  };
} {
  const messages = deps.store?.findMessagesById(messageId) ?? [];
  const out: ReturnType<typeof debugTrace> = { messages };
  const first = messages[0];
  if (!first || !deps.runtime) return out;
  const queue = deps.runtime.queue
    .snapshot()
    .find((s) => s.jid === first.chat_jid);
  if (queue) out.queue = queue;
  const group = deps.runtime.registeredGroups()[first.chat_jid];
  if (group && deps.store) {
    const row = deps.store
      .listSessionRows(1000)
      .find((r) => r.group_folder === group.folder);
    if (row)
      out.session = {
        backend: row.backend,
        last_used_at: row.last_used_at,
        orphaned_at: row.orphaned_at,
      };
  }
  return out;
}
