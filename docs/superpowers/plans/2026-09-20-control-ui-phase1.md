# Control UI — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the control-UI server skeleton — password login with live rotation, two-part sessions, strict headers, static app shell, SSE hub — with the Agents, Wardens (toggle) and MCPs tabs backed by real files.

**Architecture:** One new localhost-only Node `http` server under `src/control-ui/`, started from `src/index.ts` next to Odysseus and closed with the other `webhookServers`. Pure functions per concern (auth, router, static, events, one API module per tab) with dependencies injected through `ControlDeps`, so every module is unit-tested on temp dirs and the server is integration-tested on port 0. The frontend is a no-build ES-module PWA under `web/control/` that builds its DOM from text nodes.

**Tech Stack:** Node 20+ built-ins only (`http`, `crypto`, `fs`, `path`, `util`), vitest, Playwright (already in devDependencies) for the screenshot artifact, `sharp` (already installed) for the PWA icons.

**Spec:** `docs/superpowers/specs/2026-09-20-control-ui-design.md`. Recon and assumptions: `docs/control-ui-notes.md`.

## Global Constraints

- No new runtime dependencies; no framework; no CDN; no build step for `web/control/`; no inline `<script>`/`<style>`.
- Bind `127.0.0.1` only. Default port `3017`. Off unless `CONTROL_UI_ENABLED=1`. `CONTROL_UI_READONLY=1` refuses every mutation except `/auth/*`.
- Secrets never enter `src/config.ts` (the credential file path is config; its contents are loaded in `auth.ts`). Nothing secret is logged. The password is never printed when stdout is not a TTY.
- Fail closed: enabled + unreadable credential file ⇒ FATAL log + `process.exit(1)`, mirroring `src/odysseus-server.ts:360-383`.
- Cross-platform: `path.join`, `os.homedir()`, no shell strings, `fs.chmod` tolerated as a no-op on Windows.
- Public-repo generic: no personal paths, handles, assistant or unit names anywhere in the diff (the assistant name is read from `ASSISTANT_NAME` at runtime).
- Comment discipline: comments only for non-obvious WHY. Strict TypeScript, no `any`.
- Every state-changing verb requires the session cookie **and** the `X-Deus-Session` header; disabling a warden additionally requires `X-Confirm: <name>`.
- Security headers (CSP, frame denial, no-referrer, nosniff) on **every** response.
- Tests live in `src/control-ui/**/*.test.ts` (vitest include is `src/**/*.test.ts`).
- Rollback: unset `CONTROL_UI_ENABLED` — additive files only, no migration, no shared state.

---

## Design (patterns and data structures)

- **Observer / pub-sub** — `events.ts`: handlers `broadcast(type, data)`; attached SSE responses observe. Ring buffer of 256 frames bounds memory and gives `Last-Event-ID` replay. `Map<ServerResponse, number>` holds a per-client stall counter (O(1)); two consecutive full-buffer writes drop the client.
- **Table-driven Strategy dispatch** — `router.ts`: a linear table of `{ method, segments, handler, auth, mutation }`. Route count stays under ~60, so a scan is correct and a trie would be unearned complexity.
- **Parameter injection** — `ControlDeps` is passed into `createControlServer`; handlers never read `process.env` or import the DB. This is what lets `server.test.ts` run on a temp directory with a throwaway credential.
- **Live credential source** — `createCredentialSource(file)` caches the parsed file keyed by `mtimeMs:size` and reports `rotated: true` once when the scrypt hash changes; the server clears sessions and backoff on that signal. A `stat` per request replaces a restart.
- **Two-part session** — `Map<id, { secret: Buffer, createdAt, lastSeen, userAgent, shortId }>`; the cookie carries the id, the `X-Deus-Session` header carries the hex secret, compared with `timingSafeEqual`. Single-use SSE tickets live in a second `Map<ticket, { id, issuedAt }>`, pruned on issue.
- **Exponential backoff** — `Map<address, number[]>` of failure timestamps within a 15-minute window; delay `min(1 s × 2^(n−1), 5 min)` from the last failure. Chosen over a hard lock because all clients arrive as loopback.
- **Registry-with-template** — wardens: `config.json` if present, else `config.json.example`; first write materialises `config.json`.

## File map

| Path | Responsibility |
|------|----------------|
| `src/config.ts` (modify, after line 121) | `CONTROL_UI_ENABLED`, `CONTROL_UI_PORT`, `CONTROL_UI_READONLY`, `CONTROL_UI_CREDENTIAL_FILE` |
| `src/control-ui/auth.ts` (create) | scrypt hash/verify, credential file read/write, live credential source, session store with secrets + tickets, backoff, address normalisation, cookie helpers |
| `src/control-ui/auth.oracle.test.ts` (created by **oracle-author**, `@oracle`) | independent red-green contract for auth |
| `src/control-ui/auth.test.ts` (create) | implementer edge cases |
| `src/control-ui/router.ts` (create) | method + `:param` matcher with `auth` and `mutation` flags |
| `src/control-ui/static.ts` (create) | traversal-safe static serving + exported `SECURITY_HEADERS` |
| `src/control-ui/events.ts` (create) | SSE hub |
| `src/control-ui/api/agents.ts`, `api/wardens.ts`, `api/mcps.ts` (create) | tab data modules |
| `src/control-ui/server.ts` (create) | `createControlServer` / `startControlServer` / `readPackageVersion` |
| `src/control-ui/*.test.ts`, `src/control-ui/api/*.test.ts` (create) | unit tests + `server.test.ts` integration |
| `scripts/control-ui-credential.mjs` (create) | generate/rotate the password; TTY → print once, else write `<file>.first-password` (0600) and print the path |
| `scripts/control-ui-icons.mjs` (create) | one-off PNG icon generation with `sharp` |
| `scripts/control-ui-screenshot.mjs` (create) | Playwright capture; password read from a file path, never argv/env value |
| `web/control/index.html`, `app.css`, `app.js`, `dom.js`, `views/agents.js`, `views/wardens.js`, `views/mcps.js`, `manifest.webmanifest`, `sw.js`, `icons/icon.svg`, `icons/icon-192.png`, `icons/icon-512.png` (create) | app shell and Phase 1 tabs |
| `src/index.ts` (modify, after line 510) | start the server, push onto `webhookServers` |
| `.env.example` (modify, after the Odysseus block) | document the four variables |
| `docs/control-ui-notes.md`, `docs/control-ui-progress.md` (modify) | verification record + artifact reference, progress row |
| `docs/control-ui/artifacts/phase1-*.png` (create) | screenshots for `visual-verification-artifact-required` |

Consuming call sites for every rendering component (rule `visual-verification-required`): `views/agents.js`, `views/wardens.js`, `views/mcps.js` are imported and mounted by `web/control/app.js` `VIEWS`; `app.js` is loaded by `web/control/index.html` `<script type="module">`; `index.html` is served by `src/control-ui/static.ts` from `src/control-ui/server.ts`, which `src/index.ts` starts. Confirmed by the screenshot task.

## API surface verified (rule `api-surface-verification`)

- `readEnvFile(keys: string[]): Record<string,string>` — `src/env.ts:11`, cwd-relative `.env`, never touches `process.env`.
- `createRateLimiter(max, windowMs, opts?) → { isRateLimited(key, now?), dispose(), resetForTest() }` — `src/rate-limiter.ts:12`.
- `logger` (pino) — `logger.info(obj, msg)` / `warn` / `error` — `src/logger.ts`.
- `CONFIG_DIR = path.join(HOME_DIR, '.config', 'deus')` — `src/config.ts:45`; `PROJECT_ROOT = path.resolve(process.cwd())` — `:43`; `ASSISTANT_NAME` — `:34`.
- `webhookServers: Server[]` — `src/index.ts:146`, closed at `:178`; Odysseus pushed at `:510`. No version accessor exists in `src/index.ts`.
- Agent frontmatter fields across 27 files: `name`, `model`, `description`, `explores_code`, `color`, `version`, `linear_label`, `tools` (block list, `.claude/agents/code-explorer.md:10-14`).
- Wardens config shape: `.claude/wardens/config.json.example`; `config.json` gitignored (`.gitignore:41`).
- Container MCPs: `deus` always; `gcal` when `packages/mcp-gcal/dist/index.js`, `integrations/gcal/credentials.json`, `integrations/gcal/tokens.json` exist (`container/agent-runner/src/index.ts:815-822`); `linear` when `LINEAR_API_KEY` is set (`:827`).
- Channel credential signals: WhatsApp `store/auth/creds.json`; `TELEGRAM_BOT_TOKEN`; `DISCORD_BOT_TOKEN`; `SLACK_BOT_TOKEN`; `GMAIL_CREDENTIALS_DIR` (default `~/.gmail-mcp`, `src/channels/mcp-gmail.ts:17`); `OUTLOOK_CREDENTIALS_DIR` (`src/channels/mcp-outlook.ts:20`); `TEAMS_APP_ID`; `X_API_KEY` (`packages/mcp-x/src`).
- Containers never use `--network host` (`src/container-runner.ts`); bridge + `--add-host=host.docker.internal:host-gateway` (`src/platform.ts:185`).

## Verification strategy (frozen before implementation)

| Check | Command | Expected (predicted now) |
|-------|---------|--------------------------|
| Unit + integration | `npx vitest run src/control-ui` | all files pass; `auth.oracle.test.ts` fails before Task 1 implementation and passes after, untouched |
| Type check | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| Lint | `npx eslint src/control-ui scripts/control-ui-*.mjs web/control` | 0 errors |
| Headers | `curl -sI http://127.0.0.1:3117/` | contains `content-security-policy: default-src 'none'`, `x-frame-options: DENY`, `referrer-policy: no-referrer` |
| Unauthenticated API | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3117/api/v1/agents` | `401` |
| Cookie alone | `GET /api/v1/agents` with the cookie but no `X-Deus-Session` | `401` |
| Login + agents | login, then `GET /api/v1/agents` with cookie + header | `200`, JSON array of **27** objects, each with `name` and `description` |
| Backoff | 3 wrong passwords, then a 4th immediately | 4th → `429 {"error":"locked","retry_after_ms":<≈4000>}` |
| Rotation | re-run the credential script, then reuse the old session | `401`; old password `401`; new password `200` |
| Traversal | `GET /..%2f..%2fetc%2fpasswd` and `GET /../package.json` | `404` |
| Warden toggle | `PATCH /api/v1/wardens/threat-modeler {"enabled":false}` without `X-Confirm` → `428`; with `X-Confirm: threat-modeler` → `200 {..."enabled":false}`; `.claude/wardens/config.json` created, `.bak-` on second write |
| Read-only | same PATCH with `CONTROL_UI_READONLY=1` | `403 {"error":"read-only mode"}` |
| SSE | `POST /api/v1/events/ticket` then `curl -N '/api/v1/events?ticket=…'` after a toggle | `: ok` then `event: warden`; reusing the ticket → `401` |
| Visual (blocking rule) | `node scripts/control-ui-screenshot.mjs` against the running server | PNGs in `docs/control-ui/artifacts/`; reviewed: bottom nav with the tabs on mobile, sidebar on desktop, agent cards visible, warden toggle and confirmation rendered; record in `docs/control-ui-notes.md` with PASS/FAIL |

Not covered: real service deployment (Phase 5), Chat/Sessions (Phase 2).

Taste-pass: skipped — the user specified the design ("mimic OpenClaw's Control UI", dark, mobile-first).

Oracle: auth is credential surface (rule `independent-oracle-high-blast-radius`). `scripts/dispatch-oracle-author.sh` needs `codex`, which is not installed here, so the fallback `Agent(subagent_type="oracle-author")` is used with the auth contract below. The implementer makes it pass without editing it.

---

### Task 1: Auth primitives (oracle first)

**Files:**
- Create: `src/control-ui/auth.ts`
- Create (oracle-author): `src/control-ui/auth.oracle.test.ts`
- Create: `src/control-ui/auth.test.ts`
- Modify: `src/config.ts:121` (append constants)

**Interfaces (Produces):**
- `SESSION_COOKIE = 'deus_ctl'`, `SESSION_HEADER = 'x-deus-session'`, `SESSION_IDLE_MS = 43_200_000`, `SESSION_ABSOLUTE_MS = 604_800_000`, `TICKET_TTL_MS = 60_000`, `BACKOFF_BASE_MS = 1000`, `BACKOFF_MAX_MS = 300_000`, `BACKOFF_WINDOW_MS = 900_000`
- `interface ScryptRecord { salt: string; hash: string; N: number; r: number; p: number }`, `interface CredentialFile { scrypt: ScryptRecord; created_at: string }`
- `generatePassword(): string` — 24 random bytes, base64url
- `hashPassword(password: string): ScryptRecord` — sync; N=16384, r=8, p=1, keylen 32, 16-byte salt
- `verifyPassword(password: string, rec: ScryptRecord): Promise<boolean>` — async scrypt + constant-time compare
- `writeCredentialFile(file: string, password: string): void` — mkdir 0700, write 0600, chmod 0600
- `loadCredentialFile(file: string): CredentialLoad` where `CredentialLoad = { ok: true; cred: CredentialFile } | { ok: false; reason: string }`
- `createCredentialSource(file: string): { current(): CredentialLoad & { rotated: boolean } }` — re-reads when `mtimeMs:size` changes; `rotated` is true exactly once after the scrypt hash changes
- `createSessionStore(now?: () => number): SessionStore` where `SessionInfo = { id: string; shortId: string; createdAt: number; userAgent: string }` and `SessionStore = { create(userAgent: string): { id: string; secret: string; expiresAt: number }; validate(id?: string, secret?: string): SessionInfo | null; issueTicket(id: string): string | null; redeemTicket(ticket: string | undefined, id: string | undefined): SessionInfo | null; destroy(id: string): void; clear(): void; size(): number }`
- `createBackoff(now?: () => number): Backoff` where `Backoff = { retryAfterMs(key: string): number; recordFailure(key: string): void; recordSuccess(key: string): void; reset(): void }`
- `normalizeAddr(addr: string | undefined): string` — `::1` and `::ffff:127.0.0.1` → `127.0.0.1`; other `::ffff:` prefixes stripped; `undefined` → `'unknown'`
- `parseCookies(header?: string): Record<string, string>`, `isTls(req: IncomingMessage): boolean` (socket only), `sessionCookie(id: string, secure: boolean): string`, `clearSessionCookie(secure: boolean): string`

- [ ] **Step 1: Dispatch oracle-author** with this brief (fallback agent, codex absent):

> Author `src/control-ui/auth.oracle.test.ts` (vitest, tag the describe block `@oracle`) from the spec section "Auth" and the interface list in Task 1 of this plan, blind to any implementation. Cover: (1) `verifyPassword` resolves true for the password `hashPassword` was given and false for a one-character change; (2) `hashPassword` yields different `salt`/`hash` for the same password twice; (3) `writeCredentialFile` then `loadCredentialFile` round-trips and the file mode is `0o600` on POSIX; (4) `loadCredentialFile` returns `ok:false` for a missing file, non-JSON, and JSON without `scrypt`; (5) `createCredentialSource(file).current()` returns the parsed record, reports `rotated:false` on the first and on unchanged calls, `rotated:true` exactly once after `writeCredentialFile` is called again with a new password (bump the file's mtime with `fs.utimesSync` to a later second so the stamp differs), and `ok:false` after the file is deleted; (6) session `validate(id, secret)` is null for an unknown id, for the right id with a wrong secret, and for a secret of the wrong length; non-null after `create`; null after `destroy` and after `clear`; null once `now` advances past `SESSION_IDLE_MS`; null once it advances past `SESSION_ABSOLUTE_MS` even with continuous touches; (7) `issueTicket` returns null for an unknown id; `redeemTicket(ticket, id)` returns the session once, then null on reuse, null when `id` mismatches, null after `TICKET_TTL_MS` elapses; (8) backoff: `retryAfterMs` is 0 with no failures, ≈`BACKOFF_BASE_MS` after one failure, doubles per failure, caps at `BACKOFF_MAX_MS`, returns to 0 once `now` passes the delay, forgets failures older than `BACKOFF_WINDOW_MS`, and `recordSuccess`/`reset` clear it; (9) `normalizeAddr` maps `::1` and `::ffff:127.0.0.1` to `127.0.0.1`, leaves `10.0.0.5`, and maps `undefined` to `'unknown'`; (10) `sessionCookie` contains `HttpOnly`, `SameSite=Strict`, `Path=/`, includes `Secure` only when `secure` is true; `clearSessionCookie` has `Max-Age=0`; (11) `parseCookies` handles `a=1; b=2`, a missing header, and `=` inside values. Use `fs.mkdtempSync` for files and an injected `now` for time.

- [ ] **Step 2: Run the oracle to verify it fails**

Run: `npx vitest run src/control-ui/auth.oracle.test.ts`
Expected: FAIL — "Cannot find module './auth.js'".

- [ ] **Step 3: Add config constants** — append to `src/config.ts` after the `ODYSSEUS_HTTP_PORT` block:

```ts
// Control UI (OpenClaw-style dashboard, src/control-ui/). Off by default. Only
// the credential file PATH lives here — its contents are loaded by
// control-ui/auth.ts, matching the "secrets not in config.ts" rule.
export const CONTROL_UI_ENABLED =
  process.env.CONTROL_UI_ENABLED === '1' ||
  process.env.CONTROL_UI_ENABLED === 'true';
export const CONTROL_UI_PORT = parseInt(
  process.env.CONTROL_UI_PORT || '3017',
  10,
);
export const CONTROL_UI_READONLY =
  process.env.CONTROL_UI_READONLY === '1' ||
  process.env.CONTROL_UI_READONLY === 'true';
export const CONTROL_UI_CREDENTIAL_FILE =
  process.env.CONTROL_UI_CREDENTIAL_FILE ||
  path.join(CONFIG_DIR, 'control-ui.json');
```

- [ ] **Step 4: Write `src/control-ui/auth.ts`**

```ts
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
  const actual = await scrypt(password, Buffer.from(rec.salt, 'hex'), expected.length, {
    N: rec.N,
    r: rec.r,
    p: rec.p,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
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
  | { ok: true; cred: CredentialFile }
  | { ok: false; reason: string };

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
        return { ok: false, reason: `credential file not readable: ${file}`, rotated: false };
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
  validate(id: string | undefined, secret: string | undefined): SessionInfo | null;
  issueTicket(id: string): string | null;
  redeemTicket(ticket: string | undefined, id: string | undefined): SessionInfo | null;
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

  const live = (id: string | undefined): SessionRecord | null => {
    if (!id) return null;
    const r = sessions.get(id);
    if (!r) return null;
    const t = now();
    if (t - r.createdAt > SESSION_ABSOLUTE_MS || t - r.lastSeen > SESSION_IDLE_MS) {
      sessions.delete(id);
      return null;
    }
    r.lastSeen = t;
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
        shortId: crypto.createHash('sha256').update(id).digest('hex').slice(0, 12),
      });
      return { id, secret, expiresAt: t + SESSION_ABSOLUTE_MS };
    },
    validate(id, secret) {
      const r = live(id);
      if (!r || typeof secret !== 'string' || !id) return null;
      const given = Buffer.from(secret, 'hex');
      if (given.length !== r.secret.length || !crypto.timingSafeEqual(given, r.secret)) return null;
      return info(id, r);
    },
    issueTicket(id) {
      if (!live(id)) return null;
      const t = now();
      for (const [k, v] of tickets) if (t - v.issuedAt > TICKET_TTL_MS) tickets.delete(k);
      const ticket = crypto.randomBytes(24).toString('hex');
      tickets.set(ticket, { id, issuedAt: t });
      return ticket;
    },
    redeemTicket(ticket, id) {
      if (!ticket || !id) return null;
      const t = tickets.get(ticket);
      if (!t) return null;
      tickets.delete(ticket);
      if (t.id !== id || now() - t.issuedAt > TICKET_TTL_MS) return null;
      const r = live(id);
      return r ? info(id, r) : null;
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
    const kept = (failures.get(key) ?? []).filter((x) => t - x < BACKOFF_WINDOW_MS);
    if (kept.length) failures.set(key, kept);
    else failures.delete(key);
    return kept;
  };
  return {
    retryAfterMs(key) {
      const f = fresh(key);
      if (f.length === 0) return 0;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (f.length - 1), BACKOFF_MAX_MS);
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

export function parseCookies(header: string | undefined): Record<string, string> {
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
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
```

- [ ] **Step 5: Run the oracle**

Run: `npx vitest run src/control-ui/auth.oracle.test.ts`
Expected: PASS, file untouched.

- [ ] **Step 6: Implementer edge cases** `src/control-ui/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createBackoff,
  createCredentialSource,
  createSessionStore,
  isTls,
  loadCredentialFile,
  parseCookies,
  verifyPassword,
  writeCredentialFile,
} from './auth.js';

describe('control-ui auth edge cases', () => {
  it('verifyPassword rejects a record whose hash length differs', async () => {
    await expect(
      verifyPassword('x', { salt: 'ab'.repeat(16), hash: 'ab', N: 2, r: 1, p: 1 }),
    ).resolves.toBe(false);
  });

  it('loadCredentialFile rejects a non-hex salt', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'c.json');
    fs.writeFileSync(file, JSON.stringify({ scrypt: { salt: 'zz'.repeat(16), hash: 'ab'.repeat(32), N: 2, r: 1, p: 1 } }));
    expect(loadCredentialFile(file)).toEqual({ ok: false, reason: 'credential file has no valid scrypt record' });
  });

  it('credential source does not report rotation when the file is rewritten with the same hash', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')), 'c.json');
    writeCredentialFile(file, 'pw');
    const src = createCredentialSource(file);
    expect(src.current().rotated).toBe(false);
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw + '\n');
    fs.utimesSync(file, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
    expect(src.current().rotated).toBe(false);
  });

  it('session validate touches lastSeen so idle resets; secret must be hex', () => {
    let t = 0;
    const store = createSessionStore(() => t);
    const { id, secret } = store.create('ua');
    t = 11 * 60 * 60_000;
    expect(store.validate(id, secret)?.userAgent).toBe('ua');
    t += 11 * 60 * 60_000;
    expect(store.validate(id, secret)).not.toBeNull();
    expect(store.validate(id, 'not-hex')).toBeNull();
    expect(store.size()).toBe(1);
  });

  it('backoff caps at five minutes', () => {
    let t = 0;
    const b = createBackoff(() => t);
    for (let i = 0; i < 12; i++) b.recordFailure('k');
    expect(b.retryAfterMs('k')).toBe(5 * 60_000);
  });

  it('isTls ignores forwarded headers; cookies keep = in values', () => {
    const req = { socket: {}, headers: { 'x-forwarded-proto': 'https' } } as never;
    expect(isTls(req)).toBe(false);
    expect(parseCookies('a=1;b=x=y')).toEqual({ a: '1', b: 'x=y' });
  });
});
```

- [ ] **Step 7: Run all auth tests + typecheck**

Run: `npx vitest run src/control-ui/auth && npx tsc --noEmit -p tsconfig.json`
Expected: PASS / exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/control-ui/auth.ts src/control-ui/auth.test.ts src/control-ui/auth.oracle.test.ts
git commit -m "feat(control-ui): add auth primitives (scrypt credential source, two-part sessions, backoff)"
```

---

### Task 2: Router, static server with security headers, SSE hub

**Files:**
- Create: `src/control-ui/router.ts`, `src/control-ui/static.ts`, `src/control-ui/events.ts`
- Test: `src/control-ui/router.test.ts`, `src/control-ui/static.test.ts`, `src/control-ui/events.test.ts`

**Interfaces (Produces):**
- `type AuthMode = 'session' | 'ticket' | 'none'`
- `interface RequestContext { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string,string>; body: unknown; remoteAddr: string; session: SessionInfo | null }`
- `type Handler = (ctx: RequestContext) => void | Promise<void>`
- `createRouter(): { add(method, pattern, handler, opts?: { auth?: AuthMode; mutation?: boolean }): void; match(method, pathname): Match }` with `Match = { kind: 'ok'; handler; auth: AuthMode; mutation: boolean; params } | { kind: 'not_found' } | { kind: 'method_not_allowed' }`; `mutation` defaults to `method !== 'GET' && method !== 'HEAD'`
- `SECURITY_HEADERS: Record<string, string>`; `resolveStaticPath(rootDir, urlPath): string | null`; `serveStatic(rootDir, urlPath, res): void`
- `createEventHub(opts?): EventHub` with `EventHub = { attach(req, res): boolean; broadcast(type, data): void; clientCount(): number; close(): void }`

- [ ] **Step 1: Write failing tests**

`src/control-ui/router.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createRouter } from './router.js';

describe('control-ui router', () => {
  it('matches params, flags, and distinguishes 404 from 405', () => {
    const r = createRouter();
    const h = () => {};
    r.add('GET', '/api/v1/wardens/:name', h);
    r.add('PATCH', '/api/v1/wardens/:name', h, { auth: 'none' });
    r.add('POST', '/api/v1/events/ticket', h, { mutation: false });
    expect(r.match('PATCH', '/api/v1/wardens/plan%2Dreviewer')).toMatchObject({ kind: 'ok', auth: 'none', mutation: true, params: { name: 'plan-reviewer' } });
    expect(r.match('GET', '/api/v1/wardens/x')).toMatchObject({ kind: 'ok', auth: 'session', mutation: false });
    expect(r.match('POST', '/api/v1/events/ticket')).toMatchObject({ kind: 'ok', mutation: false });
    expect(r.match('DELETE', '/api/v1/wardens/x').kind).toBe('method_not_allowed');
    expect(r.match('GET', '/api/v1/nope').kind).toBe('not_found');
    expect(r.match('GET', '/api/v1/wardens/a/b').kind).toBe('not_found');
  });
});
```

`src/control-ui/static.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveStaticPath, SECURITY_HEADERS } from './static.js';

describe('control-ui static', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-static-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');

  it('maps / to index.html and blocks traversal', () => {
    expect(resolveStaticPath(root, '/')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticPath(root, '/index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveStaticPath(root, '/../package.json')).toBeNull();
    expect(resolveStaticPath(root, '/..%2f..%2fetc%2fpasswd')).toBeNull();
    expect(resolveStaticPath(root, '/%00')).toBeNull();
    expect(resolveStaticPath(root, '/%ZZ')).toBeNull();
  });

  it('ships a strict CSP with no inline allowances', () => {
    const csp = SECURITY_HEADERS['Content-Security-Policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  });
});
```

`src/control-ui/events.test.ts` (unchanged from the reviewed design):
```ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { createEventHub } from './events.js';

function fakeRes() {
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead: () => res,
    write: (s: string) => { chunks.push(s); return true; },
    end: () => {},
    chunks,
  });
  return res;
}

describe('control-ui event hub', () => {
  it('broadcasts frames, replays from Last-Event-ID, caps clients', () => {
    const hub = createEventHub({ maxClients: 1, ringSize: 2, keepaliveMs: 60_000 });
    const req1 = Object.assign(new EventEmitter(), { headers: {} });
    const res1 = fakeRes();
    expect(hub.attach(req1 as never, res1 as never)).toBe(true);
    hub.broadcast('warden', { name: 'a' });
    expect(res1.chunks.join('')).toContain('event: warden');
    expect(res1.chunks.join('')).toContain('data: {"name":"a"}');
    const res2 = fakeRes();
    expect(hub.attach(req1 as never, res2 as never)).toBe(false);
    req1.emit('close');
    expect(hub.clientCount()).toBe(0);
    hub.broadcast('warden', { name: 'b' });
    hub.broadcast('warden', { name: 'c' });
    const req3 = Object.assign(new EventEmitter(), { headers: { 'last-event-id': '1' } });
    const res3 = fakeRes();
    hub.attach(req3 as never, res3 as never);
    const replay = res3.chunks.join('');
    expect(replay).toContain('"name":"b"');
    expect(replay).toContain('"name":"c"');
    expect(replay).not.toContain('"name":"a"');
    hub.close();
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/control-ui/router src/control-ui/static src/control-ui/events` → FAIL, modules not found.

- [ ] **Step 3: Implement `router.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'http';
import type { SessionInfo } from './auth.js';

export type AuthMode = 'session' | 'ticket' | 'none';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: unknown;
  remoteAddr: string;
  session: SessionInfo | null;
}

export type Handler = (ctx: RequestContext) => void | Promise<void>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  auth: AuthMode;
  mutation: boolean;
}

export type Match =
  | { kind: 'ok'; handler: Handler; auth: AuthMode; mutation: boolean; params: Record<string, string> }
  | { kind: 'not_found' }
  | { kind: 'method_not_allowed' };

const split = (p: string): string[] => p.split('/').filter(Boolean);

export function createRouter() {
  const routes: Route[] = [];
  return {
    add(method: string, pattern: string, handler: Handler, opts?: { auth?: AuthMode; mutation?: boolean }) {
      routes.push({
        method,
        segments: split(pattern),
        handler,
        auth: opts?.auth ?? 'session',
        mutation: opts?.mutation ?? (method !== 'GET' && method !== 'HEAD'),
      });
    },
    match(method: string, pathname: string): Match {
      const parts = split(pathname);
      let pathMatched = false;
      for (const r of routes) {
        if (r.segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < parts.length; i++) {
          const seg = r.segments[i];
          if (seg.startsWith(':')) {
            try {
              params[seg.slice(1)] = decodeURIComponent(parts[i]);
            } catch {
              ok = false;
              break;
            }
          } else if (seg !== parts[i]) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        pathMatched = true;
        if (r.method === method) {
          return { kind: 'ok', handler: r.handler, auth: r.auth, mutation: r.mutation, params };
        }
      }
      return pathMatched ? { kind: 'method_not_allowed' } : { kind: 'not_found' };
    },
  };
}
```

- [ ] **Step 4: Implement `static.ts`**

```ts
import fs from 'fs';
import type { ServerResponse } from 'http';
import path from 'path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Applied to EVERY response by server.ts. The app has no inline script or
// style, so the CSP needs no nonce; anything rendered from API data goes in
// as a text node, and the policy is the backstop if that rule is ever broken.
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

export function resolveStaticPath(rootDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const root = path.resolve(rootDir);
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

export function serveStatic(rootDir: string, urlPath: string, res: ServerResponse): void {
  const full = resolveStaticPath(rootDir, urlPath);
  let data: Buffer;
  try {
    if (!full || !fs.statSync(full).isFile()) throw new Error('not a file');
    data = fs.readFileSync(full);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  const ext = path.extname(full).toLowerCase();
  // The shell and the service worker must never be served stale; assets may be.
  const cache = ext === '.html' || path.basename(full) === 'sw.js' ? 'no-cache' : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': cache,
  });
  res.end(data);
}
```

- [ ] **Step 5: Implement `events.ts`**

```ts
import type { IncomingMessage, ServerResponse } from 'http';

export interface EventHub {
  attach(req: IncomingMessage, res: ServerResponse): boolean;
  broadcast(type: string, data: unknown): void;
  clientCount(): number;
  close(): void;
}

export function createEventHub(opts: { keepaliveMs?: number; ringSize?: number; maxClients?: number } = {}): EventHub {
  const keepaliveMs = opts.keepaliveMs ?? 20_000;
  const ringSize = opts.ringSize ?? 256;
  const maxClients = opts.maxClients ?? 8;
  const clients = new Map<ServerResponse, number>(); // res → consecutive full-buffer writes
  const ring: { id: number; frame: string }[] = [];
  let nextId = 1;

  const timer = setInterval(() => {
    for (const res of clients.keys()) res.write(': ping\n\n');
  }, keepaliveMs);
  timer.unref();

  return {
    attach(req, res) {
      if (clients.size >= maxClients) return false;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': ok\n\n');
      const last = Number(req.headers['last-event-id']);
      if (Number.isFinite(last)) for (const e of ring) if (e.id > last) res.write(e.frame);
      clients.set(res, 0);
      req.on('close', () => clients.delete(res));
      return true;
    },
    broadcast(type, data) {
      const id = nextId++;
      const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      ring.push({ id, frame });
      if (ring.length > ringSize) ring.shift();
      for (const [res, stalls] of clients) {
        if (res.write(frame)) clients.set(res, 0);
        else if (stalls + 1 >= 2) {
          clients.delete(res);
          res.end();
        } else clients.set(res, stalls + 1);
      }
    },
    clientCount() {
      return clients.size;
    },
    close() {
      clearInterval(timer);
      for (const res of clients.keys()) res.end();
      clients.clear();
    },
  };
}
```

- [ ] **Step 6: Run tests + typecheck** — `npx vitest run src/control-ui && npx tsc --noEmit -p tsconfig.json` → PASS / 0.

- [ ] **Step 7: Commit**

```bash
git add src/control-ui/router.ts src/control-ui/router.test.ts src/control-ui/static.ts src/control-ui/static.test.ts src/control-ui/events.ts src/control-ui/events.test.ts
git commit -m "feat(control-ui): add router, static server with security headers, and SSE hub"
```

---

### Task 3: Agents, Wardens, MCPs API modules

**Files:**
- Create: `src/control-ui/api/agents.ts`, `api/wardens.ts`, `api/mcps.ts`
- Test: `src/control-ui/api/agents.test.ts`, `api/wardens.test.ts`, `api/mcps.test.ts`

**Interfaces (Produces):**
- `interface AgentInfo { name; description; model?; tools?: string[]; explores_code?; color?; version?; linear_label?; file }`; `parseFrontmatter(text): Record<string, unknown>`; `listAgents(agentsDir): AgentInfo[]`
- `interface WardenInfo { name; enabled; tools: string[]; backends?; auto_threshold?; custom_instructions: string | null; rules_file: string | null }`; `listWardens(wardensDir): WardenInfo[]`; `setWardenEnabled(wardensDir, name, enabled): WardenInfo | null`
- `interface McpInventory { container: { name; source; conditional; available }[]; skills: { name; dir; has_test }[]; channels: { package; built; configured: boolean | null }[] }`; `listMcps(repoRoot, envHas): McpInventory`

- [ ] **Step 1: Write failing tests**

`src/control-ui/api/agents.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listAgents, parseFrontmatter } from './agents.js';

const SAMPLE = `---
name: code-explorer
description: Fast read-only code exploration. <example>x</example>
model: sonnet
explores_code: true
tools:
  - Bash
  - Read
color: "blue"
---
# body
`;

describe('control-ui agents', () => {
  it('parses scalars, booleans, quoted strings and block lists', () => {
    expect(parseFrontmatter(SAMPLE)).toEqual({
      name: 'code-explorer',
      description: 'Fast read-only code exploration. <example>x</example>',
      model: 'sonnet',
      explores_code: true,
      tools: ['Bash', 'Read'],
      color: 'blue',
    });
    expect(parseFrontmatter('no frontmatter')).toEqual({});
    expect(parseFrontmatter('---\nlist: [a, b]\nn: 3\n---')).toEqual({ list: ['a', 'b'], n: 3 });
  });

  it('lists only .md files with a name, sorted, ignoring subdirectories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-agents-'));
    fs.writeFileSync(path.join(dir, 'b.md'), SAMPLE.replace('code-explorer', 'zeta'));
    fs.writeFileSync(path.join(dir, 'a.md'), SAMPLE);
    fs.writeFileSync(path.join(dir, 'README.md'), '# no frontmatter');
    fs.mkdirSync(path.join(dir, 'wardens'));
    const agents = listAgents(dir);
    expect(agents.map((a) => a.name)).toEqual(['code-explorer', 'zeta']);
    expect(agents[0].file).toBe('a.md');
    expect(agents[0].tools).toEqual(['Bash', 'Read']);
  });
});
```

`src/control-ui/api/wardens.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listWardens, setWardenEnabled } from './wardens.js';

const EXAMPLE = {
  'plan-reviewer': { enabled: true, tools: ['Edit'], custom_instructions: null },
  'code-reviewer': { enabled: true, tools: ['Bash'], backends: ['claude'], custom_instructions: null },
  'session-retrospective': { enabled: false, auto_threshold: 20, custom_instructions: 'x' },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-wardens-'));
  fs.writeFileSync(path.join(dir, 'config.json.example'), JSON.stringify(EXAMPLE));
  fs.writeFileSync(path.join(dir, 'plan-review-rules.md'), '#');
  fs.writeFileSync(path.join(dir, 'code-review-rules.md'), '#');
  fs.writeFileSync(path.join(dir, 'retrospective-schema.md'), '#');
  return dir;
}

describe('control-ui wardens', () => {
  it('falls back to the example and resolves rules files', () => {
    const list = listWardens(fixture());
    expect(list.map((w) => w.name)).toEqual(['code-reviewer', 'plan-reviewer', 'session-retrospective']);
    expect(list[1]).toEqual({ name: 'plan-reviewer', enabled: true, tools: ['Edit'], custom_instructions: null, rules_file: 'plan-review-rules.md' });
    expect(list[2].rules_file).toBe('retrospective-schema.md');
    expect(list[2].auto_threshold).toBe(20);
  });

  it('toggles into config.json, backs up on rewrite, rejects unknown names', () => {
    const dir = fixture();
    expect(setWardenEnabled(dir, 'nope', false)).toBeNull();
    expect(setWardenEnabled(dir, 'plan-reviewer', false)?.enabled).toBe(false);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'))).toHaveLength(0);
    setWardenEnabled(dir, 'plan-reviewer', true);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'))).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    expect(written['plan-reviewer'].enabled).toBe(true);
    expect(written['code-reviewer'].backends).toEqual(['claude']);
  });
});
```

`src/control-ui/api/mcps.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listMcps } from './mcps.js';

describe('control-ui mcps', () => {
  it('inventories container, skill and channel MCPs from the filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-mcps-'));
    const mk = (p: string) => { fs.mkdirSync(path.join(root, path.dirname(p)), { recursive: true }); fs.writeFileSync(path.join(root, p), ''); };
    mk('packages/mcp-gcal/dist/index.js');
    mk('packages/mcp-telegram/dist/index.js');
    mk('packages/mcp-x/package.json');
    mk('packages/mcp-channel-core/package.json');
    mk('container/agent-runner/src/skills/social-publish/agent.ts');
    mk('container/agent-runner/src/skills/social-publish/agent.test.ts');
    mk('store/auth/creds.json');
    mk('packages/mcp-whatsapp/dist/index.js');
    const inv = listMcps(root, (k) => k === 'TELEGRAM_BOT_TOKEN');
    expect(inv.container.map((c) => [c.name, c.available])).toEqual([['deus', true], ['gcal', false], ['linear', false]]);
    expect(inv.skills).toEqual([{ name: 'social-publish', dir: 'container/agent-runner/src/skills/social-publish', has_test: true }]);
    expect(inv.channels).toEqual([
      { package: 'mcp-gcal', built: true, configured: null },
      { package: 'mcp-telegram', built: true, configured: true },
      { package: 'mcp-whatsapp', built: true, configured: true },
      { package: 'mcp-x', built: false, configured: false },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/control-ui/api` → FAIL, modules not found.

- [ ] **Step 3: Implement `api/agents.ts`**

```ts
import fs from 'fs';
import path from 'path';

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  explores_code?: boolean;
  color?: string;
  version?: string;
  linear_label?: string;
  file: string;
}

function scalar(raw: string): unknown {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => String(scalar(s))).filter(Boolean);
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Minimal YAML subset used by .claude/agents: scalars, inline lists, block lists. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') break;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2] === '' ? [] : scalar(kv[2]);
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key && Array.isArray(out[key])) {
      (out[key] as unknown[]).push(scalar(item[1]));
      continue;
    }
    if (key && typeof out[key] === 'string' && /^\s+\S/.test(line)) out[key] = `${out[key]} ${line.trim()}`;
  }
  return out;
}

const STRING_FIELDS = ['model', 'color', 'version', 'linear_label'] as const;

export function listAgents(agentsDir: string): AgentInfo[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const fm = parseFrontmatter(fs.readFileSync(path.join(agentsDir, e.name), 'utf-8'));
    if (typeof fm.name !== 'string') continue;
    const a: AgentInfo = { name: fm.name, description: typeof fm.description === 'string' ? fm.description : '', file: e.name };
    for (const f of STRING_FIELDS) if (typeof fm[f] === 'string') a[f] = fm[f] as string;
    if (typeof fm.explores_code === 'boolean') a.explores_code = fm.explores_code;
    if (Array.isArray(fm.tools)) a.tools = fm.tools.map(String);
    agents.push(a);
  }
  return agents.sort((x, y) => x.name.localeCompare(y.name));
}
```

- [ ] **Step 4: Implement `api/wardens.ts`**

```ts
import fs from 'fs';
import path from 'path';

export interface WardenInfo {
  name: string;
  enabled: boolean;
  tools: string[];
  backends?: string[];
  auto_threshold?: number;
  custom_instructions: string | null;
  rules_file: string | null;
}

type RawConfig = Record<string, Record<string, unknown>>;

function readConfig(wardensDir: string): { raw: RawConfig; fromExample: boolean } {
  for (const [file, fromExample] of [['config.json', false], ['config.json.example', true]] as const) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(wardensDir, file), 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { raw: parsed as RawConfig, fromExample };
    } catch {
      // fall through to the next candidate
    }
  }
  return { raw: {}, fromExample: true };
}

function rulesFileFor(name: string, files: string[]): string | null {
  const segs = name.split('-');
  const hit = (suffix: string) => files.find((f) => f.endsWith(suffix) && segs.some((s) => f.startsWith(s)));
  return hit('-rules.md') ?? hit('-schema.md') ?? hit('.md') ?? null;
}

function toInfo(name: string, v: Record<string, unknown>, files: string[]): WardenInfo {
  const info: WardenInfo = {
    name,
    enabled: v.enabled !== false,
    tools: Array.isArray(v.tools) ? v.tools.map(String) : [],
    custom_instructions: typeof v.custom_instructions === 'string' ? v.custom_instructions : null,
    rules_file: rulesFileFor(name, files),
  };
  if (Array.isArray(v.backends)) info.backends = v.backends.map(String);
  if (typeof v.auto_threshold === 'number') info.auto_threshold = v.auto_threshold;
  return info;
}

function mdFiles(wardensDir: string): string[] {
  try {
    return fs.readdirSync(wardensDir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  } catch {
    return [];
  }
}

export function listWardens(wardensDir: string): WardenInfo[] {
  const { raw } = readConfig(wardensDir);
  const files = mdFiles(wardensDir);
  return Object.keys(raw).sort().map((name) => toInfo(name, raw[name] ?? {}, files));
}

export function setWardenEnabled(wardensDir: string, name: string, enabled: boolean): WardenInfo | null {
  const { raw, fromExample } = readConfig(wardensDir);
  if (!Object.prototype.hasOwnProperty.call(raw, name)) return null;
  raw[name] = { ...raw[name], enabled };
  const target = path.join(wardensDir, 'config.json');
  if (!fromExample) fs.copyFileSync(target, `${target}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`);
  fs.writeFileSync(target, JSON.stringify(raw, null, 2) + '\n');
  return toInfo(name, raw[name], mdFiles(wardensDir));
}
```

- [ ] **Step 5: Implement `api/mcps.ts`**

```ts
import fs from 'fs';
import path from 'path';

export interface McpInventory {
  container: { name: string; source: string; conditional: boolean; available: boolean }[];
  skills: { name: string; dir: string; has_test: boolean }[];
  channels: { package: string; built: boolean; configured: boolean | null }[];
}

const exists = (...p: string[]) => fs.existsSync(path.join(...p));

// How each channel package signals "credentials present" — mirrors what the
// channel factories in src/channels/mcp-*.ts check before they start.
const CHANNEL_CONFIGURED: Record<string, (root: string, envHas: (k: string) => boolean) => boolean> = {
  'mcp-whatsapp': (root) => exists(root, 'store', 'auth', 'creds.json'),
  'mcp-telegram': (_r, envHas) => envHas('TELEGRAM_BOT_TOKEN'),
  'mcp-discord': (_r, envHas) => envHas('DISCORD_BOT_TOKEN'),
  'mcp-slack': (_r, envHas) => envHas('SLACK_BOT_TOKEN'),
  'mcp-teams': (_r, envHas) => envHas('TEAMS_APP_ID'),
  'mcp-x': (_r, envHas) => envHas('X_API_KEY'),
};

export function listMcps(repoRoot: string, envHas: (key: string) => boolean): McpInventory {
  const container: McpInventory['container'] = [
    { name: 'deus', source: 'container/agent-runner (ipc-mcp-stdio)', conditional: false, available: true },
    {
      name: 'gcal',
      source: 'packages/mcp-gcal',
      conditional: true,
      available:
        exists(repoRoot, 'packages', 'mcp-gcal', 'dist', 'index.js') &&
        exists(repoRoot, 'integrations', 'gcal', 'credentials.json') &&
        exists(repoRoot, 'integrations', 'gcal', 'tokens.json'),
    },
    { name: 'linear', source: '@tacticlaunch/mcp-linear (container image)', conditional: true, available: envHas('LINEAR_API_KEY') },
  ];

  const skillsDir = path.join(repoRoot, 'container', 'agent-runner', 'src', 'skills');
  let skills: McpInventory['skills'] = [];
  try {
    skills = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && exists(skillsDir, d.name, 'agent.ts'))
      .map((d) => ({ name: d.name, dir: path.posix.join('container', 'agent-runner', 'src', 'skills', d.name), has_test: exists(skillsDir, d.name, 'agent.test.ts') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    skills = [];
  }

  const pkgDir = path.join(repoRoot, 'packages');
  let channels: McpInventory['channels'] = [];
  try {
    channels = fs.readdirSync(pkgDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('mcp-') && d.name !== 'mcp-channel-core')
      .map((d) => ({ package: d.name, built: exists(pkgDir, d.name, 'dist', 'index.js'), configured: CHANNEL_CONFIGURED[d.name]?.(repoRoot, envHas) ?? null }))
      .sort((a, b) => a.package.localeCompare(b.package));
  } catch {
    channels = [];
  }

  return { container, skills, channels };
}
```

- [ ] **Step 6: Run tests + typecheck** — `npx vitest run src/control-ui && npx tsc --noEmit -p tsconfig.json` → PASS / 0.

- [ ] **Step 7: Commit**

```bash
git add src/control-ui/api
git commit -m "feat(control-ui): add agents, wardens, and MCP inventory modules"
```

---

### Task 4: The server

**Files:**
- Create: `src/control-ui/server.ts`
- Test: `src/control-ui/server.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `createRateLimiter` (`src/rate-limiter.ts:12`); `logger`.
- Produces:
  - `interface ControlDeps { repoRoot: string; webRoot: string; credentialFile: string; readOnly: boolean; assistantName: string; version: string; envHas: (key: string) => boolean }`
  - `interface ControlServerOptions { sessions?: SessionStore; backoff?: Backoff; hub?: EventHub; credentials?: CredentialSource; now?: () => number; staticHandler?: typeof serveStatic }`
  - `createControlServer(deps: ControlDeps, opts?: ControlServerOptions): Server`
  - `startControlServer(deps: Omit<ControlDeps, 'credentialFile' | 'readOnly'>): Promise<Server | undefined>` — reads `CONTROL_UI_*` from config; undefined when disabled; exits on an unusable credential file
  - `readPackageVersion(root: string): string`

- [ ] **Step 1: Write the failing integration test** `src/control-ui/server.test.ts`:

```ts
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

interface Reply { status: number; headers: http.IncomingHttpHeaders; text: string }
function request(opts: http.RequestOptions & { body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function login(password = PASSWORD): Promise<{ cookie: string; auth: Record<string, string>; reply: Reply }> {
  const reply = await request({ method: 'POST', path: '/auth/login', headers: H, body: JSON.stringify({ password }) });
  if (reply.status !== 200) return { cookie: '', auth: {}, reply };
  const cookie = String(reply.headers['set-cookie']?.[0]).split(';')[0];
  const { token } = JSON.parse(reply.text);
  return { cookie, auth: { Cookie: cookie, 'X-Deus-Session': token }, reply };
}

function boot(overrides: Partial<ControlDeps> = {}, staticHandler?: () => void) {
  const deps: ControlDeps = { repoRoot: root, webRoot: path.join(root, 'web'), credentialFile: credFile, readOnly: false, assistantName: 'Test', version: '0.0.0', envHas: () => false, ...overrides };
  server = createControlServer(deps, { now: () => clock, staticHandler });
  return new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; r(); }));
}

beforeEach(() => {
  clock = 1_000_000;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-srv-'));
  credFile = path.join(root, 'cred.json');
  writeCredentialFile(credFile, PASSWORD);
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'wardens'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'a.md'), '---\nname: alpha\ndescription: d\n---\n');
  fs.writeFileSync(path.join(root, '.claude', 'wardens', 'config.json.example'), JSON.stringify({ 'plan-reviewer': { enabled: true } }));
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>t</title>');
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

describe('control-ui server', () => {
  it('serves the shell with security headers, blocks traversal and bad methods', async () => {
    await boot();
    const home = await request({ method: 'GET', path: '/' });
    expect(home.status).toBe(200);
    expect(home.headers['content-security-policy']).toContain("default-src 'none'");
    expect(home.headers['x-frame-options']).toBe('DENY');
    expect((await request({ method: 'GET', path: '/..%2f..%2fetc%2fpasswd' })).status).toBe(404);
    expect((await request({ method: 'POST', path: '/' })).status).toBe(405);
    const json = await request({ method: 'GET', path: '/api/v1/nope' });
    expect(json.status).toBe(404);
    expect(json.headers['referrer-policy']).toBe('no-referrer');
  });

  it('requires cookie AND header, then serves the API', async () => {
    await boot();
    expect((await request({ method: 'GET', path: '/api/v1/agents' })).status).toBe(401);
    const { cookie, auth, reply } = await login();
    expect(String(reply.headers['set-cookie']?.[0])).toContain('HttpOnly');
    expect(String(reply.headers['set-cookie']?.[0])).not.toContain('Secure');
    expect((await request({ method: 'GET', path: '/api/v1/agents', headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request({ method: 'GET', path: '/api/v1/agents', headers: { 'X-Deus-Session': auth['X-Deus-Session'] } })).status).toBe(401);
    const agents = await request({ method: 'GET', path: '/api/v1/agents', headers: auth });
    expect(agents.status).toBe(200);
    expect(JSON.parse(agents.text)).toEqual([{ name: 'alpha', description: 'd', file: 'a.md' }]);
    const me = JSON.parse((await request({ method: 'GET', path: '/api/v1/me', headers: auth })).text);
    expect(me).toMatchObject({ assistant: 'Test', version: '0.0.0', read_only: false });
    expect(me.session.sid).toHaveLength(12);
    expect((await request({ method: 'POST', path: '/auth/logout', headers: auth })).status).toBe(204);
    expect((await request({ method: 'GET', path: '/api/v1/agents', headers: auth })).status).toBe(401);
  });

  it('gates warden disable on X-Confirm and enforces Origin when present', async () => {
    await boot();
    const { auth } = await login();
    const patch = (headers: Record<string, string>, body: string) =>
      request({ method: 'PATCH', path: '/api/v1/wardens/plan-reviewer', headers: { ...auth, ...H, ...headers }, body });
    expect((await patch({ Origin: 'http://evil.example' }, '{"enabled":false}')).status).toBe(403);
    expect((await patch({}, '{"enabled":false}')).status).toBe(428);
    expect((await patch({}, '{"enabled":"no"}')).status).toBe(400);
    const ok = await patch({ 'X-Confirm': 'plan-reviewer', Origin: `http://127.0.0.1:${port}` }, '{"enabled":false}');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.text).enabled).toBe(false);
    expect((await patch({}, '{"enabled":true}')).status).toBe(200);
    expect((await request({ method: 'PATCH', path: '/api/v1/wardens/..%2Fx', headers: { ...auth, ...H }, body: '{"enabled":true}' })).status).toBe(404);
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
    expect(JSON.parse(locked.reply.text)).toMatchObject({ error: 'locked' });
    expect(JSON.parse(locked.reply.text).retry_after_ms).toBeGreaterThan(0);
    clock += 5_000;
    expect((await login()).reply.status).toBe(200);
  });

  it('applies rotation live, revokes sessions, and fails closed when the file vanishes', async () => {
    await boot();
    const { auth } = await login();
    expect((await request({ method: 'GET', path: '/api/v1/agents', headers: auth })).status).toBe(200);
    writeCredentialFile(credFile, 'new-password');
    fs.utimesSync(credFile, new Date(clock + 5000), new Date(clock + 5000));
    expect((await request({ method: 'GET', path: '/api/v1/agents', headers: auth })).status).toBe(401);
    expect((await login()).reply.status).toBe(401);
    const fresh = await login('new-password');
    expect(fresh.reply.status).toBe(200);
    expect((await request({ method: 'POST', path: '/auth/sessions/revoke-all', headers: { ...fresh.auth, 'X-Confirm': 'all' } })).status).toBe(204);
    expect((await request({ method: 'GET', path: '/api/v1/agents', headers: fresh.auth })).status).toBe(401);
    fs.rmSync(credFile);
    expect((await login('new-password')).reply.status).toBe(503);
  });

  it('refuses mutations in read-only mode but still logs in', async () => {
    await boot({ readOnly: true });
    const { auth } = await login();
    expect((await request({ method: 'GET', path: '/api/v1/wardens', headers: auth })).status).toBe(200);
    const r = await request({ method: 'PATCH', path: '/api/v1/wardens/plan-reviewer', headers: { ...auth, ...H, 'X-Confirm': 'plan-reviewer' }, body: '{"enabled":false}' });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text)).toEqual({ error: 'read-only mode' });
  });

  it('rejects oversized and non-JSON bodies', async () => {
    await boot();
    expect((await request({ method: 'POST', path: '/auth/login', headers: H, body: JSON.stringify({ password: 'x'.repeat(300 * 1024) }) })).status).toBe(413);
    expect((await request({ method: 'POST', path: '/auth/login', headers: H, body: '{nope' })).status).toBe(400);
  });

  it('streams SSE only with a single-use ticket bound to the cookie', async () => {
    await boot();
    const { cookie, auth } = await login();
    expect((await request({ method: 'GET', path: '/api/v1/events' })).status).toBe(401);
    const { ticket } = JSON.parse((await request({ method: 'POST', path: '/api/v1/events/ticket', headers: auth })).text);
    const first = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/api/v1/events?ticket=${ticket}`, headers: { Cookie: cookie } }, (res) => {
        expect(res.headers['content-type']).toBe('text/event-stream');
        res.once('data', (c) => { resolve(String(c)); req.destroy(); });
      });
      req.on('error', reject);
      req.end();
    });
    expect(first).toContain(': ok');
    expect((await request({ method: 'GET', path: `/api/v1/events?ticket=${ticket}`, headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('answers 500 instead of crashing when a handler throws', async () => {
    await boot({}, () => { throw new Error('boom'); });
    const r = await request({ method: 'GET', path: '/' });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text)).toMatchObject({ error: 'internal error' });
    expect(r.text).not.toContain('boom');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/control-ui/server` → FAIL, `./server.js` not found.

- [ ] **Step 3: Implement `server.ts`**

```ts
import crypto from 'crypto';
import fs from 'fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import path from 'path';

import { CONTROL_UI_CREDENTIAL_FILE, CONTROL_UI_ENABLED, CONTROL_UI_PORT, CONTROL_UI_READONLY } from '../config.js';
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
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const v = (parsed as { version?: unknown } | null)?.version;
    return typeof v === 'string' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJsonBody(req: IncomingMessage): Promise<{ ok: true; body: unknown } | { ok: false; status: 400 | 413 }> {
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
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (chunks.length === 0) return resolve({ ok: true, body: undefined });
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) });
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

const actor = (s: SessionInfo | null) => (s ? { sid: s.shortId, since: s.createdAt, ua: s.userAgent } : undefined);

export function createControlServer(deps: ControlDeps, opts: ControlServerOptions = {}): Server {
  const now = opts.now ?? Date.now;
  const sessions = opts.sessions ?? createSessionStore(now);
  const backoff = opts.backoff ?? createBackoff(now);
  const hub = opts.hub ?? createEventHub();
  const credentials = opts.credentials ?? createCredentialSource(deps.credentialFile);
  const staticHandler = opts.staticHandler ?? serveStatic;
  const loginLimiter = createRateLimiter(LOGIN_RATE_MAX, LOGIN_RATE_WINDOW_MS);
  const router = createRouter();
  const agentsDir = path.join(deps.repoRoot, '.claude', 'agents');
  const wardensDir = path.join(deps.repoRoot, '.claude', 'wardens');
  const firstPasswordFile = `${deps.credentialFile}.first-password`;

  // Rotation is detected here (every auth'd request and every login) so a new
  // password takes effect without restarting the assistant.
  const credentialState = () => {
    const state = credentials.current();
    if (state.rotated) {
      sessions.clear();
      backoff.reset();
      logger.warn({ event: 'control_ui_credential_rotated' }, 'Control UI credential rotated; all sessions revoked');
    }
    return state;
  };

  router.add('POST', '/auth/login', async (ctx) => {
    const key = ctx.remoteAddr;
    const wait = backoff.retryAfterMs(key);
    if (wait > 0 || loginLimiter.isRateLimited(key, now())) {
      logger.warn({ event: 'control_ui_login', remoteAddr: key, outcome: 'locked', retryAfterMs: wait }, 'Control UI login refused (backoff)');
      ctx.res.setHeader('Retry-After', String(Math.ceil(Math.max(wait, 1000) / 1000)));
      return writeJson(ctx.res, 429, { error: 'locked', retry_after_ms: wait });
    }
    const state = credentialState();
    if (!state.ok) {
      logger.error({ event: 'control_ui_login', remoteAddr: key, outcome: 'credential_unavailable', reason: state.reason }, 'Control UI login failed closed');
      return writeJson(ctx.res, 503, { error: 'credential unavailable' });
    }
    const password = (ctx.body as { password?: unknown } | undefined)?.password;
    const ok = typeof password === 'string' && password.length > 0 && (await verifyPassword(password, state.cred.scrypt));
    if (!ok) {
      backoff.recordFailure(key);
      logger.warn({ event: 'control_ui_login', remoteAddr: key, outcome: 'failed' }, 'Control UI login failed');
      return writeJson(ctx.res, 401, { error: 'invalid password' });
    }
    backoff.recordSuccess(key);
    const session = sessions.create(header(ctx.req, 'user-agent') ?? '');
    fs.rmSync(firstPasswordFile, { force: true });
    logger.info({ event: 'control_ui_login', remoteAddr: key, outcome: 'ok', actor: { sid: crypto.createHash('sha256').update(session.id).digest('hex').slice(0, 12) } }, 'Control UI login');
    ctx.res.setHeader('Set-Cookie', sessionCookie(session.id, isTls(ctx.req)));
    writeJson(ctx.res, 200, { ok: true, token: session.secret, expiresAt: session.expiresAt });
  }, { auth: 'none' });

  router.add('POST', '/auth/logout', (ctx) => {
    if (ctx.session) sessions.destroy(ctx.session.id);
    ctx.res.setHeader('Set-Cookie', clearSessionCookie(isTls(ctx.req)));
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  router.add('POST', '/auth/sessions/revoke-all', (ctx) => {
    if (header(ctx.req, 'x-confirm') !== 'all') return writeJson(ctx.res, 428, { error: 'confirmation required' });
    logger.warn({ event: 'control_ui_revoke_all', remoteAddr: ctx.remoteAddr, actor: actor(ctx.session), count: sessions.size() }, 'Control UI sessions revoked');
    sessions.clear();
    ctx.res.setHeader('Set-Cookie', clearSessionCookie(isTls(ctx.req)));
    ctx.res.writeHead(204);
    ctx.res.end();
  });

  router.add('GET', '/api/v1/me', (ctx) =>
    writeJson(ctx.res, 200, { assistant: deps.assistantName, version: deps.version, read_only: deps.readOnly, session: { sid: ctx.session?.shortId, since: ctx.session?.createdAt } }));
  router.add('GET', '/api/v1/agents', (ctx) => writeJson(ctx.res, 200, listAgents(agentsDir)));
  router.add('GET', '/api/v1/wardens', (ctx) => writeJson(ctx.res, 200, listWardens(wardensDir)));
  router.add('PATCH', '/api/v1/wardens/:name', (ctx) => {
    const enabled = (ctx.body as { enabled?: unknown } | undefined)?.enabled;
    if (typeof enabled !== 'boolean') return writeJson(ctx.res, 400, { error: 'enabled must be a boolean' });
    const name = ctx.params.name;
    if (!NAME_RE.test(name)) return writeJson(ctx.res, 404, { error: 'not found' });
    if (!enabled && header(ctx.req, 'x-confirm') !== name) return writeJson(ctx.res, 428, { error: 'confirmation required' });
    const before = listWardens(wardensDir).find((w) => w.name === name)?.enabled;
    const info = setWardenEnabled(wardensDir, name, enabled);
    if (!info) return writeJson(ctx.res, 404, { error: 'not found' });
    logger.info({ event: 'control_ui_warden_toggle', warden: name, from: before, to: enabled, remoteAddr: ctx.remoteAddr, actor: actor(ctx.session) }, 'Control UI warden toggled');
    hub.broadcast('warden', info);
    writeJson(ctx.res, 200, info);
  });
  router.add('GET', '/api/v1/mcps', (ctx) => writeJson(ctx.res, 200, listMcps(deps.repoRoot, deps.envHas)));
  router.add('POST', '/api/v1/events/ticket', (ctx) => {
    const ticket = ctx.session ? sessions.issueTicket(ctx.session.id) : null;
    if (!ticket) return writeJson(ctx.res, 401, { error: 'unauthorized' });
    writeJson(ctx.res, 200, { ticket });
  }, { mutation: false });
  router.add('GET', '/api/v1/events', (ctx) => {
    if (!hub.attach(ctx.req, ctx.res)) writeJson(ctx.res, 503, { error: 'too many event streams' });
  }, { auth: 'ticket' });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url ?? '/', 'http://control');
    const method = req.method ?? 'GET';
    const remoteAddr = normalizeAddr(req.socket.remoteAddress);
    const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/');

    if (!isApi) {
      if (method !== 'GET' && method !== 'HEAD') return writeJson(res, 405, { error: 'method not allowed' });
      return staticHandler(deps.webRoot, url.pathname, res);
    }

    const match = router.match(method, url.pathname);
    if (match.kind === 'not_found') return writeJson(res, 404, { error: 'not found' });
    if (match.kind === 'method_not_allowed') return writeJson(res, 405, { error: 'method not allowed' });

    let session: SessionInfo | null = null;
    if (match.auth !== 'none') {
      credentialState();
      const cookieId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      session = match.auth === 'ticket'
        ? sessions.redeemTicket(url.searchParams.get('ticket') ?? undefined, cookieId)
        : sessions.validate(cookieId, header(req, SESSION_HEADER));
      if (!session) return writeJson(res, 401, { error: 'unauthorized' });
    }
    if (match.mutation && deps.readOnly && !url.pathname.startsWith('/auth/')) {
      return writeJson(res, 403, { error: 'read-only mode' });
    }

    let body: unknown;
    if (method !== 'GET' && method !== 'HEAD') {
      if (!originMatches(req)) return writeJson(res, 403, { error: 'forbidden' });
      const read = await readJsonBody(req);
      if (!read.ok) return writeJson(res, read.status, { error: read.status === 413 ? 'payload too large' : 'invalid JSON' });
      body = read.body;
    }

    const ctx: RequestContext = { req, res, url, params: match.params, body, remoteAddr, session };
    await match.handler(ctx);
  }

  const server = createServer((req, res) => {
    // A client reset must never surface as an uncaught error in the host process.
    req.on('error', (err) => logger.warn({ err }, 'Control UI request error (ignored)'));
    res.on('error', (err) => logger.warn({ err }, 'Control UI response error (ignored)'));
    handle(req, res).catch((err: unknown) => {
      const nonce = crypto.randomBytes(4).toString('hex');
      logger.error({ err, nonce, path: req.url }, 'Control UI request failed');
      if (!res.headersSent) writeJson(res, 500, { error: 'internal error', nonce });
      else res.end();
    });
  });

  server.on('close', () => {
    loginLimiter.dispose();
    hub.close();
  });
  return server;
}

export function startControlServer(deps: Omit<ControlDeps, 'credentialFile' | 'readOnly'>): Promise<Server | undefined> {
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
    const server = createControlServer({ ...deps, credentialFile: CONTROL_UI_CREDENTIAL_FILE, readOnly: CONTROL_UI_READONLY });
    server.on('error', (err: NodeJS.ErrnoException) => reject(err));
    server.listen(CONTROL_UI_PORT, BIND_HOST, () => {
      logger.info({ port: CONTROL_UI_PORT, host: BIND_HOST, readOnly: CONTROL_UI_READONLY }, 'Control UI started');
      resolve(server);
    });
  });
}
```

- [ ] **Step 4: Run all control-ui tests + typecheck + lint** — `npx vitest run src/control-ui && npx tsc --noEmit -p tsconfig.json && npx eslint src/control-ui` → PASS / 0 / 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/control-ui/server.ts src/control-ui/server.test.ts
git commit -m "feat(control-ui): add the localhost control server with two-part sessions and live rotation"
```

---

### Task 5: The web app shell and Phase 1 tabs

**Files:**
- Create: `web/control/index.html`, `app.css`, `app.js`, `dom.js`, `views/agents.js`, `views/wardens.js`, `views/mcps.js`, `manifest.webmanifest`, `sw.js`, `icons/icon.svg`, `icons/icon-192.png`, `icons/icon-512.png`
- Create: `scripts/control-ui-icons.mjs`, `scripts/control-ui-screenshot.mjs`

**Interfaces:**
- Consumes: the HTTP API from Task 4. Every `/api/` fetch sends `credentials: 'same-origin'` plus `X-Deus-Session` from `localStorage['deus_ctl_token']`.
- Produces: `dom.js` exports `h(tag, attrs, ...children)` (strings → text nodes; `attrs` via `setAttribute`, `on*` keys via `addEventListener`) and `clear(el)`; views export `render(root, api, bus, me)`; `app.js` exports `toast` and `confirmTyped(expected, message): Promise<boolean>`.

- [ ] **Step 1: `index.html`** — no inline script/style (CSP):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="dark light">
  <meta name="theme-color" content="#0b0f14">
  <title>Deus Control</title>
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icons/icon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div id="login" class="login" hidden>
    <form id="login-form" class="login-card" autocomplete="off">
      <h1>Deus Control</h1>
      <p class="muted">Local dashboard. Reached through your SSH tunnel.</p>
      <label>Password
        <input id="password" type="password" name="password" required autofocus autocomplete="current-password">
      </label>
      <button type="submit">Sign in</button>
      <p id="login-error" class="error" role="alert"></p>
    </form>
  </div>
  <div id="app" class="app" hidden>
    <aside class="sidebar">
      <div class="brand"><span class="dot"></span><span id="brand-name">Deus</span></div>
      <nav id="nav" class="nav"></nav>
      <button id="logout" class="ghost">Sign out</button>
    </aside>
    <main id="view" class="view" tabindex="-1"></main>
    <nav id="tabbar" class="tabbar"></nav>
    <div id="banner" class="banner" hidden></div>
    <div id="toast" class="toast" hidden></div>
    <dialog id="confirm" class="confirm">
      <form method="dialog">
        <p id="confirm-message"></p>
        <label>Type <code id="confirm-expected"></code> to confirm
          <input id="confirm-input" autocomplete="off">
        </label>
        <div class="actions"><button value="cancel" class="ghost">Cancel</button><button id="confirm-ok" value="ok" disabled>Confirm</button></div>
      </form>
    </dialog>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: `dom.js`**

```js
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
```

- [ ] **Step 3: `app.css`** — tokens on `:root`, dark default, light under `prefers-color-scheme: light` guarded by `:root:not([data-theme="dark"])`; `.app` grid `240px 1fr` above 768 px, single column with `.tabbar` fixed bottom below; `.card`, `.row`, `.badge`, `.switch[role=switch]`, `table`, `.banner`, `.confirm`; 16 px gutters, 44 px targets. Presentation only; verified by the screenshot step.

- [ ] **Step 4: `app.js`**

```js
import { h, clear } from './dom.js';
import * as agents from './views/agents.js';
import * as wardens from './views/wardens.js';
import * as mcps from './views/mcps.js';

const TOKEN_KEY = 'deus_ctl_token';
const VIEWS = {
  agents: { title: 'Agents', icon: '◈', render: agents.render },
  wardens: { title: 'Wardens', icon: '⛨', render: wardens.render },
  mcps: { title: 'MCPs', icon: '⟁', render: mcps.render },
};
const DEFAULT_VIEW = 'agents';
const $ = (id) => document.getElementById(id);

function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
function setToken(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable: session lasts the page */ } }

async function call(method, path, body, extra = {}) {
  const headers = { Accept: 'application/json', 'X-Deus-Session': token(), ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && !path.startsWith('/auth/login')) { setToken(''); showLogin(); throw new Error('unauthorized'); }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e; }
  return data;
}

const api = {
  get: (p) => call('GET', p),
  post: (p, b, extra) => call('POST', p, b, extra),
  patch: (p, b, extra) => call('PATCH', p, b, extra),
};

const bus = new EventTarget();
let me = null;
let source = null;
let pollTimer = null;

async function connectEvents() {
  if (source) source.close();
  let ticket;
  try { ({ ticket } = await api.post('/api/v1/events/ticket')); } catch { return; }
  source = new EventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
  source.onopen = () => { clearInterval(pollTimer); pollTimer = null; };
  source.onerror = () => {
    if (!pollTimer) pollTimer = setInterval(() => bus.dispatchEvent(new CustomEvent('refresh')), 10_000);
  };
  for (const type of ['warden']) {
    source.addEventListener(type, (e) => bus.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(e.data) })));
  }
}

export function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3500);
}

export function banner(msg) {
  const el = $('banner');
  el.textContent = msg || '';
  el.hidden = !msg;
}

export function confirmTyped(expected, message) {
  const dlg = $('confirm');
  const input = $('confirm-input');
  const ok = $('confirm-ok');
  $('confirm-message').textContent = message;
  $('confirm-expected').textContent = expected;
  input.value = '';
  ok.disabled = true;
  input.oninput = () => { ok.disabled = input.value !== expected; };
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value === expected);
    dlg.showModal();
    input.focus();
  });
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

function currentView() {
  const key = location.hash.replace(/^#\/?/, '').split('/')[0];
  return VIEWS[key] ? key : DEFAULT_VIEW;
}

function navItems() {
  const key = currentView();
  return Object.entries(VIEWS).map(([k, v]) =>
    h('a', { href: `#/${k}`, class: k === key ? 'active' : '', 'aria-current': k === key ? 'page' : 'false' },
      h('span', { class: 'icon', 'aria-hidden': 'true' }, v.icon), h('span', {}, v.title)));
}

async function route() {
  for (const id of ['nav', 'tabbar']) { const el = $(id); clear(el); el.append(...navItems()); }
  const root = $('view');
  clear(root);
  root.append(h('p', { class: 'muted' }, 'Loading…'));
  try {
    await VIEWS[currentView()].render(root, api, bus, me);
  } catch (err) {
    if (err.message !== 'unauthorized') { clear(root); root.append(h('p', { class: 'error' }, err.message)); }
  }
}

async function boot() {
  try {
    me = await api.get('/api/v1/me');
  } catch {
    return; // showLogin already ran
  }
  $('brand-name').textContent = `${me.assistant} · Control`;
  document.title = `${me.assistant} Control`;
  $('login').hidden = true;
  $('app').hidden = false;
  await connectEvents();
  await route();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.textContent = '';
  try {
    const r = await api.post('/auth/login', { password: $('password').value });
    setToken(r.token);
    $('password').value = '';
    await boot();
  } catch (ex) {
    err.textContent = ex.status === 429
      ? `Too many attempts. Try again in ${Math.ceil((ex.data?.retry_after_ms || 1000) / 1000)} s.`
      : ex.status === 503 ? 'Credential unavailable on the server.' : 'Wrong password.';
  }
});

$('logout').addEventListener('click', async () => {
  await api.post('/auth/logout').catch(() => {});
  setToken('');
  if (source) source.close();
  showLogin();
});

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (!document.hidden && source && source.readyState === EventSource.CLOSED) connectEvents(); });
window.addEventListener('online', () => { if (source) connectEvents(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
```

- [ ] **Step 5: Views** — each `export async function render(root, api, bus, me)` builds DOM with `h` only:

`views/agents.js`: `GET /api/v1/agents`; heading "Agents (N)"; a search `<input>` filtering by name/description; one `.card` per agent: name, `model` badge, `tools` chips, `explores_code` chip, description truncated to 220 chars with a "more" button that swaps in the full text node.

`views/wardens.js`: `GET /api/v1/wardens`; a `.row` per warden: name, `rules_file`, tools/backends chips, and a `<button class="switch" role="switch" aria-checked>`; turning **off** calls `confirmTyped(name, …)` and sends `PATCH` with `{ 'X-Confirm': name }`; turning on sends `PATCH` directly; on 403 shows "Read-only mode"; hidden entirely when `me.read_only`. Shows `banner('N wardens disabled')` when any are off. Listens on `bus` for `warden` (update one row) and `refresh` (re-fetch).

`views/mcps.js`: `GET /api/v1/mcps`; three `<table>`s (Container, Skill MCPs, Channel packages) with status badges.

- [ ] **Step 6: PWA files** — `manifest.webmanifest` (name "Deus Control", `display: standalone`, dark colours, the three icons); `sw.js` cache-first for `/`, `/app.css`, `/app.js`, `/dom.js`, `/views/*.js`, `/icons/*` under a versioned cache, network-only for `/api/` and `/auth/`, old caches deleted on `activate`; `scripts/control-ui-icons.mjs` renders `icons/icon.svg` to the two PNGs with `sharp` (run once, PNGs committed).

- [ ] **Step 7: `scripts/control-ui-screenshot.mjs`** — password from a file, never argv or an env value:

```js
#!/usr/bin/env node
// Captures the running control UI for the visual verification record.
// Usage: CONTROL_UI_URL=http://127.0.0.1:3117 CONTROL_UI_PASSWORD_FILE=<0600 file> node scripts/control-ui-screenshot.mjs <tab> <outPrefix>
import fs from 'fs';
import { chromium } from 'playwright';
const [tab = 'agents', prefix = 'docs/control-ui/artifacts/phase1'] = process.argv.slice(2);
const url = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3017';
const file = process.env.CONTROL_UI_PASSWORD_FILE;
if (!file) { console.error('CONTROL_UI_PASSWORD_FILE is required'); process.exit(2); }
const password = fs.readFileSync(file, 'utf-8').trim();
const browser = await chromium.launch();
for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]]) {
  const page = await browser.newPage({ viewport, colorScheme: 'dark' });
  await page.goto(`${url}/#/${tab}`);
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#view .card, #view table, #view .row', { timeout: 10_000 });
  await page.screenshot({ path: `${prefix}-${tab}-${name}.png`, fullPage: false });
  console.log(`wrote ${prefix}-${tab}-${name}.png`);
  await page.close();
}
await browser.close();
```

- [ ] **Step 8: Run against a throwaway credential and capture**

```bash
mkdir -p docs/control-ui/artifacts
node scripts/control-ui-icons.mjs
npm run build
export CONTROL_UI_CREDENTIAL_FILE="$CLAUDE_JOB_DIR/tmp/ctl-cred.json"
node scripts/control-ui-credential.mjs        # not a TTY here → writes $CONTROL_UI_CREDENTIAL_FILE.first-password and prints only its path
CONTROL_UI_ENABLED=1 CONTROL_UI_PORT=3117 node -e "import('./dist/control-ui/server.js').then(m => m.startControlServer({ repoRoot: process.cwd(), webRoot: 'web/control', assistantName: process.env.ASSISTANT_NAME || 'Deus', version: 'dev', envHas: () => false }))" &
CONTROL_UI_URL=http://127.0.0.1:3117 CONTROL_UI_PASSWORD_FILE="$CONTROL_UI_CREDENTIAL_FILE.first-password" node scripts/control-ui-screenshot.mjs agents
CONTROL_UI_URL=http://127.0.0.1:3117 CONTROL_UI_PASSWORD_FILE="$CONTROL_UI_CREDENTIAL_FILE.first-password" node scripts/control-ui-screenshot.mjs wardens
```
(The throwaway `.first-password` file is deleted by the server on the first login; the whole throwaway credential is removed after the capture.) Expected: four PNGs; reviewed with the Read tool; record (feature / expected / observed / PASS-FAIL) appended to `docs/control-ui-notes.md` under "Verification log".

- [ ] **Step 9: Commit**

```bash
git add web/control scripts/control-ui-icons.mjs scripts/control-ui-screenshot.mjs docs/control-ui/artifacts docs/control-ui-notes.md
git commit -m "feat(control-ui): add the PWA shell with Agents, Wardens, and MCPs tabs"
```

---

### Task 6: Wire into the host, document, verify end-to-end

**Files:**
- Modify: `src/index.ts:510` (after the Odysseus push)
- Create: `scripts/control-ui-credential.mjs`
- Modify: `.env.example`, `docs/control-ui-progress.md`, `docs/control-ui-notes.md`

- [ ] **Step 1: `src/index.ts`** — add `import { readPackageVersion, startControlServer } from './control-ui/server.js';` next to the Odysseus import and, after line 510:

```ts
  // Control UI (no-op unless CONTROL_UI_ENABLED=1). Localhost-only dashboard
  // reached through an SSH tunnel; fails closed on a missing credential file.
  const controlServer = await startControlServer({
    repoRoot: PROJECT_ROOT,
    webRoot: path.join(PROJECT_ROOT, 'web', 'control'),
    assistantName: ASSISTANT_NAME,
    version: readPackageVersion(PROJECT_ROOT),
    envHas: (key) => Boolean(process.env[key] || readEnvFile([key])[key]),
  });
  if (controlServer) webhookServers.push(controlServer);
```
Verify `PROJECT_ROOT`, `ASSISTANT_NAME`, `path` and `readEnvFile` are already imported in `src/index.ts` (grep) and add any that are missing.

- [ ] **Step 2: `scripts/control-ui-credential.mjs`**

```js
#!/usr/bin/env node
// Generates (or rotates) the Control UI password. Stores only the scrypt hash
// (mode 0600). Prints the password once on a TTY; otherwise writes it to
// <credential file>.first-password (0600) and prints only that path, so the
// secret never lands in an agent transcript. The server deletes that file
// after the first successful login. Requires a build (imports dist/).
import os from 'os';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.env.CONTROL_UI_CREDENTIAL_FILE || path.join(os.homedir(), '.config', 'deus', 'control-ui.json');
let auth;
try {
  auth = await import(pathToFileURL(path.join(here, '..', 'dist', 'control-ui', 'auth.js')).href);
} catch {
  console.error('dist/control-ui/auth.js not found — run `npm run build` first.');
  process.exit(1);
}
const password = auth.generatePassword();
auth.writeCredentialFile(file, password);
console.log(`Control UI credential written to ${file} (mode 0600).`);
if (process.stdout.isTTY) {
  console.log('Password — shown once, not stored anywhere:');
  console.log(`\n  ${password}\n`);
} else {
  const once = `${file}.first-password`;
  fs.writeFileSync(once, password + '\n', { mode: 0o600 });
  fs.chmodSync(once, 0o600);
  console.log(`Not a terminal — password written to ${once} (0600). Read it once; it is deleted after the first login.`);
}
```

- [ ] **Step 3: `.env.example`** — after the Odysseus block:

```
# Control UI — OpenClaw-style dashboard on 127.0.0.1 (reach it via ssh -L).
# Create the password with: node scripts/control-ui-credential.mjs
CONTROL_UI_ENABLED=
CONTROL_UI_PORT=3017
CONTROL_UI_READONLY=
CONTROL_UI_CREDENTIAL_FILE=
```

- [ ] **Step 4: Run the full verification table** against the built server on `CONTROL_UI_PORT=3117` with the throwaway credential; paste each observed value next to its prediction in `docs/control-ui-notes.md` "Verification log — Phase 1". `npx vitest run` (whole suite) must stay green.

- [ ] **Step 5: Update `docs/control-ui-progress.md`** Phase 1 row → `done <date>`; note the throwaway credential was deleted.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts scripts/control-ui-credential.mjs .env.example docs/control-ui-notes.md docs/control-ui-progress.md
git commit -m "feat(control-ui): start the control server from the host and document setup"
```

Each commit above passes the repo's commit gates: code-reviewer SHIP, verification-gate SHIP (and ai-eng-warden if it fires) marked via `scripts/cogate.py --skip-gpt` / `codex_warden_hooks.py mark` from inside the worktree with `--repo-root` set to the main checkout.

## Self-review

- Spec coverage (Phase 1 slice): auth incl. rotation, two-part session, tickets, backoff ✓ (Task 1, 4); headers + render rule ✓ (2, 5); SSE ✓ (2, 4); Agents/Wardens (confirm + banner)/MCPs ✓ (3, 4, 5); read-only mode ✓ (4, 5); fail-closed start ✓ (4); wiring ✓ (6); verification incl. visual ✓ (5, 6). Later tabs are later phases by design.
- Placeholders: none — every step has code or an exact command; `app.css` and the three views are specified by exact behaviour and the selectors the screenshot script waits on.
- Type consistency: `ControlDeps` fields match between Task 4 and 6; `RequestContext.session` (router) is what `server.ts` fills; `SessionStore.redeemTicket(ticket, id)` matches the server's call; `Match.mutation` drives the read-only gate; `SECURITY_HEADERS` exported by `static.ts` is applied in `server.ts`.
