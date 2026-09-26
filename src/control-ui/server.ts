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
import { homeDir } from '../platform.js';
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
import {
  createBuildRunner,
  listContainers,
  stopContainer,
  type BuildRunner,
} from './api/containers.js';
import { createDockerRunner, type DockerRunner } from './api/docker.js';
import { containerLogs, queryLogs, redactSecrets } from './api/logs.js';
import { createConversationReader } from './api/claude-conversation.js';
import { readSlashCommands } from './api/claude-commands.js';
import { readSystem, type SystemView } from './api/system.js';
import { readConfig, writeConfig } from './api/config.js';
import {
  debugCounts,
  debugHealth,
  debugTrace,
  MESSAGE_ID_RE,
} from './api/debug.js';
import type { LogEntry, LogRing } from '../log-ring.js';
import { createHostCli, type HostCli } from './api/host-cli.js';
import { parsePreviewHosts } from './api/allowed-url.js';
import {
  capCheck,
  clearAttention,
  countActions,
  getAttention,
  JOB_ID_RE,
  lastActionAt,
  listJobs as listBrowserJobs,
  newJobId,
  paramsHash,
  readJob,
  readRules,
  sweepJobs,
  validateJob as validateBrowserJob,
  writeJob,
  writeRules,
  type JobRecord,
} from './api/browser-store.js';
import { getSite, JOB_KINDS, SITES, type JobKind } from '../browser/sites.js';
import {
  callbackPage,
  createGmailAuth,
  dirState as gmailDirState,
  ensureDir as ensureGmailDir,
  FLOW_COOKIE,
  gmailDir,
  saveKeys as saveGmailKeys,
  status as gmailStatus,
  validateKeysBody,
  type CallbackResult,
  type GmailAuthOptions,
} from './api/gmail-auth.js';
import {
  addArtifact,
  ARTIFACT_ID_RE,
  listArtifacts,
  removeArtifact,
  validateAddInput,
} from './api/artifacts.js';
import {
  archiveWorkflows,
  createDirWatcher,
  createWorkflowWatcher,
  listWorkflows,
  registryDirOk,
  WORKFLOW_ID_RE,
  type WorkflowWatcher,
} from './api/workflows.js';
import {
  CLAUDE_JOB_ID_RE,
  CLAUDE_NAME_RE,
  createLedger,
  createPins,
  createWaitingOnReader,
  listClaudeSessions,
  readLogs as readClaudeLogs,
  spawnEnv,
  transcriptPath,
  startClaudeSession,
  stopClaudeSession,
  validatePrompt,
  type ClaudeSession,
} from './api/claude-sessions.js';
import type { WebTurnDeps } from '../web-turn.js';
import {
  createLiveViews,
  INPUT_MAX_BYTES,
  resolveTmuxBin,
  type LiveViews,
} from './api/claude-live.js';
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
  /** Container runtime binary and this install's instance stamp (Phase 4). */
  bin?: string;
  instanceId?: string;
  /** In-process log ring; absent → the Logs tab has no host source. */
  logRing?: LogRing;
  /** `.env` path and the config dir holding its backups. */
  envPath?: string;
  configDir?: string;
  /** `CONTROL_UI_PREVIEW_HOSTS`, raw; parsed once here. */
  previewHosts?: string;
  /** `GMAIL_CREDENTIALS_DIR`, raw; defaults to `~/.gmail-mcp`. */
  gmailCredentialsDir?: string;
  /** The port the operator's tunnel maps — the OAuth redirect is built from it, never from Host. */
  publicPort?: number;
  startChannel?: (
    name: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  stopChannel?: (name: string) => Promise<boolean>;
  isChannelLive?: (name: string) => boolean;
  /** Claude Code CLI (absolute path, resolved at boot) and its projects dir; null → the Claude tab answers 503. */
  claudeBin?: string | null;
  claudeProjectsDir?: string;
}

export interface ControlServerOptions {
  sessions?: SessionStore;
  backoff?: Backoff;
  hub?: EventHub;
  credentials?: CredentialSource;
  now?: () => number;
  staticHandler?: typeof serveStatic;
  queuePollMs?: number;
  docker?: DockerRunner;
  buildRunner?: BuildRunner;
  systemPollMs?: number;
  logBatchMs?: number;
  hostCli?: HostCli;
  claudePollMs?: number;
  /** Live views; `null` disables them (tests pass a fake or null). */
  liveViews?: LiveViews | null;
  liveSweepMs?: number;
  workflowDebounceMs?: number;
  workflowPollMs?: number;
  browserPollMs?: number;
  browserSweepMs?: number;
  /** Construction-only test hooks for the Gmail flow (never from env or config). */
  gmailAuthOverrides?: Pick<
    GmailAuthOptions,
    'exchange' | 'profile' | 'revoke' | 'random' | 'sleep'
  >;
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
const CONFIG_WRITES_PER_MIN = 6;
const DOCKER_READS_PER_MIN = 30;
const SYSTEM_POLL_MS = 30_000;
const LOG_BATCH_MS = 500;
const LOG_BATCH_MAX = 100;
const CLAUDE_STARTS_PER_10MIN = 3;
const LIVE_OPENS_PER_MIN = 20;
const CLAUDE_PINS_PER_MIN = 30;
const LIVE_SWEEP_MS = 20_000;
const CLAUDE_READS_PER_MIN = 30;
// The conversation view polls every 1.5 s while it is showing.
const CLAUDE_CONV_READS_PER_MIN = 120;
const CLAUDE_STOPS_PER_MIN = 6;
const CLAUDE_LIVE_MAX = 3;
const CLAUDE_POLL_MS = 3000;
const CLAUDE_TAB_ACTIVE_MS = 60_000;
const WORKFLOW_READS_PER_MIN = 60;
const WORKFLOW_ARCHIVES_PER_MIN = 6;
const WORKFLOW_ARCHIVE_DAYS = 30;
const WORKFLOW_WATCH_DEBOUNCE_MS = 500;
const ARTIFACT_READS_PER_MIN = 60;
const ARTIFACT_WRITES_PER_MIN = 6;
const GMAIL_MUTATIONS_PER_MIN = 6;
const BROWSER_READS_PER_MIN = 60;
const BROWSER_MUTATIONS_PER_MIN = 12;
const BROWSER_POLL_MS = 30_000;
const BROWSER_SWEEP_MS = 60 * 60_000;
const GMAIL_CALLBACK_FAILS_PER_MIN = 10;
const GMAIL_KEYS_BODY_MAX = 16 * 1024;
const OAUTH_DONE_FALLBACK =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{{title}}</title></head>' +
  '<body><main><h1>{{message}}</h1><p><a href="/#/channels">Back to Channels</a></p></main></body></html>';

/** What a request log may carry about an error: never the object, whose
 *  `config`/`response` can hold a client secret or an authorization code. */
function safeError(err: unknown): {
  name?: string;
  code?: string;
  status?: number;
  message: string;
} {
  const e = err as {
    name?: unknown;
    code?: unknown;
    status?: unknown;
    message?: unknown;
  };
  const out: ReturnType<typeof safeError> = {
    message: redactSecrets(
      typeof e?.message === 'string' ? e.message.slice(0, 500) : String(err),
    ),
  };
  if (typeof e?.name === 'string') out.name = e.name;
  if (typeof e?.code === 'string' || typeof e?.code === 'number')
    out.code = String(e.code);
  if (typeof e?.status === 'number') out.status = e.status;
  return out;
}
const pathOnly = (url: string | undefined): string => (url ?? '').split('?')[0];

/** Hostname for audit lines; the full URL never reaches a log. */
function safeHostname(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
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

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1']);
export function hostAllowed(
  host: string | undefined,
  localPort: number | undefined,
  publicPort: number | undefined,
): boolean {
  if (!host) return false;
  const m = /^([a-z0-9.]+):(\d{1,5})$/i.exec(host.trim());
  if (!m || !LOOPBACK_NAMES.has(m[1].toLowerCase())) return false;
  const port = Number(m[2]);
  return (
    port === localPort || (publicPort !== undefined && port === publicPort)
  );
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
  const configLimiter = createRateLimiter(CONFIG_WRITES_PER_MIN, 60_000);
  const dockerReadLimiter = createRateLimiter(DOCKER_READS_PER_MIN, 60_000);
  const docker = opts.docker ?? createDockerRunner(deps.bin ?? 'docker');
  const claudeStartLimiter = createRateLimiter(
    CLAUDE_STARTS_PER_10MIN,
    600_000,
  );
  const liveOpenLimiter = createRateLimiter(LIVE_OPENS_PER_MIN, 60_000);
  const claudePinLimiter = createRateLimiter(CLAUDE_PINS_PER_MIN, 60_000);
  const claudeReadLimiter = createRateLimiter(CLAUDE_READS_PER_MIN, 60_000);
  const claudeConvLimiter = createRateLimiter(
    CLAUDE_CONV_READS_PER_MIN,
    60_000,
  );
  const claudeStopLimiter = createRateLimiter(CLAUDE_STOPS_PER_MIN, 60_000);
  const workflowReadLimiter = createRateLimiter(WORKFLOW_READS_PER_MIN, 60_000);
  const workflowArchiveLimiter = createRateLimiter(
    WORKFLOW_ARCHIVES_PER_MIN,
    60_000,
  );
  const gmailLimiter = createRateLimiter(GMAIL_MUTATIONS_PER_MIN, 60_000);
  const browserReadLimiter = createRateLimiter(BROWSER_READS_PER_MIN, 60_000);
  const browserWriteLimiter = createRateLimiter(
    BROWSER_MUTATIONS_PER_MIN,
    60_000,
  );
  const gmailCallbackLimiter = createRateLimiter(
    GMAIL_CALLBACK_FAILS_PER_MIN,
    60_000,
  );
  const artifactReadLimiter = createRateLimiter(ARTIFACT_READS_PER_MIN, 60_000);
  const artifactWriteLimiter = createRateLimiter(
    ARTIFACT_WRITES_PER_MIN,
    60_000,
  );
  const claudeCli: HostCli | null =
    opts.hostCli ??
    (deps.claudeBin
      ? createHostCli(deps.claudeBin, {
          cwd: deps.repoRoot,
          env: spawnEnv(process.env),
        })
      : null);
  // The same attach the operator's terminal uses, relayed to one browser.
  const tmuxBin = resolveTmuxBin();
  const liveViews: LiveViews | null =
    opts.liveViews !== undefined
      ? opts.liveViews
      : deps.claudeBin && tmuxBin
        ? createLiveViews({
            tmuxBin,
            // A second process on this host (a verification fixture) sets its
            // own socket so it can never close the operator's open views.
            socket: process.env.CONTROL_UI_TMUX_SOCKET || undefined,
            claudeBin: deps.claudeBin,
            cwd: deps.repoRoot,
            env: spawnEnv(process.env),
            audit: (event, fields) =>
              logger.warn({ event, ...fields }, 'Control UI live view'),
          })
        : null;
  // Leftovers from a previous process on the private socket.
  if (liveViews && opts.liveViews === undefined) void liveViews.killLeftovers();
  const claudePins = deps.configDir
    ? createPins(path.join(deps.configDir, 'control-ui', 'claude-pins.json'))
    : null;
  const claudeLedger = deps.configDir
    ? createLedger(
        path.join(deps.configDir, 'control-ui', 'claude-started.json'),
      )
    : null;
  const readConversation = deps.claudeProjectsDir
    ? createConversationReader(deps.claudeProjectsDir)
    : null;
  const waitingOn = deps.claudeProjectsDir
    ? createWaitingOnReader(deps.claudeProjectsDir)
    : undefined;
  const instanceId = deps.instanceId ?? '';
  const build =
    opts.buildRunner ?? createBuildRunner({ repoRoot: deps.repoRoot, hub });
  // First-read audits, once per session per source; bounded like createCounts.
  const readAudits = new Map<string, Set<string>>();
  const auditRead = (
    session: SessionInfo | null,
    key: string,
    event: string,
    remoteAddr: string,
  ) => {
    const sid = session?.shortId ?? '';
    let seen = readAudits.get(sid);
    if (!seen) {
      if (readAudits.size >= SESSION_COUNTERS_MAX)
        readAudits.delete(readAudits.keys().next().value as string);
      seen = new Set();
      readAudits.set(sid, seen);
    }
    if (seen.has(key)) return;
    seen.add(key);
    logger.info(
      { event, source: key, remoteAddr, actor: actor(session) },
      'Control UI read',
    );
  };
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
      liveViews?.closeAll('credential-rotated');
      sessions.clear();
      gmailAuth.dropAll();
      createCounts.clear();
      readAudits.clear();
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
    if (ctx.session) {
      liveViews?.closeOwner(ctx.session.id, 'logout');
      sessions.destroy(ctx.session.id);
      gmailAuth.dropSession(ctx.session.id);
    }
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
    liveViews?.closeAll('revoked');
    sessions.clear();
    gmailAuth.dropAll();
    createCounts.clear();
    readAudits.clear();
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

  // ---- Phase 4: containers, logs, system, config, debug --------------------
  const dockerRead = (ctx: RequestContext): boolean => {
    if (
      dockerReadLimiter.isRateLimited(
        ctx.session?.shortId ?? ctx.remoteAddr,
        now(),
      )
    ) {
      writeJson(ctx.res, 429, { error: 'too many runtime reads' });
      return false;
    }
    return true;
  };
  const snapshot = () => deps.runtime?.queue.snapshot() ?? [];
  const containerDeps = () => ({ docker, instanceId, snapshot });

  router.add('GET', '/api/v1/containers', async (ctx) => {
    if (!dockerRead(ctx)) return;
    writeJson(ctx.res, 200, await listContainers(containerDeps()));
  });
  router.add('POST', '/api/v1/containers/rebuild', async (ctx) => {
    if (header(ctx.req, 'x-confirm') !== 'rebuild')
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    const r = await build.start();
    if (r === 'unsupported')
      return writeJson(ctx.res, 501, { error: 'rebuild needs a POSIX host' });
    if (r === 'running')
      return writeJson(ctx.res, 409, { error: 'a build is already running' });
    const st = build.status();
    logger.warn(
      {
        event: 'control_ui_container_rebuild',
        image_ref: st.image_ref,
        head: st.head,
        dirty: st.dirty,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI started an image rebuild',
    );
    writeJson(ctx.res, 200, {
      started: true,
      image_ref: st.image_ref,
      head: st.head,
      dirty: st.dirty,
    });
  });
  router.add('GET', '/api/v1/containers/build', (ctx) => {
    writeJson(ctx.res, 200, build.status());
  });
  router.add('POST', '/api/v1/containers/:name/stop', async (ctx) => {
    const name = ctx.params.name;
    if (header(ctx.req, 'x-confirm') !== name)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    const r = await stopContainer(containerDeps(), name);
    if ('status' in r) {
      logger.warn(
        {
          event: 'control_ui_container_stop_refused',
          name: name.slice(0, 128),
          remoteAddr: ctx.remoteAddr,
          actor: actor(ctx.session),
        },
        'Control UI refused a container stop',
      );
      return writeJson(ctx.res, 404, { error: 'not found' });
    }
    if ('error' in r) return writeJson(ctx.res, 502, { error: r.error });
    logger.warn(
      {
        event: 'control_ui_container_stop',
        name,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI stopped a container',
    );
    hub.broadcast('container', { name, action: 'stopped' });
    writeJson(ctx.res, 200, r);
  });

  router.add('GET', '/api/v1/logs', async (ctx) => {
    const source = ctx.url.searchParams.get('source') ?? 'host';
    if (source.startsWith('container:')) {
      if (deps.readOnly)
        return writeJson(ctx.res, 403, {
          error: 'read-only from the dashboard',
        });
      if (!dockerRead(ctx)) return;
      const r = await containerLogs(
        docker,
        source.slice('container:'.length),
        ctx.url.searchParams.get('lines'),
        instanceId,
      );
      if ('status' in r) return writeJson(ctx.res, 404, { error: 'not found' });
      if ('error' in r) return writeJson(ctx.res, 502, { error: r.error });
      auditRead(
        ctx.session,
        `logs:${source}`,
        'control_ui_logs_read',
        ctx.remoteAddr,
      );
      return writeJson(ctx.res, 200, { source, lines: r.lines });
    }
    if (source !== 'host')
      return writeJson(ctx.res, 400, { error: 'unknown source' });
    if (!deps.logRing)
      return writeJson(ctx.res, 503, { error: 'host logs unavailable' });
    auditRead(ctx.session, 'logs:host', 'control_ui_logs_read', ctx.remoteAddr);
    writeJson(ctx.res, 200, {
      source,
      entries: queryLogs(deps.logRing, {
        level: ctx.url.searchParams.get('level') ?? undefined,
        q: ctx.url.searchParams.get('q') ?? undefined,
        lines: ctx.url.searchParams.get('lines'),
        readOnly: deps.readOnly,
      }),
    });
  });
  router.add('GET', '/api/v1/logs/export', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (!deps.logRing)
      return writeJson(ctx.res, 503, { error: 'host logs unavailable' });
    const entries = queryLogs(deps.logRing, {
      level: ctx.url.searchParams.get('level') ?? undefined,
      q: ctx.url.searchParams.get('q') ?? undefined,
      lines: 1000,
    }) as LogEntry[];
    logger.info(
      {
        event: 'control_ui_logs_export',
        count: entries.length,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI exported host logs',
    );
    ctx.res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="deus-control-logs.txt"',
    });
    ctx.res.end(entries.map((e) => e.line).join('\n') + '\n');
  });

  router.add('GET', '/api/v1/system', async (ctx) => {
    if (!dockerRead(ctx)) return;
    writeJson(
      ctx.res,
      200,
      await readSystem({
        repoRoot: deps.repoRoot,
        docker,
        version: deps.version,
      }),
    );
  });

  router.add('GET', '/api/v1/config', (ctx) => {
    if (!deps.envPath)
      return writeJson(ctx.res, 503, { error: 'config unavailable' });
    auditRead(ctx.session, 'config', 'control_ui_config_read', ctx.remoteAddr);
    writeJson(
      ctx.res,
      200,
      readConfig({
        envPath: deps.envPath,
        processEnv: process.env,
        readOnly: deps.readOnly,
      }),
    );
  });
  router.add('PATCH', '/api/v1/config', async (ctx) => {
    if (!deps.envPath || !deps.configDir)
      return writeJson(ctx.res, 503, { error: 'config unavailable' });
    const body = (ctx.body ?? {}) as { key?: unknown; value?: unknown };
    const key = typeof body.key === 'string' ? body.key : '';
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key))
      return writeJson(ctx.res, 400, { error: 'invalid key' });
    if (header(ctx.req, 'x-confirm') !== key)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (
      configLimiter.isRateLimited(ctx.session?.shortId ?? ctx.remoteAddr, now())
    )
      return writeJson(ctx.res, 429, { error: 'too many config writes' });
    const r = await writeConfig(
      {
        envPath: deps.envPath,
        backupDir: path.join(deps.configDir, 'control-ui', 'env-backups'),
        projectRoot: deps.repoRoot,
      },
      key,
      body.value,
    );
    if ('status' in r) return writeJson(ctx.res, r.status, { error: r.error });
    logger.warn(
      {
        event: 'control_ui_config_write',
        key,
        backup: r.backup,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI changed a config key (restart required)',
    );
    writeJson(ctx.res, 200, { restart_required: true, key, backup: r.backup });
  });

  const debugDeps = () => ({
    docker,
    store: deps.store,
    runtime: deps.runtime,
    channels: deps.channels,
    hub,
    buildRunning: () => build.status().running,
  });
  router.add('GET', '/api/v1/debug/health', async (ctx) => {
    writeJson(ctx.res, 200, await debugHealth(debugDeps()));
  });
  router.add('GET', '/api/v1/debug/counts', (ctx) => {
    writeJson(ctx.res, 200, debugCounts(debugDeps()));
  });
  router.add('GET', '/api/v1/debug/events', (ctx) => {
    writeJson(ctx.res, 200, { events: hub.recent(50) });
  });
  router.add('GET', '/api/v1/debug/trace', (ctx) => {
    const id = ctx.url.searchParams.get('message_id') ?? '';
    if (!MESSAGE_ID_RE.test(id) || id.includes('..'))
      return writeJson(ctx.res, 400, { error: 'invalid message id' });
    writeJson(ctx.res, 200, debugTrace(debugDeps(), id));
  });

  // System poll: only while someone is watching; `alert` on a rising edge.
  let lastAlert: SystemView['alert'] | undefined;
  const systemPoll = setInterval(() => {
    if (hub.clientCount() === 0) return;
    readSystem({ repoRoot: deps.repoRoot, docker, version: deps.version })
      .then((sys) => {
        hub.broadcast('system', sys);
        if (sys.alert && sys.alert !== lastAlert)
          hub.broadcast('alert', { kind: sys.alert, disk: sys.disk });
        lastAlert = sys.alert;
      })
      .catch(() => {});
  }, opts.systemPollMs ?? SYSTEM_POLL_MS);
  systemPoll.unref();

  // Host log follow: batched, capped, never for the read-only viewer, and
  // never carrying the dashboard's own audit lines (a write error that gets
  // logged would otherwise feed straight back into the stream).
  let logBatch: LogEntry[] = [];
  let logDropped = 0;
  let logTimer: ReturnType<typeof setInterval> | undefined;
  let unsubscribeLog: (() => void) | undefined;
  if (deps.logRing && !deps.readOnly) {
    unsubscribeLog = deps.logRing.onEntry((e) => {
      if (hub.clientCount() === 0) return;
      if (String(e.fields.event ?? '').startsWith('control_ui_')) return;
      if (logBatch.length >= LOG_BATCH_MAX) logDropped++;
      else logBatch.push(e);
    });
    logTimer = setInterval(() => {
      if (logBatch.length === 0) return;
      const entries = logBatch.map((e) => ({
        ...e,
        msg: redactSecrets(e.msg),
        line: redactSecrets(e.line),
      }));
      const dropped = logDropped;
      logBatch = [];
      logDropped = 0;
      hub.broadcast('log', { entries, dropped });
    }, opts.logBatchMs ?? LOG_BATCH_MS);
    logTimer.unref();
  }

  // ---- Claude Code sessions ------------------------------------------------
  // The CLI's output is untrusted input: rows are filtered on realpath(cwd),
  // ids are parsed structurally, kind/resumable are re-checked per route, and
  // a failed list is never an empty list.
  let claudeTabSeen = 0;
  let claudeListCache: { at: number; sessions: ClaudeSession[] } | null = null;
  let claudeLastDropped = -1;
  const claudeUnavailable = (res: ServerResponse) =>
    writeJson(res, 503, {
      error: claudeCli ? 'session list unavailable' : 'claude CLI not found',
    });
  const claudeList = async (fresh: boolean) => {
    if (!claudeCli) return { error: 'claude CLI not found' } as const;
    if (
      !fresh &&
      claudeListCache &&
      now() - claudeListCache.at < CLAUDE_POLL_MS
    )
      return { sessions: claudeListCache.sessions, dropped: 0 };
    const r = await listClaudeSessions(claudeCli, deps.repoRoot, {
      waitingOn,
    });
    if ('sessions' in r) {
      claudeListCache = { at: now(), sessions: r.sessions };
      const listed = new Set(r.sessions.map((s) => s.id));
      claudeLedger?.prune(listed); // only after a successful list
      claudePins?.prune(listed);
      if (r.dropped !== claudeLastDropped) {
        // Rows outside this repo are filtered on realpath(cwd); the count is
        // the only trace that another instance's sessions were seen.
        claudeLastDropped = r.dropped;
        logger.info(
          { event: 'control_ui_claude_dropped', dropped: r.dropped },
          'Control UI filtered sessions outside the repo',
        );
      }
    }
    return r;
  };
  const claudeRefused = (ctx: RequestContext, id: string, reason: string) =>
    logger.warn(
      {
        event: 'control_ui_claude_refused',
        id: id.slice(0, 64),
        reason,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI refused a Claude session action',
    );
  // Resolves :id through a fresh list; answers the response itself on failure.
  const claudeRow = async (
    ctx: RequestContext,
  ): Promise<ClaudeSession | null> => {
    const id = ctx.params.id;
    if (!CLAUDE_JOB_ID_RE.test(id)) {
      claudeRefused(ctx, id, 'invalid_id');
      writeJson(ctx.res, 404, { error: 'not found' });
      return null;
    }
    const r = await claudeList(true);
    if (!('sessions' in r)) {
      claudeRefused(ctx, id, 'list_unavailable');
      claudeUnavailable(ctx.res);
      return null;
    }
    const row = r.sessions.find((s) => s.id === id);
    if (!row) {
      claudeRefused(ctx, id, 'not_listed');
      writeJson(ctx.res, 404, { error: 'not found' });
    }
    return row ?? null;
  };
  const claudeRead = (ctx: RequestContext): boolean => {
    if (
      claudeReadLimiter.isRateLimited(
        ctx.session?.shortId ?? ctx.remoteAddr,
        now(),
      )
    ) {
      writeJson(ctx.res, 429, { error: 'too many session reads' });
      return false;
    }
    return true;
  };

  router.add('GET', '/api/v1/claude/sessions', async (ctx) => {
    if (!claudeRead(ctx)) return;
    claudeTabSeen = now();
    if (!claudeCli)
      return writeJson(ctx.res, 200, {
        sessions: [],
        unavailable: true,
        error: 'claude CLI not found',
      });
    const r = await claudeList(false);
    if (!('sessions' in r))
      return writeJson(ctx.res, 200, {
        sessions: [],
        unavailable: true,
        error: redactSecrets(r.error).slice(0, 200),
      });
    const started = new Set((claudeLedger?.read() ?? []).map((e) => e.id));
    const pinned = new Set(claudePins?.read() ?? []);
    // "Last active" is the conversation file's mtime: the list itself only
    // carries a start time.
    const lastActive = (sessionId: string | null): number | null => {
      if (!sessionId || !deps.claudeProjectsDir) return null;
      const file = transcriptPath(deps.claudeProjectsDir, sessionId);
      if (!file) return null;
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return null;
      }
    };
    writeJson(ctx.res, 200, {
      sessions: r.sessions.map((s) => ({
        ...s,
        started_here: started.has(s.id),
        pinned: pinned.has(s.id),
        last_active: lastActive(s.session_id),
      })),
      live: Boolean(liveViews) && !deps.readOnly,
    });
  });
  router.add('GET', '/api/v1/claude/sessions/:id/logs', async (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (!claudeRead(ctx)) return;
    const row = await claudeRow(ctx);
    if (!row || !claudeCli) return;
    const r = await readClaudeLogs(claudeCli, row.id);
    if ('error' in r) return writeJson(ctx.res, 502, { error: r.error });
    auditRead(
      ctx.session,
      `claude-logs:${row.id}`,
      'control_ui_claude_read',
      ctx.remoteAddr,
    );
    writeJson(ctx.res, 200, r);
  });
  router.add('POST', '/api/v1/claude/sessions', async (ctx) => {
    if (header(ctx.req, 'x-confirm') !== 'start')
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (!claudeCli) return claudeUnavailable(ctx.res);
    const body = (ctx.body ?? {}) as { name?: unknown; prompt?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prompt = validatePrompt(body.prompt);
    // Validated before the limiter so invalid input never spends budget.
    if (!CLAUDE_NAME_RE.test(name) || prompt === null)
      return writeJson(ctx.res, 400, { error: 'name and prompt are required' });
    if (claudeStartLimiter.isRateLimited('global', now()))
      return writeJson(ctx.res, 429, { error: 'too many session starts' });
    const ledgerRaw = claudeLedger ? claudeLedger.read() : [];
    if (ledgerRaw === null)
      return writeJson(ctx.res, 409, {
        error: 'live-session ledger unreadable',
      });
    const ledger = ledgerRaw;
    const listed = await claudeList(true);
    if (!('sessions' in listed)) return claudeUnavailable(ctx.res);
    const live = listed.sessions.filter(
      (s) => s.state === 'working' && ledger.some((e) => e.id === s.id),
    ).length;
    if (live >= CLAUDE_LIVE_MAX)
      return writeJson(ctx.res, 409, {
        error: `${live} dashboard-started sessions are already working`,
        live,
      });
    const promptHash = crypto
      .createHash('sha256')
      .update(prompt)
      .digest('hex')
      .slice(0, 12);
    const r = await startClaudeSession(claudeCli, name, prompt);
    if ('error' in r)
      return writeJson(ctx.res, r.error.startsWith('invalid') ? 400 : 502, {
        error: r.error,
      });
    if ('unparsed' in r) {
      logger.warn(
        {
          event: 'control_ui_claude_start_unparsed',
          name,
          promptHash,
          stdout: r.stdout,
          remoteAddr: ctx.remoteAddr,
          actor: actor(ctx.session),
        },
        'Control UI started a Claude session but could not parse its id',
      );
      return writeJson(ctx.res, 502, {
        error: 'could not determine the session id',
      });
    }
    const after = await claudeList(true);
    const row =
      'sessions' in after
        ? after.sessions.find((s) => s.id === r.id)
        : undefined;
    logger.warn(
      {
        event: 'control_ui_claude_start',
        name,
        promptHash,
        id: r.id,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI started a Claude session',
    );
    if (
      claudeLedger &&
      !claudeLedger.add({ id: r.id, started_at: row?.started_at ?? now() })
    )
      return writeJson(ctx.res, 500, {
        error: 'ledger write failed',
        id: r.id,
      });
    hub.broadcast('csession', { action: 'started', id: r.id });
    writeJson(ctx.res, 200, { started: true, id: r.id });
  });
  // ---- Live views -----------------------------------------------------------
  // Read-only gets no live screen, matching the rule that it never gets the
  // host log follow; every live route refuses it explicitly (the stream is a
  // GET, so the dispatcher's mutation check alone would not).
  const liveGate = (ctx: RequestContext): LiveViews | null => {
    if (deps.readOnly) {
      writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
      return null;
    }
    if (!liveViews) {
      writeJson(ctx.res, 503, { error: 'live view needs tmux on the server' });
      return null;
    }
    return liveViews;
  };
  router.add(
    'POST',
    '/api/v1/claude/live',
    async (ctx) => {
      const lv = liveGate(ctx);
      if (!lv || !ctx.session) return;
      if (liveOpenLimiter.isRateLimited(ctx.session.shortId, now()))
        return writeJson(ctx.res, 429, { error: 'too many live views opened' });
      const body = (ctx.body ?? {}) as {
        id?: unknown;
        cols?: unknown;
        rows?: unknown;
      };
      ctx.params.id = typeof body.id === 'string' ? body.id : '';
      const row = await claudeRow(ctx);
      if (!row) return;
      if (row.kind !== 'background')
        return writeJson(ctx.res, 409, {
          error: 'only background sessions can be opened here',
        });
      const r = await lv.open(ctx.session.id, row.id, body.cols, body.rows);
      if (!r.ok) return writeJson(ctx.res, r.status, { error: r.error });
      writeJson(ctx.res, 200, { vid: r.vid });
    },
    { maxBody: 1024 },
  );
  router.add(
    'GET',
    '/api/v1/claude/live/:vid/stream',
    (ctx) => {
      const lv = liveGate(ctx);
      if (!lv || !ctx.session) return;
      if (!lv.attachStream(ctx.params.vid, ctx.session.id, ctx.res))
        writeJson(ctx.res, 403, { error: 'not your view' });
    },
    { auth: 'ticket' },
  );
  router.add(
    'POST',
    '/api/v1/claude/live/:vid/input',
    (ctx) => {
      const lv = liveGate(ctx);
      if (!lv || !ctx.session) return;
      const data = (ctx.body as { data?: unknown } | undefined)?.data;
      if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
        return writeJson(ctx.res, 400, { error: 'invalid input' });
      const bytes = Buffer.from(data, 'base64');
      const r = lv.input(ctx.params.vid, ctx.session.id, bytes);
      if (!r.ok) return writeJson(ctx.res, r.status, { error: r.error });
      ctx.res.writeHead(204);
      ctx.res.end();
    },
    { maxBody: Math.ceil((INPUT_MAX_BYTES * 4) / 3) + 256 },
  );
  router.add(
    'POST',
    '/api/v1/claude/live/:vid/resize',
    (ctx) => {
      const lv = liveGate(ctx);
      if (!lv || !ctx.session) return;
      const b = (ctx.body ?? {}) as { cols?: unknown; rows?: unknown };
      const r = lv.resize(ctx.params.vid, ctx.session.id, b.cols, b.rows);
      if (!r.ok) return writeJson(ctx.res, r.status, { error: r.error });
      ctx.res.writeHead(204);
      ctx.res.end();
    },
    { maxBody: 256 },
  );
  router.add('DELETE', '/api/v1/claude/live/:vid', (ctx) => {
    const lv = liveGate(ctx);
    if (!lv || !ctx.session) return;
    if (!lv.closeOwned(ctx.params.vid, ctx.session.id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    ctx.res.writeHead(204);
    ctx.res.end();
  });
  // The open view's session as a conversation. Keyed by the view, so only the
  // login that opened it can read it, and resolved through the cached session
  // list, so polling never runs the CLI and a /clear is followed.
  router.add('GET', '/api/v1/claude/live/:vid/conversation', async (ctx) => {
    const lv = liveGate(ctx);
    if (!lv || !ctx.session) return;
    const m = lv.meta(ctx.params.vid);
    if (!m || m.owner !== ctx.session.id)
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (claudeConvLimiter.isRateLimited(ctx.session.shortId, now()))
      return writeJson(ctx.res, 429, { error: 'too many reads' });
    const list = await claudeList(false);
    const row =
      'sessions' in list
        ? list.sessions.find((s) => s.id === m.claudeId)
        : undefined;
    const read =
      row?.session_id && readConversation
        ? readConversation(row.session_id)
        : null;
    if (!read) return writeJson(ctx.res, 404, { error: 'no conversation' });
    auditRead(
      ctx.session,
      `claude-conversation:${m.claudeId}`,
      'control_ui_claude_read',
      ctx.remoteAddr,
    );
    if (ctx.url.searchParams.get('v') === read.version)
      return writeJson(ctx.res, 200, {
        unchanged: true,
        version: read.version,
      });
    writeJson(ctx.res, 200, { version: read.version, ...read.conv });
  });
  router.add('GET', '/api/v1/claude/commands', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (!claudeRead(ctx)) return;
    writeJson(ctx.res, 200, {
      commands: readSlashCommands(deps.repoRoot, homeDir),
    });
  });
  // Ends views whose login is gone (expiry, revocation) or whose browser left.
  // Checking rotation here means it does not wait for the next request.
  const liveSweep = setInterval(() => {
    if (!liveViews || liveViews.size() === 0) return;
    credentialState();
    liveViews.sweep((owner) => sessions.isLive(owner));
  }, opts.liveSweepMs ?? LIVE_SWEEP_MS);
  liveSweep.unref();

  // Pinning is harmless and reversible, so it takes no typed confirmation.
  router.add(
    'PUT',
    '/api/v1/claude/sessions/:id/pin',
    async (ctx) => {
      if (!claudePins)
        return writeJson(ctx.res, 503, { error: 'pins unavailable' });
      const want = (ctx.body as { pinned?: unknown } | undefined)?.pinned;
      if (typeof want !== 'boolean')
        return writeJson(ctx.res, 400, {
          error: 'pinned must be true or false',
        });
      if (
        claudePinLimiter.isRateLimited(
          ctx.session?.shortId ?? ctx.remoteAddr,
          now(),
        )
      )
        return writeJson(ctx.res, 429, { error: 'too many changes' });
      const row = await claudeRow(ctx);
      if (!row) return;
      if (!claudePins.set(row.id, want))
        return writeJson(ctx.res, 503, { error: 'pins unavailable' });
      hub.broadcast('csession', {
        action: want ? 'pinned' : 'unpinned',
        id: row.id,
      });
      writeJson(ctx.res, 200, { pinned: want });
    },
    { maxBody: 256 },
  );
  router.add('POST', '/api/v1/claude/sessions/:id/stop', async (ctx) => {
    if (header(ctx.req, 'x-confirm') !== ctx.params.id)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (
      claudeStopLimiter.isRateLimited(
        ctx.session?.shortId ?? ctx.remoteAddr,
        now(),
      )
    )
      return writeJson(ctx.res, 429, { error: 'too many stops' });
    const row = await claudeRow(ctx);
    if (!row || !claudeCli) return;
    if (row.kind !== 'background') {
      claudeRefused(ctx, row.id, 'interactive');
      return writeJson(ctx.res, 409, {
        error: 'interactive sessions are stopped from the terminal',
      });
    }
    const r = await stopClaudeSession(claudeCli, row.id);
    if ('error' in r) return writeJson(ctx.res, 502, { error: r.error });
    logger.warn(
      {
        event: 'control_ui_claude_stop',
        id: row.id,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI stopped a Claude session',
    );
    await claudeList(true);
    hub.broadcast('csession', { action: 'stopped', id: row.id });
    writeJson(ctx.res, 200, r);
  });

  // Workflow registry: records written by scripts/workflow.mjs under CONFIG_DIR.
  // The dir is created here (0700) so the watcher can start before the first
  // record; a symlinked or non-directory path refuses to list and to watch.
  const workflowDir = deps.configDir
    ? path.join(deps.configDir, 'control-ui', 'workflows')
    : null;
  const previewHosts = parsePreviewHosts(deps.previewHosts);
  if (workflowDir) {
    try {
      fs.mkdirSync(workflowDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Control UI could not create the workflow registry',
      );
    }
  }
  const workflowList = () =>
    workflowDir
      ? listWorkflows(workflowDir, {
          readOnly: deps.readOnly,
          hosts: previewHosts,
          now,
        })
      : ({ error: 'registry unavailable' } as const);
  router.add('GET', '/api/v1/workflows', (ctx) => {
    if (workflowReadLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many requests' });
    const r = workflowList();
    if ('error' in r) return writeJson(ctx.res, 503, { error: r.error });
    writeJson(ctx.res, 200, r);
  });
  router.add('POST', '/api/v1/workflows/archive', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (header(ctx.req, 'x-confirm') !== 'archive')
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    const body = (ctx.body ?? {}) as { id?: unknown };
    // The only browser string that reaches a path: shape-checked here, before
    // the limiter and before anything is joined.
    if (
      body.id !== undefined &&
      (typeof body.id !== 'string' || !WORKFLOW_ID_RE.test(body.id))
    )
      return writeJson(ctx.res, 400, { error: 'invalid id' });
    if (workflowArchiveLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many archive requests' });
    if (!workflowDir)
      return writeJson(ctx.res, 503, { error: 'registry unavailable' });
    const r = archiveWorkflows(workflowDir, {
      olderThanDays: WORKFLOW_ARCHIVE_DAYS,
      id: body.id,
      now,
    });
    if (r.status !== 200)
      return writeJson(ctx.res, r.status, { error: r.error });
    logger.warn(
      {
        event: 'control_ui_workflow_archive',
        id: body.id ?? null,
        archived: r.archived,
        skipped: r.skipped,
        stale: r.stale ?? false,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI archived workflow records',
    );
    const out: Record<string, unknown> = {
      archived: r.archived,
      skipped: r.skipped,
    };
    if (r.stale) out.stale = true;
    writeJson(ctx.res, 200, out);
  });
  // Every producer of the record shape goes through workflowList(), so a
  // read-only deployment's SSE frames carry the same projection as the route.
  let workflowWatcher: WorkflowWatcher | null = null;
  if (workflowDir && registryDirOk(workflowDir)) {
    workflowWatcher = createWorkflowWatcher(
      workflowDir,
      () => {
        if (hub.clientCount() === 0) return;
        const r = workflowList();
        if ('error' in r) return;
        hub.broadcast('workflow', r);
      },
      {
        debounceMs: opts.workflowDebounceMs ?? WORKFLOW_WATCH_DEBOUNCE_MS,
        pollMs: opts.workflowPollMs,
      },
    );
  }

  // Gmail: connect the assistant's own MCP channel from the dashboard. The
  // credential dir is host-side only (never mounted); the callback is the one
  // unauthenticated route, gated by a session-bound single-use state, a
  // path-scoped flow cookie and PKCE. Nothing below logs a token, a code or
  // the client secret; errors are logged as code/status only.
  const gmailCredDir = gmailDir(
    { GMAIL_CREDENTIALS_DIR: deps.gmailCredentialsDir },
    homeDir,
  );
  const gmailRedirect = `http://localhost:${deps.publicPort ?? CONTROL_UI_PORT}/api/v1/integrations/gmail/callback`;
  const gmailAuth = createGmailAuth({
    dir: gmailCredDir,
    redirectUri: gmailRedirect,
    now,
    ...(opts.gmailAuthOverrides ?? {}),
  });
  let oauthDoneTemplate = OAUTH_DONE_FALLBACK;
  try {
    oauthDoneTemplate = fs.readFileSync(
      path.join(deps.webRoot, 'oauth-done.html'),
      'utf-8',
    );
  } catch {
    /* fallback page */
  }
  const flowCookie = (
    value: string,
    secure: boolean,
    clear = false,
  ): string => {
    const parts = [
      `${FLOW_COOKIE}=${clear ? '' : value}`,
      'HttpOnly',
      'SameSite=Lax',
      'Path=/api/v1/integrations/gmail/callback',
      `Max-Age=${clear ? 0 : 600}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  };
  const gmailAudit = (
    ctx: RequestContext,
    event: string,
    extra: Record<string, unknown> = {},
  ) =>
    logger.warn(
      {
        event,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
        ...extra,
      },
      'Control UI Gmail integration',
    );
  const gmailUnavailable = (res: ServerResponse) =>
    writeJson(res, 503, { error: 'credential dir unavailable' });
  router.add('GET', '/api/v1/integrations/gmail', (ctx) => {
    writeJson(
      ctx.res,
      200,
      gmailStatus(gmailCredDir, {
        channelLive: deps.isChannelLive?.('gmail') ?? false,
        redirectUri: gmailRedirect,
        now,
      }),
    );
  });
  router.add(
    'POST',
    '/api/v1/integrations/gmail/keys',
    (ctx) => {
      if (deps.readOnly)
        return writeJson(ctx.res, 403, {
          error: 'read-only from the dashboard',
        });
      const body = (ctx.body ?? {}) as { json?: unknown };
      // Validated before the limiter so junk never spends budget.
      if (validateKeysBody(body.json) === 'invalid')
        return writeJson(ctx.res, 400, { error: 'invalid client json' });
      if (gmailLimiter.isRateLimited(sid(ctx), now()))
        return writeJson(ctx.res, 429, { error: 'too many changes' });
      const r = saveGmailKeys(gmailCredDir, body.json, gmailRedirect);
      if (r === 'unavailable') return gmailUnavailable(ctx.res);
      if (r === 'invalid')
        return writeJson(ctx.res, 400, { error: 'invalid client json' });
      gmailAudit(ctx, 'control_ui_gmail_keys');
      writeJson(ctx.res, 201, { keys: true });
    },
    { maxBody: GMAIL_KEYS_BODY_MAX },
  );
  router.add('POST', '/api/v1/integrations/gmail/connect', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (gmailLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!ensureGmailDir(gmailCredDir)) return gmailUnavailable(ctx.res);
    const r = gmailAuth.issueState(ctx.session?.id ?? '');
    if ('error' in r)
      return writeJson(
        ctx.res,
        r.error === 'credential dir unavailable' ? 503 : 409,
        {
          error: r.error,
        },
      );
    ctx.res.setHeader('Set-Cookie', flowCookie(r.flowCookie, isTls(ctx.req)));
    gmailAudit(ctx, 'control_ui_gmail_connect');
    writeJson(ctx.res, 200, { url: r.url });
  });
  const oauthPage = (
    ctx: RequestContext,
    result: CallbackResult,
    httpStatus: number,
  ) => {
    ctx.res.setHeader('Set-Cookie', flowCookie('', isTls(ctx.req), true));
    ctx.res.writeHead(httpStatus, {
      'Content-Type': 'text/html; charset=utf-8',
      ...SECURITY_HEADERS,
    });
    ctx.res.end(callbackPage(oauthDoneTemplate, result, deps.assistantName));
  };
  router.add(
    'GET',
    '/api/v1/integrations/gmail/callback',
    async (ctx) => {
      if (deps.readOnly)
        return oauthPage(
          ctx,
          { ok: false, status: 403, message: 'read-only' },
          403,
        );
      const q = ctx.url.searchParams;
      const cookie = parseCookies(ctx.req.headers.cookie)[FLOW_COOKIE];
      const result = await gmailAuth.consume(q.get('state'), cookie, {
        code: q.get('code') ?? undefined,
        error: q.get('error') ?? undefined,
      });
      if (!result.ok) {
        // Only failed-state hits count: every request shares the loopback
        // address behind the tunnel, so a valid callback is never denied.
        if (
          result.status === 403 &&
          gmailCallbackLimiter.isRateLimited(ctx.remoteAddr, now())
        )
          return writeJson(ctx.res, 429, { error: 'too many attempts' });
        gmailAudit(ctx, 'control_ui_gmail_connect_failed', {
          reason: result.message,
          ...(result.detail ?? {}),
        });
        return oauthPage(ctx, result, result.status);
      }
      const started = deps.startChannel
        ? await deps.startChannel('gmail')
        : { ok: false as const, reason: 'no lifecycle' };
      gmailAudit(ctx, 'control_ui_gmail_connected', {
        domain: result.email.split('@')[1] ?? '',
        channel: started.ok ? 'started' : started.reason,
      });
      oauthPage(ctx, result, 200);
    },
    { auth: 'none' },
  );
  router.add('POST', '/api/v1/integrations/gmail/disconnect', async (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (header(ctx.req, 'x-confirm') !== 'gmail')
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (gmailLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (gmailDirState(gmailCredDir) !== 'ok') return gmailUnavailable(ctx.res);
    // The child is a concurrent writer of the token file: stop it first.
    if (deps.stopChannel) await deps.stopChannel('gmail');
    const r = await gmailAuth.disconnect();
    gmailAudit(ctx, 'control_ui_gmail_disconnect', r);
    if (!r.revoked) gmailAudit(ctx, 'control_ui_gmail_revoke_failed');
    if (!r.deleted) gmailAudit(ctx, 'control_ui_gmail_delete_failed');
    writeJson(ctx.res, 200, r);
  });
  router.add('DELETE', '/api/v1/integrations/gmail/keys', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    if (header(ctx.req, 'x-confirm') !== 'gmail')
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (gmailLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    const r = gmailAuth.forgetKeys();
    if (r === 'connected')
      return writeJson(ctx.res, 409, { error: 'disconnect first' });
    if (r === 'missing')
      return writeJson(ctx.res, 404, { error: 'no client keys' });
    gmailAudit(ctx, 'control_ui_gmail_keys_forgotten');
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  // Browser jobs: the control plane for acting on sites that have no API.
  // This phase cannot act — there is no runner and no session credential here,
  // so an approval records the operator's decision and the job stops at
  // `sandbox-unavailable`. What it does hold is the part worth getting right
  // before anything can click: the operator's rules and budgets, the enforced
  // allow-lists, and an approvals queue where a proposal drafted from a
  // supplier's own words is read by a human before it goes anywhere.
  const browserDir = deps.configDir
    ? path.join(deps.configDir, 'browser')
    : null;
  if (browserDir) {
    try {
      fs.mkdirSync(browserDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Control UI could not create the browser job dir',
      );
    }
  }
  const browserAudit = (
    ctx: RequestContext,
    event: string,
    extra: Record<string, unknown> = {},
  ) =>
    logger.warn(
      {
        event,
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
        ...extra,
      },
      'Control UI browser jobs',
    );
  const siteParam = (ctx: RequestContext) => getSite(ctx.params.site);
  // Takes the directory rather than closing over it: TypeScript cannot carry a
  // `string | null` narrowing across the closure, and the only caller,
  // GET /api/v1/browser, has already answered 503 when it is missing.
  const browserState = (dir: string) => {
    const at = now();
    return SITES.map((site) => {
      const view = readRules(dir, site.id);
      const counts = countActions(dir, site.id, at);
      return {
        site: site.id,
        rules: view.rules,
        invalid: view.invalid ?? false,
        reason: view.reason,
        counts: counts.counts,
        counts_exact: counts.exact,
        attention: getAttention(dir, site.id),
        execution: 'unavailable' as const,
      };
    });
  };
  const browserJobsPayload = (readOnly: boolean) => {
    if (!browserDir) return { jobs: [], scanned: 0, truncated: 0 };
    const r = listBrowserJobs(browserDir, { readOnly, now: now });
    return 'error' in r ? { jobs: [], scanned: 0, truncated: 0 } : r;
  };
  router.add('GET', '/api/v1/browser', (ctx) => {
    if (browserReadLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many requests' });
    if (!browserDir)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    writeJson(ctx.res, 200, {
      sites: browserState(browserDir),
      ...browserJobsPayload(deps.readOnly),
    });
  });
  router.add('PUT', '/api/v1/browser/sites/:site/rules', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const site = siteParam(ctx);
    if (!site) return writeJson(ctx.res, 404, { error: 'unknown site' });
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    // Turning autonomy on is the one thing here that needs the operator's own
    // hand: the typed site name is what earns the confirmation stamp, and the
    // stamp is bound to the caps and allow-list it was given for.
    const wantsAutonomy = body.autonomous === true;
    if (wantsAutonomy && header(ctx.req, 'x-confirm') !== site.id)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (browserWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!browserDir)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    const r = writeRules(browserDir, site.id, body, {
      confirmAutonomy: wantsAutonomy,
      now: now,
    });
    if (!r.ok)
      return writeJson(ctx.res, r.reason === 'busy' ? 409 : 400, {
        error: r.reason === 'bad-schema' ? 'invalid rules' : r.reason,
      });
    browserAudit(ctx, 'control_ui_browser_rules_saved', {
      site: site.id,
      enabled: r.rules.enabled,
      autonomous: r.rules.autonomous,
      weekly_cap: r.rules.weekly_cap,
      daily_cap: r.rules.daily_cap,
    });
    writeJson(ctx.res, 200, { rules: r.rules });
  });
  router.add('POST', '/api/v1/browser/sites/:site/attention/clear', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const site = siteParam(ctx);
    if (!site) return writeJson(ctx.res, 404, { error: 'unknown site' });
    if (header(ctx.req, 'x-confirm') !== site.id)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (browserWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!browserDir)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    clearAttention(browserDir, site.id);
    browserAudit(ctx, 'control_ui_browser_attention_cleared', {
      site: site.id,
    });
    ctx.res.writeHead(204);
    ctx.res.end();
  });
  router.add('POST', '/api/v1/browser/jobs', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const kind = body.kind;
    if (
      typeof kind !== 'string' ||
      !(JOB_KINDS as readonly string[]).includes(kind)
    )
      return writeJson(ctx.res, 400, { error: 'unknown kind' });
    const site = getSite(String(kind).split('.')[0]);
    if (!site) return writeJson(ctx.res, 400, { error: 'unknown kind' });
    if (browserWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!browserDir)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    // Status, provenance and the timestamp come from here, never from the
    // body: attribution the operator cannot trust is worse than none.
    const params = (body.params ?? {}) as Record<string, unknown>;
    const draft: JobRecord = {
      v: 1,
      id: newJobId(),
      site: site.id,
      kind: kind as JobKind,
      params: Object.fromEntries(
        Object.entries(params).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>,
      status: 'proposed',
      proposed_by: `session:${ctx.session?.shortId ?? 'unknown'}`,
      proposed_at: new Date(now()).toISOString(),
      rev: 1,
    };
    const v = validateBrowserJob(draft, draft.id, now);
    if (!v.ok) return writeJson(ctx.res, 400, { error: v.reason });
    const view = readRules(browserDir, site.id);
    const gate = capCheck(
      view,
      v.job,
      countActions(browserDir, site.id, now()),
      now(),
      { attention: getAttention(browserDir, site.id) },
    );
    // Only the allow-list is checked at propose time: caps and pacing are the
    // approval's business, and a proposal refused for being early is noise.
    if (
      !gate.ok &&
      (gate.reason === 'not-allowed' ||
        gate.reason === 'rules-invalid' ||
        gate.reason === 'disabled')
    )
      return writeJson(ctx.res, 400, { error: gate.reason });
    if (!writeJob(browserDir, v.job).ok)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    browserAudit(ctx, 'control_ui_browser_job_proposed', {
      site: site.id,
      kind,
      proposed_by: v.job.proposed_by,
    });
    hub.broadcast('browser', browserJobsPayload(deps.readOnly));
    writeJson(ctx.res, 201, { id: v.job.id });
  });
  const approveJob = (
    job: JobRecord,
    by: string,
    at: number,
  ): { status: number; body: Record<string, unknown> } => {
    if (!browserDir)
      return { status: 503, body: { error: 'browser registry unavailable' } };
    const view = readRules(browserDir, job.site);
    const gate = capCheck(
      view,
      job,
      countActions(browserDir, job.site, at),
      at,
      {
        // Thunk, not a value: every refusal above the gap test short-circuits
        // the directory walk instead of computing it and discarding it.
        lastAt: () => lastActionAt(browserDir, job.site, at),
        attention: getAttention(browserDir, job.site),
      },
    );
    if (!gate.ok) return { status: 409, body: { error: gate.reason } };
    const approved: JobRecord = {
      ...job,
      status: 'blocked',
      approved_by: by,
      approved_at: new Date(at).toISOString(),
      approved_rev: job.rev,
      params_sha256: paramsHash(job.params),
      rules_mtime: view.mtimeMs,
      rules_sha256: view.sha256,
      // E1 has no runner: the approval is real and recorded, the action is not
      // possible yet, and the record says exactly that rather than pretending.
      reason: 'sandbox-unavailable',
      finished_at: new Date(at).toISOString(),
      rev: job.rev + 1,
    };
    // The operator typed the job id to get here, so "approved" must not be
    // reported unless the record actually landed: the job would stay
    // `proposed` and the poller would re-select it on every tick. Matches the
    // propose route, which checks the identical call.
    if (!writeJob(browserDir, approved).ok)
      return { status: 503, body: { error: 'browser registry unavailable' } };
    return {
      status: 200,
      body: { id: job.id, status: approved.status, reason: approved.reason },
    };
  };
  router.add('POST', '/api/v1/browser/jobs/:id/approve', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const id = ctx.params.id;
    if (!JOB_ID_RE.test(id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (header(ctx.req, 'x-confirm') !== id)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (browserWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!browserDir)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    const r = readJob(browserDir, id, now);
    if (!r.ok) return writeJson(ctx.res, 404, { error: 'not found' });
    // An expired proposal answers with the closed reason the gate uses, so the
    // tab and the CLI see one vocabulary rather than two.
    if (r.job.status === 'expired')
      return writeJson(ctx.res, 409, { error: 'expired' });
    if (r.job.status !== 'proposed')
      return writeJson(ctx.res, 409, { error: `job is ${r.job.status}` });
    const out = approveJob(
      r.job,
      `session:${ctx.session?.shortId ?? 'unknown'}`,
      now(),
    );
    browserAudit(ctx, 'control_ui_browser_job_approved', {
      id,
      site: r.job.site,
      kind: r.job.kind,
      auto: false,
      outcome: out.status === 200 ? out.body.reason : out.body.error,
    });
    hub.broadcast('browser', browserJobsPayload(deps.readOnly));
    writeJson(ctx.res, out.status, out.body);
  });
  router.add('POST', '/api/v1/browser/jobs/:id/reject', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const id = ctx.params.id;
    if (!JOB_ID_RE.test(id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (browserWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!browserDir)
      return writeJson(ctx.res, 503, { error: 'browser registry unavailable' });
    const r = readJob(browserDir, id, now);
    if (!r.ok) return writeJson(ctx.res, 404, { error: 'not found' });
    // Only a job still waiting can be rejected, matching approve. Without this
    // any job in any state could be rewritten to `rejected`: harmless while
    // nothing runs, but `running` counts toward the caps, so in E2 rejecting a
    // running job would quietly decrement them and erase the audit of an
    // action that may already have happened.
    if (r.job.status !== 'proposed')
      return writeJson(ctx.res, 409, { error: 'job is not waiting' });
    if (
      !writeJob(browserDir, {
        ...r.job,
        status: 'rejected',
        finished_at: new Date(now()).toISOString(),
        rev: r.job.rev + 1,
      }).ok
    )
      return writeJson(ctx.res, 503, {
        error: 'browser registry unavailable',
      });
    browserAudit(ctx, 'control_ui_browser_job_rejected', {
      id,
      site: r.job.site,
    });
    hub.broadcast('browser', browserJobsPayload(deps.readOnly));
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  // Auto-approval, when the operator has turned it on for a site: at most one
  // job per tick, only `instagram.follow` (words in the operator's name and an
  // inbox read always wait for a human), and only while someone is actually at
  // the dashboard — the same client-gated shape as claudePoll. It re-runs the
  // full gate, so it can approve nothing the operator's own rules do not.
  const browserPoll = setInterval(() => {
    if (!browserDir || deps.readOnly || hub.clientCount() === 0) return;
    const at = now();
    let changed = false;
    for (const site of SITES) {
      const view = readRules(browserDir, site.id);
      if (!view.rules.enabled || !view.rules.autonomous) continue;
      const list = listBrowserJobs(browserDir, { readOnly: false, now });
      if ('error' in list) continue;
      // Last match, not first: the listing is newest-first, so taking the
      // first would approve the newest proposal every tick and starve older
      // ones behind any steady stream of new ones. Oldest-first makes the
      // queue fair and drains it in the order the operator sees it.
      // (`findLast` would read better but needs a newer lib target.)
      // Bounded honesty: `listJobs` slices before this runs, so this is the
      // oldest of the newest 200, not the globally oldest. Harmless while the
      // sweeper keeps the directory small and nothing executes; if E2 ever
      // faces a backlog deeper than that slice, starvation returns here.
      const waiting = list.jobs.filter(
        (j) =>
          j.site === site.id &&
          j.status === 'proposed' &&
          j.kind === 'instagram.follow',
      );
      const next = waiting[waiting.length - 1];
      if (!next) continue;
      const r = readJob(browserDir, next.id, now);
      if (!r.ok) continue;
      const out = approveJob(r.job, 'rules', at);
      if (out.status !== 200) continue;
      changed = true;
      logger.warn(
        {
          event: 'control_ui_browser_job_approved',
          id: r.job.id,
          site: site.id,
          kind: r.job.kind,
          auto: true,
          rules_mtime: view.mtimeMs,
          outcome: out.body.reason,
        },
        'Control UI browser jobs',
      );
    }
    if (changed) hub.broadcast('browser', browserJobsPayload(false));
  }, opts.browserPollMs ?? BROWSER_POLL_MS);
  browserPoll.unref();
  // Pruning is the server's own business, never a read's side effect: a
  // read-only client listing jobs must not delete anything.
  const browserSweep = setInterval(() => {
    if (!browserDir || deps.readOnly) return;
    sweepJobs(browserDir, now());
  }, opts.browserSweepMs ?? BROWSER_SWEEP_MS);
  browserSweep.unref();

  // Artifacts registry: one operator-curated file under CONFIG_DIR/control-ui.
  // The read-time URL check inside listArtifacts is the security control for
  // every href the tab renders; the write-time check only keeps unshowable
  // links out. Route and watcher share the one projected list.
  const controlDir = deps.configDir
    ? path.join(deps.configDir, 'control-ui')
    : null;
  // Created here in its own right (not as a side effect of the workflows dir)
  // so the watcher below can start on a fresh instance; it never retries.
  if (controlDir) {
    try {
      fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'Control UI could not create the artifacts registry dir',
      );
    }
  }
  const artifactList = () =>
    controlDir
      ? listArtifacts(controlDir, {
          hosts: previewHosts,
          readOnly: deps.readOnly,
        })
      : ({ error: 'registry unavailable' } as const);
  router.add('GET', '/api/v1/artifacts', (ctx) => {
    if (artifactReadLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many requests' });
    const r = artifactList();
    if ('error' in r) return writeJson(ctx.res, 503, { error: r.error });
    writeJson(ctx.res, 200, r);
  });
  router.add('POST', '/api/v1/artifacts', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    // Validated before the limiter so invalid input never spends budget.
    const checked = validateAddInput(body, previewHosts);
    if (!checked.ok) {
      const out: Record<string, unknown> = { error: checked.error };
      if (checked.blocked) out.blocked = checked.blocked;
      return writeJson(ctx.res, 400, out);
    }
    if (artifactWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!controlDir)
      return writeJson(ctx.res, 503, { error: 'registry unavailable' });
    const r = addArtifact(
      controlDir,
      {
        title: body.title,
        url: body.url,
        kind: body.kind,
        description: body.description,
      },
      { hosts: previewHosts, now, by: 'dashboard' },
    );
    if (r.status !== 201) {
      const out: Record<string, unknown> = { error: r.error };
      if (r.blocked) out.blocked = r.blocked;
      if (r.reason) out.reason = r.reason;
      return writeJson(ctx.res, r.status, out);
    }
    logger.warn(
      {
        event: 'control_ui_artifact_add',
        id: r.id,
        kind: body.kind,
        hostname: safeHostname(body.url),
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI added an artifact link',
    );
    writeJson(ctx.res, 201, { id: r.id, rev: r.rev });
  });
  router.add('DELETE', '/api/v1/artifacts/:id', (ctx) => {
    if (deps.readOnly)
      return writeJson(ctx.res, 403, { error: 'read-only from the dashboard' });
    const id = ctx.params.id;
    if (!ARTIFACT_ID_RE.test(id))
      return writeJson(ctx.res, 404, { error: 'not found' });
    if (header(ctx.req, 'x-confirm') !== id)
      return writeJson(ctx.res, 428, { error: 'confirmation required' });
    if (artifactWriteLimiter.isRateLimited(sid(ctx), now()))
      return writeJson(ctx.res, 429, { error: 'too many changes' });
    if (!controlDir)
      return writeJson(ctx.res, 503, { error: 'registry unavailable' });
    const r = removeArtifact(controlDir, id, id, { now, by: 'dashboard' });
    if (r.status !== 204) {
      const out: Record<string, unknown> = { error: r.error };
      if (r.reason) out.reason = r.reason;
      return writeJson(ctx.res, r.status, out);
    }
    logger.warn(
      {
        event: 'control_ui_artifact_remove',
        id,
        hostname: safeHostname(r.entry.url),
        remoteAddr: ctx.remoteAddr,
        actor: actor(ctx.session),
      },
      'Control UI removed an artifact link',
    );
    ctx.res.writeHead(204);
    ctx.res.end();
  });
  // The dir also holds the Claude ledger and env backups; the callback reads
  // only the registry and broadcasts only when the projected list changed.
  let artifactLastJson = '';
  let artifactWatcher: WorkflowWatcher | null = null;
  if (controlDir && registryDirOk(controlDir)) {
    artifactWatcher = createDirWatcher(
      controlDir,
      () => {
        if (hub.clientCount() === 0) return;
        const r = artifactList();
        if ('error' in r) return;
        const json = JSON.stringify(r);
        if (json === artifactLastJson) return;
        artifactLastJson = json;
        hub.broadcast('artifact', r);
      },
      {
        debounceMs: opts.workflowDebounceMs ?? WORKFLOW_WATCH_DEBOUNCE_MS,
        pollMs: opts.workflowPollMs,
      },
    );
  }

  // Poll-and-diff only while the Claude tab is in use; skipped while a tick is in flight.
  let claudeLastJson = '';
  let claudePolling = false;
  const claudePoll = setInterval(() => {
    if (
      !claudeCli ||
      claudePolling ||
      hub.clientCount() === 0 ||
      now() - claudeTabSeen > CLAUDE_TAB_ACTIVE_MS
    )
      return;
    claudePolling = true;
    claudeList(true)
      .then((r) => {
        if (!('sessions' in r)) return;
        const json = JSON.stringify(r.sessions);
        if (json === claudeLastJson) return;
        claudeLastJson = json;
        hub.broadcast('csession', { sessions: r.sessions });
      })
      .catch(() => {})
      .finally(() => {
        claudePolling = false;
      });
  }, opts.claudePollMs ?? CLAUDE_POLL_MS);
  claudePoll.unref();

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
    // DNS rebinding: a page on another name that resolves to 127.0.0.1 would
    // still carry its own Host. Only loopback names on the port this socket
    // accepted, or the tunnel's local port, are answered.
    if (!hostAllowed(req.headers.host, req.socket.localPort, deps.publicPort))
      return writeJson(res, 421, { error: 'misdirected request' });
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
      logger.error(
        { err: safeError(err), nonce, path: pathOnly(req.url) },
        'Control UI request failed',
      );
      if (!res.headersSent)
        writeJson(res, 500, { error: 'internal error', nonce });
      else res.end();
    });
  });

  server.on('close', () => {
    clearInterval(queuePoll);
    clearInterval(systemPoll);
    clearInterval(claudePoll);
    claudeStartLimiter.dispose();
    liveOpenLimiter.dispose();
    claudePinLimiter.dispose();
    clearInterval(liveSweep);
    liveViews?.closeAll('shutdown');
    claudeReadLimiter.dispose();
    claudeConvLimiter.dispose();
    claudeStopLimiter.dispose();
    workflowReadLimiter.dispose();
    workflowArchiveLimiter.dispose();
    if (workflowWatcher) workflowWatcher.close();
    if (artifactWatcher) artifactWatcher.close();
    artifactReadLimiter.dispose();
    artifactWriteLimiter.dispose();
    gmailLimiter.dispose();
    gmailCallbackLimiter.dispose();
    browserReadLimiter.dispose();
    browserWriteLimiter.dispose();
    clearInterval(browserPoll);
    clearInterval(browserSweep);
    if (logTimer) clearInterval(logTimer);
    if (unsubscribeLog) unsubscribeLog();
    configLimiter.dispose();
    dockerReadLimiter.dispose();
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
