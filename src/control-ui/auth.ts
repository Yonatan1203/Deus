import crypto from 'crypto';
import fs from 'fs';
import type { IncomingMessage } from 'http';
import path from 'path';
import { promisify } from 'util';

export const SESSION_COOKIE = 'deus_ctl';
export const SESSION_HEADER = 'x-deus-session';
export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;
export const TICKET_TTL_MS = 60_000;
export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_MAX_MS = 5 * 60_000;
export const BACKOFF_WINDOW_MS = 15 * 60_000;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

export interface ScryptRecord {
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

export interface CredentialFile {
  scrypt: ScryptRecord;
  created_at: string;
}

export function generatePassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashPassword(password: string): ScryptRecord {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    salt: salt.toString('hex'),
    hash: hash.toString('hex'),
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
}

export async function verifyPassword(
  password: string,
  rec: ScryptRecord,
): Promise<boolean> {
  const expected = Buffer.from(rec.hash, 'hex');
  const actual = await scrypt(
    password,
    Buffer.from(rec.salt, 'hex'),
    expected.length,
    { N: rec.N, r: rec.r, p: rec.p },
  );
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

export function writeCredentialFile(file: string, password: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body: CredentialFile = {
    scrypt: hashPassword(password),
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode only applies on creation; rotation must re-tighten.
  fs.chmodSync(file, 0o600);
}

export type CredentialLoad =
  { ok: true; cred: CredentialFile } | { ok: false; reason: string };

const HEX = /^[0-9a-f]+$/;

function isScryptRecord(v: unknown): v is ScryptRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.salt === 'string' &&
    HEX.test(r.salt) &&
    r.salt.length >= 32 &&
    typeof r.hash === 'string' &&
    HEX.test(r.hash) &&
    r.hash.length >= 64 &&
    Number.isInteger(r.N) &&
    (r.N as number) > 1 &&
    Number.isInteger(r.r) &&
    (r.r as number) > 0 &&
    Number.isInteger(r.p) &&
    (r.p as number) > 0
  );
}

export function loadCredentialFile(file: string): CredentialLoad {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { ok: false, reason: `credential file not readable: ${file}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'credential file is not valid JSON' };
  }
  const obj = parsed as { scrypt?: unknown; created_at?: unknown } | null;
  if (!obj || !isScryptRecord(obj.scrypt)) {
    return { ok: false, reason: 'credential file has no valid scrypt record' };
  }
  return {
    ok: true,
    cred: {
      scrypt: obj.scrypt,
      created_at: typeof obj.created_at === 'string' ? obj.created_at : '',
    },
  };
}

export type CredentialState = CredentialLoad & { rotated: boolean };

export interface CredentialSource {
  current(): CredentialState;
}

/** Re-reads the credential file when it changes so rotation needs no restart. */
export function createCredentialSource(file: string): CredentialSource {
  let stamp: string | null = null;
  let cached: CredentialLoad | null = null;
  let lastHash: string | null = null;
  return {
    current() {
      let next: string;
      try {
        const s = fs.statSync(file);
        next = `${s.mtimeMs}:${s.size}`;
      } catch {
        stamp = null;
        cached = null;
        return {
          ok: false,
          reason: `credential file not readable: ${file}`,
          rotated: false,
        };
      }
      if (next === stamp && cached) return { ...cached, rotated: false };
      stamp = next;
      cached = loadCredentialFile(file);
      const hash = cached.ok ? cached.cred.scrypt.hash : null;
      const rotated = lastHash !== null && hash !== null && hash !== lastHash;
      if (hash !== null) lastHash = hash;
      return { ...cached, rotated };
    },
  };
}

export interface SessionInfo {
  id: string;
  shortId: string;
  createdAt: number;
  userAgent: string;
}

export interface SessionStore {
  create(userAgent: string): { id: string; secret: string; expiresAt: number };
  validate(
    id: string | undefined,
    secret: string | undefined,
  ): SessionInfo | null;
  issueTicket(id: string): string | null;
  redeemTicket(
    ticket: string | undefined,
    id: string | undefined,
  ): SessionInfo | null;
  destroy(id: string): void;
  clear(): void;
  size(): number;
}

interface SessionRecord {
  secret: Buffer;
  createdAt: number;
  lastSeen: number;
  userAgent: string;
  shortId: string;
}

export function createSessionStore(now: () => number = Date.now): SessionStore {
  const sessions = new Map<string, SessionRecord>();
  const tickets = new Map<string, { id: string; issuedAt: number }>();

  const info = (id: string, r: SessionRecord): SessionInfo => ({
    id,
    shortId: r.shortId,
    createdAt: r.createdAt,
    userAgent: r.userAgent,
  });

  // Returns the record only while it is within both expiry windows. It never
  // touches lastSeen: only a fully authenticated call may extend the idle
  // window, otherwise a replayed cookie alone could keep a session alive.
  const live = (id: string | undefined): SessionRecord | null => {
    if (!id) return null;
    const r = sessions.get(id);
    if (!r) return null;
    const t = now();
    if (
      t - r.createdAt > SESSION_ABSOLUTE_MS ||
      t - r.lastSeen > SESSION_IDLE_MS
    ) {
      sessions.delete(id);
      return null;
    }
    return r;
  };

  return {
    create(userAgent) {
      const id = crypto.randomBytes(32).toString('hex');
      const secret = crypto.randomBytes(32).toString('hex');
      const t = now();
      sessions.set(id, {
        secret: Buffer.from(secret, 'hex'),
        createdAt: t,
        lastSeen: t,
        userAgent: userAgent.slice(0, 200),
        shortId: crypto
          .createHash('sha256')
          .update(id)
          .digest('hex')
          .slice(0, 12),
      });
      return { id, secret, expiresAt: t + SESSION_ABSOLUTE_MS };
    },
    validate(id, secret) {
      const r = live(id);
      if (!r || !id || typeof secret !== 'string') return null;
      const given = Buffer.from(secret, 'hex');
      if (
        given.length !== r.secret.length ||
        !crypto.timingSafeEqual(given, r.secret)
      ) {
        return null;
      }
      r.lastSeen = now();
      return info(id, r);
    },
    issueTicket(id) {
      if (!live(id)) return null;
      const t = now();
      for (const [k, v] of tickets)
        if (t - v.issuedAt > TICKET_TTL_MS) tickets.delete(k);
      const ticket = crypto.randomBytes(24).toString('hex');
      tickets.set(ticket, { id, issuedAt: t });
      return ticket;
    },
    redeemTicket(ticket, id) {
      if (!ticket || !id) return null;
      const t = tickets.get(ticket);
      if (!t) return null;
      // A mismatched session must not burn the legitimate client's ticket.
      if (t.id !== id) return null;
      tickets.delete(ticket);
      if (now() - t.issuedAt > TICKET_TTL_MS) return null;
      const r = live(id);
      if (!r) return null;
      r.lastSeen = now();
      return info(id, r);
    },
    destroy(id) {
      sessions.delete(id);
    },
    clear() {
      sessions.clear();
      tickets.clear();
    },
    size() {
      return sessions.size;
    },
  };
}

export interface Backoff {
  retryAfterMs(key: string): number;
  recordFailure(key: string): void;
  recordSuccess(key: string): void;
  reset(): void;
}

export function createBackoff(now: () => number = Date.now): Backoff {
  const failures = new Map<string, number[]>();
  const fresh = (key: string): number[] => {
    const t = now();
    const kept = (failures.get(key) ?? []).filter(
      (x) => t - x < BACKOFF_WINDOW_MS,
    );
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };
  return {
    retryAfterMs(key) {
      const f = fresh(key);
      if (f.length === 0) return 0;
      const delay = Math.min(
        BACKOFF_BASE_MS * 2 ** (f.length - 1),
        BACKOFF_MAX_MS,
      );
      return Math.max(0, f[f.length - 1] + delay - now());
    },
    recordFailure(key) {
      failures.set(key, [...(failures.get(key) ?? []), now()]);
    },
    recordSuccess(key) {
      failures.delete(key);
    },
    reset() {
      failures.clear();
    },
  };
}

export function normalizeAddr(addr: string | undefined): string {
  if (!addr) return 'unknown';
  const bare = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return bare === '::1' ? '127.0.0.1' : bare;
}

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

export function isTls(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: boolean }).encrypted === true;
}

export function sessionCookie(id: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(SESSION_ABSOLUTE_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
