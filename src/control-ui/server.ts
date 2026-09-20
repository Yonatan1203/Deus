import crypto from 'crypto';
import fs from 'fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import path from 'path';

import {
  CONTROL_UI_CREDENTIAL_FILE,
  CONTROL_UI_ENABLED,
  CONTROL_UI_PORT,
  CONTROL_UI_READONLY,
} from '../config.js';
import { logger } from '../logger.js';
import { createRateLimiter } from '../rate-limiter.js';
import { listAgents } from './api/agents.js';
import { listMcps } from './api/mcps.js';
import { listWardens, setWardenEnabled } from './api/wardens.js';
import {
  clearSessionCookie,
  createBackoff,
  createCredentialSource,
  createSessionStore,
  isTls,
  loadCredentialFile,
  normalizeAddr,
  parseCookies,
  SESSION_COOKIE,
  SESSION_HEADER,
  sessionCookie,
  verifyPassword,
  type Backoff,
  type CredentialSource,
  type SessionInfo,
  type SessionStore,
} from './auth.js';
import { createEventHub, type EventHub } from './events.js';
import { createRouter, type RequestContext } from './router.js';
import { SECURITY_HEADERS, serveStatic } from './static.js';

export interface ControlDeps {
  repoRoot: string;
  webRoot: string;
  credentialFile: string;
  readOnly: boolean;
  assistantName: string;
  version: string;
  envHas: (key: string) => boolean;
}

export interface ControlServerOptions {
  sessions?: SessionStore;
  backoff?: Backoff;
  hub?: EventHub;
  credentials?: CredentialSource;
  now?: () => number;
  staticHandler?: typeof serveStatic;
}

const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;
const LOGIN_RATE_MAX = 10;
const LOGIN_RATE_WINDOW_MS = 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function readPackageVersion(root: string): string {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf-8'),
    );
    const v = (parsed as { version?: unknown } | null)?.version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

type BodyRead = { ok: true; body: unknown } | { ok: false; status: 400 | 413 };

function readJsonBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        resolve({ ok: false, status: 413 });
        // Drain instead of destroying so the 413 reaches the client intact.
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (chunks.length === 0) return resolve({ ok: true, body: undefined });
      try {
        resolve({
          ok: true,
          body: JSON.parse(Buffer.concat(chunks).toString('utf-8')),
        });
      } catch {
        resolve({ ok: false, status: 400 });
      }
    });
    req.on('error', () => {
      if (!done) {
        done = true;
        resolve({ ok: false, status: 400 });
      }
    });
  });
}

// A missing Origin is accepted on purpose: a cross-site request that carries
// the custom X-Deus-Session header is never a "simple" request, so the header
// requirement is the CSRF control; this check only rejects a foreign Origin.
function originMatches(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const actor = (s: SessionInfo | null) =>
  s ? { sid: s.shortId, since: s.createdAt, ua: s.userAgent } : undefined;

export function createControlServer(
  deps: ControlDeps,
  opts: ControlServerOptions = {},
): Server {
  const now = opts.now ?? Date.now;
  const sessions = opts.sessions ?? createSessionStore(now);
  const backoff = opts.backoff ?? createBackoff(now);
  const hub = opts.hub ?? createEventHub();
  const credentials =
    opts.credentials ?? createCredentialSource(deps.credentialFile);
  const staticHandler = opts.staticHandler ?? serveStatic;
  const loginLimiter = createRateLimiter(LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS);
  const router = createRouter();
  const agentsDir = path.join(deps.repoRoot, '.claude', 'agents');
  const wardensDir = path.join(deps.repoRoot, '.claude', 'wardens');
  const firstPasswordFile = `${deps.credentialFile}.first-password`;

  // Rotation is detected here (every login and every authenticated request)
  // so a new password takes effect without restarting the assistant.
  const credentialState = () => {
    const state = credentials.current();
    if (state.rotated) {
      sessions.clear();
      backoff.reset();
      logger.warn(
        { event: 'control_ui_credential_rotated' },
        'Control UI credential rotated; all sessions revoked',
      );
    }
    return state;
  };

  router.add(
    'POST',
    '/auth/login',
    async (ctx) => {
      const key = ctx.remoteAddr;
      const wait = backoff.retryAfterMs(key);
      if (wait > 0 || loginLimiter.isRateLimited(key, now())) {
        logger.warn(
          {
            event: 'control_ui_login',
            remoteAddr: key,
            outcome: 'locked',
            retryAfterMs: wait,
          },
          'Control UI login refused (backoff)',
        );
        ctx.res.setHeader(
          'Retry-After',
          String(Math.ceil(Math.max(wait, 1000) / 1000)),
        );
        return writeJson(ctx.res, 429, {
          error: 'locked',
          retry_after_ms: wait,
        });
      }
      const state = credentialState();
      if (!state.ok) {
        logger.error(
          {
            event: 'control_ui_login',
            remoteAddr: key,
            outcome: 'credential_unavailable',
            reason: state.reason,
          },
          'Control UI login failed closed',
        );
        return writeJson(ctx.res, 503, { error: 'credential unavailable' });
      }
      const password = (ctx.body as { password?: unknown } | undefined)
        ?.password;
      const ok =
        typeof password === 'string' &&
        password.length > 0 &&
        (await verifyPassword(password, state.cred.scrypt));
      if (!ok) {
        backoff.recordFailure(key);
        logger.warn(
          { event: 'control_ui_login', remoteAddr: key, outcome: 'failed' },
          'Control UI login failed',
        );
        return writeJson(ctx.res, 401, { error: 'invalid password' });
      }
      backoff.recordSuccess(key);
      const session = sessions.create(header(ctx.req, 'user-agent') ?? '');
      fs.rmSync(firstPasswordFile, { force: true });
      logger.info(
        {
          event: 'control_ui_login',
          remoteAddr: key,
          outcome: 'ok',
          actor: {
            sid: crypto
              .createHash('sha256')
              .update(session.id)
              .digest('hex')
              .slice(0, 12),
          },
        },
        'Control UI login',
      );
      ctx.res.setHeader(
        'Set-Cookie',
        sessionCookie(session.id, isTls(ctx.req)),
      );
      writeJson(ctx.res, 200, {
        ok: true,
        token: session.secret,
        expiresAt: session.expiresAt,
      });
    },
    { auth: 'none' },
  );

  router.add('POST', '/auth/logout', (ctx) => {
    if (ctx.session) sessions.destroy(ctx.session.id);
    ctx.res.setHeader('Set-Cookie', clearSessionCookie(isTls(ctx.req)));
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  router.add('POST', '/auth/sessions/revoke-all', (ctx) => {
    if (header(ctx.req, 'x-confirm') !== 'all') {
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    }
    logger.warn(
      {
        event: 'control_ui_revoke_all',
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
        count: sessions.size(),
      },
      'Control UI sessions revoked',
    );
    sessions.clear();
    ctx.res.setHeader('Set-Cookie', clearSessionCookie(isTls(ctx.req)));
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  router.add('GET', '/api/v1/me', (ctx) =>
    writeJson(ctx.res, 200, {
      assistant: deps.assistantName,
      version: deps.version,
      read_only: deps.readOnly,
      session: { sid: ctx.session?.shortId, since: ctx.session?.createdAt },
    }),
  );
  router.add('GET', '/api/v1/agents', (ctx) =>
    writeJson(ctx.res, 200, listAgents(agentsDir)),
  );
  router.add('GET', '/api/v1/wardens', (ctx) =>
    writeJson(ctx.res, 200, listWardens(wardensDir)),
  );
  router.add('PATCH', '/api/v1/wardens/:name', (ctx) => {
    const enabled = (ctx.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') {
      return writeJson(ctx.res, 400, { error: 'enabled must be a boolean' });
    }
    const name = ctx.params.name;
    if (!NAME_RE.test(name))
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (!enabled && header(ctx.req, 'x-confirm') !== name) {
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    }
    const before = listWardens(wardensDir).find(
      (w) => w.name === name,
    )?.enabled;
    const info = setWardenEnabled(wardensDir, name, enabled);
    if (!info) return writeJson(ctx.res, 404, { error: 'not found' });
    logger.info(
      {
        event: 'control_ui_warden_toggle',
        warden: name,
        from: before,
        to: enabled,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI warden toggled',
    );
    hub.broadcast('warden', info);
    writeJson(ctx.res, 200, info);
  });
  router.add('GET', '/api/v1/mcps', (ctx) =>
    writeJson(ctx.res, 200, listMcps(deps.repoRoot, deps.envHas)),
  );
  router.add(
    'POST',
    '/api/v1/events/ticket',
    (ctx) => {
      const ticket = ctx.session ? sessions.issueTicket(ctx.session.id) : null;
      if (!ticket) return writeJson(ctx.res, 401, { error: 'unauthorized' });
      writeJson(ctx.res, 200, { ticket });
    },
    { mutation: false },
  );
  router.add(
    'GET',
    '/api/v1/events',
    (ctx) => {
      if (!hub.attach(ctx.req, ctx.res)) {
        writeJson(ctx.res, 503, { error: 'too many event streams' });
      }
    },
    { auth: 'ticket' },
  );

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://control');
    const method = req.method ?? 'GET';
    const remoteAddr = normalizeAddr(req.socket.remoteAddress);
    const isApi =
      url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/');

    if (!isApi) {
      if (method !== 'GET' && method !== 'HEAD') {
        return writeJson(res, 405, { error: 'method not allowed' });
      }
      return staticHandler(deps.webRoot, url.pathname, res);
    }

    const match = router.match(method, url.pathname);
    if (match.kind === 'not_found')
      return writeJson(res, 404, { error: 'not found' });
    if (match.kind === 'method_not_allowed') {
      return writeJson(res, 405, { error: 'method not allowed' });
    }

    let session: SessionInfo | null = null;
    if (match.auth !== 'none') {
      credentialState();
      const cookieId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      session =
        match.auth === 'ticket'
          ? sessions.redeemTicket(
              url.searchParams.get('ticket') ?? undefined,
              cookieId,
            )
          : sessions.validate(cookieId, header(req, SESSION_HEADER));
      if (!session) return writeJson(res, 401, { error: 'unauthorized' });
    }
    if (match.mutation && deps.readOnly && !url.pathname.startsWith('/auth/')) {
      return writeJson(res, 403, { error: 'read-only mode' });
    }

    let body: unknown;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!originMatches(req))
        return writeJson(res, 403, { error: 'forbidden' });
      const read = await readJsonBody(req);
      if (!read.ok) {
        if (read.status === 413) res.setHeader('Connection', 'close');
        return writeJson(res, read.status, {
          error: read.status === 413 ? 'payload too large' : 'invalid JSON',
        });
      }
      body = read.body;
    }

    const ctx: RequestContext = {
      req,
      res,
      url,
      params: match.params,
      body,
      remoteAddr,
      session,
    };
    await match.handler(ctx);
  }

  const server = createServer((req, res) => {
    // A client reset must never surface as an uncaught error in the host process.
    req.on('error', (err) =>
      logger.warn({ err }, 'Control UI request error (ignored)'),
    );
    res.on('error', (err) =>
      logger.warn({ err }, 'Control UI response error (ignored)'),
    );
    handle(req, res).catch((err: unknown) => {
      const nonce = crypto.randomBytes(4).toString('hex');
      logger.error({ err, nonce, path: req.url }, 'Control UI request failed');
      if (!res.headersSent)
        writeJson(res, 500, { error: 'internal error', nonce });
      else res.end();
    });
  });

  server.on('close', () => {
    loginLimiter.dispose();
    hub.close();
  });
  return server;
}

export function startControlServer(
  deps: Omit<ControlDeps, 'credentialFile' | 'readOnly'>,
): Promise<Server | undefined> {
  if (!CONTROL_UI_ENABLED) {
    logger.info('Control UI disabled (CONTROL_UI_ENABLED not set)');
    return Promise.resolve(undefined);
  }
  const loaded = loadCredentialFile(CONTROL_UI_CREDENTIAL_FILE);
  if (!loaded.ok) {
    logger.error(
      { reason: loaded.reason },
      'FATAL: CONTROL_UI_ENABLED=1 but the credential file is unusable. ' +
        'Refusing to start (never run open). Create it with: node scripts/control-ui-credential.mjs',
    );
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    const server = createControlServer({
      ...deps,
      credentialFile: CONTROL_UI_CREDENTIAL_FILE,
      readOnly: CONTROL_UI_READONLY,
    });
    server.on('error', (err: NodeJS.ErrnoException) => reject(err));
    server.listen(CONTROL_UI_PORT, BIND_HOST, () => {
      logger.info(
        {
          port: CONTROL_UI_PORT,
          host: BIND_HOST,
          readOnly: CONTROL_UI_READONLY,
        },
        'Control UI started',
      );
      resolve(server);
    });
  });
}
