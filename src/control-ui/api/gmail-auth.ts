import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { readRecordFile } from './workflows.js';

// Connects the assistant's own Gmail MCP channel from the dashboard: the
// operator pastes a Google Desktop OAuth client once, Connect sends them to
// Google, the callback exchanges the code server-side and writes the files
// `packages/mcp-gmail` reads. Nothing here logs; every function returns a
// closed result the route turns into a status line, an audit and a page.
// Credentials (client secret, tokens, code) never leave this module except
// toward Google, and never appear in a returned message.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const KEYS_FILE = 'gcp-oauth.keys.json';
export const TOKENS_FILE = 'credentials.json';
export const ACCOUNT_FILE = 'account.json';
export const FLOW_COOKIE = 'deus_ctl_oauth';
export const STATE_TTL_MS = 10 * 60_000;
export const STATES_MAX = 5;
export const KEYS_BODY_MAX = 16 * 1024;
export const CODE_MAX = 512;
export const DELETE_RECHECK_MS = 2000;
export const DELETE_RECHECK_STEP_MS = 200;
const FILE_MAX = 64 * 1024;
const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const PROFILE_ENDPOINT =
  'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export type Keys = { client_id: string; client_secret: string };
export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expiry_date: number;
  scope: string;
}
export type CallbackMessage =
  | 'connected'
  | 'state unknown or expired'
  | 'flow cookie mismatch'
  | 'access denied'
  | 'consent failed'
  | 'invalid code'
  | 'client keys missing'
  | 'exchange failed'
  | 'no refresh token'
  | 'token response invalid'
  | 'profile invalid'
  | 'credential dir unavailable'
  | 'read-only';
export type CallbackResult =
  | { ok: true; email: string; message: 'connected' }
  | {
      ok: false;
      status: 400 | 403 | 502 | 503;
      message: CallbackMessage;
      detail?: { code?: string; status?: number };
    };
export interface GmailStatus {
  keys: boolean;
  keys_invalid?: true;
  connected: boolean;
  email?: string;
  connected_at?: string;
  token_age_ms?: number;
  channel_live: boolean;
  redirect_uri: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const EMAIL_RE = /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u;
export const isValidEmail = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 320 && EMAIL_RE.test(v);

export function gmailDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.GMAIL_CREDENTIALS_DIR || path.join(home, '.gmail-mcp');
}

/** `ok` for a real directory; `missing`; `bad` for a symlink or a file. */
export function dirState(dir: string): 'ok' | 'missing' | 'bad' {
  try {
    return fs.lstatSync(dir).isDirectory() ? 'ok' : 'bad';
  } catch {
    return 'missing';
  }
}
export function ensureDir(dir: string): boolean {
  if (dirState(dir) === 'missing') {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
  }
  return dirState(dir) === 'ok';
}

function readJson(dir: string, file: string): unknown | null {
  const r = readRecordFile(path.join(dir, file), FILE_MAX);
  return r.ok ? r.raw : null;
}
const exists = (dir: string, file: string): boolean => {
  try {
    return fs.lstatSync(path.join(dir, file)).isFile();
  } catch {
    return false;
  }
};

/** Write, fsync and re-tighten: the MCP factory re-reads these at call time. */
function writeSecret(dir: string, file: string, body: object): void {
  const p = path.join(dir, file);
  const fd = fs.openSync(
    p,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.writeSync(fd, JSON.stringify(body, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(p, 0o600); // mode applies only on creation
}
function unlinkQuiet(dir: string, file: string): void {
  try {
    fs.unlinkSync(path.join(dir, file));
  } catch {
    /* already gone */
  }
}

function parseKeys(raw: unknown): Keys | 'invalid' {
  if (!isObj(raw)) return 'invalid';
  const cfg = isObj(raw.installed)
    ? raw.installed
    : isObj(raw.web)
      ? raw.web
      : null;
  if (!cfg) return 'invalid';
  const { client_id, client_secret } = cfg;
  if (
    typeof client_id !== 'string' ||
    !client_id.endsWith(CLIENT_ID_SUFFIX) ||
    client_id.length > 256
  )
    return 'invalid';
  if (
    typeof client_secret !== 'string' ||
    client_secret.length === 0 ||
    client_secret.length > 256
  )
    return 'invalid';
  return { client_id, client_secret };
}

/** `null` when no key file, `'invalid'` when it does not parse to a client. */
export function readKeys(dir: string): Keys | null | 'invalid' {
  if (!exists(dir, KEYS_FILE)) return null;
  const raw = readJson(dir, KEYS_FILE);
  return raw === null ? 'invalid' : parseKeys(raw);
}

/** Shape check alone — routes run this before their limiter so junk never spends budget. */
export function validateKeysBody(rawBody: unknown): Keys | 'invalid' {
  if (
    typeof rawBody !== 'string' ||
    rawBody.length === 0 ||
    rawBody.length > KEYS_BODY_MAX
  )
    return 'invalid';
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return 'invalid';
  }
  return parseKeys(parsed);
}

/** Validates a pasted client JSON and rewrites it as a fresh literal. */
export function saveKeys(
  dir: string,
  rawBody: unknown,
  redirectUri: string,
): 'ok' | 'invalid' | 'unavailable' {
  const keys = validateKeysBody(rawBody);
  if (keys === 'invalid') return 'invalid';
  if (!ensureDir(dir)) return 'unavailable';
  writeSecret(dir, KEYS_FILE, {
    installed: {
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      redirect_uris: [redirectUri],
    },
  });
  return 'ok';
}

function parseTokens(raw: unknown): Tokens | null {
  if (!isObj(raw)) return null;
  const { access_token, refresh_token, token_type, expiry_date, scope } = raw;
  if (typeof access_token !== 'string' || access_token.length === 0)
    return null;
  if (typeof refresh_token !== 'string' || refresh_token.length === 0)
    return null;
  if (typeof token_type !== 'string') return null;
  if (typeof expiry_date !== 'number' || !Number.isInteger(expiry_date))
    return null;
  if (typeof scope !== 'string') return null;
  return { access_token, refresh_token, token_type, expiry_date, scope };
}

export function status(
  dir: string,
  opts: { channelLive: boolean; redirectUri: string; now?: () => number },
): GmailStatus {
  const now = opts.now ?? Date.now;
  const out: GmailStatus = {
    keys: false,
    connected: false,
    channel_live: opts.channelLive,
    redirect_uri: opts.redirectUri,
  };
  if (dirState(dir) !== 'ok') return out;
  const keys = readKeys(dir);
  out.keys = keys !== null && keys !== 'invalid';
  if (keys === 'invalid') out.keys_invalid = true;
  // Connected means a token file the MCP server would accept: a refresh token.
  const tokens = readJson(dir, TOKENS_FILE);
  if (
    isObj(tokens) &&
    typeof tokens.refresh_token === 'string' &&
    tokens.refresh_token.length > 0
  ) {
    out.connected = true;
    try {
      out.token_age_ms = Math.max(
        0,
        now() - fs.lstatSync(path.join(dir, TOKENS_FILE)).mtimeMs,
      );
    } catch {
      /* raced away */
    }
    const account = readJson(dir, ACCOUNT_FILE);
    if (isObj(account)) {
      if (isValidEmail(account.email)) out.email = account.email;
      if (
        typeof account.connected_at === 'string' &&
        account.connected_at.length <= 40
      )
        out.connected_at = account.connected_at;
    }
  }
  return out;
}

export type Exchange = (code: string, verifier: string) => Promise<unknown>;
export type Profile = (accessToken: string) => Promise<unknown>;
export type Revoke = (refreshToken: string) => Promise<void>;
export interface GmailAuthOptions {
  dir: string;
  redirectUri: string;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  exchange?: Exchange;
  profile?: Profile;
  revoke?: Revoke;
  sleep?: (ms: number) => Promise<void>;
}
export interface GmailAuth {
  issueState(sid: string):
    | { state: string; url: string; flowCookie: string }
    | {
        error:
          | 'client keys missing'
          | 'client keys invalid'
          | 'credential dir unavailable';
      };
  consume(
    state: unknown,
    flowCookie: unknown,
    params: { code?: unknown; error?: unknown },
  ): Promise<CallbackResult>;
  disconnect(): Promise<{ revoked: boolean; deleted: boolean }>;
  forgetKeys(): 'ok' | 'connected' | 'missing';
  /** Logout / revoke-all / credential rotation: a revoked browser must not finish a flow. */
  dropSession(sid: string): void;
  dropAll(): void;
  pendingCount(): number;
}

interface Pending {
  sid: string;
  flowCookie: string;
  verifier: string;
  createdAt: number;
}

const b64url = (b: Buffer): string => b.toString('base64url');
const errDetail = (err: unknown): { code?: string; status?: number } => {
  const e = err as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const out: { code?: string; status?: number } = {};
  if (typeof e?.code === 'string' || typeof e?.code === 'number')
    out.code = String(e.code);
  const st =
    typeof e?.status === 'number'
      ? e.status
      : typeof e?.response?.status === 'number'
        ? e.response.status
        : undefined;
  if (st !== undefined) out.status = st;
  return out;
};

export function createGmailAuth(opts: GmailAuthOptions): GmailAuth {
  const { dir, redirectUri } = opts;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? ((n: number) => crypto.randomBytes(n));
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const exchange: Exchange =
    opts.exchange ??
    (async (code, verifier) => {
      const keys = readKeys(dir);
      if (keys === null || keys === 'invalid')
        throw new Error('client keys missing');
      const client = new OAuth2Client(
        keys.client_id,
        keys.client_secret,
        redirectUri,
      );
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier,
      });
      return tokens;
    });
  const profile: Profile =
    opts.profile ??
    (async (accessToken) => {
      const res = await fetch(PROFILE_ENDPOINT, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok)
        throw Object.assign(new Error('profile request failed'), {
          status: res.status,
        });
      return res.json();
    });
  const revoke: Revoke =
    opts.revoke ??
    (async (token) => {
      await new OAuth2Client().revokeToken(token);
    });
  const pending = new Map<string, Pending>();

  const sweep = () => {
    const cutoff = now() - STATE_TTL_MS;
    for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
  };

  return {
    pendingCount: () => pending.size,
    dropSession(sid) {
      for (const [k, v] of pending) if (v.sid === sid) pending.delete(k);
    },
    dropAll() {
      pending.clear();
    },
    issueState(sid) {
      if (dirState(dir) !== 'ok')
        return { error: 'credential dir unavailable' };
      const keys = readKeys(dir);
      if (keys === null) return { error: 'client keys missing' };
      if (keys === 'invalid') return { error: 'client keys invalid' };
      sweep();
      for (const [k, v] of pending) if (v.sid === sid) pending.delete(k); // one per session
      while (pending.size >= STATES_MAX) {
        const oldest = [...pending.entries()].sort(
          (a, b) => a[1].createdAt - b[1].createdAt,
        )[0];
        pending.delete(oldest[0]);
      }
      const state = random(32).toString('hex');
      const flowCookie = random(32).toString('hex');
      const verifier = b64url(random(32));
      const challenge = b64url(
        crypto.createHash('sha256').update(verifier).digest(),
      );
      pending.set(state, { sid, flowCookie, verifier, createdAt: now() });
      const q = new URLSearchParams({
        client_id: keys.client_id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GMAIL_SCOPE,
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      return { state, url: `${AUTH_ENDPOINT}?${q.toString()}`, flowCookie };
    },
    async consume(state, flowCookie, params) {
      sweep();
      const entry = typeof state === 'string' ? pending.get(state) : undefined;
      if (!entry)
        return { ok: false, status: 403, message: 'state unknown or expired' };
      pending.delete(state as string); // single use, whatever follows
      if (typeof flowCookie !== 'string' || flowCookie !== entry.flowCookie)
        return { ok: false, status: 403, message: 'flow cookie mismatch' };
      if (params.error !== undefined)
        return {
          ok: false,
          status: 400,
          message:
            params.error === 'access_denied'
              ? 'access denied'
              : 'consent failed',
        };
      const code = params.code;
      if (
        typeof code !== 'string' ||
        code.length === 0 ||
        code.length > CODE_MAX
      )
        return { ok: false, status: 400, message: 'invalid code' };
      if (dirState(dir) !== 'ok')
        return {
          ok: false,
          status: 503,
          message: 'credential dir unavailable',
        };
      const keys = readKeys(dir);
      if (keys === null || keys === 'invalid')
        return { ok: false, status: 503, message: 'client keys missing' };
      let raw: unknown;
      try {
        raw = await exchange(code, entry.verifier);
      } catch (err) {
        return {
          ok: false,
          status: 502,
          message: 'exchange failed',
          detail: errDetail(err),
        };
      }
      if (
        isObj(raw) &&
        (raw.refresh_token === undefined ||
          raw.refresh_token === null ||
          raw.refresh_token === '')
      )
        return { ok: false, status: 502, message: 'no refresh token' };
      const tokens = parseTokens(raw);
      if (!tokens)
        return { ok: false, status: 502, message: 'token response invalid' };
      writeSecret(dir, TOKENS_FILE, tokens);
      let prof: unknown;
      try {
        prof = await profile(tokens.access_token);
      } catch (err) {
        unlinkQuiet(dir, TOKENS_FILE);
        return {
          ok: false,
          status: 502,
          message: 'profile invalid',
          detail: errDetail(err),
        };
      }
      const email = isObj(prof) ? prof.emailAddress : undefined;
      if (!isValidEmail(email)) {
        unlinkQuiet(dir, TOKENS_FILE);
        return { ok: false, status: 502, message: 'profile invalid' };
      }
      writeSecret(dir, ACCOUNT_FILE, {
        email,
        connected_at: new Date(now()).toISOString(),
      });
      return { ok: true, email, message: 'connected' };
    },
    async disconnect() {
      let revoked = false;
      const tokens = parseTokens(readJson(dir, TOKENS_FILE));
      if (tokens) {
        try {
          await revoke(tokens.refresh_token);
          revoked = true;
        } catch {
          revoked = false;
        }
      }
      unlinkQuiet(dir, TOKENS_FILE);
      unlinkQuiet(dir, ACCOUNT_FILE);
      // The MCP child is killed without awaiting its exit; a refresh in flight
      // can re-create the token file. Re-check with awaited timers, never a spin.
      // A fixed number of steps, not a clock deadline: the clock is injectable
      // and a frozen one must never turn this into an endless loop.
      let reappeared = false;
      for (let i = 0; i < DELETE_RECHECK_MS / DELETE_RECHECK_STEP_MS; i++) {
        await sleep(DELETE_RECHECK_STEP_MS);
        reappeared = exists(dir, TOKENS_FILE) || exists(dir, ACCOUNT_FILE);
        if (reappeared) {
          unlinkQuiet(dir, TOKENS_FILE);
          unlinkQuiet(dir, ACCOUNT_FILE);
        }
      }
      const deleted =
        !reappeared && !exists(dir, TOKENS_FILE) && !exists(dir, ACCOUNT_FILE);
      return { revoked, deleted };
    },
    forgetKeys() {
      if (!exists(dir, KEYS_FILE)) return 'missing';
      if (exists(dir, TOKENS_FILE)) return 'connected';
      unlinkQuiet(dir, KEYS_FILE);
      return 'ok';
    },
  };
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] as string,
  );

/** Fills the static template's two slots with escaped text from the closed message set. */
export function callbackPage(
  template: string,
  result: CallbackResult,
  assistantName: string,
): string {
  const message = result.ok
    ? `Gmail connected as ${result.email}.`
    : `Gmail was not connected: ${result.message}.`;
  return template
    .replaceAll('{{title}}', escapeHtml(`${assistantName} Control`))
    .replaceAll('{{message}}', escapeHtml(message));
}
