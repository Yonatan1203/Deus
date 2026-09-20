import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createControlServer, type ControlDeps } from './server.js';
import { writeCredentialFile } from './auth.js';

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

function boot(
  overrides: Partial<ControlDeps> = {},
  staticHandler?: () => void,
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
  server = createControlServer(deps, { now: () => clock, staticHandler });
  return new Promise<void>((r) =>
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      r();
    }),
  );
}

beforeEach(() => {
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
});

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
