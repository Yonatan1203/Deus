import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

vi.mock('../container-runner.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));
vi.mock('../db.js', () => ({ getAllTasks: vi.fn(() => []) }));
vi.mock('../router-state.js', () => ({ getAvailableGroups: vi.fn(() => []) }));
vi.mock('../webui-consolidation.js', () => ({
  consolidateWebConversation: vi.fn(),
}));
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import {
  createControlServer,
  type ControlDeps,
  type ControlServerOptions,
} from './server.js';
import { createLogRing } from '../log-ring.js';
import { logger } from '../logger.js';
import { ensureControlTmpDir } from './api/config.js';
import type { DockerRunner } from './api/docker.js';
import type { BuildRunner } from './api/containers.js';
import { writeCredentialFile } from './auth.js';
import {
  _resetWebTurnStateForTest,
  startWebTurn,
  type WebTurnDeps,
} from '../web-turn.js';
import type { RuntimeEventSink } from '../agent-runtimes/types.js';
import type { ControlStore } from './store.js';
import type { ScheduledTask, TaskRunLog } from '../types.js';

const PASSWORD = 'correct-horse';
const H = { 'Content-Type': 'application/json' };
let server: Server;
let port: number;
let root: string;
let credFile: string;
let clock = 1_000_000;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function request(
  opts: http.RequestOptions & { body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text }),
      );
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function login(password = PASSWORD) {
  const reply = await request({
    method: 'POST',
    path: '/auth/login',
    headers: H,
    body: JSON.stringify({ password }),
  });
  if (reply.status !== 200)
    return { cookie: '', auth: {} as Record<string, string>, reply };
  const cookie = String(reply.headers['set-cookie']?.[0]).split(';')[0];
  const { token } = JSON.parse(reply.text);
  return { cookie, auth: { Cookie: cookie, 'X-Deus-Session': token }, reply };
}

function fakeRuntime(opts: { gate?: Promise<void> } = {}) {
  const closeStdin = vi.fn();
  const notifyIdle = vi.fn();
  const backend = {
    name: () => 'claude' as const,
    runTurn: async (_c: unknown, _s: unknown, sink: RuntimeEventSink) => {
      await sink({ type: 'output_text', text: 'hi' });
      await sink({ type: 'tool_call', name: 'Read', arguments: { path: 'x' } });
      if (opts.gate) await opts.gate;
      await sink({ type: 'turn_complete' });
      return { status: 'success' as const, result: 'hi' };
    },
  };
  const snapshotState = [
    {
      jid: 'main@x',
      active: true,
      idleWaiting: false,
      isTaskContainer: false,
      runningTaskId: null,
      containerName: 'deus-main-1',
      groupFolder: 'main',
      pendingTaskCount: 0,
      retryCount: 0,
    },
  ];
  const runtime = {
    queue: {
      enqueueTask: (_j: string, _i: string, fn: () => Promise<void>) => {
        void fn();
      },
      closeStdin,
      notifyIdle,
      isShuttingDown: () => false,
      snapshot: () => snapshotState,
    },
    registry: { resolve: () => backend },
    registeredGroups: () => ({
      'main@x': {
        name: 'Main',
        folder: 'main',
        trigger: '@d',
        added_at: '',
        isControlGroup: true,
      },
    }),
  } as unknown as WebTurnDeps;
  return { runtime, closeStdin, notifyIdle, snapshotState };
}

function fakeStore(root: string): ControlStore {
  const row = (f: string, i: number) => ({
    id: i,
    group_folder: f,
    backend: 'claude',
    session_ref: 'abcd1234',
    last_used_at: null,
    orphaned_at: null,
    orphan_reason: null,
    last_compacted_at: null,
    metadata: null,
  });
  return {
    listSessionRows: () => [row('main', 1), row('other', 2)],
    clearSession: vi.fn(),
    stopContainer: vi.fn(),
    groupFolderPath: (f: string) => {
      if (!/^[a-z]+$/.test(f)) throw new Error('bad');
      return path.join(root, 'groups', f);
    },
    ...taskStore(),
  };
}

// In-memory task store so route tests can assert persistence.
function taskStore() {
  const tasks = new Map<string, ScheduledTask>();
  const runs = new Map<string, TaskRunLog[]>();
  return {
    tasks,
    runs,
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
      runs.delete(id);
    }),
    getTaskRunLogs: (id: string, limit: number) =>
      (runs.get(id) ?? []).slice(0, limit),
    countMessages: () => 0,
    findMessagesById: () => [],
    dbPing: () => true,
    onTasksChanged: vi.fn(),
  };
}

function boot(
  overrides: Partial<ControlDeps> = {},
  staticHandler?: () => void,
  queuePollMs?: number,
  extra: Omit<
    ControlServerOptions,
    'now' | 'staticHandler' | 'queuePollMs'
  > = {},
) {
  const deps: ControlDeps = {
    repoRoot: root,
    webRoot: path.join(root, 'web'),
    credentialFile: credFile,
    readOnly: false,
    assistantName: 'Test',
    version: '0.0.0',
    envHas: () => false,
    ...overrides,
  };
  server = createControlServer(deps, {
    now: () => clock,
    staticHandler,
    queuePollMs,
    ...extra,
  });
  return new Promise<void>((r) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      r();
    }),
  );
}

beforeEach(() => {
  _resetWebTurnStateForTest();
  clock = 1_000_000;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-srv-'));
  credFile = path.join(root, 'cred.json');
  writeCredentialFile(credFile, PASSWORD);
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'wardens'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude', 'agents', 'a.md'),
    '---\nname: alpha\ndescription: d\n---\n',
  );
  fs.writeFileSync(
    path.join(root, '.claude', 'wardens', 'config.json.example'),
    JSON.stringify({ 'plan-reviewer': { enabled: true } }),
  );
  fs.writeFileSync(
    path.join(root, 'web', 'index.html'),
    '<!doctype html><title>t</title>',
  );
  fs.mkdirSync(path.join(root, 'groups', 'main'), { recursive: true });
  fs.writeFileSync(path.join(root, 'groups', 'main', 'CLAUDE.md'), '# hi');
});

function streamRequest(
  opts: http.RequestOptions & { body?: string },
  onChunk: (text: string, req: http.ClientRequest) => void,
) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    let text = '';
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c) => {
        text += c;
        onChunk(text, req);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('control-ui server', () => {
  it('serves the shell with security headers, blocks traversal and bad methods', async () => {
    await boot();
    const home = await request({ method: 'GET', path: '/' });
    expect(home.status).toBe(200);
    expect(home.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(home.headers['x-frame-options']).toBe('DENY');
    expect(
      (await request({ method: 'GET', path: '/..%2f..%2fetc%2fpasswd' }))
        .status,
    ).toBe(404);
    expect((await request({ method: 'POST', path: '/' })).status).toBe(405);
    const json = await request({ method: 'GET', path: '/api/v1/nope' });
    expect(json.status).toBe(404);
    expect(json.headers['referrer-policy']).toBe('no-referrer');
  });

  it('requires cookie AND header, then serves the API', async () => {
    await boot();
    expect(
      (await request({ method: 'GET', path: '/api/v1/agents' })).status,
    ).toBe(401);
    const { cookie, auth, reply } = await login();
    const setCookie = String(reply.headers['set-cookie']?.[0]);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('Secure');
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/agents',
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/agents',
          headers: { 'X-Deus-Session': auth['X-Deus-Session'] },
        })
      ).status,
    ).toBe(401);
    const agents = await request({
      method: 'GET',
      path: '/api/v1/agents',
      headers: auth,
    });
    expect(agents.status).toBe(200);
    expect(JSON.parse(agents.text)).toEqual([
      { name: 'alpha', description: 'd', file: 'a.md' },
    ]);
    const me = JSON.parse(
      (await request({ method: 'GET', path: '/api/v1/me', headers: auth }))
        .text,
    );
    expect(me).toMatchObject({
      assistant: 'Test',
      version: '0.0.0',
      read_only: false,
    });
    expect(me.session.sid).toHaveLength(12);
    expect(
      (await request({ method: 'POST', path: '/auth/logout', headers: auth }))
        .status,
    ).toBe(204);
    expect(
      (await request({ method: 'GET', path: '/api/v1/agents', headers: auth }))
        .status,
    ).toBe(401);
  });

  it('gates warden disable on X-Confirm and enforces Origin when present', async () => {
    await boot();
    const { auth } = await login();
    const patch = (headers: Record<string, string>, body: string) =>
      request({
        method: 'PATCH',
        path: '/api/v1/wardens/plan-reviewer',
        headers: { ...auth, ...H, ...headers },
        body,
      });
    expect(
      (await patch({ Origin: 'http://evil.example' }, '{"enabled":false}'))
        .status,
    ).toBe(403);
    expect((await patch({}, '{"enabled":false}')).status).toBe(428);
    expect((await patch({}, '{"enabled":"no"}')).status).toBe(400);
    const ok = await patch(
      { 'X-Confirm': 'plan-reviewer', Origin: `http://127.0.0.1:${port}` },
      '{"enabled":false}',
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text).enabled).toBe(false);
    expect((await patch({}, '{"enabled":true}')).status).toBe(200);
    expect(
      (
        await request({
          method: 'PATCH',
          path: '/api/v1/wardens/..%2Fx',
          headers: { ...auth, ...H },
          body: '{"enabled":true}',
        })
      ).status,
    ).toBe(404);
  });

  it('backs off exponentially and never echoes the password', async () => {
    await boot();
    for (let i = 0; i < 3; i++) {
      const r = await login('wrong');
      expect(r.reply.status).toBe(401);
      expect(r.reply.text).not.toContain('wrong');
      clock += 10_000;
    }
    clock -= 10_000;
    const locked = await login();
    expect(locked.reply.status).toBe(429);
    const body = JSON.parse(locked.reply.text);
    expect(body).toMatchObject({ error: 'locked' });
    expect(body.retry_after_ms).toBeGreaterThan(0);
    clock += 5_000;
    expect((await login()).reply.status).toBe(200);
  });

  it('applies rotation live, revokes sessions, and fails closed when the file vanishes', async () => {
    await boot();
    const { auth } = await login();
    expect(
      (await request({ method: 'GET', path: '/api/v1/agents', headers: auth }))
        .status,
    ).toBe(200);
    writeCredentialFile(credFile, 'new-password');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(credFile, later, later);
    expect(
      (await request({ method: 'GET', path: '/api/v1/agents', headers: auth }))
        .status,
    ).toBe(401);
    expect((await login()).reply.status).toBe(401);
    clock += 2_000;
    const fresh = await login('new-password');
    expect(fresh.reply.status).toBe(200);
    expect(
      (
        await request({
          method: 'POST',
          path: '/auth/sessions/revoke-all',
          headers: { ...fresh.auth, 'X-Confirm': 'all' },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/agents',
          headers: fresh.auth,
        })
      ).status,
    ).toBe(401);
    fs.rmSync(credFile);
    expect((await login('new-password')).reply.status).toBe(503);
  });

  it('refuses mutations in read-only mode but still logs in', async () => {
    await boot({ readOnly: true });
    const { auth } = await login();
    expect(
      (await request({ method: 'GET', path: '/api/v1/wardens', headers: auth }))
        .status,
    ).toBe(200);
    const r = await request({
      method: 'PATCH',
      path: '/api/v1/wardens/plan-reviewer',
      headers: { ...auth, ...H, 'X-Confirm': 'plan-reviewer' },
      body: '{"enabled":false}',
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual({ error: 'read-only mode' });
  });

  it('rejects oversized and non-JSON bodies', async () => {
    await boot();
    const big = await request({
      method: 'POST',
      path: '/auth/login',
      headers: H,
      body: JSON.stringify({ password: 'x'.repeat(300 * 1024) }),
    });
    expect(big.status).toBe(413);
    const bad = await request({
      method: 'POST',
      path: '/auth/login',
      headers: H,
      body: '{nope',
    });
    expect(bad.status).toBe(400);
  });

  it('streams SSE only with a single-use ticket bound to the cookie', async () => {
    await boot();
    const { cookie, auth } = await login();
    expect(
      (await request({ method: 'GET', path: '/api/v1/events' })).status,
    ).toBe(401);
    const { ticket } = JSON.parse(
      (
        await request({
          method: 'POST',
          path: '/api/v1/events/ticket',
          headers: auth,
        })
      ).text,
    );
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/events?ticket=${ticket}`,
          headers: { Cookie: cookie },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          res.once('data', (c) => {
            resolve(String(c));
            req.destroy();
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(first).toContain(': ok');
    expect(
      (
        await request({
          method: 'GET',
          path: `/api/v1/events?ticket=${ticket}`,
          headers: { Cookie: cookie },
        })
      ).status,
    ).toBe(401);
  });

  it('answers 500 instead of crashing when a handler throws', async () => {
    await boot({}, () => {
      throw new Error('boom');
    });
    const r = await request({ method: 'GET', path: '/' });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'internal error' });
    expect(r.text).not.toContain('boom');
  });
});

describe('control-ui server — chat, sessions, groups', () => {
  it('answers 503 for the live routes without a runtime', async () => {
    await boot();
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/sessions',
          headers: auth,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/chat/turns',
          headers: { ...auth, ...H },
          body: '{"message":"hi"}',
        })
      ).status,
    ).toBe(503);
  });

  it('streams a chat turn as SSE frames and rejects empty messages', async () => {
    const { runtime } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root) });
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/chat/turns',
          headers: { ...auth, ...H },
          body: '{"message":""}',
        })
      ).status,
    ).toBe(400);
    const r = await streamRequest(
      {
        method: 'POST',
        path: '/api/v1/chat/turns',
        headers: { ...auth, ...H },
        body: '{"message":"hi","history":[{"role":"assistant","content":"earlier"}]}',
      },
      () => {},
    );
    expect(r.status).toBe(200);
    const types = [...r.text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(types).toEqual([
      'turn_started',
      'output_text',
      'tool_call',
      'turn_complete',
    ]);
    expect(r.text).toContain('"name":"Read"');
  });

  it('aborts a running turn via DELETE and refuses foreign or unknown ids', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const { runtime, closeStdin } = fakeRuntime({ gate });
    await boot({ runtime, store: fakeStore(root) });
    const { auth } = await login();
    let deleted: Promise<Reply> | null = null;
    const r = await streamRequest(
      {
        method: 'POST',
        path: '/api/v1/chat/turns',
        headers: { ...auth, ...H },
        body: '{"message":"hi"}',
      },
      (text) => {
        const m = /event: turn_started\ndata: (\{.*\})/.exec(text);
        if (m && !deleted) {
          const { id } = JSON.parse(m[1]);
          deleted = request({
            method: 'DELETE',
            path: `/api/v1/chat/turns/${id}`,
            headers: auth,
          });
        }
      },
    );
    expect((await deleted!).status).toBe(204);
    expect(closeStdin).toHaveBeenCalledWith('main@x');
    expect(r.text).toContain('event: error');
    expect(r.text).toContain('turn stopped by user');
    release();
    expect(
      (
        await request({
          method: 'DELETE',
          path: '/api/v1/chat/turns/0123456789abcdef',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    const foreign = startWebTurn(runtime, {
      prompt: 'x',
      latest: 'x',
      stream: false,
      source: 'odysseus',
      remoteAddr: 't',
      onEvent: () => {},
      onDone: () => {},
    });
    if (!foreign.ok) throw new Error('expected ok');
    expect(
      (
        await request({
          method: 'DELETE',
          path: `/api/v1/chat/turns/${foreign.id}`,
          headers: auth,
        })
      ).status,
    ).toBe(404);
    foreign.abort();
  });

  it('refuses chat and abort in read-only mode', async () => {
    const { runtime } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root), readOnly: true });
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/chat/turns',
          headers: { ...auth, ...H },
          body: '{"message":"hi"}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'DELETE',
          path: '/api/v1/chat/turns/0123456789abcdef',
          headers: auth,
        })
      ).status,
    ).toBe(403);
  });

  it('lists sessions with containers and kills per folder with confirmation', async () => {
    const { runtime } = fakeRuntime();
    const store = fakeStore(root);
    await boot({ runtime, store });
    const { auth } = await login();
    const list = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/sessions',
          headers: auth,
        })
      ).text,
    );
    expect(list.rows).toHaveLength(2);
    expect(list.rows[0].active_container).toEqual({
      name: 'deus-main-1',
      jid: 'main@x',
    });
    expect(list.rows[1].active_container).toBeNull();
    expect(list.containers.main.map((c: { name: string }) => c.name)).toEqual([
      'deus-main-1',
    ]);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/sessions/main/kill',
          headers: auth,
        })
      ).status,
    ).toBe(428);
    const killed = await request({
      method: 'POST',
      path: '/api/v1/sessions/main/kill',
      headers: { ...auth, 'X-Confirm': 'main' },
    });
    expect(killed.status).toBe(200);
    expect(JSON.parse(killed.text)).toEqual({
      stopped: ['deus-main-1'],
      errors: [],
      orphaned: true,
    });
    expect(store.stopContainer).toHaveBeenCalledWith('deus-main-1');
    expect(store.clearSession).toHaveBeenCalledWith(
      'main',
      undefined,
      'control-ui kill',
    );
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/sessions/nope/kill',
          headers: { ...auth, 'X-Confirm': 'nope' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/sessions/..%2Fx/kill',
          headers: { ...auth, 'X-Confirm': '../x' },
        })
      ).status,
    ).toBe(404);
  });

  it('lists groups and reads/writes CLAUDE.md with confirmation, backups, caps, and a rate limit', async () => {
    const { runtime } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root) });
    const { auth } = await login();
    const groups = JSON.parse(
      (await request({ method: 'GET', path: '/api/v1/groups', headers: auth }))
        .text,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].container.containerName).toBe('deus-main-1');
    expect(groups[0].claude_md_bytes).toBe(4);
    expect(
      JSON.parse(
        (
          await request({
            method: 'GET',
            path: '/api/v1/groups/main/claude-md',
            headers: auth,
          })
        ).text,
      ),
    ).toMatchObject({ content: '# hi' });
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/groups/nope/claude-md',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    const put = (headers: Record<string, string>, body: string) =>
      request({
        method: 'PUT',
        path: '/api/v1/groups/main/claude-md',
        headers: { ...auth, ...H, ...headers },
        body,
      });
    expect((await put({}, '{"content":"# a"}')).status).toBe(428);
    const first = await put({ 'X-Confirm': 'main' }, '{"content":"# a"}');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.text)).toMatchObject({
      bytes_before: 4,
      bytes_after: 3,
    });
    expect(JSON.parse(first.text).backup).toMatch(/CLAUDE\.md\.bak-/);
    expect(
      (
        await put(
          { 'X-Confirm': 'main' },
          JSON.stringify({ content: 'x'.repeat(1_200_000) }),
        )
      ).status,
    ).toBe(413);
    for (let i = 0; i < 5; i++)
      expect(
        (await put({ 'X-Confirm': 'main' }, '{"content":"# b"}')).status,
      ).toBe(200);
    expect(
      (await put({ 'X-Confirm': 'main' }, '{"content":"# c"}')).status,
    ).toBe(429);
  });

  it('refuses CLAUDE.md writes in read-only mode', async () => {
    const { runtime } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root), readOnly: true });
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'PUT',
          path: '/api/v1/groups/main/claude-md',
          headers: { ...auth, ...H, 'X-Confirm': 'main' },
          body: '{"content":"# a"}',
        })
      ).status,
    ).toBe(403);
  });

  it('broadcasts queue snapshots when they change', async () => {
    const { runtime, snapshotState } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root) }, undefined, 10);
    const { cookie, auth } = await login();
    const { ticket } = JSON.parse(
      (
        await request({
          method: 'POST',
          path: '/api/v1/events/ticket',
          headers: auth,
        })
      ).text,
    );
    const frames = await new Promise<string>((resolve, reject) => {
      let text = '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/events?ticket=${ticket}`,
          headers: { Cookie: cookie },
        },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (c) => {
            text += c;
            if (text.includes('"containerName":"deus-main-2"')) {
              req.destroy();
              resolve(text);
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
      setTimeout(
        () =>
          snapshotState.push({
            ...snapshotState[0],
            jid: 'b@x',
            containerName: 'deus-main-2',
          }),
        40,
      );
      setTimeout(() => reject(new Error('no queue frame')), 2000);
    });
    expect(frames).toContain('event: queue');
  });
});

describe('control-ui server — tasks, channels, memory', () => {
  const TASK = {
    group_folder: 'main',
    chat_jid: 'main@x',
    prompt: 'p',
    schedule_type: 'interval',
    schedule_value: '60000',
  };

  it('creates, updates, runs, lists runs and deletes tasks with the guards', async () => {
    const { runtime } = fakeRuntime();
    const store = fakeStore(root);
    await boot({ runtime, store });
    const { auth } = await login();
    const post = (body: unknown, extra: Record<string, string> = {}) =>
      request({
        method: 'POST',
        path: '/api/v1/tasks',
        headers: { ...auth, ...H, ...extra },
        body: JSON.stringify(body),
      });
    const created = await post(TASK);
    expect(created.status).toBe(201);
    const task = JSON.parse(created.text);
    expect(task.id).toMatch(/^task-\d+-[a-z0-9]{6}$/);
    expect(task.chat_jid).toBe('main@x');
    expect(
      (store as unknown as { onTasksChanged: ReturnType<typeof vi.fn> })
        .onTasksChanged,
    ).toHaveBeenCalled();
    const list = JSON.parse(
      (await request({ method: 'GET', path: '/api/v1/tasks', headers: auth }))
        .text,
    );
    expect(list.map((t: { id: string }) => t.id)).toEqual([task.id]);
    const patch = await request({
      method: 'PATCH',
      path: `/api/v1/tasks/${task.id}`,
      headers: { ...auth, ...H },
      body: '{"schedule_value":"120000"}',
    });
    expect(patch.status).toBe(200);
    expect(new Date(JSON.parse(patch.text).next_run).getTime()).toBe(
      clock + 120_000,
    );
    expect(
      (
        await request({
          method: 'PATCH',
          path: `/api/v1/tasks/${task.id}`,
          headers: { ...auth, ...H },
          body: '{"schedule_value":"1000"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request({
          method: 'PATCH',
          path: `/api/v1/tasks/${task.id}`,
          headers: { ...auth, ...H },
          body: '{"status":"completed"}',
        })
      ).status,
    ).toBe(400);
    const run = await request({
      method: 'POST',
      path: `/api/v1/tasks/${task.id}/run`,
      headers: auth,
    });
    expect(run.status).toBe(200);
    expect(new Date(JSON.parse(run.text).next_run).getTime()).toBe(clock);
    expect(
      (
        await request({
          method: 'PATCH',
          path: `/api/v1/tasks/${task.id}`,
          headers: { ...auth, ...H },
          body: '{"status":"paused"}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request({
          method: 'POST',
          path: `/api/v1/tasks/${task.id}/run`,
          headers: auth,
        })
      ).status,
    ).toBe(409);
    expect(
      JSON.parse(
        (
          await request({
            method: 'GET',
            path: `/api/v1/tasks/${task.id}/runs`,
            headers: auth,
          })
        ).text,
      ),
    ).toEqual([]);
    expect(
      (
        await request({
          method: 'DELETE',
          path: `/api/v1/tasks/${task.id}`,
          headers: auth,
        })
      ).status,
    ).toBe(428);
    expect(
      (
        await request({
          method: 'DELETE',
          path: `/api/v1/tasks/${task.id}`,
          headers: { ...auth, 'X-Confirm': task.id },
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await request({
          method: 'DELETE',
          path: `/api/v1/tasks/${task.id}`,
          headers: { ...auth, 'X-Confirm': task.id },
        })
      ).status,
    ).toBe(404);
    // Validation failures (each still spends limiter budget — attempts are attempts).
    expect(
      (await post({ ...TASK, schedule_value: 'bad', schedule_type: 'cron' }))
        .status,
    ).toBe(400);
    expect((await post({ ...TASK, group_folder: 'nope' })).status).toBe(404);
    expect((await post({ ...TASK, chat_jid: 'other@x' })).status).toBe(400);
    // 6 mutations so far (create, run, run→409, 3 invalid creates) → the shared limiter trips.
    expect((await post({ ...TASK, schedule_value: '1000' })).status).toBe(429);
  });

  it('caps active tasks and refuses task mutations in read-only mode', async () => {
    const { runtime } = fakeRuntime();
    const store = fakeStore(root);
    for (let i = 0; i < 100; i++) {
      store.createTask({
        id: `task-${i}`,
        group_folder: 'main',
        chat_jid: 'main@x',
        prompt: 'p',
        schedule_type: 'once',
        schedule_value: '2030-01-01',
        context_mode: 'isolated',
        next_run: null,
        status: 'active',
        created_at: '',
      });
    }
    await boot({ runtime, store });
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/tasks',
          headers: { ...auth, ...H },
          body: JSON.stringify(TASK),
        })
      ).status,
    ).toBe(429);
    await new Promise<void>((r) => server.close(() => r()));
    await boot({ runtime, store: fakeStore(root), readOnly: true });
    const ro = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/tasks',
          headers: { ...ro.auth, ...H },
          body: JSON.stringify(TASK),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/tasks/task-1/run',
          headers: ro.auth,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/tasks',
          headers: ro.auth,
        })
      ).status,
    ).toBe(200);
  });

  it('lists channels with wiring and pairing state and gates the QR', async () => {
    const { runtime } = fakeRuntime();
    const authDir = path.join(root, 'wa', 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'wa', 'qr-data.txt'), 'example-qr');
    const telegram = {
      name: 'telegram',
      isConnected: () => true,
      ownsJid: (jid: string) => jid === 'main@x',
    } as unknown as import('../types.js').Channel;
    await boot({
      runtime,
      store: fakeStore(root),
      channels: () => [telegram],
      whatsappAuthDir: authDir,
    });
    const { auth } = await login();
    const list = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/channels',
          headers: auth,
        })
      ).text,
    );
    expect(list).toHaveLength(8);
    expect(
      list.find((c: { name: string }) => c.name === 'telegram'),
    ).toMatchObject({ connected: true, groups: ['main'] });
    expect(
      list.find((c: { name: string }) => c.name === 'whatsapp').pairing,
    ).toEqual({
      needs_pairing: true,
      qr_available: true,
      pairing_code_available: false,
    });
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/channels/whatsapp/qr',
          headers: auth,
        })
      ).status,
    ).toBe(428);
    const qr = await request({
      method: 'POST',
      path: '/api/v1/channels/whatsapp/qr',
      headers: { ...auth, 'X-Confirm': 'whatsapp' },
    });
    expect(qr.status).toBe(200);
    expect(JSON.parse(qr.text).qr).toBe('example-qr');
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/channels/whatsapp/qr',
          headers: { ...auth, 'X-Confirm': 'whatsapp' },
        })
      ).status,
    ).toBe(409);
    await new Promise<void>((r) => server.close(() => r()));
    await boot({
      runtime,
      store: fakeStore(root),
      channels: () => [],
      whatsappAuthDir: authDir,
      readOnly: true,
    });
    const ro = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/channels/whatsapp/qr',
          headers: { ...ro.auth, 'X-Confirm': 'whatsapp' },
        })
      ).status,
    ).toBe(403);
  });

  it('browses and writes memory within the roots and policies', async () => {
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(vault, 'Persona'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# core');
    fs.writeFileSync(path.join(vault, 'memory', 'a.md'), '# a');
    fs.writeFileSync(path.join(vault, 'Persona', 'p.md'), '# p');
    fs.writeFileSync(path.join(root, 'groups', 'main', 'brand.md'), '# b');
    const { runtime } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root), vaultPath: vault });
    const { auth } = await login();
    const tree = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/memory/tree',
          headers: auth,
        })
      ).text,
    );
    expect(
      tree.map((e: { root: string; path: string }) => `${e.root}:${e.path}`),
    ).toEqual([
      'groups:main/CLAUDE.md',
      'groups:main/brand.md',
      'vault:CLAUDE.md',
      'vault:Persona/p.md',
      'vault:memory/a.md',
    ]);
    expect(
      JSON.parse(
        (
          await request({
            method: 'GET',
            path: '/api/v1/memory/file?root=vault&path=memory/a.md',
            headers: auth,
          })
        ).text,
      ),
    ).toMatchObject({ content: '# a' });
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/memory/file?root=vault&path=../groups/main/brand.md',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/memory/file?root=vault&path=memory/a.txt',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    const put = (body: unknown, extra: Record<string, string> = {}) =>
      request({
        method: 'PUT',
        path: '/api/v1/memory/file',
        headers: { ...auth, ...H, ...extra },
        body: JSON.stringify(body),
      });
    expect(
      (await put({ root: 'vault', path: 'memory/a.md', content: '# a2' }))
        .status,
    ).toBe(428);
    const ok = await put(
      { root: 'vault', path: 'memory/a.md', content: '# a2' },
      { 'X-Confirm-Edit': '1' },
    );
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({
      bytes_before: 3,
      bytes_after: 4,
      index_not_updated: true,
    });
    expect(
      (
        await put(
          { root: 'vault', path: 'CLAUDE.md', content: 'x' },
          { 'X-Confirm-Edit': '1' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await put(
          { root: 'vault', path: 'Persona/p.md', content: 'x' },
          { 'X-Confirm-Edit': '1' },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await put(
          { root: 'groups', path: 'main/CLAUDE.md', content: 'x' },
          { 'X-Confirm-Edit': '1' },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await put(
          { root: 'groups', path: 'main/missing.md', content: 'x' },
          { 'X-Confirm-Edit': '1' },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await put(
          {
            root: 'groups',
            path: 'main/brand.md',
            content: 'x'.repeat(1_200_000),
          },
          { 'X-Confirm-Edit': '1' },
        )
      ).status,
    ).toBe(413);
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (
        await put(
          { root: 'groups', path: 'main/brand.md', content: `# b${i}` },
          { 'X-Confirm-Edit': '1' },
        )
      ).status;
    expect(last).toBe(429);
    await new Promise<void>((r) => server.close(() => r()));
    await boot({
      runtime,
      store: fakeStore(root),
      vaultPath: vault,
      readOnly: true,
    });
    const ro = await login();
    const roTree = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/memory/tree',
          headers: ro.auth,
        })
      ).text,
    );
    expect(roTree.every((e: { root: string }) => e.root === 'groups')).toBe(
      true,
    );
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/memory/file?root=vault&path=memory/a.md',
          headers: ro.auth,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request({
          method: 'PUT',
          path: '/api/v1/memory/file',
          headers: { ...ro.auth, ...H, 'X-Confirm-Edit': '1' },
          body: JSON.stringify({
            root: 'groups',
            path: 'main/brand.md',
            content: 'x',
          }),
        })
      ).status,
    ).toBe(403);
  });
});

describe('control-ui server — containers, logs, system, config, debug', () => {
  const ID = 'abcdef12';
  const own = `deus-main-1758000000000-i${ID}`;
  const foreign = 'deus-main-1758000000001-i00000000';
  function fakeDocker(fail = false): DockerRunner & { calls: string[][] } {
    const calls: string[][] = [];
    const answer = async (argv: string[]) => {
      calls.push(argv);
      if (fail) return { ok: false as const, error: 'docker not found' };
      if (argv[0] === 'ps')
        return {
          ok: true as const,
          stdout: [
            JSON.stringify({
              Names: own,
              Image: 'deus-agent:latest',
              State: 'running',
              Status: 'Up',
              CreatedAt: 'now',
            }),
            JSON.stringify({
              Names: foreign,
              Image: 'x',
              State: 'running',
              Status: 'Up',
              CreatedAt: 'now',
            }),
          ].join('\n'),
          stderr: '',
        };
      if (argv[0] === 'logs')
        return {
          ok: true as const,
          stdout: 'line one\ntoken=abc\n',
          stderr: '',
        };
      if (argv[0] === 'version')
        return { ok: true as const, stdout: '27.0\n', stderr: '' };
      if (argv[0] === 'system')
        return {
          ok: true as const,
          stdout:
            '{"Type":"Images","TotalCount":"1","Active":"1","Size":"1B","Reclaimable":"0B"}\n',
          stderr: '',
        };
      if (argv[0] === 'stop')
        return { ok: true as const, stdout: '', stderr: '' };
      return { ok: false as const, error: 'unexpected' };
    };
    return { calls, run: answer, cached: (_k, _t, argv) => answer(argv) };
  }
  function fakeBuild(): BuildRunner & { starts: number } {
    const b = {
      starts: 0,
      running: false,
      async start() {
        if (b.running) return 'running' as const;
        b.running = true;
        b.starts++;
        return 'started' as const;
      },
      status: () => ({
        running: b.running,
        started_at: null,
        finished_at: null,
        code: null,
        image_ref: 'deus-agent:latest',
        head: 'abc',
        dirty: false,
        lines: [],
      }),
    };
    return b;
  }
  let envPath: string;
  let configDir: string;
  let ring: ReturnType<typeof createLogRing>;
  const push = (s: string) =>
    new Promise<void>((r) => ring.stream.write(`${s}\n`, () => r()));
  const bootP4 = (
    over: Partial<ControlDeps> = {},
    extra: Parameters<typeof boot>[3] = {},
  ) => {
    envPath = path.join(root, '.env');
    fs.writeFileSync(
      envPath,
      '# hello\nLOG_LEVEL=info\nANTHROPIC_API_KEY=sk-x\n',
    );
    configDir = path.join(root, 'cfg');
    ensureControlTmpDir(root);
    ring = createLogRing(100);
    const { runtime, snapshotState } = fakeRuntime();
    snapshotState[0].containerName = own;
    return boot(
      {
        runtime,
        store: fakeStore(root),
        bin: 'docker',
        instanceId: ID,
        logRing: ring,
        envPath,
        configDir,
        ...over,
      },
      undefined,
      undefined,
      {
        docker: fakeDocker(),
        buildRunner: fakeBuild(),
        logBatchMs: 20,
        ...extra,
      },
    );
  };
  const infoSpy = vi.spyOn(logger, 'info');
  const warnSpy = vi.spyOn(logger, 'warn');
  beforeEach(() => {
    infoSpy.mockClear();
    warnSpy.mockClear();
  });
  const events = (spy: typeof infoSpy, ev: string) =>
    spy.mock.calls.filter((c) => (c[0] as { event?: string })?.event === ev);

  it('lists own containers, refuses foreign stops (audited), stops own ones, guards rebuild', async () => {
    await bootP4();
    const { auth } = await login();
    const list = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/containers',
          headers: auth,
        })
      ).text,
    );
    expect(list.containers.map((c: { name: string }) => c.name)).toEqual([own]);
    expect(list.containers[0]).toMatchObject({ group_folder: 'main' });
    expect(
      (
        await request({
          method: 'POST',
          path: `/api/v1/containers/${own}/stop`,
          headers: auth,
        })
      ).status,
    ).toBe(428);
    const refused = await request({
      method: 'POST',
      path: `/api/v1/containers/${foreign}/stop`,
      headers: { ...auth, 'X-Confirm': foreign },
    });
    expect(refused.status).toBe(404);
    const audit = events(warnSpy, 'control_ui_container_stop_refused');
    expect(audit).toHaveLength(1);
    expect((audit[0][0] as { name: string }).name.length).toBeLessThanOrEqual(
      128,
    );
    const ok = await request({
      method: 'POST',
      path: `/api/v1/containers/${own}/stop`,
      headers: { ...auth, 'X-Confirm': own },
    });
    expect(ok.status).toBe(200);
    expect(events(warnSpy, 'control_ui_container_stop')).toHaveLength(1);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/containers/rebuild',
          headers: auth,
        })
      ).status,
    ).toBe(428);
    const started = await request({
      method: 'POST',
      path: '/api/v1/containers/rebuild',
      headers: { ...auth, 'X-Confirm': 'rebuild' },
    });
    expect(started.status).toBe(200);
    expect(JSON.parse(started.text)).toMatchObject({
      started: true,
      image_ref: 'deus-agent:latest',
      head: 'abc',
      dirty: false,
    });
    const rebuildAudit = events(warnSpy, 'control_ui_container_rebuild');
    expect(rebuildAudit[0][0]).toMatchObject({
      image_ref: 'deus-agent:latest',
      head: 'abc',
      dirty: false,
    });
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/containers/rebuild',
          headers: { ...auth, 'X-Confirm': 'rebuild' },
        })
      ).status,
    ).toBe(409);
    expect(
      JSON.parse(
        (
          await request({
            method: 'GET',
            path: '/api/v1/containers/build',
            headers: auth,
          })
        ).text,
      ),
    ).toMatchObject({ running: true });
  });

  it('answers 502 when the runtime refuses a stop and probe_error when it is missing', async () => {
    await bootP4({}, { docker: fakeDocker(true) });
    const { auth } = await login();
    expect(
      JSON.parse(
        (
          await request({
            method: 'GET',
            path: '/api/v1/containers',
            headers: auth,
          })
        ).text,
      ),
    ).toEqual({ containers: [], probe_error: 'docker not found' });
    expect(
      (
        await request({
          method: 'POST',
          path: `/api/v1/containers/${own}/stop`,
          headers: { ...auth, 'X-Confirm': own },
        })
      ).status,
    ).toBe(502);
    const sys = JSON.parse(
      (await request({ method: 'GET', path: '/api/v1/system', headers: auth }))
        .text,
    );
    expect(sys.docker).toEqual({ error: 'docker not found' });
    expect(sys.disk).toHaveProperty('used_pct');
  });

  it('serves host and container logs with redaction, dedups read audits, exports', async () => {
    await bootP4();
    const { auth } = await login();
    await push('{"level":30,"msg":"alpha","token":"t1"}');
    await push('{"level":40,"msg":"beta"}');
    await push('{"level":30,"msg":"gamma","event":"control_ui_x"}');
    const host = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/logs?source=host&level=warn',
          headers: auth,
        })
      ).text,
    );
    expect(host.entries.map((e: { msg: string }) => e.msg)).toEqual(['beta']);
    const all = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/logs?source=host',
          headers: auth,
        })
      ).text,
    );
    expect(all.entries[0]).toMatchObject({ fields: { token: '[redacted]' } });
    expect(
      events(infoSpy, 'control_ui_logs_read').filter(
        (c) => (c[0] as { source: string }).source === 'logs:host',
      ),
    ).toHaveLength(1);
    const c = await request({
      method: 'GET',
      path: `/api/v1/logs?source=container:${own}&lines=5`,
      headers: auth,
    });
    expect(JSON.parse(c.text)).toEqual({
      source: `container:${own}`,
      lines: ['line one', 'token=[redacted]'],
    });
    expect(
      (
        await request({
          method: 'GET',
          path: `/api/v1/logs?source=container:${foreign}`,
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/logs?source=nope',
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(events(infoSpy, 'control_ui_logs_read')).toHaveLength(2);
    const ex = await request({
      method: 'GET',
      path: '/api/v1/logs/export',
      headers: auth,
    });
    expect(ex.status).toBe(200);
    expect(ex.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(ex.headers['content-disposition']).toContain('attachment');
    expect(ex.text).toContain('[redacted]');
    expect(ex.text).not.toContain('t1');
  });

  it('streams batched log frames, capped, never audit lines, never in read-only', async () => {
    await bootP4();
    const { auth, cookie } = await login();
    const { ticket } = JSON.parse(
      (
        await request({
          method: 'POST',
          path: '/api/v1/events/ticket',
          headers: auth,
        })
      ).text,
    );
    const frames = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/events?ticket=${ticket}`,
          headers: { Cookie: cookie },
        },
        (res) => {
          res.on('data', (chunk) => {
            buf += String(chunk);
            if (buf.includes('event: log')) {
              setTimeout(() => {
                resolve(buf);
                req.destroy();
              }, 60);
            }
          });
          setTimeout(async () => {
            for (let i = 0; i < 150; i++)
              await push(`{"level":30,"msg":"m${i}"}`);
            await push(
              '{"level":30,"msg":"audit","event":"control_ui_secret"}',
            );
          }, 30);
        },
      );
      req.on('error', reject);
      req.end();
    });
    const logFrames = frames
      .split('\n\n')
      .filter((f) => f.includes('event: log'));
    expect(logFrames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(logFrames[0].split('data: ')[1]);
    expect(payload.entries.length).toBeLessThanOrEqual(100);
    expect(payload.dropped).toBeGreaterThanOrEqual(0);
    expect(frames).not.toContain('control_ui_secret');
    server.close();
    await bootP4({ readOnly: true });
    const ro = await login();
    expect(
      (
        await request({
          method: 'GET',
          path: `/api/v1/logs?source=container:${own}`,
          headers: ro.auth,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/logs/export',
          headers: ro.auth,
        })
      ).status,
    ).toBe(403);
    await push('{"level":30,"msg":"ro","token":"zz"}');
    const roLogs = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/logs?source=host',
          headers: ro.auth,
        })
      ).text,
    );
    expect(Object.keys(roLogs.entries[0]).sort()).toEqual([
      'level',
      'msg',
      'seq',
      'time',
    ]);
    const t2 = JSON.parse(
      (
        await request({
          method: 'POST',
          path: '/api/v1/events/ticket',
          headers: ro.auth,
        })
      ).text,
    ).ticket;
    const roFrames = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/events?ticket=${t2}`,
          headers: { Cookie: ro.cookie },
        },
        (res) => {
          res.on('data', (chunk) => (buf += String(chunk)));
          setTimeout(async () => {
            await push('{"level":30,"msg":"should-not-stream"}');
            setTimeout(() => {
              resolve(buf);
              req.destroy();
            }, 80);
          }, 30);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(roFrames).not.toContain('event: log');
    expect(
      (
        await request({
          method: 'POST',
          path: `/api/v1/containers/${own}/stop`,
          headers: { ...ro.auth, 'X-Confirm': own },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/containers/rebuild',
          headers: { ...ro.auth, 'X-Confirm': 'rebuild' },
        })
      ).status,
    ).toBe(403);
    const roCfg = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/config',
          headers: ro.auth,
        })
      ).text,
    );
    expect(roCfg.keys.every((k: { editable: boolean }) => k.editable)).toBe(
      true,
    );
    expect(
      (
        await request({
          method: 'PATCH',
          path: '/api/v1/config',
          headers: { ...ro.auth, ...H, 'X-Confirm': 'LOG_LEVEL' },
          body: JSON.stringify({ key: 'LOG_LEVEL', value: 'warn' }),
        })
      ).status,
    ).toBe(403);
  });

  it('config: omits secrets, validates, rewrites with backup outside the root, limits and audits', async () => {
    await bootP4();
    const { auth } = await login();
    const cfg = JSON.parse(
      (await request({ method: 'GET', path: '/api/v1/config', headers: auth }))
        .text,
    );
    expect(
      cfg.keys.find((k: { key: string }) => k.key === 'ANTHROPIC_API_KEY'),
    ).toBeUndefined();
    expect(cfg.secret_keys_omitted).toBeGreaterThanOrEqual(1);
    expect(
      cfg.keys.find((k: { key: string }) => k.key === 'LOG_LEVEL'),
    ).toMatchObject({ value: 'info', editable: true });
    await request({ method: 'GET', path: '/api/v1/config', headers: auth });
    expect(events(infoSpy, 'control_ui_config_read')).toHaveLength(1);
    const patch = (key: string, value: unknown, confirm = key) =>
      request({
        method: 'PATCH',
        path: '/api/v1/config',
        headers: { ...auth, ...H, 'X-Confirm': confirm },
        body: JSON.stringify({ key, value }),
      });
    expect((await patch('LOG_LEVEL', 'warn', '')).status).toBe(428);
    expect((await patch('ANTHROPIC_API_KEY', 'x')).status).toBe(400);
    expect((await patch('LOG_LEVEL', 'verbose')).status).toBe(400);
    expect(
      (await patch('CONTAINER_TIMEOUT', '20000\nGITHUB_WEBHOOK_SECRET=x'))
        .status,
    ).toBe(400);
    const okReply = await patch('LOG_LEVEL', 'warn');
    expect(okReply.status).toBe(200);
    expect(JSON.parse(okReply.text)).toMatchObject({
      restart_required: true,
      key: 'LOG_LEVEL',
    });
    const text = fs.readFileSync(envPath, 'utf-8');
    expect(text).toContain('# hello\nLOG_LEVEL=warn\nANTHROPIC_API_KEY=sk-x\n');
    expect(
      fs.readdirSync(path.join(configDir, 'control-ui', 'env-backups')),
    ).toHaveLength(1);
    expect(fs.readdirSync(root).filter((f) => f.startsWith('.env'))).toEqual([
      '.env',
    ]);
    const audit = events(warnSpy, 'control_ui_config_write');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0][0])).not.toContain('warn"');
    for (let i = 0; i < 5; i++)
      await patch('LOG_LEVEL', i % 2 ? 'info' : 'warn');
    expect((await patch('LOG_LEVEL', 'info')).status).toBe(429);
  });

  it('debug: health, counts, events, trace validation', async () => {
    await bootP4();
    const { auth } = await login();
    const health = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/debug/health',
          headers: auth,
        })
      ).text,
    );
    expect(health).toMatchObject({
      docker: { ok: true, version: '27.0' },
      db: { ok: true },
      build_running: false,
    });
    const counts = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/debug/counts',
          headers: auth,
        })
      ).text,
    );
    expect(counts).toMatchObject({ groups: 1, containers_active: 1 });
    const ev = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/debug/events',
          headers: auth,
        })
      ).text,
    );
    expect(Array.isArray(ev.events)).toBe(true);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/debug/trace?message_id=..',
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/debug/trace?message_id=a%20b',
          headers: auth,
        })
      ).status,
    ).toBe(400);
    expect(
      JSON.parse(
        (
          await request({
            method: 'GET',
            path: '/api/v1/debug/trace?message_id=m1',
            headers: auth,
          })
        ).text,
      ),
    ).toEqual({ messages: [] });
    for (let i = 0; i < 30; i++)
      await request({ method: 'GET', path: '/api/v1/system', headers: auth });
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/containers',
          headers: auth,
        })
      ).status,
    ).toBe(429);
  });
});
