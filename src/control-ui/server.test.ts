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
import { createControlServer, type ControlDeps } from './server.js';
import { writeCredentialFile } from './auth.js';
import {
  _resetWebTurnStateForTest,
  startWebTurn,
  type WebTurnDeps,
} from '../web-turn.js';
import type { RuntimeEventSink } from '../agent-runtimes/types.js';
import type { ControlStore } from './store.js';

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
  };
}

function boot(
  overrides: Partial<ControlDeps> = {},
  staticHandler?: () => void,
  queuePollMs?: number,
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
