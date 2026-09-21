# Control UI — design

**Scope:** an OpenClaw-style control web app for one Deus instance, served by
the host process on `127.0.0.1` and reached through an SSH tunnel. Recon and
assumptions: `docs/control-ui-notes.md` (generic) plus a local, untracked
companion for instance-identifying facts.

## Goal

A browser dashboard, usable from a phone and a laptop, that shows and controls
what the Rust TUI shows plus everything OpenClaw's Control UI offers: chat with
streaming tool calls, agents, wardens, MCPs, groups, sessions, scheduled tasks,
channels, memory, containers, logs, system health, redacted config, and a debug
trace. Real data only — every endpoint reads the live DB, files, and Docker.

## Non-goals

- Exposing anything beyond `127.0.0.1` (no TLS, no Tailscale, no reverse proxy).
- Controlling the sibling instance or any other assistant process on the host.
- A frontend build toolchain or any CDN asset.
- Arbitrary shell from the browser. Every action is a fixed, allowlisted verb.
- Weakening container isolation or adding host mounts.

## What a session really grants (trust boundaries)

Four boundaries, all named because the design is only as strong as the weakest:

1. **Network → host.** The firewall admits SSH only and port 3017 is never
   published by Docker, so the sole ingress is an SSH tunnel. Authentication
   here is SSH's.
2. **Local process → server.** Any process under the same OS user can reach
   `127.0.0.1:3017`; the password is the only control, exactly as Odysseus
   documents for its bearer token. A local file read yields only a scrypt hash
   of 192 random bits. A process that can read the host's memory is out of
   scope — it already owns the assistant.
3. **Agent container → host.** Closed: containers run on the default bridge
   (`--add-host=host.docker.internal:host-gateway`, `src/platform.ts:185`),
   never `--network host`, so the host loopback is unreachable from an agent.
4. **Browser → server.** Two porous points, both mitigated below: cookies are
   not port-scoped (any other `localhost:*` server on the tunnelling machine
   would receive a plain cookie session), and the dashboard DOM renders text
   authored by chat senders, by the LLM, and by agents writing `CLAUDE.md` and
   vault files.
5. **Container → host → browser.** Containers write into host state over IPC —
   `sessions.metadata_json`, run logs, memory files — and the dashboard reads
   that state back. Everything on this path is container-authored: it is
   projected to typed fields (`metadata` → finite numbers under known keys),
   truncated (run-log text to 4 KB per row) or rendered as text nodes, never
   forwarded verbatim as objects.
6. **Dashboard → scheduler → channel → recipients.** A scheduled task's output
   is sent to a real chat destination. The destination `chat_jid` is chosen
   explicitly by the operator, validated against the task's group, shown in
   the form and carried in the audit line — never inferred.

From Phase 2 on a session holder can write agent instruction files, toggle the
review gates of an autonomous pipeline, and stop containers — the session's
real capability is "influence an agent that runs with the host's privileges",
not "read a dashboard". Every control below is sized to that.

## Architecture

```
browser ──ssh -L 3017──▶ 127.0.0.1:3017  src/control-ui/server.ts  (Node http)
                                            │
            ┌───────────────┬───────────────┼────────────────┬──────────────┐
            ▼               ▼               ▼                ▼              ▼
     static (web/control) auth.ts     api/*.ts          events.ts (SSE)   web-turn.ts
                                        │                                   │
                              db.ts · RouterState · GroupQueue · Channel[] · RuntimeRegistry
                              .claude/agents · .claude/wardens · groups/ · vault · docker CLI
```

One new server inside the existing process, started from `src/index.ts` right
after `startOdysseusServer` and pushed onto `webhookServers` so shutdown closes
it. Dependencies are injected (`ControlDeps`); nothing reaches into module
globals; every module is testable on temp dirs and the server on port 0 —
the same shape as `src/odysseus-server.ts`.

### Design patterns (named on purpose)

- **Observer / pub-sub** — `events.ts` is a hub: handlers publish typed events,
  every attached SSE client observes. A bounded ring buffer (256 frames) gives
  `Last-Event-ID` replay without unbounded memory; a per-client stall counter
  in a `Map<ServerResponse, number>` drops a client after two consecutive
  full-buffer writes (O(1) per client, no timers).
- **Table-driven Strategy dispatch** — `router.ts` is a linear route table
  matched by method and `:param` segments. Route count stays under ~60, so a
  linear scan is correct and a trie would be unearned complexity.
- **Parameter injection** — `ControlDeps` (paths, env lookup, assistant name,
  version, read-only flag, credential file) is passed in; handlers never import
  `process.env` or the DB module directly. That is what makes the integration
  test run on a temp directory.
- **Registry-with-template** — wardens read `.claude/wardens/config.json` and
  fall back to `config.json.example` (the tracked template) on first write,
  matching what the Rust TUI does.
- **Two-part credential** — session id in a cookie, session secret in a header
  (below). Maps in the session store are keyed by id for O(1) lookup; secrets
  are compared with `timingSafeEqual`.

### Modules (`src/control-ui/`)

| File | One purpose |
|------|-------------|
| `server.ts` | `createControlServer(deps, opts?)` / `startControlServer(deps)`: bind, route dispatch, auth gate, read-only gate, body cap, whole-request error boundary, security headers, audit log |
| `router.ts` | method + `:param` matcher with per-route `auth: 'session' \| 'ticket' \| 'none'` and `mutation` flags |
| `auth.ts` | scrypt hash/verify (async), credential file read/write, live credential source (re-read on change), session store with secrets + single-use SSE tickets, exponential backoff, cookie helpers |
| `static.ts` | traversal-safe static serving; exports the security header set |
| `events.ts` | SSE hub (above) |
| `deps.ts` | `ControlDeps` + `resolveDeps()` (paths, `readEnvFile`, docker binary) |
| `api/*.ts` | one module per tab (agents, wardens, mcps, groups, sessions, chat, tasks, channels, memory, containers, logs, system, config, debug) |

Two small changes outside the module: `GroupQueue.snapshot()` (read-only) and
`db.getTaskRunLogs(taskId, limit)`. One refactor for Phase 2: the enqueue-and-
stream lifecycle inside `odysseus-server.ts:handleChatCompletion` moves to
`src/web-turn.ts` as `startWebTurn(deps, { prompt, latest, onEvent, onDone })`;
Odysseus keeps its OpenAI framing on top and its tests must pass unchanged.

## Auth

- **Credential.** `scripts/control-ui-credential.mjs` generates a 24-byte
  base64url password and writes `~/.config/deus/control-ui.json` (override:
  `CONTROL_UI_CREDENTIAL_FILE`) mode `0600` with
  `{ scrypt: { salt, hash, N: 16384, r: 8, p: 1 }, created_at }`. When stdout
  is a TTY it prints the password once; otherwise it writes it to
  `<file>.first-password` (0600) and prints only that path, so a password never
  lands in an agent transcript. The server deletes `.first-password` after the
  first successful login. Re-running the script rotates.
- **Rotation is live.** `auth.ts` exposes a credential *source* that re-reads
  the file whenever its mtime/size changes (a `stat` per login and per
  authenticated request — cheap). When the scrypt record changes, every session
  and every backoff entry is cleared and an audit line is written. If the file
  becomes unreadable or malformed at runtime, logins fail closed with 503 and an
  audit line; existing sessions keep working until they expire or the file is
  restored.
- **Fail closed at start.** `CONTROL_UI_ENABLED=1` with a missing/unreadable/
  malformed credential file aborts startup with a FATAL log, like Odysseus.
- **Login.** `POST /auth/login {password}` → async `crypto.scrypt` +
  `timingSafeEqual` → a session with a random 32-byte **id** and a random
  32-byte **secret**. The id goes in `Set-Cookie: deus_ctl=<id>; HttpOnly;
  SameSite=Strict; Path=/; Max-Age=604800` (`Secure` added only when the
  socket itself is TLS — `X-Forwarded-Proto` is not trusted, there is no proxy
  in this design). The secret is returned in the JSON body and held by the page
  in `localStorage` (origin *and port* scoped). Every `/api/` request must carry
  both: the cookie and `X-Deus-Session: <secret>`. A cookie harvested by another
  `localhost:*` server is useless without the secret; a secret leaked from
  storage is useless without the cookie. Sessions expire after 12 h idle or 7 d
  absolute; the server records creation time and `User-Agent` per session.
- **SSE.** `EventSource` cannot set headers, so `POST /api/v1/events/ticket`
  (session-authenticated) returns a single-use ticket valid for 60 s, and
  `GET /api/v1/events?ticket=…` is accepted only when the ticket matches the
  cookie's session. `Referrer-Policy: no-referrer` keeps the ticket out of
  referrers; it is consumed on first use.
- **Logout and revocation.** `POST /auth/logout` deletes the session;
  `POST /auth/sessions/revoke-all` (session-authenticated, `X-Confirm: all`)
  clears every session. Rotating the password also revokes everything.
- **Backoff, not lockout.** After each failed login from a source address the
  next attempt is refused with `429 { error: "locked", retry_after_ms }` until
  `min(1 s × 2^(n−1), 5 min)` has elapsed since the last failure; failures
  older than 15 min are forgotten. Because tunnelled and local clients both
  arrive as loopback, a hard lock would let any local process lock the
  operator out forever; capped backoff bounds that at 5 min per attempt.
  Loopback addresses are normalised (`::1`, `::ffff:127.0.0.1` → `127.0.0.1`)
  so alternating IP families does not double the budget. A 10/min per-source
  rate limit applies on top. Rotating the credential resets backoff.
- **CSRF.** `SameSite=Strict` plus, on every non-GET request, the required
  `X-Deus-Session` header (which a cross-site form cannot set) and an
  `Origin`/`Host` match when `Origin` is present. A missing `Origin` is
  accepted because a cross-site request carrying a custom header is never a
  simple request — the custom header is the control, the Origin check is
  belt-and-braces.
- **Read-only mode bounds the actor.** `CONTROL_UI_READONLY=1` makes the
  server refuse every mutation except `/auth/*` with `403 { error: "read-only
  mode" }` — including chat turns and turn aborts, because a turn drives an
  agent that holds rw vault and project mounts and is therefore a superset of
  any dashboard file write. `/me` reports `read_only: true`, the banner reads
  "read-only: the assistant cannot be driven from this dashboard", and the UI
  hides every write control including the chat composer. Read-only also
  **excludes the vault** from the Memory tab (only the repo `groups/` root is
  listed and readable) and refuses the WhatsApp pairing QR — the phone
  deployment gets neither the personal corpus nor a credential. Read-only
  also withholds agent output: container log sources and the log export are
  refused, host log entries are projected to `{ seq, time, level, msg }`, the
  `log` SSE stream is not started, and the Config tab lists only the editable
  keys (jids stay in scope, as Groups/Sessions already show them). Recommended
  for a phone-only deployment. A per-session capability (view vs control
  sessions) that would allow this without an env flag is a recorded
  follow-up, not in scope.
- **What needs no session:** `GET /` and static assets, `manifest.webmanifest`,
  `sw.js`, `POST /auth/login`. Everything under `/api/` is 401 without a valid
  session. Method gate before auth (404/405 first) so route presence never
  leaks through auth differences.
- **Audit.** Every login attempt (ok / failed / locked), rotation, revoke-all,
  and every mutation is logged with `remoteAddr`, the session's short id (first
  12 hex of `sha256(id)`), its creation time and `User-Agent`, and for state
  changes the `{ from, to }` values. Never the password, never the secret.

## Browser render boundary

Text from the API is untrusted at the **render** boundary, not only at the API
boundary: chat messages come from arbitrary senders, tool-call arguments from
the LLM, `CLAUDE.md` and memory files from agents. Two architectural controls:

1. **Headers on every response** (static, JSON, SSE):
   `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src
   'self'; font-src 'self'; img-src 'self' data:; connect-src 'self';
   manifest-src 'self'; base-uri 'none'; form-action 'none';
   frame-ancestors 'none'` (`font-src` covers the self-hosted Geist files),
   `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
   `X-Content-Type-Options: nosniff`. No inline `<script>` or `<style>` exists
   anywhere in `web/control/` — stated invariant, checked by the CSP itself.
2. **DOM rule.** Views build elements with a tiny `h(tag, attrs, ...children)`
   helper: string children become text nodes, attributes are set with
   `setAttribute`, and `innerHTML` is never used with data. Markup literals
   only. There is no `esc()` because there is nothing to escape into.

## API (JSON under `/api/v1`, SSE at `/api/v1/events`)

Mutating verbs are explicit. Destructive or gate-affecting ones require
`X-Confirm: <resource id>` echoed by the client after a typed confirmation
(`428` on mismatch). `X-Confirm` is a UX guard against mis-taps, **not** a
security control — the same session can set it.

| Area | Routes |
|------|--------|
| Me | `GET me` → `{ assistant, version, read_only, session: { sid, since } }` |
| Agents | `GET agents` → `[ { name, description, model, tools?, explores_code?, color?, version?, linear_label?, file } ]` |
| Wardens | `GET wardens` → `[ { name, enabled, tools, backends?, auto_threshold?, custom_instructions, rules_file } ]`; `PATCH wardens/:name { enabled }` — disabling requires `X-Confirm: <name>`; writes `config.json` (created from the example on first write, `.bak-<ts>` kept), logs `{ from, to }`, broadcasts `warden`; the UI shows a persistent "N wardens disabled" banner |
| MCPs | `GET mcps` → `{ container: [ { name, source, conditional, available } ], skills: [ { name, dir, has_test } ], channels: [ { package, built, configured } ] }` |
| Events | `POST events/ticket` → `{ ticket }`; `GET events?ticket=` → SSE |
| Groups | `GET groups`; `GET groups/:folder/claude-md`; `PUT groups/:folder/claude-md { content }` (1 MB cap, collision-proof `.bak-<ts>-<rand>` with the newest 10 retained, 6/min per session, `X-Confirm: <folder>` — instruction files get their own typed confirmation, distinct from memory files) |
| Sessions | `GET sessions` (rows with projected `metadata` and the containers per folder); `POST sessions/:folder/kill` (`X-Confirm: <folder>`, folder must be a registered group) → stop every active container serving that folder (one container serves a jid regardless of backend; several jids can share a folder), then orphan every backend's row with reason `control-ui kill`; the dialog lists the containers first |
| Chat | `POST chat/turns { message, history? }` → SSE stream of `RuntimeEvent`s plus a first `turn_started`; audited with a prompt hash; `DELETE chat/turns/:id` → `queue.closeStdin(mainJid)` (graceful, never `docker kill`) and only for turns the dashboard started — the id is not a secret, ownership is the control. Only final assistant text is replayed as history; it is cleared on logout/401 |
| Tasks | `GET tasks`; `POST tasks` (explicit `chat_jid` validated for the folder; interval ≥ 60 s; 6/min per session; 50 per session); `PATCH tasks/:id`; `POST tasks/:id/run` (sets `next_run = now`; the scheduler polls every 60 s — the UI says so; shares the limiter; audited with a prompt hash); `DELETE tasks/:id` (`X-Confirm`; exposes the pre-existing hard delete, see `docs/decisions/no-db-deletion.md` follow-up); `GET tasks/:id/runs?limit=50` (text truncated to 4 KB) |
| Channels | `GET channels` (adapters, configured/connected, wired groups, WhatsApp pairing state from the adapter's own `WHATSAPP_AUTH_DIR` resolution); `POST channels/whatsapp/qr` — a mutation (`X-Confirm: whatsapp`, audited, refused in read-only), served only while unpaired (409 once paired); the UI names the revocation path (WhatsApp → Linked devices) |
| Memory | `GET memory/tree` (roots `vault` and `groups`; vault omitted in read-only; symlinks skipped); `GET memory/file?root=&path=` (realpath-confined, `.md` only, audited); `PUT memory/file { root, path, content }` (`X-Confirm-Edit: 1`, existing files only, 1 MB, `.bak-<ts>-<rand>` newest 10, 12/min per session). Vault `Persona/`, `Atoms/` and the root `CLAUDE.md` are read-only from the dashboard; `groups/**/CLAUDE.md` is refused here in favour of the Groups route; vault writes report `index_not_updated: true` |
| Containers | `GET containers` (own instance only); `POST containers/:name/stop` (`X-Confirm`); ~~`POST containers/:name/start`~~ dropped — agent containers run with `--rm`, there is nothing to start; `POST containers/rebuild` (one at a time, `build` SSE events, POSIX only) |
| Logs | `GET logs?source=&level=&q=&lines=`; `GET logs/export`; follow via `log` SSE events |
| System | `GET system` → uptime, load, RAM, disk (`used_pct ≥ 85` raises `alert`), `docker system df` |
| Config | `GET config` — keys matching `/TOKEN\|KEY\|SECRET\|PASSWORD\|CREDENTIAL\|AUTH/i` are **absent**, not masked; `PATCH config { key, value }` (`X-Confirm: <key>`) for the allowlist only; `.env` rewritten with `.bak-<ts>`; returns `restart_required: true` |
| Debug | `GET debug/health`, `GET debug/counts`, `GET debug/events`, `GET debug/trace?message_id=` |

Common rules: 256 KB body cap (1 MB for the two file `PUT`s); the **entire**
request callback — static serving, routing, body read, handler — runs inside
one error boundary that logs with a nonce and answers `500 { error, nonce }`
without the stack; every `docker` call has a 15 s timeout; the login path uses
async scrypt so a burst of attempts cannot stall the shared event loop that
also runs channels and the scheduler.

## Live updates

`GET /api/v1/events` (ticket-authenticated) streams `queue`, `task`,
`container`, `system`, `log`, `build`, `alert`, `warden` and `ping` (20 s).
Max 8 clients; the 9th gets 503. The client fetches a fresh ticket on every
(re)connect, re-syncs on `visibilitychange` and `online`, and falls back to
10 s polling while the stream is down. WebSocket was considered and rejected:
a dependency or a hand-written frame parser for no client→server streaming.

## Frontend (`web/control/`)

- `index.html`, `app.css`, `app.js` + `views/*.js` as native ES modules; hash
  routing. No framework, no bundler, no CDN, no inline script or style.
- Dark by default with `prefers-color-scheme` honoured; tokens on `:root`.
- Mobile-first: bottom tab bar under 768 px, left sidebar above; 16 px gutters,
  44 px touch targets, no horizontal scroll.
- PWA: `manifest.webmanifest`, `sw.js` caching the app shell only.
- Login screen is the same page; any 401 clears the stored secret and shows it.
- Chat history is kept per group in `localStorage` and replayed like Odysseus
  clients do; the server stores nothing.
- Typed-confirmation dialog for every `X-Confirm` verb; hidden in read-only mode.

## Error handling

- Client reset mid-stream: `req`/`res` `error` listeners swallow and log.
- Docker missing/unreachable: Containers/System show the probe error; the rest
  keeps working.
- Credential file unreadable at runtime: 503 on login + audit; sessions keep
  working until expiry.
- SSE backpressure: two consecutive full-buffer writes drop the client; it
  reconnects with a new ticket and `Last-Event-ID`.

## Security controls (summary for the threat-modeler)

Bind `127.0.0.1` only; SSH is the transport. scrypt-hashed 192-bit password;
live rotation with session revocation; two-part session (cookie + header
secret) so cookie port-leakage is inert; single-use SSE tickets; exponential
backoff with loopback normalisation instead of a hard lock; `HttpOnly +
SameSite=Strict` cookie, `Secure` only on a TLS socket; custom header as the
CSRF control; strict CSP + frame denial + no-referrer on every response; DOM
built from text nodes only; secrets absent (not masked) from config and never
logged; attributed audit lines with `{from,to}`; no shell from the browser —
fixed `execFile` argv or DB calls only; file access confined to allowlisted
roots with `realpath` checks; body caps; SSE client cap; read-only mode; whole-
request error boundary; async scrypt. `X-Confirm` is listed under UX, not here.

## Testing

- Unit (vitest): `auth` (hash/verify, credential source rotation, session
  secrets and tickets, backoff curve, loopback normalisation, cookie flags),
  `static` (traversal, headers), `router`, `events` (ring, cap, backpressure),
  `agents` parser, `wardens` toggle on a temp dir, later `config` redaction,
  `logs` parser, `debug` trace.
- Integration: `server.test.ts` boots on port 0 with a temp repo and exercises
  every route including 401/403/405/413/428/429/503 paths, rotation, ticket
  reuse, read-only mode, and a forced static-handler throw (must answer 500,
  must not crash).
- `odysseus-server.test.ts` passes unchanged after the Phase 2 refactor.
- Manual per phase (recorded in `docs/control-ui-notes.md`): tunnel, real data
  on every tab, screenshots, chat round trip, task persistence, container
  stop/start, backoff, nothing public answers, channels still deliver.

## Phasing

1. Server skeleton, auth, static + headers, SSE hub, Agents/Wardens/MCPs.
2. `web-turn` refactor, Chat, Sessions, Groups.
3. Tasks, Channels, Memory.
4. Containers, Logs, System, Config, Debug.
5. Deploy into the instance's unit (`CONTROL_UI_ENABLED=1`,
   `CONTROL_UI_PORT=3017`, optionally `CONTROL_UI_READONLY=1`), credential
   generation, verification, final report.

Each phase: plan-reviewer SHIP + threat-modeler SHIP → TDD → code-reviewer +
verification-gate SHIP → commit on `control-ui`.

## Deployment and rollback

No new unit: the server runs inside the instance's existing service
(`Restart=always`, `After=docker.service`, enabled at boot). Deploy = merge
`control-ui` into the instance checkout, `npm run build`, add the env lines to
the unit, `daemon-reload`, restart, confirm the listener is `127.0.0.1:3017`
only. Access: `ssh -L 3017:127.0.0.1:3017 <user>@<host>` → `http://localhost:3017`.
Rollback: unset `CONTROL_UI_ENABLED` and restart — additive files only, no
migration, no shared state.

## Decisions taken without asking

See "Assumptions" in `docs/control-ui-notes.md`.
