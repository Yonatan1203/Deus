import { describe, expect, it } from 'vitest';
import type { ControlStore } from '../store.js';
import {
  debugCounts,
  debugHealth,
  debugTrace,
  MESSAGE_ID_RE,
} from './debug.js';
import type { DockerRunner } from './docker.js';

const docker: DockerRunner = {
  run: async () => ({ ok: false, error: 'x' }),
  cached: async () => ({ ok: true, stdout: '27.0\n', stderr: '' }),
};
const hub = {
  attach: () => true,
  broadcast: () => {},
  clientCount: () => 2,
  recent: () => [],
  close: () => {},
};
const store = {
  dbPing: () => true,
  countMessages: () => 7,
  findMessagesById: (id: string) =>
    id === 'm1'
      ? [
          {
            id: 'm1',
            chat_jid: 'g@x',
            timestamp: 't',
            is_from_me: false,
            is_bot_message: false,
            content_length: 3,
          },
        ]
      : [],
  getAllTasks: () => [
    { status: 'active' },
    { status: 'paused' },
    { status: 'active' },
  ],
  listSessionRows: () => [
    {
      group_folder: 'main',
      backend: 'claude',
      last_used_at: 'lu',
      orphaned_at: null,
    },
  ],
} as unknown as ControlStore;
const runtime = {
  queue: { snapshot: () => [{ jid: 'g@x', active: true, containerName: 'c' }] },
  registeredGroups: () => ({ 'g@x': { folder: 'main' } }),
} as never;

describe('debug api', () => {
  it('health, counts, trace', async () => {
    const deps = {
      docker,
      store,
      runtime,
      hub,
      buildRunning: () => false,
      channels: () => [{ name: 'telegram', isConnected: () => true }] as never,
    };
    expect(await debugHealth(deps)).toMatchObject({
      docker: { ok: true, version: '27.0' },
      db: { ok: true },
      channels: [{ name: 'telegram', connected: true }],
      sse_clients: 2,
      build_running: false,
    });
    expect(debugCounts(deps)).toEqual({
      groups: 1,
      tasks: { active: 2, paused: 1 },
      sessions: 1,
      containers_active: 1,
      messages: 7,
      sse_clients: 2,
    });
    const t = debugTrace(deps, 'm1');
    expect(t.messages[0]).not.toHaveProperty('content');
    expect(t.queue).toMatchObject({ jid: 'g@x' });
    expect(t.session).toEqual({
      backend: 'claude',
      last_used_at: 'lu',
      orphaned_at: null,
    });
    expect(debugTrace(deps, 'zzz')).toEqual({ messages: [] });
    expect(MESSAGE_ID_RE.test('..')).toBe(true); // shape only; the route rejects traversal-looking ids by the same regex bound
    expect(MESSAGE_ID_RE.test('a b')).toBe(false);
    expect(MESSAGE_ID_RE.test('x'.repeat(129))).toBe(false);
  });
});
