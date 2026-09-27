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
import { IS_WINDOWS } from '../platform.js';
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
import { createChannelLifecycle } from '../channels/lifecycle.js';
import type { Channel } from '../types.js';
import type { ChannelOpts } from '../channels/registry.js';
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
  const contexts: Record<string, unknown>[] = [];
  const backend = {
    name: () => 'claude' as const,
    runTurn: async (
      c: Record<string, unknown>,
      _s: unknown,
      sink: RuntimeEventSink,
    ) => {
      contexts.push(c);
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
  return { runtime, closeStdin, notifyIdle, snapshotState, contexts };
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
    // Never the real tmux socket from a test; a test that needs live views
    // passes its own fake through `extra`.
    liveViews: null,
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

  const cfg = () => path.join(root, 'cfg');
  const newChat = async (auth: Record<string, string>, body = '{}') =>
    JSON.parse(
      (
        await request({
          method: 'POST',
          path: '/api/v1/chats',
          headers: { ...auth, ...H },
          body,
        })
      ).text,
    );
  const getChat = async (auth: Record<string, string>, id: string) =>
    JSON.parse(
      (
        await request({
          method: 'GET',
          path: `/api/v1/chats/${id}`,
          headers: auth,
        })
      ).text,
    );

  it("streams a turn of a saved chat, saves both sides, and uses the chat's model", async () => {
    const { runtime, contexts } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root), configDir: cfg() });
    const { auth } = await login();
    const post = (body: string) =>
      request({
        method: 'POST',
        path: '/api/v1/chat/turns',
        headers: { ...auth, ...H },
        body,
      });
    // The old browser-history body is gone: a chat is required.
    expect((await post('{"message":"hi"}')).status).toBe(400);
    const chat = await newChat(auth);
    expect(
      (await post(JSON.stringify({ chat_id: chat.id, message: '' }))).status,
    ).toBe(400);
    expect(
      (
        await post(
          JSON.stringify({ chat_id: 'ffffffffffffffff', message: 'hi' }),
        )
      ).status,
    ).toBe(404);
    await request({
      method: 'PATCH',
      path: `/api/v1/chats/${chat.id}`,
      headers: { ...auth, ...H },
      body: JSON.stringify({ model: 'claude-sonnet-5', effort: 'high' }),
    });
    const r = await streamRequest(
      {
        method: 'POST',
        path: '/api/v1/chat/turns',
        headers: { ...auth, ...H },
        body: JSON.stringify({ chat_id: chat.id, message: 'What is ready?' }),
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
    expect(contexts.at(-1)).toMatchObject({
      model: 'claude-sonnet-5',
      effort: 'high',
    });
    const saved = await getChat(auth, chat.id);
    expect(saved.title).toBe('What is ready?');
    expect(saved.running_turn_id).toBeNull();
    expect(
      saved.messages.map((m: { role: string; text: string }) => [
        m.role,
        m.text,
      ]),
    ).toEqual([
      ['user', 'What is ready?'],
      ['assistant', 'hi'],
    ]);
    expect(saved.messages[1].activity).toEqual(['Used Read']);
  });

  it('keeps the reply when the browser leaves mid-turn, and shows the running turn meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const { runtime } = fakeRuntime({ gate });
    await boot({ runtime, store: fakeStore(root), configDir: cfg() });
    const { auth } = await login();
    const chat = await newChat(auth);
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/v1/chat/turns',
          headers: { ...auth, ...H },
        },
        (res) => {
          res.once('data', () => {
            req.destroy(); // the phone locks
            resolve();
          });
        },
      );
      req.on('error', () => {});
      req.on('close', resolve);
      req.end(JSON.stringify({ chat_id: chat.id, message: 'hi' }));
      setTimeout(() => reject(new Error('no stream')), 5000);
    });
    const during = await getChat(auth, chat.id);
    expect(during.running_turn_id).toMatch(/^[0-9a-f]{16}$/);
    release();
    await new Promise((r) => setTimeout(r, 50));
    const after = await getChat(auth, chat.id);
    expect(after.running_turn_id).toBeNull();
    expect(after.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: 'hi',
    });
  });

  it('stops a running turn via DELETE, saves "Stopped", and refuses foreign or unknown ids', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const { runtime, closeStdin } = fakeRuntime({ gate });
    await boot({ runtime, store: fakeStore(root), configDir: cfg() });
    const { auth } = await login();
    const chat = await newChat(auth);
    let deleted: Promise<Reply> | null = null;
    const r = await streamRequest(
      {
        method: 'POST',
        path: '/api/v1/chat/turns',
        headers: { ...auth, ...H },
        body: JSON.stringify({ chat_id: chat.id, message: 'hi' }),
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
    expect((await getChat(auth, chat.id)).messages.at(-1)).toMatchObject({
      role: 'assistant',
      error: 'Stopped',
    });
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

  it('chat list, import, rename, settings and a confirmed delete', async () => {
    await boot({ configDir: cfg() });
    const { auth } = await login();
    const imported = await newChat(
      auth,
      JSON.stringify({
        title: 'Earlier chat',
        messages: [
          { role: 'user', text: 'old question', at: 1 },
          { role: 'assistant', text: 'old answer', at: 2 },
        ],
      }),
    );
    expect(imported.imported).toBe(2);
    const bad = await request({
      method: 'POST',
      path: '/api/v1/chats',
      headers: { ...auth, ...H },
      body: JSON.stringify({ messages: [{ role: 'system', text: 'x' }] }),
    });
    expect(bad.status).toBe(400);
    const list = JSON.parse(
      (await request({ method: 'GET', path: '/api/v1/chats', headers: auth }))
        .text,
    );
    expect(list.chats.map((c: { title: string }) => c.title)).toEqual([
      'Earlier chat',
    ]);
    const patch = (body: unknown) =>
      request({
        method: 'PATCH',
        path: `/api/v1/chats/${imported.id}`,
        headers: { ...auth, ...H },
        body: JSON.stringify(body),
      });
    expect((await patch({ model: 'gpt-4' })).status).toBe(400);
    expect((await patch({ effort: 'extreme' })).status).toBe(400);
    expect(JSON.parse((await patch({ title: 'Renamed' })).text).title).toBe(
      'Renamed',
    );
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/chats/..%2F..%2Fetc',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    const del = (confirm?: string) =>
      request({
        method: 'DELETE',
        path: `/api/v1/chats/${imported.id}`,
        headers: { ...auth, ...(confirm ? { 'X-Confirm': confirm } : {}) },
      });
    expect((await del()).status).toBe(428);
    expect((await del(imported.id)).status).toBe(204);
    expect((await getChat(auth, imported.id)).error).toBe('not found');
  });

  it("lists Amos's commands and whether models can be picked", async () => {
    fs.mkdirSync(path.join(root, 'container', 'skills', 'status'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'container', 'skills', 'status', 'SKILL.md'),
      '---\nname: status\ndescription: Quick health check.\n---\n',
    );
    const { runtime } = fakeRuntime();
    await boot({ runtime, store: fakeStore(root), configDir: cfg() });
    const { auth } = await login();
    const r = JSON.parse(
      (
        await request({
          method: 'GET',
          path: '/api/v1/chat/commands',
          headers: auth,
        })
      ).text,
    );
    expect(r).toEqual({
      commands: [
        { name: 'status', description: 'Quick health check.', source: 'amos' },
      ],
      models: true,
    });
  });

  it('refuses chat writes and abort in read-only mode, but lists chats', async () => {
    const { runtime } = fakeRuntime();
    await boot({
      runtime,
      store: fakeStore(root),
      readOnly: true,
      configDir: cfg(),
    });
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
          method: 'POST',
          path: '/api/v1/chats',
          headers: { ...auth, ...H },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request({ method: 'GET', path: '/api/v1/chats', headers: auth }))
        .status,
    ).toBe(200);
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

describe('control-ui server — claude sessions', () => {
  const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
  const SID2 = 'b2c3d4e5-0000-4000-8000-000000000002';
  type Row = Record<string, unknown>;
  function fakeCli(
    over: { rows?: Row[]; fail?: boolean; startOut?: string } = {},
  ) {
    const calls: string[][] = [];
    const state = {
      rows: over.rows,
      fail: over.fail ?? false,
      startOut: over.startOut ?? 'Started e5f6a7b8',
    };
    const rowsFor = () =>
      state.rows ?? [
        {
          id: 'a1b2c3d4',
          sessionId: SID,
          name: 'Posts (fixture)',
          kind: 'background',
          state: 'blocked',
          status: 'idle',
          cwd: root,
          startedAt: 5,
        },
        {
          id: 'b2c3d4e5',
          sessionId: SID2,
          name: 'Images (fixture)',
          kind: 'background',
          state: 'working',
          status: 'busy',
          cwd: path.join(root, 'wt'),
          startedAt: 6,
        },
        {
          id: 'c3d4e5f6',
          sessionId: null,
          name: 'terminal',
          kind: 'interactive',
          state: 'working',
          cwd: root,
          startedAt: 7,
        },
        {
          id: 'd4e5f6a7',
          sessionId: SID,
          name: 'foreign',
          kind: 'background',
          state: 'working',
          cwd: os.tmpdir(),
          startedAt: 8,
        },
      ];
    const run = async (argv: string[]) => {
      calls.push(argv);
      if (state.fail) return { ok: false as const, error: 'timeout' };
      if (argv[0] === 'agents')
        return {
          ok: true as const,
          stdout: JSON.stringify(rowsFor()),
          stderr: '',
        };
      if (argv[0] === 'logs')
        return {
          ok: true as const,
          stdout: 'log line\ntoken=abc\n',
          stderr: '',
        };
      if (argv[0] === 'stop')
        return { ok: true as const, stdout: `stopped ${argv[1]}`, stderr: '' };
      if (argv[0] === '--bg')
        return { ok: true as const, stdout: state.startOut, stderr: '' };
      return { ok: false as const, error: 'unexpected' };
    };
    return {
      calls,
      state,
      cli: {
        run,
        cached: (_k: string, _t: number, argv: string[]) => run(argv),
      },
    };
  }
  let projects: string;
  let configDir: string;
  const bootC = (
    over: Partial<ControlDeps> = {},
    cli = fakeCli(),
    extra: Record<string, unknown> = {},
  ) => {
    projects = path.join(root, 'projects');
    fs.mkdirSync(path.join(projects, 'p1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'wt'), { recursive: true });
    fs.writeFileSync(
      path.join(projects, 'p1', `${SID}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: 'Make the posts' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Approve the hero shot?' }],
          },
        }),
      ].join('\n') + '\n',
    );
    configDir = path.join(root, 'cfg');
    const { runtime } = fakeRuntime();
    return boot(
      {
        runtime,
        store: fakeStore(root),
        claudeBin: '/fake/claude',
        claudeProjectsDir: projects,
        configDir,
        ...over,
      },
      undefined,
      undefined,
      { hostCli: cli.cli, claudePollMs: 60_000, ...extra },
    ).then(() => cli);
  };
  // logger.warn is already a spy from the Phase 4 block; a second spyOn would
  // stack and lose pino's receiver.
  const warnSpy = vi.mocked(logger.warn);
  beforeEach(() => {
    warnSpy.mockClear(); // braces: a returned spy would register as a cleanup hook
  });
  const ev = (name: string) =>
    warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === name,
    );
  const j = (r: { text: string }) => JSON.parse(r.text);

  it('lists only rows under the repo, with waiting_on and started_here', async () => {
    await bootC();
    const { auth } = await login();
    const r = j(
      await request({
        method: 'GET',
        path: '/api/v1/claude/sessions',
        headers: auth,
      }),
    );
    expect(r.sessions.map((s: { id: string }) => s.id)).toEqual([
      'a1b2c3d4',
      'b2c3d4e5',
      'c3d4e5f6',
    ]);
    expect(r.sessions[0]).toMatchObject({
      waiting_on: 'Approve the hero shot?',
      started_here: false,
      cwd_rel: '.',
      resumable: true,
    });
    expect(r.sessions[1]).toMatchObject({ cwd_rel: 'wt' });
    expect(r.sessions[2]).toMatchObject({
      kind: 'interactive',
      resumable: false,
    });
  });

  it('answers unavailable/503 when the CLI fails, never an empty list', async () => {
    const cli = await bootC();
    const { auth } = await login();
    cli.state.fail = true;
    const r = await request({
      method: 'GET',
      path: '/api/v1/claude/sessions',
      headers: auth,
    });
    expect(r.status).toBe(200);
    expect(j(r)).toMatchObject({ unavailable: true, sessions: [] });
    for (const p of ['/api/v1/claude/sessions/a1b2c3d4/logs'])
      expect(
        (await request({ method: 'GET', path: p, headers: auth })).status,
      ).toBe(503);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/claude/sessions/a1b2c3d4/stop',
          headers: { ...auth, 'X-Confirm': 'a1b2c3d4' },
        })
      ).status,
    ).toBe(503);
    expect(
      ev('control_ui_claude_refused').some(
        (c) => (c[0] as { reason: string }).reason === 'list_unavailable',
      ),
    ).toBe(true);
  });

  it('logs resolve through the list; unknown/foreign ids refused; the old transcript route is gone', async () => {
    await bootC();
    const { auth } = await login();
    const list = j(
      await request({
        method: 'GET',
        path: '/api/v1/claude/sessions',
        headers: auth,
      }),
    );
    // "last active" comes from the conversation file's mtime.
    expect(typeof list.sessions[0].last_active).toBe('number');
    expect(list.sessions[2].last_active).toBeNull(); // no conversation file
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions/a1b2c3d4/transcript',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    const l = j(
      await request({
        method: 'GET',
        path: '/api/v1/claude/sessions/a1b2c3d4/logs',
        headers: auth,
      }),
    );
    expect(l.lines).toEqual(['log line', 'token=[redacted]']);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions/d4e5f6a7/logs',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions/zz/logs',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    expect(ev('control_ui_claude_refused')).toHaveLength(2);
    for (let i = 0; i < 27; i++)
      await request({
        method: 'GET',
        path: '/api/v1/claude/sessions',
        headers: auth,
      });
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions/a1b2c3d4/logs',
          headers: auth,
        })
      ).status,
    ).toBe(429);
  });

  it('start: confirm, validation, global limiter, ceiling, structural id, ledger', async () => {
    const cli = await bootC();
    const { auth } = await login();
    const start = (body: unknown, confirm = 'start', a = auth) =>
      request({
        method: 'POST',
        path: '/api/v1/claude/sessions',
        headers: { ...a, ...H, 'X-Confirm': confirm },
        body: JSON.stringify(body),
      });
    expect((await start({ name: 'X', prompt: 'go' }, '')).status).toBe(428);
    expect((await start({ name: '-x', prompt: 'go' })).status).toBe(400);
    expect((await start({ name: 'ok', prompt: '' })).status).toBe(400);
    cli.state.rows = [
      {
        id: 'e5f6a7b8',
        sessionId: SID2,
        name: 'Posts run',
        kind: 'background',
        state: 'working',
        cwd: root,
        startedAt: 9,
      },
    ];
    const ok = await start({ name: 'Posts run', prompt: 'do it --not-a-flag' });
    expect(ok.status).toBe(200);
    expect(j(ok)).toEqual({ started: true, id: 'e5f6a7b8' });
    const spawn = cli.calls.find((c) => c[0] === '--bg')!;
    expect(spawn).toEqual([
      '--bg',
      '--name=Posts run',
      '--permission-mode=auto',
      '--',
      'do it --not-a-flag',
    ]);
    expect(ev('control_ui_claude_start')[0][0]).toMatchObject({
      id: 'e5f6a7b8',
      name: 'Posts run',
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(configDir, 'control-ui', 'claude-started.json'),
          'utf-8',
        ),
      ),
    ).toEqual([{ id: 'e5f6a7b8', started_at: 9 }]);
    expect(
      j(
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions',
          headers: auth,
        }),
      ).sessions[0],
    ).toMatchObject({ started_here: true });
    cli.state.startOut = 'no id here';
    const un = await start({ name: 'Two', prompt: 'x' });
    expect(un.status).toBe(502);
    expect(ev('control_ui_claude_start_unparsed')).toHaveLength(1);
    cli.state.startOut = 'Started f6a7b8c9';
    expect((await start({ name: 'Three', prompt: 'x' })).status).toBe(200);
    const second = await login();
    expect(
      (await start({ name: 'Four', prompt: 'x' }, 'start', second.auth)).status,
    ).toBe(429);
    fs.writeFileSync(
      path.join(configDir, 'control-ui', 'claude-started.json'),
      '{corrupt',
    );
    server.close();
    await bootC({}, cli);
    const a3 = (await login()).auth;
    cli.state.startOut = 'Started 11112222';
    expect(
      (await start({ name: 'Five', prompt: 'x' }, 'start', a3)).status,
    ).toBe(409);
  });

  it('refuses start when 3 dashboard-started sessions are working', async () => {
    const cli = await bootC();
    const { auth } = await login();
    const ids = ['e5f6a7b8', 'f6a7b8c9', 'a7b8c9d0'];
    cli.state.rows = ids.map((id) => ({
      id,
      sessionId: SID2,
      name: id,
      kind: 'background',
      state: 'working',
      cwd: root,
      startedAt: 1,
    }));
    fs.mkdirSync(path.join(configDir, 'control-ui'), { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'control-ui', 'claude-started.json'),
      JSON.stringify(ids.map((id) => ({ id, started_at: 1 }))),
    );
    const r = await request({
      method: 'POST',
      path: '/api/v1/claude/sessions',
      headers: { ...auth, ...H, 'X-Confirm': 'start' },
      body: JSON.stringify({ name: 'More', prompt: 'x' }),
    });
    expect(r.status).toBe(409);
    expect(j(r)).toMatchObject({ live: 3 });
  });

  // A stand-in for the live-view registry: the registry itself is tested
  // against real tmux in claude-live.test.ts; here the question is what the
  // routes hand it and what they refuse before it is ever reached.
  function fakeLive() {
    const calls: unknown[][] = [];
    const owners = new Map<string, string>();
    const ids = new Map<string, string>();
    let n = 0;
    const live = {
      calls,
      async open(owner: string, id: string, cols: unknown, rows: unknown) {
        calls.push(['open', owner, id, cols, rows]);
        const vid = (++n).toString(16).padStart(32, '0');
        owners.set(vid, owner);
        ids.set(vid, id);
        return { ok: true as const, vid };
      },
      attachStream(vid: string, owner: string, res: http.ServerResponse) {
        calls.push(['stream', vid, owner]);
        if (owners.get(vid) !== owner) return false;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('event: o\ndata: aGk=\n\n');
        return true;
      },
      input(vid: string, owner: string, bytes: Buffer) {
        calls.push(['input', vid, owner, bytes.toString()]);
        return owners.get(vid) === owner
          ? { ok: true as const }
          : { ok: false as const, status: 404, error: 'not found' };
      },
      resize(vid: string, owner: string, cols: unknown, rows: unknown) {
        calls.push(['resize', vid, owner, cols, rows]);
        return owners.get(vid) === owner
          ? { ok: true as const }
          : { ok: false as const, status: 404, error: 'not found' };
      },
      closeOwned(vid: string, owner: string) {
        calls.push(['close', vid, owner]);
        return owners.get(vid) === owner;
      },
      closeOwner(owner: string, reason: string) {
        calls.push(['closeOwner', owner, reason]);
      },
      closeAll(reason: string) {
        calls.push(['closeAll', reason]);
      },
      sweep() {},
      async killLeftovers() {},
      size: () => owners.size,
      has: (vid: string) => owners.has(vid),
      meta: (vid: string) =>
        owners.has(vid)
          ? {
              owner: owners.get(vid) as string,
              claudeId: ids.get(vid) as string,
            }
          : null,
    };
    return live;
  }

  it("conversation: only the view's own login reads it, unchanged versions are cheap, read-only refused", async () => {
    const live = fakeLive();
    const cli = await bootC({}, fakeCli(), { liveViews: live });
    const a = await login();
    const b = await login();
    const opened = await request({
      method: 'POST',
      path: '/api/v1/claude/live',
      headers: { ...a.auth, ...H },
      body: JSON.stringify({ id: 'a1b2c3d4', cols: 80, rows: 24 }),
    });
    const { vid } = j(opened);
    const agentCalls = () => cli.calls.filter((c) => c[0] === 'agents').length;
    const before = agentCalls();
    const get = (auth: Record<string, string>, q = '') =>
      request({
        method: 'GET',
        path: `/api/v1/claude/live/${vid}/conversation${q}`,
        headers: auth,
      });
    const first = await get(a.auth);
    expect(first.status).toBe(200);
    const conv = j(first);
    expect(conv.items).toEqual([
      { k: 'user', text: 'Make the posts' },
      { k: 'assistant', text: 'Approve the hero shot?' },
    ]);
    expect(typeof conv.version).toBe('string');
    // Polling reads the cached list: no CLI call per poll.
    const again = await get(a.auth, `?v=${encodeURIComponent(conv.version)}`);
    expect(j(again)).toEqual({ unchanged: true, version: conv.version });
    expect(agentCalls()).toBe(before);
    // Another login, or a view that does not exist, gets nothing.
    expect((await get(b.auth)).status).toBe(404);
    expect(
      (
        await request({
          method: 'GET',
          path: `/api/v1/claude/live/${'f'.repeat(32)}/conversation`,
          headers: a.auth,
        })
      ).status,
    ).toBe(404);
    // Its own limit, per login.
    let last = 200;
    for (let i = 0; i < 130 && last !== 429; i++)
      last = (await get(a.auth)).status;
    expect(last).toBe(429);
    // The command list: names and one-line descriptions, built-ins included.
    const cmds = j(
      await request({
        method: 'GET',
        path: '/api/v1/claude/commands',
        headers: a.auth,
      }),
    ).commands as { name: string; source: string }[];
    expect(cmds.find((c) => c.name === 'effort')).toBeTruthy();
    server.close();

    await bootC({ readOnly: true }, cli, { liveViews: fakeLive() });
    const ro = await login();
    expect(
      (
        await request({
          method: 'GET',
          path: `/api/v1/claude/live/${vid}/conversation`,
          headers: ro.auth,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/claude/commands',
          headers: ro.auth,
        })
      ).status,
    ).toBe(403);
    server.close();
  });

  it('conversation: model and effort fall back to the settings defaults, and the transcript wins', async () => {
    const settings = path.join(root, 'settings.json');
    fs.writeFileSync(
      settings,
      JSON.stringify({
        model: 'opus',
        modelSettings: {
          'claude-opus-5': { effortLevel: 'medium' },
          'claude-opus-5-5': { effortLevel: 'high' },
        },
      }),
    );
    const live = fakeLive();
    await bootC({ claudeSettingsFile: settings }, fakeCli(), {
      liveViews: live,
    });
    const { auth } = await login();
    const { vid } = j(
      await request({
        method: 'POST',
        path: '/api/v1/claude/live',
        headers: { ...auth, ...H },
        body: JSON.stringify({ id: 'a1b2c3d4', cols: 80, rows: 24 }),
      }),
    );
    const get = (q = '') =>
      request({
        method: 'GET',
        path: `/api/v1/claude/live/${vid}/conversation${q}`,
        headers: auth,
      });
    const first = j(await get());
    // The fixture's reply names no model, so the alias stands in; the effort is
    // the highest-versioned opus entry.
    expect(first.model).toBeNull();
    expect(first.model_label).toBe('opus');
    expect(first.effort).toBe('high');
    expect(first.version).toMatch(/^[0-9]+:[0-9]+\|[0-9]+:[0-9]+$/);
    expect(j(await get(`?v=${encodeURIComponent(first.version)}`))).toEqual({
      unchanged: true,
      version: first.version,
    });
    // A settings change is a new version.
    fs.writeFileSync(
      settings,
      JSON.stringify({
        model: 'opus',
        modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } },
      }),
    );
    fs.utimesSync(settings, new Date(), new Date(Date.now() + 2000));
    const second = j(await get(`?v=${encodeURIComponent(first.version)}`));
    expect(second.unchanged).toBeUndefined();
    expect(second.effort).toBe('low');
    // The transcript wins over the defaults.
    const transcript = path.join(projects, 'p1', `${SID}.jsonl`);
    fs.appendFileSync(
      transcript,
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>Set effort level to max (this session only)</local-command-stdout>',
        },
      }) +
        '\n' +
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: 'ok' }],
          },
        }) +
        '\n',
    );
    fs.utimesSync(transcript, new Date(), new Date(Date.now() + 4000));
    const third = j(await get(`?v=${encodeURIComponent(second.version)}`));
    expect(third.effort).toBe('max');
    expect(third.model).toBe('claude-opus-5-5');
    expect(third.model_label).toBeNull();
    server.close();
  });

  it('create artifact: starts a session with the fixed prompt, lists it as creating, drops it once registered', async () => {
    const cli = await bootC();
    const { auth } = await login();
    const post = (body: unknown, confirm = 'create') =>
      request({
        method: 'POST',
        path: '/api/v1/artifacts/create',
        headers: {
          ...auth,
          ...H,
          ...(confirm ? { 'X-Confirm': confirm } : {}),
        },
        body: JSON.stringify(body),
      });
    const good = {
      title: 'Posts preview',
      kind: 'app',
      description: 'A page with one card per post this week.',
    };
    expect((await post(good, '')).status).toBe(428);
    expect((await post({ ...good, title: 'Q3: Sales (v2)' })).status).toBe(400);
    expect((await post({ ...good, description: 'short' })).status).toBe(400);
    expect(
      (await post({ ...good, description: 'has \x1b[0m an escape in it' }))
        .status,
    ).toBe(400);
    expect((await post({ ...good, kind: 'thing' })).status).toBe(400);
    // The list the server refreshes right after the start already shows it.
    cli.state.rows = [
      {
        id: 'e5f6a7b8',
        sessionId: SID,
        name: 'Posts preview',
        kind: 'background',
        state: 'working',
        status: 'busy',
        cwd: root,
        startedAt: 9,
      },
    ];
    const r = await post(good);
    expect(r.status).toBe(200);
    expect(j(r)).toEqual({ id: 'e5f6a7b8' });
    const spawn = cli.calls.find((c) => c[0] === '--bg')!;
    expect(spawn[1]).toBe('--name=Posts preview');
    expect(spawn[4]).toContain('Title: Posts preview');
    expect(spawn[4]).toContain(
      'artifact-registry.mjs add --title "Posts preview" --url <the artifact url> --kind app',
    );
    const list = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(list.creating).toEqual([
      expect.objectContaining({
        id: 'e5f6a7b8',
        title: 'Posts preview',
        kind: 'app',
        state: 'working',
      }),
    ]);
    // A second create with the same title while it runs is refused.
    expect((await post(good)).status).toBe(409);
    // Once the session registers the title, the creating entry is gone.
    await request({
      method: 'POST',
      path: '/api/v1/artifacts',
      headers: { ...auth, ...H },
      body: JSON.stringify({
        title: 'Posts preview',
        url: 'https://claude.ai/artifact/abc',
        kind: 'app',
      }),
    });
    const after = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(after.creating).toEqual([]);
    expect(after.artifacts).toHaveLength(1);
    server.close();
    // Read-only: refused before anything starts.
    await bootC({ readOnly: true });
    const ro = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/artifacts/create',
          headers: { ...ro.auth, ...H, 'X-Confirm': 'create' },
          body: JSON.stringify(good),
        })
      ).status,
    ).toBe(403);
  });

  it('integrations: lists the catalogue and sets one up through a guided session, one at a time', async () => {
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'add-telegram'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, '.claude', 'skills', 'add-telegram', 'SKILL.md'),
      '---\nname: add-telegram\ndescription: Add Telegram as a channel.\n---\n',
    );
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'add-old'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, '.claude', 'skills', 'add-old', 'SKILL.md'),
      '---\nname: add-old\ndescription: "[DEPRECATED] gone"\n---\n',
    );
    const cli = await bootC({
      envHas: (k: string) => k === 'TELEGRAM_BOT_TOKEN',
    });
    const { auth } = await login();
    const list = j(
      await request({
        method: 'GET',
        path: '/api/v1/integrations',
        headers: auth,
      }),
    );
    expect(list.integrations).toEqual([
      expect.objectContaining({
        name: 'add-telegram',
        title: 'Telegram',
        kind: 'channel',
        needs: ['TELEGRAM_BOT_TOKEN'],
        configured: true,
      }),
    ]);
    const setup = (name: string, confirm = 'setup') =>
      request({
        method: 'POST',
        path: `/api/v1/integrations/${name}/setup`,
        headers: {
          ...auth,
          ...H,
          ...(confirm ? { 'X-Confirm': confirm } : {}),
        },
        body: '{}',
      });
    expect((await setup('add-telegram', '')).status).toBe(428);
    expect((await setup('add-nope')).status).toBe(404);
    expect((await setup('..%2Fx')).status).toBe(404);
    expect((await setup('add-old')).status).toBe(404);
    cli.state.rows = [
      {
        id: 'e5f6a7b8',
        sessionId: SID,
        name: 'Add Telegram',
        kind: 'background',
        state: 'working',
        status: 'busy',
        cwd: root,
        startedAt: 9,
      },
    ];
    const r = await setup('add-telegram');
    expect(r.status).toBe(200);
    expect(j(r)).toEqual({ id: 'e5f6a7b8' });
    // Even before the CLI lists the new session, a second setup is refused.
    cli.state.rows = [];
    expect((await setup('add-telegram')).status).toBe(409);
    cli.state.rows = [
      {
        id: 'e5f6a7b8',
        sessionId: SID,
        name: 'Add Telegram',
        kind: 'background',
        state: 'working',
        status: 'busy',
        cwd: root,
        startedAt: 9,
      },
    ];
    const spawn = cli.calls.find((c) => c[0] === '--bg')!;
    expect(spawn[1]).toBe('--name=Add Telegram');
    expect(spawn[4].startsWith('/add-telegram\n')).toBe(true);
    expect(spawn[4]).toContain("dashboard's Channels tab");
    // While that session works, nothing else can be set up — not even a different integration.
    fs.mkdirSync(path.join(root, '.claude', 'skills', 'add-slack'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, '.claude', 'skills', 'add-slack', 'SKILL.md'),
      '---\nname: add-slack\ndescription: Add Slack.\n---\n',
    );
    const again = await setup('add-slack');
    expect(again.status).toBe(409);
    expect(j(again)).toMatchObject({ id: 'e5f6a7b8', name: 'add-telegram' });
    server.close();
    // Read-only: catalogue without key names, and no setup.
    await bootC({
      readOnly: true,
      envHas: (k: string) => k === 'TELEGRAM_BOT_TOKEN',
    });
    const ro = await login();
    const roList = j(
      await request({
        method: 'GET',
        path: '/api/v1/integrations',
        headers: ro.auth,
      }),
    );
    expect(roList.integrations[0]).toMatchObject({
      needs: [],
      configured: null,
    });
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/integrations/add-telegram/setup',
          headers: { ...ro.auth, ...H, 'X-Confirm': 'setup' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });

  it('live: opens only listed background sessions, routes input by owner, refuses read-only', async () => {
    const live = fakeLive();
    const cli = await bootC({}, fakeCli(), { liveViews: live });
    const a = await login();
    const b = await login();
    const post = (auth: Record<string, string>, p: string, body: unknown) =>
      request({
        method: 'POST',
        path: p,
        headers: { ...auth, ...H },
        body: JSON.stringify(body),
      });
    const opened = await post(a.auth, '/api/v1/claude/live', {
      id: 'a1b2c3d4',
      cols: 100,
      rows: 30,
    });
    expect(opened.status).toBe(200);
    const { vid } = j(opened);
    const [, ownerA, id, cols, rows] = live.calls[0];
    expect([id, cols, rows]).toEqual(['a1b2c3d4', 100, 30]);
    // Only background sessions under this repo, by the same list as the rest.
    expect(
      (
        await post(a.auth, '/api/v1/claude/live', {
          id: 'c3d4e5f6',
          cols: 80,
          rows: 24,
        })
      ).status,
    ).toBe(409);
    for (const bad of ['d4e5f6a7', 'zz', 42])
      expect(
        (
          await post(a.auth, '/api/v1/claude/live', {
            id: bad,
            cols: 80,
            rows: 24,
          })
        ).status,
      ).toBe(404);
    // No typed confirmation to type: the operator's decision.
    const typed = await post(a.auth, `/api/v1/claude/live/${vid}/input`, {
      data: Buffer.from('hi\r').toString('base64'),
    });
    expect(typed.status).toBe(204);
    expect(live.calls.at(-1)).toEqual(['input', vid, ownerA, 'hi\r']);
    expect(
      (
        await post(a.auth, `/api/v1/claude/live/${vid}/input`, {
          data: '@@not base64',
        })
      ).status,
    ).toBe(400);
    // Another login is a different owner, so the registry refuses it.
    expect(
      (await post(b.auth, `/api/v1/claude/live/${vid}/input`, { data: 'aGk=' }))
        .status,
    ).toBe(404);
    expect(live.calls.at(-1)?.[2]).not.toBe(ownerA);
    // The stream is ticketed and owner-checked.
    const ticket = async (auth: Record<string, string>) =>
      j(
        await request({
          method: 'POST',
          path: '/api/v1/events/ticket',
          headers: auth,
        }),
      ).ticket as string;
    const streamA = await request({
      method: 'GET',
      path: `/api/v1/claude/live/${vid}/stream?ticket=${await ticket(a.auth)}`,
      headers: { Cookie: a.cookie },
    });
    expect(streamA.status).toBe(200);
    expect(streamA.headers['content-type']).toContain('text/event-stream');
    const streamB = await request({
      method: 'GET',
      path: `/api/v1/claude/live/${vid}/stream?ticket=${await ticket(b.auth)}`,
      headers: { Cookie: b.cookie },
    });
    expect(streamB.status).toBe(403);
    // Logout ends that login's views; revoke-all ends every view.
    await request({
      method: 'POST',
      path: '/auth/logout',
      headers: { ...b.auth, ...H },
    });
    expect(live.calls.at(-1)?.[0]).toBe('closeOwner');
    await request({
      method: 'POST',
      path: '/auth/sessions/revoke-all',
      headers: { ...a.auth, ...H, 'X-Confirm': 'all' },
    });
    expect(live.calls.at(-1)).toEqual(['closeAll', 'revoked']);
    server.close();

    // Read-only: no live view at all, including the GET stream.
    const roLive = fakeLive();
    await bootC({ readOnly: true }, cli, { liveViews: roLive });
    const ro = await login();
    expect(
      (
        await post(ro.auth, '/api/v1/claude/live', {
          id: 'a1b2c3d4',
          cols: 80,
          rows: 24,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'GET',
          path: `/api/v1/claude/live/${'0'.repeat(32)}/stream?ticket=${await ticket(ro.auth)}`,
          headers: { Cookie: ro.cookie },
        })
      ).status,
    ).toBe(403);
    expect(roLive.calls).toEqual([]);
    server.close();

    // No tmux on the host: a clear 503, not a broken view.
    await bootC({}, cli, { liveViews: null });
    const nt = await login();
    expect(
      (
        await post(nt.auth, '/api/v1/claude/live', {
          id: 'a1b2c3d4',
          cols: 80,
          rows: 24,
        })
      ).status,
    ).toBe(503);
  });

  it('pins: round trip in the list, refusals, read-only, unreadable file, no config dir', async () => {
    await bootC();
    const { auth } = await login();
    const pin = (id: string, body: unknown, a = auth) =>
      request({
        method: 'PUT',
        path: `/api/v1/claude/sessions/${id}/pin`,
        headers: { ...a, ...H },
        body: JSON.stringify(body),
      });
    const listed = async (a = auth) =>
      j(
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions',
          headers: a,
        }),
      ).sessions as { id: string; pinned: boolean }[];
    expect((await listed()).every((r) => r.pinned === false)).toBe(true);
    const r = await pin('b2c3d4e5', { pinned: true });
    expect(r.status).toBe(200);
    expect(j(r)).toEqual({ pinned: true });
    expect((await listed()).find((x) => x.id === 'b2c3d4e5')?.pinned).toBe(
      true,
    );
    const file = path.join(configDir, 'control-ui', 'claude-pins.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      v: 1,
      pins: ['b2c3d4e5'],
    });
    expect((await pin('b2c3d4e5', { pinned: false })).status).toBe(200);
    expect((await listed()).find((x) => x.id === 'b2c3d4e5')?.pinned).toBe(
      false,
    );
    expect((await pin('d4e5f6a7', { pinned: true })).status).toBe(404); // outside the repo
    expect((await pin('zz', { pinned: true })).status).toBe(404);
    expect((await pin('a1b2c3d4', { pinned: 'yes' })).status).toBe(400);
    // A file that cannot be read is never overwritten from a failed read.
    fs.writeFileSync(file, '{ broken');
    expect((await pin('a1b2c3d4', { pinned: true })).status).toBe(503);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ broken');
    expect((await listed()).every((x) => x.pinned === false)).toBe(true);
    server.close();

    await bootC({ readOnly: true });
    const ro = await login();
    expect((await pin('a1b2c3d4', { pinned: true }, ro.auth)).status).toBe(403);
    server.close();

    await bootC({ configDir: undefined });
    const nc = await login();
    expect((await pin('a1b2c3d4', { pinned: true }, nc.auth)).status).toBe(503);
    expect((await listed(nc.auth)).every((x) => x.pinned === false)).toBe(true);
  });

  it('answers only loopback names on its own port or the tunnel port', async () => {
    await bootC({ publicPort: 4040 });
    // Allowed hosts reach the route (401 without a login); others never do.
    const hosts: [string, number][] = [
      [`127.0.0.1:${port}`, 401],
      [`localhost:${port}`, 401],
      ['localhost:4040', 401],
      [`evil.example:${port}`, 421],
      ['127.0.0.1:1', 421],
      ['127.0.0.1', 421],
    ];
    for (const [host, want] of hosts)
      expect(
        (
          await request({
            method: 'GET',
            path: '/api/v1/me',
            headers: { Host: host },
          })
        ).status,
        host,
      ).toBe(want);
  });

  it('stop refuses interactive, confirms by id, and is rate limited; read-only withholds', async () => {
    const cli = await bootC();
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/claude/sessions/c3d4e5f6/stop',
          headers: { ...auth, 'X-Confirm': 'c3d4e5f6' },
        })
      ).status,
    ).toBe(409);
    const stop = await request({
      method: 'POST',
      path: '/api/v1/claude/sessions/b2c3d4e5/stop',
      headers: { ...auth, 'X-Confirm': 'b2c3d4e5' },
    });
    expect(stop.status).toBe(200);
    expect(cli.calls.at(-2)).toEqual(['stop', 'b2c3d4e5']);
    for (let i = 0; i < 6; i++)
      await request({
        method: 'POST',
        path: '/api/v1/claude/sessions/b2c3d4e5/stop',
        headers: { ...auth, 'X-Confirm': 'b2c3d4e5' },
      });
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/claude/sessions/b2c3d4e5/stop',
          headers: { ...auth, 'X-Confirm': 'b2c3d4e5' },
        })
      ).status,
    ).toBe(429);
    server.close();
    await bootC({ readOnly: true }, cli);
    const ro = await login();
    const list = j(
      await request({
        method: 'GET',
        path: '/api/v1/claude/sessions',
        headers: ro.auth,
      }),
    );
    expect(list.sessions[0]).toHaveProperty('waiting_on');
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions/a1b2c3d4/logs',
          headers: ro.auth,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/claude/sessions',
          headers: { ...ro.auth, ...H, 'X-Confirm': 'start' },
          body: JSON.stringify({ name: 'x', prompt: 'y' }),
        })
      ).status,
    ).toBe(403);
    server.close();
    await bootC({ claudeBin: null }, cli, { hostCli: undefined });
    const nb = await login();
    expect(
      j(
        await request({
          method: 'GET',
          path: '/api/v1/claude/sessions',
          headers: nb.auth,
        }),
      ),
    ).toMatchObject({ unavailable: true });
  });
});

describe('control-ui server — workflows', () => {
  const warnSpy = vi.mocked(logger.warn);
  let configDir: string;
  let wfDir: string;
  beforeEach(() => {
    warnSpy.mockClear();
    clock = Date.parse('2026-09-21T12:00:00.000Z');
    configDir = path.join(root, 'cfg');
    wfDir = path.join(configDir, 'control-ui', 'workflows');
  });
  const j = (r: { text: string }) => JSON.parse(r.text);
  const ev = (name: string) =>
    warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === name,
    );
  let seq = 0;
  const wf = (over: Record<string, unknown> = {}) => ({
    v: 1,
    id: `wf-${(seq++).toString(16).padStart(12, '0')}`,
    name: 'Posts batch',
    kind: 'posts',
    status: 'running',
    percent: 40,
    step: 'rendering',
    message: 'hello',
    session_id: 'a1b2c3d4',
    preview_url: 'https://claude.ai/artifact/a',
    outputs: [{ label: 'Drive', url: 'https://claude.ai/o' }],
    started_at: '2026-09-21T10:00:00.000Z',
    updated_at: '2026-09-21T10:05:00.000Z',
    rev: 1,
    ...over,
  });
  const plant = (r: { id: string }, ageMs = 0) => {
    const file = path.join(wfDir, `${r.id}.json`);
    fs.writeFileSync(file, JSON.stringify(r));
    const t = new Date(clock - ageMs);
    fs.utimesSync(file, t, t);
    return file;
  };
  const bootW = (over: Partial<ControlDeps> = {}, extra = {}) =>
    boot(
      {
        runtime: fakeRuntime().runtime,
        store: fakeStore(root),
        configDir,
        ...over,
      },
      undefined,
      undefined,
      { workflowDebounceMs: 50, workflowPollMs: 100, ...extra },
    );
  const sse = (
    auth: Record<string, string>,
    cookie: string,
    event: string,
    act: () => void,
    waitMs = 700,
  ) =>
    request({
      method: 'POST',
      path: '/api/v1/events/ticket',
      headers: auth,
    }).then(
      (t) =>
        new Promise<string[]>((resolve, reject) => {
          const { ticket } = JSON.parse(t.text);
          let buf = '';
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: `/api/v1/events?ticket=${ticket}`,
              headers: { Cookie: cookie },
            },
            (res) => {
              res.on('data', (c) => (buf += String(c)));
              setTimeout(act, 30);
              setTimeout(() => {
                req.destroy();
                resolve(
                  buf
                    .split('\n\n')
                    .filter((f) => f.includes(`event: ${event}`)),
                );
              }, waitMs);
            },
          );
          req.on('error', reject);
          req.end();
        }),
    );

  it('creates the registry dir, lists records, and refuses without auth', async () => {
    await bootW();
    expect(fs.statSync(wfDir).isDirectory()).toBe(true);
    if (!IS_WINDOWS) expect(fs.statSync(wfDir).mode & 0o777).toBe(0o700);
    expect(
      (await request({ method: 'GET', path: '/api/v1/workflows' })).status,
    ).toBe(401);
    const { auth } = await login();
    let r = j(
      await request({
        method: 'GET',
        path: '/api/v1/workflows',
        headers: auth,
      }),
    );
    expect(r).toEqual({
      workflows: [],
      scanned: 0,
      candidates: 0,
      truncated: 0,
    });
    plant(
      wf({ name: 'older', preview_url: 'https://claude.ai/p?token=S3CR3T' }),
      60_000,
    );
    plant(wf({ name: 'newer' }));
    plant(wf({ kind: 'videos' }), 120_000);
    r = j(
      await request({
        method: 'GET',
        path: '/api/v1/workflows',
        headers: auth,
      }),
    );
    expect(
      r.workflows.map(
        (w: { name?: string; reason?: string }) => w.name ?? w.reason,
      ),
    ).toEqual(['newer', 'older', 'bad-kind']);
    expect(r.workflows[1]).toMatchObject({
      preview_url: null,
      preview_blocked: 'secret-query',
      step: 'rendering',
      session_id: 'a1b2c3d4',
    });
    expect(JSON.stringify(r)).not.toContain('S3CR3T');
    expect(r.workflows[0].outputs).toEqual([
      { label: 'Drive', url: 'https://claude.ai/o' },
    ]);
  });

  it('answers 503 without a config dir or with a symlinked registry, and 429 past the read budget', async () => {
    await bootW({ configDir: undefined });
    const { auth } = await login();
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/workflows',
          headers: auth,
        })
      ).status,
    ).toBe(503);
    await new Promise<void>((r) => server.close(() => r()));
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-real-'));
    fs.mkdirSync(path.join(configDir, 'control-ui'), { recursive: true });
    fs.symlinkSync(real, wfDir);
    await bootW();
    const s2 = await login();
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/workflows',
          headers: s2.auth,
        })
      ).status,
    ).toBe(503);
    fs.rmSync(real, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
    fs.unlinkSync(wfDir);
    await bootW();
    const s3 = await login();
    for (let i = 0; i < 60; i++)
      expect(
        (
          await request({
            method: 'GET',
            path: '/api/v1/workflows',
            headers: s3.auth,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/workflows',
          headers: s3.auth,
        })
      ).status,
    ).toBe(429);
  });

  it('read-only projects on the data path: route and SSE frame carry no prose', async () => {
    await bootW({ readOnly: true });
    const { auth, cookie } = await login();
    plant(wf());
    const r = j(
      await request({
        method: 'GET',
        path: '/api/v1/workflows',
        headers: auth,
      }),
    );
    expect(Object.keys(r.workflows[0]).sort()).toEqual([
      'id',
      'kind',
      'name',
      'percent',
      'started_at',
      'status',
      'updated_at',
    ]);
    const frames = await sse(auth, cookie, 'workflow', () =>
      plant(wf({ name: 'second' })),
    );
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(frames[0].split('data: ')[1]);
    expect(payload.workflows).toHaveLength(2);
    for (const w of payload.workflows)
      for (const k of [
        'step',
        'message',
        'outputs',
        'preview_url',
        'session_id',
      ])
        expect(w).not.toHaveProperty(k);
    expect(JSON.stringify(payload)).not.toContain('hello');
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/workflows/archive',
          headers: { ...auth, ...H, 'X-Confirm': 'archive' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });

  it('broadcasts one debounced workflow frame for a burst of writes', async () => {
    await bootW();
    const { auth, cookie } = await login();
    const frames = await sse(auth, cookie, 'workflow', () => {
      for (let i = 0; i < 3; i++) plant(wf({ name: `w${i}` }));
    });
    expect(frames).toHaveLength(1);
    const payload = JSON.parse(frames[0].split('data: ')[1]);
    expect(
      payload.workflows.map((w: { name: string }) => w.name).sort(),
    ).toEqual(['w0', 'w1', 'w2']);
    expect(payload).toMatchObject({ scanned: 3, candidates: 3, truncated: 0 });
  });

  it('archives with typed confirmation, shape-checks the id first, and audits', async () => {
    await bootW();
    const { auth } = await login();
    const post = (body: string, confirm?: string) =>
      request({
        method: 'POST',
        path: '/api/v1/workflows/archive',
        headers: {
          ...auth,
          ...H,
          ...(confirm ? { 'X-Confirm': confirm } : {}),
        },
        body,
      });
    expect((await post('{}')).status).toBe(428);
    expect((await post('{"id":"../x"}', 'archive')).status).toBe(400);
    expect((await post('{"id":["wf-aaaaaaaaaaaa"]}', 'archive')).status).toBe(
      400,
    );
    expect((await post('{"id":"wf-aaaaaaaaaaaa"}', 'archive')).status).toBe(
      404,
    );
    expect(fs.readdirSync(wfDir).filter((n) => n.endsWith('.json'))).toEqual(
      [],
    );
    const DAY = 24 * 60 * 60 * 1000;
    const old = wf({
      status: 'done',
      percent: 100,
      finished_at: new Date(clock - 40 * DAY).toISOString(),
    });
    const recent = wf({
      status: 'done',
      percent: 100,
      finished_at: new Date(clock - 2 * DAY).toISOString(),
    });
    const fresh = wf({ status: 'running' });
    const stale = wf({ status: 'running' });
    plant(old);
    plant(recent);
    plant(fresh, 60 * 60 * 1000);
    plant(stale, 25 * 60 * 60 * 1000);
    let r = await post('{}', 'archive');
    expect(r.status).toBe(200);
    expect(j(r)).toEqual({ archived: 1, skipped: 0 });
    expect(fs.existsSync(path.join(wfDir, 'archive', `${old.id}.json`))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(wfDir, `${recent.id}.json`))).toBe(true);
    r = await post(`{"id":"${fresh.id}"}`, 'archive');
    expect(r.status).toBe(409);
    expect(j(r).error).toBe('workflow still active');
    r = await post(`{"id":"${stale.id}"}`, 'archive');
    expect(j(r)).toEqual({ archived: 1, skipped: 0, stale: true });
    r = await post(`{"id":"${recent.id}"}`, 'archive');
    expect(j(r)).toEqual({ archived: 1, skipped: 0 });
    plant(recent);
    expect((await post(`{"id":"${recent.id}"}`, 'archive')).status).toBe(409);
    const audits = ev('control_ui_workflow_archive');
    expect(audits).toHaveLength(3);
    expect(audits[1][0]).toMatchObject({
      id: stale.id,
      stale: true,
      archived: 1,
    });
    // Six archive calls reached the limiter (the 428 and the two 400s did not).
    expect((await post('{}', 'archive')).status).toBe(429);
  });
});

describe('control-ui server — artifacts', () => {
  const warnSpy = vi.mocked(logger.warn);
  let configDir: string;
  let ctlDir: string;
  beforeEach(() => {
    warnSpy.mockClear();
    clock = Date.parse('2026-09-21T12:00:00.000Z');
    configDir = path.join(root, 'cfg');
    ctlDir = path.join(configDir, 'control-ui');
  });
  const j = (r: { text: string }) => JSON.parse(r.text);
  const ev = (name: string) =>
    warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === name,
    );
  const bootA = (over: Partial<ControlDeps> = {}) =>
    boot(
      {
        runtime: fakeRuntime().runtime,
        store: fakeStore(root),
        configDir,
        ...over,
      },
      undefined,
      undefined,
      { workflowDebounceMs: 50, workflowPollMs: 100 },
    );
  const regFile = () => path.join(ctlDir, 'artifacts.json');
  const plant = (artifacts: object[], rev = 1) =>
    fs.writeFileSync(regFile(), JSON.stringify({ v: 1, rev, artifacts }));
  const art = (over: Record<string, unknown> = {}) => ({
    id: 'art-0123456789ab',
    title: 'Supplier Line',
    url: 'https://claude.ai/artifact/fixture',
    kind: 'app',
    description: 'The supplier tracker',
    added_at: '2026-09-21T10:00:00.000Z',
    added_by: 'cli',
    ...over,
  });
  const sse = (
    auth: Record<string, string>,
    cookie: string,
    act: () => void,
    waitMs = 700,
  ) =>
    request({
      method: 'POST',
      path: '/api/v1/events/ticket',
      headers: auth,
    }).then(
      (t) =>
        new Promise<string[]>((resolve, reject) => {
          const { ticket } = JSON.parse(t.text);
          let buf = '';
          const req = http.request(
            {
              host: '127.0.0.1',
              port,
              path: `/api/v1/events?ticket=${ticket}`,
              headers: { Cookie: cookie },
            },
            (res) => {
              res.on('data', (c) => (buf += String(c)));
              setTimeout(act, 30);
              setTimeout(() => {
                req.destroy();
                resolve(
                  buf
                    .split('\n\n')
                    .filter((f) => f.includes('event: artifact')),
                );
              }, waitMs);
            },
          );
          req.on('error', reject);
          req.end();
        }),
    );

  it('lists the registry (empty, valid, invalid) and refuses without auth or config', async () => {
    await bootA();
    expect(fs.statSync(ctlDir).isDirectory()).toBe(true);
    expect(
      (await request({ method: 'GET', path: '/api/v1/artifacts' })).status,
    ).toBe(401);
    const { auth } = await login();
    expect(
      j(
        await request({
          method: 'GET',
          path: '/api/v1/artifacts',
          headers: auth,
        }),
      ),
    ).toEqual({ artifacts: [], rev: 0, creating: [] });
    plant(
      [
        art(),
        art({
          id: 'art-0123456789ac',
          title: 'Bad',
          url: 'https://evil.example/',
          kind: 'report',
        }),
      ],
      3,
    );
    let r = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(r.rev).toBe(3);
    expect(r.artifacts[0]).toMatchObject({
      url: 'https://claude.ai/artifact/fixture',
      hostname: 'claude.ai',
      description: 'The supplier tracker',
    });
    expect(r.artifacts[1]).toMatchObject({
      url: null,
      blocked: 'host',
      hostname: 'evil.example',
    });
    fs.writeFileSync(
      regFile(),
      '{"v":1,"rev":0,"artifacts":[],"secret":"S3CR3T"}',
    );
    r = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(r).toEqual({
      artifacts: [],
      rev: 0,
      invalid: true,
      reason: 'bad-schema',
      creating: [],
    });
    await new Promise<void>((res) => server.close(() => res()));
    await bootA({ configDir: undefined });
    const s2 = await login();
    expect(
      (
        await request({
          method: 'GET',
          path: '/api/v1/artifacts',
          headers: s2.auth,
        })
      ).status,
    ).toBe(503);
  });

  it('adds with validation and audit, removes with the typed id, and budgets writes', async () => {
    await bootA();
    const { auth } = await login();
    const post = (body: object) =>
      request({
        method: 'POST',
        path: '/api/v1/artifacts',
        headers: { ...auth, ...H },
        body: JSON.stringify(body),
      });
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/artifacts',
          headers: H,
          body: '{}',
        })
      ).status,
    ).toBe(401);
    let r = await post({
      title: 'Supplier Line',
      url: 'javascript:alert(1)',
      kind: 'app',
    });
    expect(r.status).toBe(400);
    expect(j(r)).toEqual({ error: 'url not allowed', blocked: 'protocol' });
    expect(
      j(await post({ title: 'x', url: 'https://evil.example/', kind: 'app' })),
    ).toMatchObject({ blocked: 'host' });
    expect(
      j(
        await post({
          title: 'x',
          url: 'https://claude.ai/p?api_key=1',
          kind: 'app',
        }),
      ),
    ).toMatchObject({ blocked: 'secret-query' });
    expect(
      (await post({ title: '', url: 'https://claude.ai/p', kind: 'app' }))
        .status,
    ).toBe(400);
    r = await post({
      title: 'קו ספקים',
      url: 'https://claude.ai/artifact/a',
      kind: 'app',
      description: 'd',
    });
    expect(r.status).toBe(201);
    const { id } = j(r);
    expect(id).toMatch(/^art-[0-9a-f]{12}$/);
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf-8'))).toMatchObject({
      rev: 1,
    });
    const add = ev('control_ui_artifact_add');
    expect(add).toHaveLength(1);
    expect(add[0][0]).toMatchObject({ id, hostname: 'claude.ai' });
    expect(JSON.stringify(add[0][0])).not.toContain('/artifact/a');
    // Remove: id regex → 404 before anything; typed id required.
    const del = (rid: string, confirm?: string) =>
      request({
        method: 'DELETE',
        path: `/api/v1/artifacts/${rid}`,
        headers: { ...auth, ...(confirm ? { 'X-Confirm': confirm } : {}) },
      });
    expect((await del('..%2Fx')).status).toBe(404);
    expect((await del(id)).status).toBe(428);
    expect((await del(id, 'Supplier Line')).status).toBe(428); // a title is never the confirmation
    expect((await del('art-ffffffffffff', 'art-ffffffffffff')).status).toBe(
      404,
    );
    expect((await del(id, id)).status).toBe(204);
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf-8'))).toMatchObject({
      rev: 2,
      artifacts: [],
    });
    expect(
      fs
        .readFileSync(path.join(ctlDir, 'artifacts-removed.jsonl'), 'utf-8')
        .trim()
        .split('\n'),
    ).toHaveLength(1);
    expect(ev('control_ui_artifact_remove')[0][0]).toMatchObject({
      id,
      hostname: 'claude.ai',
    });
    // Registry full by count (201st) and a stale lock broken.
    plant(
      Array.from({ length: 200 }, (_, i) =>
        art({ id: `art-${i.toString(16).padStart(12, '0')}` }),
      ),
      9,
    );
    r = await post({
      title: 'one more',
      url: 'https://claude.ai/p',
      kind: 'app',
    });
    expect(r.status).toBe(409);
    expect(j(r).error).toBe('registry full');
    fs.writeFileSync(path.join(ctlDir, 'artifacts.json.lock'), 'other');
    expect(
      j(await post({ title: 'busy', url: 'https://claude.ai/p', kind: 'app' })),
    ).toEqual({ error: 'registry busy' });
    // Invalid input never spent budget; the writes that reached the limiter so
    // far are 201, 404, 204, 409, 409 — one more 409, then 429.
    expect(
      (await post({ title: 'a', url: 'https://claude.ai/p', kind: 'app' }))
        .status,
    ).toBe(409);
    expect(
      (await post({ title: 'a', url: 'https://claude.ai/p', kind: 'app' }))
        .status,
    ).toBe(429);
  });

  it('read-only withholds url and description on the route and the SSE frame, and refuses writes', async () => {
    await bootA({ readOnly: true });
    const { auth, cookie } = await login();
    plant([art()], 2);
    const r = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(Object.keys(r.artifacts[0]).sort()).toEqual([
      'added_at',
      'added_by',
      'hostname',
      'id',
      'kind',
      'local',
      'title',
    ]);
    const frames = await sse(auth, cookie, () =>
      plant([art(), art({ id: 'art-0123456789ad', title: 'Second' })], 3),
    );
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(frames[frames.length - 1].split('data: ')[1]);
    expect(payload.rev).toBe(3);
    for (const a of payload.artifacts)
      for (const k of ['url', 'description', 'blocked'])
        expect(a).not.toHaveProperty(k);
    expect(JSON.stringify(payload)).not.toContain('claude.ai/artifact');
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/artifacts',
          headers: { ...auth, ...H },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'DELETE',
          path: '/api/v1/artifacts/art-0123456789ab',
          headers: { ...auth, 'X-Confirm': 'art-0123456789ab' },
        })
      ).status,
    ).toBe(403);
  });

  it('broadcasts one artifact frame per registry change and none for other files in the dir', async () => {
    await bootA();
    const { auth, cookie } = await login();
    let frames = await sse(auth, cookie, () => plant([art()], 1));
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0].split('data: ')[1])).toMatchObject({ rev: 1 });
    frames = await sse(auth, cookie, () =>
      fs.writeFileSync(path.join(ctlDir, 'claude-started.json'), '[]'),
    );
    expect(frames).toHaveLength(0);
  });

  it('frames the local copy behind a ticket; only the version route follows the source', async () => {
    await bootA();
    const { auth, cookie } = await login();
    const ticket = async () =>
      JSON.parse(
        (
          await request({
            method: 'POST',
            path: '/api/v1/events/ticket',
            headers: auth,
          })
        ).text,
      ).ticket as string;
    // A source page and its copy, as the CLI's `add --file` records them.
    const src = path.join(root, 'page.html');
    fs.writeFileSync(src, '<p>one</p>');
    const st = fs.statSync(src);
    const id = 'art-0123456789ab';
    const local = {
      source: fs.realpathSync(src),
      uid: st.uid,
      bytes: st.size,
      copied_at: '2026-09-21T10:00:00.000Z',
      source_mtime_ms: st.mtimeMs,
    };
    const copy = path.join(ctlDir, 'artifacts', `${id}.html`);
    fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(copy, '<p>one</p>', { mode: 0o600 });
    plant([art({ local }), art({ id: 'art-ffffffffffff', title: 'Remote' })]);
    const page = (
      q: string,
      headers: Record<string, string> = { Cookie: cookie },
    ) =>
      request({
        method: 'GET',
        path: `/api/v1/artifacts/${id}/page${q}`,
        headers,
      });
    expect((await page('')).status).toBe(401);
    const t = await ticket();
    const r = await page(`?ticket=${t}`);
    expect(r.status).toBe(200);
    expect(r.text).toBe('<p>one</p>');
    expect(r.headers['x-frame-options']).toBeUndefined();
    const csp = r.headers['content-security-policy'];
    expect(typeof csp).toBe('string'); // exactly one policy header
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('allow-same-origin');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await page(`?ticket=${t}`)).status).toBe(401); // single use
    const noLocal = await request({
      method: 'GET',
      path: `/api/v1/artifacts/art-ffffffffffff/page?ticket=${await ticket()}`,
      headers: { Cookie: cookie },
    });
    expect(noLocal.status).toBe(404);
    expect(j(noLocal)).toMatchObject({ error: 'no-local' });
    // The list says only that a copy exists.
    const list = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(
      list.artifacts.find((a: { id: string }) => a.id === id),
    ).toMatchObject({ local: true });
    expect(
      list.artifacts.find((a: { id: string }) => a.id !== id),
    ).toMatchObject({ local: false });
    expect(JSON.stringify(list)).not.toContain('page.html');
    // Version: unchanged until the source changes; the page never re-reads the source.
    const version = () =>
      request({
        method: 'GET',
        path: `/api/v1/artifacts/${id}/version`,
        headers: auth,
      });
    let v = j(await version());
    expect(v.following).toBe(true);
    const v0 = v.version;
    expect(j(await version()).version).toBe(v0);
    fs.writeFileSync(src, '<p>two, longer</p>');
    fs.utimesSync(src, new Date(), new Date(st.mtimeMs + 5000));
    expect((await page(`?ticket=${await ticket()}`)).text).toBe('<p>one</p>'); // the copy, always
    v = j(await version());
    expect(v.following).toBe(true);
    expect(v.version).not.toBe(v0);
    expect((await page(`?ticket=${await ticket()}`)).text).toBe(
      '<p>two, longer</p>',
    );
    expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(fs.readFileSync(regFile(), 'utf-8')).artifacts[0].local
        .source_mtime_ms,
    ).toBe(fs.statSync(src).mtimeMs);
    // A source that fails a check keeps the copy and is no longer followed.
    const v1 = j(await version()).version;
    const other = path.join(root, 'other.html');
    fs.writeFileSync(other, '<p>three</p>');
    fs.unlinkSync(src);
    fs.symlinkSync(other, src);
    v = j(await version());
    expect(v.following).toBe(false);
    expect(v.version).toBe(v1);
    expect((await page(`?ticket=${await ticket()}`)).text).toBe(
      '<p>two, longer</p>',
    );
    fs.unlinkSync(src);
    fs.writeFileSync(src, '<p>four</p>');
    fs.utimesSync(src, new Date(), new Date(Date.now() + 10_000));
    const twin = path.join(root, 'twin.html');
    fs.linkSync(src, twin); // two links
    expect(j(await version()).following).toBe(false);
    expect((await page(`?ticket=${await ticket()}`)).text).toBe(
      '<p>two, longer</p>',
    );
    fs.unlinkSync(twin); // one link again, and newer: followed
    expect(j(await version()).following).toBe(true);
    expect((await page(`?ticket=${await ticket()}`)).text).toBe('<p>four</p>');
    const txt = path.join(root, 'notes.txt');
    fs.writeFileSync(txt, '<p>five</p>');
    fs.unlinkSync(src);
    fs.renameSync(txt, src); // still .html by name — the recorded path — so the name check holds; a differing realpath is the symlink case above
    fs.utimesSync(src, new Date(), new Date(Date.now() + 20_000));
    expect(j(await version()).following).toBe(true);
    // The copy gone: both routes say so.
    fs.unlinkSync(copy);
    expect(j(await version())).toMatchObject({ error: 'no-copy' });
    expect((await page(`?ticket=${await ticket()}`)).status).toBe(404);
  });
  it('a read-only server reports the copy and never refreshes it', async () => {
    await bootA({ readOnly: true });
    const { auth } = await login();
    const src = path.join(root, 'page.html');
    fs.writeFileSync(src, '<p>one</p>');
    const st = fs.statSync(src);
    const id = 'art-0123456789ab';
    const copy = path.join(ctlDir, 'artifacts', `${id}.html`);
    fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
    fs.writeFileSync(copy, '<p>one</p>', { mode: 0o600 });
    plant([
      art({
        local: {
          source: fs.realpathSync(src),
          uid: st.uid,
          bytes: st.size,
          copied_at: '2026-09-21T10:00:00.000Z',
          source_mtime_ms: st.mtimeMs,
        },
      }),
    ]);
    fs.writeFileSync(src, '<p>two, longer</p>');
    fs.utimesSync(src, new Date(), new Date(st.mtimeMs + 5000));
    const v = j(
      await request({
        method: 'GET',
        path: `/api/v1/artifacts/${id}/version`,
        headers: auth,
      }),
    );
    expect(v.following).toBe(false);
    expect(fs.readFileSync(copy, 'utf-8')).toBe('<p>one</p>');
    expect(JSON.parse(fs.readFileSync(regFile(), 'utf-8')).rev).toBe(1);
    const list = j(
      await request({
        method: 'GET',
        path: '/api/v1/artifacts',
        headers: auth,
      }),
    );
    expect(list.artifacts[0]).toMatchObject({ local: true });
    expect(list.artifacts[0].url).toBeUndefined();
  });
});

describe('control-ui server — gmail', () => {
  const warnSpy = vi.mocked(logger.warn);
  // logger.error has no spy from the earlier blocks; one is created here once.
  const errorSpy = vi.isMockFunction(logger.error)
    ? vi.mocked(logger.error)
    : vi.spyOn(logger, 'error');
  let gdir: string;
  const SECRET = 'FIXTURE-SECRET-xyz';
  const CLIENT = JSON.stringify({
    installed: {
      client_id: 'fixture.apps.googleusercontent.com',
      client_secret: SECRET,
      redirect_uris: [],
    },
  });
  const TOKENS = {
    access_token: 'ya29.FIXTURE-ACCESS',
    refresh_token: '1//FIXTURE-REFRESH',
    token_type: 'Bearer',
    expiry_date: 1790000000000,
    scope: 'gmail.modify',
  };
  beforeEach(() => {
    warnSpy.mockClear();
    errorSpy.mockClear();
    clock = Date.parse('2026-09-21T12:00:00.000Z');
    gdir = path.join(root, 'gmail-creds');
  });
  const j = (r: { text: string }) => JSON.parse(r.text);
  const ev = (spy: typeof warnSpy, name: string) =>
    spy.mock.calls.filter((c) => (c[0] as { event?: string })?.event === name);
  const lifecycle = () => {
    const calls: string[] = [];
    let live = false;
    return {
      calls,
      startChannel: vi.fn(async (n: string) => {
        calls.push(`start:${n}`);
        live = true;
        return { ok: true as const };
      }),
      stopChannel: vi.fn(async (n: string) => {
        calls.push(`stop:${n}`);
        live = false;
        return true;
      }),
      isChannelLive: () => live,
    };
  };
  const hooks = (
    over: Partial<ControlServerOptions['gmailAuthOverrides']> = {},
  ) => ({
    exchange: vi.fn(async () => ({ ...TOKENS })),
    profile: vi.fn(async () => ({ emailAddress: 'fixture@example.invalid' })),
    revoke: vi.fn(async () => {}),
    sleep: async () => {},
    ...over,
  });
  const bootG = (
    over: Partial<ControlDeps> = {},
    h = hooks(),
    life = lifecycle(),
  ) =>
    boot(
      {
        runtime: fakeRuntime().runtime,
        store: fakeStore(root),
        gmailCredentialsDir: gdir,
        publicPort: 3017,
        ...life,
        ...over,
      },
      undefined,
      undefined,
      { gmailAuthOverrides: h },
    ).then(() => ({ h, life }));
  const post = (
    auth: Record<string, string>,
    p: string,
    body?: object,
    extra: Record<string, string> = {},
  ) =>
    request({
      method: 'POST',
      path: p,
      headers: { ...auth, ...H, ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
  const callback = (qs: string, cookies: string) =>
    request({
      method: 'GET',
      path: `/api/v1/integrations/gmail/callback?${qs}`,
      headers: cookies ? { Cookie: cookies } : {},
    });
  const flowCookieOf = (r: Reply) => {
    const set = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    const c = set.find((s) => s.startsWith('deus_ctl_oauth='));
    return c ? c.split(';')[0] : null;
  };
  const allText = () =>
    JSON.stringify([
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ]);

  it('status, keys paste, connect, callback, disconnect and forget — end to end', async () => {
    const { h, life } = await bootG();
    expect(
      (await request({ method: 'GET', path: '/api/v1/integrations/gmail' }))
        .status,
    ).toBe(401);
    const { auth, cookie } = await login();
    const url = '/api/v1/integrations/gmail';
    expect(
      j(await request({ method: 'GET', path: url, headers: auth })),
    ).toEqual({
      keys: false,
      connected: false,
      channel_live: false,
      redirect_uri: 'http://localhost:3017/api/v1/integrations/gmail/callback',
    });
    expect((await post(auth, `${url}/connect`)).status).toBe(409);
    expect(
      (
        await post(auth, `${url}/keys`, {
          json: '{"installed":{"client_id":"x"}}',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(auth, `${url}/keys`, { json: 'x'.repeat(17 * 1024) })).status,
    ).toBe(413);
    const k = await post(auth, `${url}/keys`, { json: CLIENT });
    expect(k.status).toBe(201);
    if (!IS_WINDOWS)
      expect(
        fs.statSync(path.join(gdir, 'gcp-oauth.keys.json')).mode & 0o777,
      ).toBe(0o600);
    expect(ev(warnSpy, 'control_ui_gmail_keys')).toHaveLength(1);
    expect(
      j(await request({ method: 'GET', path: url, headers: auth })),
    ).toMatchObject({ keys: true, connected: false });
    // Connect issues a state and a path-scoped Lax flow cookie.
    const c = await post(auth, `${url}/connect`);
    expect(c.status).toBe(200);
    const consent = new URL(j(c).url);
    expect(consent.hostname).toBe('accounts.google.com');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    const setCookie = ([] as string[])
      .concat(c.headers['set-cookie'] ?? [])
      .find((s) => s.startsWith('deus_ctl_oauth='))!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api/v1/integrations/gmail/callback');
    expect(setCookie).toContain('Max-Age=600');
    expect(setCookie).not.toContain('Secure');
    const state = consent.searchParams.get('state')!;
    const flow = flowCookieOf(c)!;
    // Callback: no flow cookie → 403 page; wrong state → 403; happy path → 200 page.
    let r = await callback(`state=${state}&code=abc`, '');
    expect(r.status).toBe(403);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(r.text).toContain('flow cookie mismatch');
    // That consumed the state (single use): re-issue for the happy path.
    const c2 = await post(auth, `${url}/connect`);
    const state2 = new URL(j(c2).url).searchParams.get('state')!;
    const flow2 = flowCookieOf(c2)!;
    r = await callback(
      `state=${state2}&code=4%2Ffixture`,
      `${flow2}; ${cookie}`,
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain('Gmail connected as fixture@example.invalid');
    expect(r.text).toContain('/#/channels');
    const cleared = ([] as string[])
      .concat(r.headers['set-cookie'] ?? [])
      .find((s) => s.startsWith('deus_ctl_oauth='))!;
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('Path=/api/v1/integrations/gmail/callback');
    expect(h.exchange).toHaveBeenCalledTimes(1);
    expect(vi.mocked(h.exchange).mock.calls[0][0]).toBe('4/fixture');
    expect(life.startChannel).toHaveBeenCalledWith('gmail');
    expect(
      JSON.parse(fs.readFileSync(path.join(gdir, 'credentials.json'), 'utf-8')),
    ).toEqual(TOKENS);
    expect(ev(warnSpy, 'control_ui_gmail_connected')[0][0]).toMatchObject({
      domain: 'example.invalid',
      channel: 'started',
    });
    const st = j(await request({ method: 'GET', path: url, headers: auth }));
    expect(st).toMatchObject({
      keys: true,
      connected: true,
      email: 'fixture@example.invalid',
      channel_live: true,
    });
    // Second visit of the same state → 403.
    expect((await callback(`state=${state2}&code=x`, `${flow2}`)).status).toBe(
      403,
    );
    void flow;
    // Forget keys refused while connected; disconnect stops the channel before revoking.
    expect(
      (
        await request({
          method: 'DELETE',
          path: `${url}/keys`,
          headers: { ...auth, 'X-Confirm': 'gmail' },
        })
      ).status,
    ).toBe(409);
    expect((await post(auth, `${url}/disconnect`)).status).toBe(428);
    const d = await post(auth, `${url}/disconnect`, undefined, {
      'X-Confirm': 'gmail',
    });
    expect(d.status).toBe(200);
    expect(j(d)).toEqual({ revoked: true, deleted: true });
    expect(life.calls).toEqual(['start:gmail', 'stop:gmail']);
    expect(h.revoke).toHaveBeenCalledWith(TOKENS.refresh_token);
    expect(fs.existsSync(path.join(gdir, 'credentials.json'))).toBe(false);
    clock += 61_000; // six mutations reached the limiter above; a new window
    expect(
      (
        await request({
          method: 'DELETE',
          path: `${url}/keys`,
          headers: { ...auth, 'X-Confirm': 'gmail' },
        })
      ).status,
    ).toBe(204);
    expect(fs.existsSync(path.join(gdir, 'gcp-oauth.keys.json'))).toBe(false);
    // No secret anywhere: responses were checked above; logs here.
    const text = allText();
    for (const s of [
      SECRET,
      TOKENS.refresh_token,
      TOKENS.access_token,
      '4/fixture',
    ])
      expect(text).not.toContain(s);
  });

  it('surfaces a failed revoke, limits mutations, and never logs the raw exchange error', async () => {
    const gaxios = Object.assign(
      new Error('Request failed with status code 400'),
      {
        code: '400',
        response: { status: 400 },
        config: { data: `client_secret=${SECRET}&code=c` },
      },
    );
    const { h } = await bootG(
      {},
      hooks({
        revoke: vi.fn(async () => {
          throw new Error('revoke down');
        }),
        exchange: vi.fn(async () => {
          throw gaxios;
        }),
      }),
    );
    const { auth } = await login();
    const url = '/api/v1/integrations/gmail';
    await post(auth, `${url}/keys`, { json: CLIENT });
    const c = await post(auth, `${url}/connect`);
    const state = new URL(j(c).url).searchParams.get('state')!;
    const r = await callback(`state=${state}&code=c`, flowCookieOf(c)!);
    expect(r.status).toBe(502);
    expect(r.text).toContain('exchange failed');
    expect(ev(warnSpy, 'control_ui_gmail_connect_failed')[0][0]).toMatchObject({
      reason: 'exchange failed',
      code: '400',
      status: 400,
    });
    expect(allText()).not.toContain(SECRET);
    // Disconnect with nothing connected still answers; a revoke failure is visible when tokens exist.
    fs.writeFileSync(
      path.join(gdir, 'credentials.json'),
      JSON.stringify(TOKENS),
    );
    const d = await post(auth, `${url}/disconnect`, undefined, {
      'X-Confirm': 'gmail',
    });
    expect(j(d)).toEqual({ revoked: false, deleted: true });
    expect(ev(warnSpy, 'control_ui_gmail_revoke_failed')).toHaveLength(1);
    // Mutations so far: keys, connect, disconnect = 3; three more, then 429.
    for (let i = 0; i < 3; i++)
      expect((await post(auth, `${url}/connect`)).status).toBe(200);
    expect((await post(auth, `${url}/connect`)).status).toBe(429);
    void h;
  });

  it('logout drops pending states, bad-state floods are limited per address but a valid callback still passes', async () => {
    await bootG();
    const s1 = await login();
    const url = '/api/v1/integrations/gmail';
    await post(s1.auth, `${url}/keys`, { json: CLIENT });
    const c = await post(s1.auth, `${url}/connect`);
    const state = new URL(j(c).url).searchParams.get('state')!;
    const flow = flowCookieOf(c)!;
    await post(s1.auth, '/auth/logout');
    expect((await callback(`state=${state}&code=c`, flow)).status).toBe(403);
    const s2 = await login();
    // The dropped-state hit above was failure 1; nine more reach the 10/min cap.
    for (let i = 0; i < 9; i++)
      expect((await callback(`state=bad${i}&code=c`, '')).status).toBe(403);
    expect((await callback('state=bad11&code=c', '')).status).toBe(429);
    const c2 = await post(s2.auth, `${url}/connect`);
    const state2 = new URL(j(c2).url).searchParams.get('state')!;
    expect(
      (await callback(`state=${state2}&code=ok`, flowCookieOf(c2)!)).status,
    ).toBe(200);
  });

  it('the real channel lifecycle, spread into deps as index.ts does, reports channel_live after connect', async () => {
    const channels: Channel[] = [];
    let connected = false;
    const gmail = {
      name: 'gmail',
      connect: async () => {
        connected = true;
      },
      disconnect: async () => {
        connected = false;
      },
      isConnected: () => connected,
      ownsJid: () => false,
      sendMessage: async () => {},
    } as unknown as Channel;
    const life = createChannelLifecycle(channels, {} as ChannelOpts, (n) =>
      n === 'gmail' ? () => gmail : undefined,
    );
    await boot(
      {
        runtime: fakeRuntime().runtime,
        store: fakeStore(root),
        gmailCredentialsDir: gdir,
        publicPort: 3017,
        ...life,
      },
      undefined,
      undefined,
      { gmailAuthOverrides: hooks() },
    );
    const { auth } = await login();
    const url = '/api/v1/integrations/gmail';
    await post(auth, `${url}/keys`, { json: CLIENT });
    const c = await post(auth, `${url}/connect`);
    const state = new URL(j(c).url).searchParams.get('state')!;
    expect(
      (await callback(`state=${state}&code=ok`, flowCookieOf(c)!)).status,
    ).toBe(200);
    expect(channels.map((ch) => ch.name)).toEqual(['gmail']);
    expect(
      j(await request({ method: 'GET', path: url, headers: auth })),
    ).toMatchObject({ connected: true, channel_live: true });
    const d = await post(auth, `${url}/disconnect`, undefined, {
      'X-Confirm': 'gmail',
    });
    expect(j(d)).toEqual({ revoked: true, deleted: true });
    expect(channels).toEqual([]);
    expect(
      j(await request({ method: 'GET', path: url, headers: auth })),
    ).toMatchObject({ connected: false, channel_live: false });
  });

  it('read-only refuses every mutation and the callback, but status still answers; a throwing route logs safely', async () => {
    await bootG({ readOnly: true });
    const { auth } = await login();
    const url = '/api/v1/integrations/gmail';
    expect(
      (await request({ method: 'GET', path: url, headers: auth })).status,
    ).toBe(200);
    expect((await post(auth, `${url}/keys`, { json: CLIENT })).status).toBe(
      403,
    );
    expect((await post(auth, `${url}/connect`)).status).toBe(403);
    expect(
      (
        await post(auth, `${url}/disconnect`, undefined, {
          'X-Confirm': 'gmail',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request({
          method: 'DELETE',
          path: `${url}/keys`,
          headers: { ...auth, 'X-Confirm': 'gmail' },
        })
      ).status,
    ).toBe(403);
    const r = await callback('state=x&code=y', '');
    expect(r.status).toBe(403);
    expect(r.text).toContain('read-only');
  });

  it('the top-level 500 handler logs a safe error shape and the path without its query', async () => {
    const boom = Object.assign(
      new Error(`boom client_secret=${SECRET}&code=c`),
      { code: 'EBOOM', config: { data: `client_secret=${SECRET}` } },
    );
    await boot({}, () => {
      throw boom;
    });
    const r = await request({ method: 'GET', path: '/?state=s&code=c' });
    expect(r.status).toBe(500);
    const call = errorSpy.mock.calls.find((c) =>
      String(c[1]).includes('request failed'),
    )!;
    const logged = call[0] as { err: Record<string, unknown>; path: string };
    expect(logged.path).toBe('/');
    expect(logged.err).toEqual({
      name: 'Error',
      code: 'EBOOM',
      message: 'boom client_secret=[redacted]',
    });
    expect(JSON.stringify(call)).not.toContain(SECRET);
  });
});

describe('control-ui server — browser jobs', () => {
  const warnSpy = vi.mocked(logger.warn);
  let configDir: string;
  let bdir: string;
  beforeEach(() => {
    warnSpy.mockClear();
    clock = Date.parse('2026-09-23T12:00:00.000Z'); // a Wednesday, outside quiet hours
    configDir = path.join(root, 'cfg');
    bdir = path.join(configDir, 'browser');
  });
  const j = (r: { text: string }) => JSON.parse(r.text);
  const ev = (name: string) =>
    warnSpy.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === name,
    );
  const bootB = (over: Partial<ControlDeps> = {}, extra = {}) =>
    boot(
      {
        runtime: fakeRuntime().runtime,
        store: fakeStore(root),
        configDir,
        ...over,
      },
      undefined,
      undefined,
      { browserPollMs: 60_000, browserSweepMs: 3_600_000, ...extra },
    );
  const rules = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    autonomous: false,
    weekly_cap: 25,
    daily_cap: 4,
    min_gap_seconds: 45,
    jitter_seconds: 0,
    quiet_hours: null,
    allow: { kinds: ['instagram.follow'], handles: ['@ours'], threads: [] },
    ...over,
  });
  const put = (
    auth: Record<string, string>,
    site: string,
    body: object,
    confirm?: string,
  ) =>
    request({
      method: 'PUT',
      path: `/api/v1/browser/sites/${site}/rules`,
      headers: { ...auth, ...H, ...(confirm ? { 'X-Confirm': confirm } : {}) },
      body: JSON.stringify(body),
    });
  const propose = (auth: Record<string, string>, body: object) =>
    request({
      method: 'POST',
      path: '/api/v1/browser/jobs',
      headers: { ...auth, ...H },
      body: JSON.stringify(body),
    });
  const approve = (
    auth: Record<string, string>,
    id: string,
    confirm?: string,
  ) =>
    request({
      method: 'POST',
      path: `/api/v1/browser/jobs/${id}/approve`,
      headers: { ...auth, ...(confirm ? { 'X-Confirm': confirm } : {}) },
    });
  const rejectJob = (auth: Record<string, string>, id: string) =>
    request({
      method: 'POST',
      path: `/api/v1/browser/jobs/${id}/reject`,
      headers: { ...auth },
    });
  const onDisk = (id: string) =>
    JSON.parse(
      fs.readFileSync(path.join(bdir, 'jobs', `${id}.json`), 'utf-8'),
    ) as Record<string, unknown>;

  it('creates the dir, reports both sites disabled, and refuses without auth', async () => {
    await bootB();
    expect(fs.statSync(bdir).isDirectory()).toBe(true);
    if (!IS_WINDOWS) expect(fs.statSync(bdir).mode & 0o777).toBe(0o700);
    expect(
      (await request({ method: 'GET', path: '/api/v1/browser' })).status,
    ).toBe(401);
    const { auth } = await login();
    const r = j(
      await request({ method: 'GET', path: '/api/v1/browser', headers: auth }),
    );
    expect(r.sites).toHaveLength(2);
    expect(r.sites[0]).toMatchObject({
      site: 'instagram',
      counts: { day: 0, week: 0 },
      execution: 'unavailable',
    });
    expect(r.sites[0].rules.enabled).toBe(false);
    expect(r.jobs).toEqual([]);
  });

  it('saves rules, but only the typed site name earns autonomy', async () => {
    await bootB();
    const { auth } = await login();
    expect((await put(auth, 'instagram', rules({ daily_cap: 0 }))).status).toBe(
      400,
    );
    expect(
      (await put(auth, 'instagram', rules({ daily_cap: 26 }))).status,
    ).toBe(400);
    expect((await put(auth, 'twitter', rules())).status).toBe(404);
    expect((await put(auth, 'instagram', rules())).status).toBe(200);
    expect(ev('control_ui_browser_rules_saved')[0][0]).toMatchObject({
      site: 'instagram',
      weekly_cap: 25,
      autonomous: false,
    });
    // Autonomy without the typed confirmation is refused outright.
    expect(
      (await put(auth, 'instagram', rules({ autonomous: true }))).status,
    ).toBe(428);
    const okAuto = await put(
      auth,
      'instagram',
      rules({ autonomous: true }),
      'instagram',
    );
    expect(okAuto.status).toBe(200);
    expect(j(okAuto).rules.autonomous).toBe(true);
    const file = path.join(bdir, 'rules', 'instagram.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(rec.autonomy_scope_sha256).toBeTruthy();
    // A cap edited outside the dashboard keeps the stamp and loses the grant.
    fs.writeFileSync(file, JSON.stringify({ ...rec, weekly_cap: 500 }));
    const after = j(
      await request({ method: 'GET', path: '/api/v1/browser', headers: auth }),
    );
    expect(after.sites[0].rules.autonomous).toBe(false);
  });

  it('sets status and provenance itself, and enforces the allow-list at propose time', async () => {
    await bootB();
    const { auth } = await login();
    await put(auth, 'instagram', rules());
    expect(
      (
        await propose(auth, {
          kind: 'instagram.dm',
          params: { handle: '@ours' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await propose(auth, {
          kind: 'instagram.follow',
          params: { handle: '@stranger' },
        })
      ).status,
    ).toBe(400);
    const r = await propose(auth, {
      kind: 'instagram.follow',
      params: { handle: '@OURS' },
      status: 'approved', // ignored
      proposed_by: 'session:someone-else', // ignored
      proposed_at: new Date(clock + 3_600_000).toISOString(), // ignored
    });
    expect(r.status).toBe(201);
    const { id } = j(r);
    const rec = onDisk(id);
    expect(rec.status).toBe('proposed');
    expect(String(rec.proposed_by)).toMatch(/^session:[0-9a-f]+$/);
    expect(Date.parse(String(rec.proposed_at))).toBeLessThanOrEqual(clock);
    expect(ev('control_ui_browser_job_proposed')[0][0]).toMatchObject({
      site: 'instagram',
      kind: 'instagram.follow',
    });
  });

  it('approves with the typed id, records the decision, and stops at sandbox-unavailable without spawning anything', async () => {
    const spawn = vi.fn();
    await bootB({}, { hostCli: { run: spawn } });
    const { auth } = await login();
    await put(auth, 'instagram', rules());
    const { id } = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    expect((await approve(auth, id)).status).toBe(428);
    expect((await approve(auth, id, 'bj-000000000000')).status).toBe(428);
    const ok = await approve(auth, id, id);
    expect(ok.status).toBe(200);
    expect(j(ok)).toMatchObject({
      id,
      status: 'blocked',
      reason: 'sandbox-unavailable',
    });
    expect(spawn).not.toHaveBeenCalled();
    const rec = onDisk(id);
    expect(rec).toMatchObject({
      status: 'blocked',
      reason: 'sandbox-unavailable',
    });
    expect(String(rec.approved_by)).toMatch(/^session:/);
    expect(rec.params_sha256).toBeTruthy();
    expect(rec.rules_sha256).toBeTruthy();
    expect(rec.approved_rev).toBe(1);
    const audit = ev('control_ui_browser_job_approved')[0][0];
    expect(audit).toMatchObject({ id, auto: false });
    expect(JSON.stringify(audit)).not.toContain('@ours');
    // Approving twice is refused: the job is no longer a proposal.
    expect((await approve(auth, id, id)).status).toBe(409);
  });

  it('rejects only a job that is still waiting, and says so otherwise', async () => {
    await bootB();
    const { auth } = await login();
    await put(auth, 'instagram', rules());
    const { id } = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    expect((await rejectJob(auth, id)).status).toBe(204);
    expect(onDisk(id)).toMatchObject({ status: 'rejected' });
    // Rejecting again must not rewrite a terminal record. `running` counts
    // toward the caps, so in E2 an ungated reject would silently decrement
    // them and erase the audit of an action that may already have happened.
    const again = await rejectJob(auth, id);
    expect(again.status).toBe(409);
    expect(onDisk(id)).toMatchObject({ status: 'rejected', rev: 2 });
  });

  it('does not report an approval it could not write', async () => {
    await bootB();
    const { auth } = await login();
    await put(auth, 'instagram', rules());
    const { id } = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    // The operator typed the id to get here. If the record cannot land, the
    // answer must not be "approved" — the job would stay proposed and the
    // poller would re-select it on every tick.
    //
    // The fault is injected at the rename rather than by removing write
    // permission, because these tests run as root and root ignores the mode
    // bits: a chmod here passes silently and proves nothing.
    const real = fs.renameSync;
    const spy = vi
      .spyOn(fs, 'renameSync')
      .mockImplementation((from: fs.PathLike, to: fs.PathLike) => {
        if (String(to).includes(`${path.sep}jobs${path.sep}`))
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return real(from, to);
      });
    try {
      const r = await approve(auth, id, id);
      expect(r.status).toBe(503);
      expect(onDisk(id)).toMatchObject({ status: 'proposed' });
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an approval the caps or the attention marker would not allow', async () => {
    await bootB();
    const { auth } = await login();
    await put(auth, 'instagram', rules({ daily_cap: 1, weekly_cap: 25 }));
    const first = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    // A prior action today fills the cap.
    fs.writeFileSync(
      path.join(bdir, 'jobs', 'bj-aaaaaaaaaaaa.json'),
      JSON.stringify({
        v: 1,
        id: 'bj-aaaaaaaaaaaa',
        site: 'instagram',
        kind: 'instagram.follow',
        params: { handle: '@ours' },
        status: 'done',
        proposed_by: 'cli',
        proposed_at: new Date(clock - 7_200_000).toISOString(),
        finished_at: new Date(clock - 7_200_000).toISOString(),
        rev: 2,
      }),
    );
    const capped = await approve(auth, first.id, first.id);
    expect(capped.status).toBe(409);
    expect(j(capped).error).toBe('daily-cap');
    // An unreadable record makes the count inexact, and an inexact count refuses.
    fs.writeFileSync(
      path.join(bdir, 'jobs', 'bj-bbbbbbbbbbbb.json'),
      '{"v":1,',
    );
    await put(auth, 'instagram', rules({ daily_cap: 4, weekly_cap: 25 }));
    const second = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    expect(j(await approve(auth, second.id, second.id)).error).toBe(
      'counts-unavailable',
    );
    fs.unlinkSync(path.join(bdir, 'jobs', 'bj-bbbbbbbbbbbb.json'));
    // The attention marker stops everything for that site.
    fs.mkdirSync(path.join(bdir, 'attention'), { recursive: true });
    fs.writeFileSync(path.join(bdir, 'attention', 'instagram'), 'challenge');
    expect(j(await approve(auth, second.id, second.id)).error).toBe(
      'needs-attention',
    );
    const cleared = await request({
      method: 'POST',
      path: '/api/v1/browser/sites/instagram/attention/clear',
      headers: { ...auth, 'X-Confirm': 'instagram' },
    });
    expect(cleared.status).toBe(204);
    expect(j(await approve(auth, second.id, second.id))).toMatchObject({
      status: 'blocked',
    });
  });

  it('rejects, expires stale proposals at read time, and withholds params in read-only', async () => {
    await bootB();
    const { auth } = await login();
    await put(auth, 'instagram', rules());
    const { id } = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    expect(
      (
        await request({
          method: 'POST',
          path: `/api/v1/browser/jobs/${id}/reject`,
          headers: auth,
        })
      ).status,
    ).toBe(204);
    expect(onDisk(id).status).toBe('rejected');
    expect(ev('control_ui_browser_job_rejected')).toHaveLength(1);
    expect(
      (
        await request({
          method: 'POST',
          path: '/api/v1/browser/jobs/nope/reject',
          headers: auth,
        })
      ).status,
    ).toBe(404);
    // A proposal older than a day lists as expired without its file changing.
    const old = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    const file = path.join(bdir, 'jobs', `${old.id}.json`);
    const rec = onDisk(old.id);
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...rec,
        proposed_at: new Date(clock - 25 * 3_600_000).toISOString(),
      }),
    );
    const listed = j(
      await request({ method: 'GET', path: '/api/v1/browser', headers: auth }),
    );
    expect(
      listed.jobs.find((x: { id: string }) => x.id === old.id).status,
    ).toBe('expired');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).status).toBe('proposed');
    expect(j(await approve(auth, old.id, old.id)).error).toBe('expired');
    // Read-only: the list answers, the params do not.
    await new Promise<void>((r) => server.close(() => r()));
    await bootB({ readOnly: true });
    const ro = await login();
    const body = j(
      await request({
        method: 'GET',
        path: '/api/v1/browser',
        headers: ro.auth,
      }),
    );
    expect(body.jobs.length).toBeGreaterThan(0);
    for (const job of body.jobs) {
      expect(job).not.toHaveProperty('params');
      expect(job).not.toHaveProperty('result');
    }
    expect((await put(ro.auth, 'instagram', rules())).status).toBe(403);
    expect(
      (
        await propose(ro.auth, {
          kind: 'instagram.follow',
          params: { handle: '@ours' },
        })
      ).status,
    ).toBe(403);
    expect((await approve(ro.auth, id, id)).status).toBe(403);
  });

  it('auto-approves a follow only with autonomy on, a client connected, and never a reply', async () => {
    await bootB({}, { browserPollMs: 40 });
    const { auth, cookie } = await login();
    await put(auth, 'instagram', rules({ autonomous: true }), 'instagram');
    await put(
      auth,
      'alibaba',
      {
        enabled: true,
        autonomous: true,
        weekly_cap: 10,
        daily_cap: 2,
        min_gap_seconds: 15,
        jitter_seconds: 0,
        quiet_hours: null,
        allow: { kinds: ['alibaba.reply'], handles: [], threads: ['T1'] },
      },
      'alibaba',
    );
    const follow = j(
      await propose(auth, {
        kind: 'instagram.follow',
        params: { handle: '@ours' },
      }),
    );
    const reply = j(
      await propose(auth, {
        kind: 'alibaba.reply',
        params: { thread_id: 'T1', body: 'hello' },
      }),
    );
    // No client connected: the poller does nothing at all.
    await new Promise((r) => setTimeout(r, 120));
    expect(onDisk(follow.id).status).toBe('proposed');
    // With a client, the follow is approved and the reply never is.
    const { ticket } = JSON.parse(
      (
        await request({
          method: 'POST',
          path: '/api/v1/events/ticket',
          headers: auth,
        })
      ).text,
    );
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: `/api/v1/events?ticket=${ticket}`,
          headers: { Cookie: cookie },
        },
        () => {
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 300);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(onDisk(follow.id).status).toBe('blocked');
    expect(onDisk(follow.id).approved_by).toBe('rules');
    expect(onDisk(reply.id).status).toBe('proposed');
    const auto = ev('control_ui_browser_job_approved').filter(
      (c) => (c[0] as { auto?: boolean }).auto,
    );
    expect(auto.length).toBeGreaterThanOrEqual(1);
  });
});

describe('control-ui server — one agent', () => {
  it('serves one agent file by name, and 404 for anything else', async () => {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.claude', 'agents', 'helper.md'),
      '---\nname: helper\ndescription: Helps.\n---\n# Helper\nDo things.\n',
    );
    await boot();
    const { auth } = await login();
    const ok = await request({
      method: 'GET',
      path: '/api/v1/agents/helper',
      headers: auth,
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text)).toMatchObject({
      name: 'helper',
      body: '# Helper\nDo things.\n',
      truncated: false,
    });
    for (const bad of ['nobody', '..%2F..%2Fetc', 'HELPER'])
      expect(
        (
          await request({
            method: 'GET',
            path: `/api/v1/agents/${bad}`,
            headers: auth,
          })
        ).status,
      ).toBe(404);
  });
});

describe('control-ui server — static compression', () => {
  it('gzips app.css for a client that accepts it, and not otherwise', async () => {
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'web', 'app.css'),
      '.a{color:red}\n'.repeat(300),
    );
    await boot();
    const gz = await request({
      method: 'GET',
      path: '/app.css',
      headers: { 'Accept-Encoding': 'gzip' },
    });
    expect(gz.status).toBe(200);
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers['vary']).toBe('Accept-Encoding');
    const plain = await request({ method: 'GET', path: '/app.css' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    const again = await request({
      method: 'GET',
      path: '/app.css',
      headers: { 'If-None-Match': String(plain.headers['etag']) },
    });
    expect(again.status).toBe(304);
  });
});
