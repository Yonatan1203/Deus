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
import { listChannels, whatsappQr } from './api/channels.js';
import { abortChatTurn, startChatTurn } from './api/chat.js';
import { listGroups, readClaudeMd, writeClaudeMd } from './api/groups.js';
import { listMcps } from './api/mcps.js';
import {
  memoryTree,
  readMemoryFile,
  writeMemoryFile,
  writePolicy,
  type RootName,
} from './api/memory.js';
import {
  containersForFolder,
  killSession,
  listSessions,
} from './api/sessions.js';
import {
  createTaskFromBody,
  listTasks,
  removeTask,
  runTaskNow,
  TASK_ID_RE,
  updateTaskFromBody,
} from './api/tasks.js';
import { listWardens, setWardenEnabled } from './api/wardens.js';
import type { WebTurnDeps } from '../web-turn.js';
import type { Channel } from '../types.js';
import type { ControlStore } from './store.js';
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
  /** Live host objects for chat/sessions/groups; absent → those routes answer 503. */
  runtime?: WebTurnDeps;
  store?: ControlStore;
  channels?: () => Channel[];
  /** Vault root for the Memory tab; null/absent → only the repo groups root. */
  vaultPath?: string | null;
  /** The WhatsApp adapter's auth dir (qr-data.txt lives in its parent). */
  whatsappAuthDir?: string;
}

export interface ControlServerOptions {
  sessions?: SessionStore;
  backoff?: Backoff;
  hub?: EventHub;
  credentials?: CredentialSource;
  now?: () => number;
  staticHandler?: typeof serveStatic;
  queuePollMs?: number;
}

const BIND_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 256 * 1024;
const LOGIN_RATE_MAX = 10;
const LOGIN_RATE_WINDOW_MS = 60_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TURN_ID_RE = /^[0-9a-f]{16}$/;
const CLAUDE_MD_MAX_BYTES = 1024 * 1024;
const CLAUDE_MD_BODY_CAP = Math.floor(CLAUDE_MD_MAX_BYTES * 1.5);
const CLAUDE_MD_WRITES_PER_MIN = 6;
const QUEUE_POLL_MS = 2000;
const TASK_MUTATIONS_PER_MIN = 6;
const TASK_CREATES_PER_SESSION = 50;
const ACTIVE_TASK_CAP = 100;
const SESSION_COUNTERS_MAX = 1000;
const MEMORY_WRITES_PER_MIN = 12;
const MEMORY_MAX_BYTES = 1024 * 1024;
const MEMORY_BODY_CAP = Math.floor(MEMORY_MAX_BYTES * 1.5);

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

function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY_BYTES,
): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
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
  const claudeMdLimiter = createRateLimiter(CLAUDE_MD_WRITES_PER_MIN, 60_000);
  const taskLimiter = createRateLimiter(TASK_MUTATIONS_PER_MIN, 60_000);
  const memoryLimiter = createRateLimiter(MEMORY_WRITES_PER_MIN, 60_000);
  // Creates per session; cleared with the session store, bounded so it cannot grow forever.
  const createCounts = new Map<string, number>();
  const bumpCreateCount = (sid: string): boolean => {
    const n = (createCounts.get(sid) ?? 0) + 1;
    if (n > TASK_CREATES_PER_SESSION) return false;
    if (!createCounts.has(sid) && createCounts.size >= SESSION_COUNTERS_MAX) {
      createCounts.delete(createCounts.keys().next().value as string);
    }
    createCounts.set(sid, n);
    return true;
  };
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
      createCounts.clear();
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
    createCounts.clear();
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

  // ── Phase 2: chat, sessions, groups (need the live host objects) ──
  const live = (
    res: ServerResponse,
  ): { runtime: WebTurnDeps; store: ControlStore } | null => {
    if (!deps.runtime || !deps.store) {
      writeJson(res, 503, { error: 'runtime unavailable' });
      return null;
    }
    return { runtime: deps.runtime, store: deps.store };
  };
  const folderOf = (store: ControlStore, folder: string): string | null => {
    try {
      store.groupFolderPath(folder);
      return folder;
    } catch {
      return null;
    }
  };

  router.add('POST', '/api/v1/chat/turns', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    const started = startChatTurn(l.runtime, ctx.body, ctx.remoteAddr, ctx.res);
    if ('status' in started)
      return writeJson(ctx.res, started.status, { error: started.error });
    logger.info(
      {
        event: 'control_ui_chat_turn',
        turnId: started.id,
        promptHash: started.promptHash,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI chat turn',
    );
  });
  router.add('DELETE', '/api/v1/chat/turns/:id', (ctx) => {
    if (!live(ctx.res)) return;
    const id = ctx.params.id;
    if (!TURN_ID_RE.test(id) || !abortChatTurn(id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    logger.info(
      {
        event: 'control_ui_chat_abort',
        turnId: id,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI chat turn stopped',
    );
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  router.add('GET', '/api/v1/sessions', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    const folders = [
      ...new Set(
        Object.values(l.runtime.registeredGroups()).map((g) => g.folder),
      ),
    ];
    const containers: Record<
      string,
      ReturnType<typeof containersForFolder>
    > = {};
    for (const f of folders) containers[f] = containersForFolder(l.runtime, f);
    writeJson(ctx.res, 200, {
      rows: listSessions(l.store, l.runtime),
      containers,
    });
  });
  router.add('POST', '/api/v1/sessions/:folder/kill', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    const folder = folderOf(l.store, ctx.params.folder);
    if (!folder) return writeJson(ctx.res, 404, { error: 'not found' });
    if (header(ctx.req, 'x-confirm') !== folder)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    const result = killSession(l.store, l.runtime, folder);
    if (!result) return writeJson(ctx.res, 404, { error: 'not found' });
    logger.warn(
      {
        event: 'control_ui_session_kill',
        folder,
        stopped: result.stopped,
        errors: result.errors,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI session killed',
    );
    hub.broadcast('session', { folder, ...result });
    writeJson(ctx.res, 200, result);
  });

  router.add('GET', '/api/v1/groups', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    writeJson(ctx.res, 200, listGroups(l.store, l.runtime));
  });
  router.add('GET', '/api/v1/groups/:folder/claude-md', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    const folder = folderOf(l.store, ctx.params.folder);
    const doc = folder ? readClaudeMd(l.store, l.runtime, folder) : null;
    if (!doc) return writeJson(ctx.res, 404, { error: 'not found' });
    writeJson(ctx.res, 200, doc);
  });
  router.add(
    'PUT',
    '/api/v1/groups/:folder/claude-md',
    (ctx) => {
      const l = live(ctx.res);
      if (!l) return;
      const folder = folderOf(l.store, ctx.params.folder);
      if (!folder) return writeJson(ctx.res, 404, { error: 'not found' });
      if (header(ctx.req, 'x-confirm') !== folder)
        return writeJson(ctx.res, 428, { error: 'confirmation required' });
      const content = (ctx.body as { content?: unknown } | undefined)?.content;
      if (typeof content !== 'string')
        return writeJson(ctx.res, 400, { error: 'content must be a string' });
      if (Buffer.byteLength(content) > CLAUDE_MD_MAX_BYTES)
        return writeJson(ctx.res, 413, { error: 'payload too large' });
      if (
        claudeMdLimiter.isRateLimited(
          ctx.session?.shortId ?? ctx.remoteAddr,
          now(),
        )
      ) {
        return writeJson(ctx.res, 429, { error: 'too many writes' });
      }
      const result = writeClaudeMd(l.store, l.runtime, folder, content);
      if (!result) return writeJson(ctx.res, 404, { error: 'not found' });
      logger.warn(
        {
          event: 'control_ui_claude_md_write',
          folder,
          ...result,
          remoteAddr: ctx.remoteAddr,
          actor: actor(ctx.session),
        },
        'Control UI wrote an instruction file',
      );
      hub.broadcast('group', { folder, ...result });
      writeJson(ctx.res, 200, result);
    },
    { maxBody: CLAUDE_MD_BODY_CAP },
  );

  // ── Phase 3: tasks, channels, memory ──
  const sid = (ctx: RequestContext) => ctx.session?.shortId ?? ctx.remoteAddr;

  router.add('GET', '/api/v1/tasks', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    writeJson(ctx.res, 200, listTasks(l.store));
  });
  router.add('POST', '/api/v1/tasks', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    if (taskLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many task changes' });
    if (
      l.store.getAllTasks().filter((t) => t.status === 'active').length >=
      ACTIVE_TASK_CAP
    ) {
      return writeJson(ctx.res, 429, { error: 'too many active tasks' });
    }
    if (!bumpCreateCount(sid(ctx)))
      return writeJson(ctx.res, 429, {
        error: 'task creation limit reached for this session',
      });
    const r = createTaskFromBody(l.store, l.runtime, ctx.body, now());
    if (!r.ok) return writeJson(ctx.res, r.status, { error: r.error });
    logger.warn(
      {
        event: 'control_ui_task_create',
        taskId: r.task.id,
        folder: r.task.group_folder,
        chat_jid: r.task.chat_jid,
        schedule_type: r.task.schedule_type,
        promptHash: crypto
          .createHash('sha256')
          .update(r.task.prompt)
          .digest('hex')
          .slice(0, 12),
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI created a scheduled task',
    );
    hub.broadcast('task', { id: r.task.id, action: 'created' });
    writeJson(ctx.res, 201, r.task);
  });
  router.add('PATCH', '/api/v1/tasks/:id', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    if (!TASK_ID_RE.test(ctx.params.id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    const before = l.store.getTaskById(ctx.params.id);
    const r = updateTaskFromBody(l.store, ctx.params.id, ctx.body, now());
    if (!r.ok) return writeJson(ctx.res, r.status, { error: r.error });
    logger.info(
      {
        event: 'control_ui_task_update',
        taskId: r.task.id,
        from: before && {
          status: before.status,
          schedule: `${before.schedule_type} ${before.schedule_value}`,
        },
        to: {
          status: r.task.status,
          schedule: `${r.task.schedule_type} ${r.task.schedule_value}`,
        },
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI updated a scheduled task',
    );
    hub.broadcast('task', { id: r.task.id, action: 'updated' });
    writeJson(ctx.res, 200, r.task);
  });
  router.add('POST', '/api/v1/tasks/:id/run', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    if (!TASK_ID_RE.test(ctx.params.id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (taskLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many task changes' });
    const r = runTaskNow(l.store, ctx.params.id, now());
    if (!r.ok) return writeJson(ctx.res, r.status, { error: r.error });
    logger.warn(
      {
        event: 'control_ui_task_run',
        taskId: ctx.params.id,
        chat_jid: r.chat_jid,
        promptHash: r.promptHash,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI queued a task to run now',
    );
    hub.broadcast('task', { id: ctx.params.id, action: 'run' });
    writeJson(ctx.res, 200, { next_run: r.next_run });
  });
  router.add('DELETE', '/api/v1/tasks/:id', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    const id = ctx.params.id;
    if (!TASK_ID_RE.test(id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (header(ctx.req, 'x-confirm') !== id)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (!removeTask(l.store, id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    logger.warn(
      {
        event: 'control_ui_task_delete',
        taskId: id,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI deleted a scheduled task',
    );
    hub.broadcast('task', { id, action: 'deleted' });
    ctx.res.writeHead(204);
    ctx.res.end();
  });
  router.add('GET', '/api/v1/tasks/:id/runs', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    if (!TASK_ID_RE.test(ctx.params.id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    const limit = Math.min(
      200,
      Math.max(
        1,
        parseInt(ctx.url.searchParams.get('limit') ?? '50', 10) || 50,
      ),
    );
    writeJson(ctx.res, 200, l.store.getTaskRunLogs(ctx.params.id, limit));
  });

  router.add('GET', '/api/v1/channels', (ctx) => {
    const l = live(ctx.res);
    if (!l) return;
    writeJson(
      ctx.res,
      200,
      listChannels({
        repoRoot: deps.repoRoot,
        envHas: deps.envHas,
        channels: deps.channels ?? (() => []),
        registeredGroups: l.runtime.registeredGroups,
        whatsappAuthDir:
          deps.whatsappAuthDir ?? path.join(deps.repoRoot, 'store', 'auth'),
      }),
    );
  });
  // Credential issuance: a mutation (read-only refuses it), typed confirmation, audited.
  router.add('POST', '/api/v1/channels/whatsapp/qr', async (ctx) => {
    if (header(ctx.req, 'x-confirm') !== 'whatsapp')
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    const r = await whatsappQr(
      deps.whatsappAuthDir ?? path.join(deps.repoRoot, 'store', 'auth'),
    );
    logger.warn(
      {
        event: 'control_ui_whatsapp_qr',
        served: 'qr' in r,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI WhatsApp pairing QR requested',
    );
    if ('status' in r)
      return writeJson(ctx.res, r.status, {
        error: r.status === 409 ? 'already paired' : 'no pairing QR available',
      });
    writeJson(ctx.res, 200, r);
  });

  const memoryRoots = () => ({
    vault: deps.readOnly ? null : (deps.vaultPath ?? null),
    groups: path.join(deps.repoRoot, 'groups'),
  });
  const rootParam = (v: string | null): RootName | null =>
    v === 'vault' || v === 'groups' ? v : null;
  router.add('GET', '/api/v1/memory/tree', (ctx) =>
    writeJson(ctx.res, 200, memoryTree(memoryRoots())),
  );
  router.add('GET', '/api/v1/memory/file', (ctx) => {
    const root = rootParam(ctx.url.searchParams.get('root'));
    const rel = ctx.url.searchParams.get('path') ?? '';
    const doc = root ? readMemoryFile(memoryRoots(), root, rel) : null;
    if (!doc) return writeJson(ctx.res, 404, { error: 'not found' });
    logger.info(
      {
        event: 'control_ui_memory_read',
        root,
        path: rel,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI read a memory file',
    );
    writeJson(ctx.res, 200, doc);
  });
  router.add(
    'PUT',
    '/api/v1/memory/file',
    (ctx) => {
      const b = (ctx.body ?? {}) as {
        root?: unknown;
        path?: unknown;
        content?: unknown;
      };
      const root = rootParam(typeof b.root === 'string' ? b.root : null);
      const rel = typeof b.path === 'string' ? b.path : '';
      if (!root || !rel)
        return writeJson(ctx.res, 400, { error: 'root and path are required' });
      if (header(ctx.req, 'x-confirm-edit') !== '1')
        return writeJson(ctx.res, 428, { error: 'confirmation required' });
      const policy = writePolicy(root, rel);
      if (policy === 'read_only')
        return writeJson(ctx.res, 403, {
          error: 'read-only from the dashboard',
        });
      if (policy === 'use_groups_route') {
        return writeJson(ctx.res, 409, {
          error: `use /api/v1/groups/${rel.split('/')[0]}/claude-md`,
        });
      }
      if (typeof b.content !== 'string')
        return writeJson(ctx.res, 400, { error: 'content must be a string' });
      if (Buffer.byteLength(b.content) > MEMORY_MAX_BYTES)
        return writeJson(ctx.res, 413, { error: 'payload too large' });
      if (memoryLimiter.isRateLimited(sid(ctx), now()))
        return writeJson(ctx.res, 429, { error: 'too many writes' });
      const result = writeMemoryFile(memoryRoots(), root, rel, b.content);
      if (!result) return writeJson(ctx.res, 404, { error: 'not found' });
      logger.warn(
        {
          event: 'control_ui_memory_write',
          root,
          path: rel,
          ...result,
          remoteAddr: ctx.remoteAddr,
          actor: actor(ctx.session),
        },
        'Control UI wrote a memory file',
      );
      hub.broadcast('memory', { root, path: rel });
      writeJson(ctx.res, 200, result);
    },
    { maxBody: MEMORY_BODY_CAP },
  );

  // Poll-and-diff: dashboards see container state change within one tick.
  let lastQueueJson = '';
  const queuePoll = setInterval(() => {
    if (!deps.runtime) return;
    const snap = deps.runtime.queue.snapshot();
    const json = JSON.stringify(snap);
    if (json === lastQueueJson) return;
    lastQueueJson = json;
    hub.broadcast('queue', snap);
  }, opts.queuePollMs ?? QUEUE_POLL_MS);
  queuePoll.unref();

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
      const read = await readJsonBody(req, match.maxBody);
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
    clearInterval(queuePoll);
    loginLimiter.dispose();
    claudeMdLimiter.dispose();
    taskLimiter.dispose();
    memoryLimiter.dispose();
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
