# Control UI — design

**Scope:** an OpenClaw-style control web app for one Deus instance (Amos,
`deus-newly.service`), served by the host process on `127.0.0.1` and reached
through an SSH tunnel. Recon and assumptions: `docs/control-ui-notes.md`.

## Goal

A browser dashboard, usable from a phone and a laptop, that shows and controls
what the Rust TUI shows plus everything OpenClaw's Control UI offers: chat with
streaming tool calls, agents, wardens, MCPs, groups, sessions, scheduled tasks,
channels, memory, containers, logs, system health, redacted config, and a debug
trace. Real data only — every endpoint reads the live DB, files, and Docker.

## Non-goals

- Exposing anything beyond `127.0.0.1` (no TLS, no Tailscale, no reverse proxy).
- Controlling Rafi or NanoClaw — separate processes, out of scope.
- A frontend build toolchain or any CDN asset.
- Arbitrary shell from the browser. Every action is a fixed, allowlisted verb.
- Weakening container isolation or adding host mounts.

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
it. It gets its dependencies injected (`ControlDeps`), never reaches into
module globals, and is fully testable with fake deps on port 0 — the same shape
as `src/odysseus-server.ts`.

### Modules (`src/control-ui/`)

| File | One purpose |
|------|-------------|
| `server.ts` | `createControlServer(deps)` / `startControlServer(deps)`: bind, route dispatch, body cap, error boundary, audit log |
| `router.ts` | tiny method + path-pattern matcher (`GET /api/v1/tasks/:id/runs`) — no framework |
| `auth.ts` | credential file (scrypt), login/logout, in-memory session store, lockout, cookie flags |
| `static.ts` | serve `web/control/` with a path-traversal guard, content types, `Cache-Control` |
| `events.ts` | SSE hub: `broadcast(type, data)`, keepalive, per-client backpressure cap, `Last-Event-ID` ring buffer (256 events) |
| `deps.ts` | `ControlDeps` interface + `resolveDeps()` (paths, `readEnvFile`, docker binary) |
| `api/agents.ts` | parse `.claude/agents/*.md` frontmatter |
| `api/wardens.ts` | read/merge `.claude/wardens/config.json` (+ `config.json.example` defaults) and rules files; toggle `enabled` |
| `api/mcps.ts` | container MCP servers, skill MCPs (`container/agent-runner/src/skills/*/agent.ts`), channel packages (`packages/mcp-*`) |
| `api/groups.ts` | registered groups + live container state; CLAUDE.md read/write with `.bak-<ts>` |
| `api/sessions.ts` | `sessions` rows joined with `GroupQueue.snapshot()`; kill |
| `api/chat.ts` | start a turn (SSE), abort a turn |
| `api/tasks.ts` | list/create/update/run-now/delete + run logs |
| `api/channels.ts` | adapters, configured/connected, group wiring, WhatsApp pairing state |
| `api/memory.ts` | browse/read/write files under the vault and `groups/<folder>/` |
| `api/containers.ts` | `docker ps/stats/stop/start`, rebuild via `container/build.sh` |
| `api/logs.ts` | tail + follow `logs/*.log` and `groups/<folder>/logs/`, filter, export |
| `api/system.ts` | uptime, load, RAM, disk, `docker system df`, disk alert |
| `api/config.ts` | effective config with secrets removed; allowlisted `.env` edits |
| `api/debug.ts` | health probes, table counts, recent audit events, no-reply trace |

Two small changes outside the module:

- `src/group-queue.ts`: add `snapshot(): GroupSnapshot[]` (read-only copy of
  `{ jid, active, idleWaiting, isTaskContainer, runningTaskId, containerName,
  groupFolder, pendingTaskCount, retryCount }`). Nothing else.
- `src/db.ts`: add `getTaskRunLogs(taskId, limit)` — the table has writers but
  no reader.

And one refactor: the enqueue-and-stream lifecycle inside
`odysseus-server.ts:handleChatCompletion` (control-group resolution, in-flight
guard, injection scan, `enqueueTask` with the event sink, keepalive, absolute
timer, `_close` wind-down, slot release) moves to `src/web-turn.ts` as
`startWebTurn(deps, { prompt, latest, onEvent, onDone })`. Odysseus keeps its
OpenAI framing on top; the control UI consumes the raw `RuntimeEvent` stream so
it can render `tool_call` and `activity` live. Behaviour of Odysseus is
unchanged and its test file must still pass untouched.

## Auth

- **Credential:** `scripts/control-ui-credential.mjs` generates a 24-byte
  base64url password, prints it **once** to stdout, and writes
  `~/.config/deus/control-ui.json` (override: `CONTROL_UI_CREDENTIAL_FILE`) mode
  `0600` containing `{ scrypt: { salt, hash, N: 16384, r: 8, p: 1 }, created_at }`.
  Node's `crypto.scrypt` — no new dependency. Re-running rotates it.
- **Fail closed:** `CONTROL_UI_ENABLED=1` with a missing/unreadable/malformed
  credential file aborts startup with a FATAL log, exactly like Odysseus does
  for a short token.
- **Login:** `POST /auth/login {password}` → scrypt + `timingSafeEqual` →
  session id (32 random bytes, hex) in an in-memory `Map` with 12 h idle and
  7 d absolute expiry → `Set-Cookie: deus_ctl=<id>; HttpOnly; SameSite=Strict;
  Path=/; Max-Age=…`. `Secure` is added when the request is TLS-terminated
  (`req.socket.encrypted` or `X-Forwarded-Proto: https`); over the plain-HTTP
  SSH tunnel it is omitted, otherwise the browser would drop the cookie.
  `POST /auth/logout` deletes the session. Restart logs everyone out (accepted).
- **Lockout:** 5 failed logins per source address → 15 min lock; a global
  counter of 20 failures/15 min locks all logins. Every attempt (success, fail,
  locked) is audit-logged with the source address and never the password.
- **CSRF:** `SameSite=Strict` plus, on every non-GET request, a required
  `X-Deus-Control: 1` header and an `Origin`/`Host` match. A missing header is
  a 403 before any handler runs.
- **What needs no session:** `GET /`, static assets, `manifest.webmanifest`,
  `sw.js`, `POST /auth/login`. Everything under `/api/` and `/events` is 401
  without a valid session.
- **Method gate before auth** (as Odysseus): unknown paths 404, wrong methods
  405, so presence of routes never leaks through auth differences.

## API (JSON under `/api/v1`, SSE at `/api/v1/events`)

Mutating verbs are explicit. Destructive ones require `X-Confirm: <resource id>`
echoed back by the client after a typed confirmation; the server rejects a
mismatch with 428.

| Area | Routes |
|------|--------|
| Me | `GET me` → `{ assistant, version, instance: { unit, cwd }, session: { expires } }` |
| Agents | `GET agents` → `[ { name, description, model, tools?, explores_code?, color?, version?, linear_label?, file } ]` |
| Wardens | `GET wardens` → `[ { name, enabled, type, tools, backends?, custom_instructions, rules_file? } ]`; `PATCH wardens/:name { enabled }` writes `config.json` (created from the example on first write, `.bak-<ts>` kept) |
| MCPs | `GET mcps` → `{ container: [ { name, source, conditional, available } ], skills: [ { name, dir, has_test } ], channels: [ { package, built, configured } ] }` |
| Groups | `GET groups` → registered groups + `{ folder_exists, claude_md_bytes, container }`; `GET groups/:folder/claude-md`; `PUT groups/:folder/claude-md { content }` (1 MB cap, `.bak-<ts>`) |
| Sessions | `GET sessions` → rows + live container; `POST sessions/:folder/:backend/kill` (`X-Confirm`) → `docker stop -t 1` on the active container if any, then `orphan` the row with reason `control-ui kill` via the existing orphan write path |
| Chat | `POST chat/turns { message, history?: [ { role, content } ] }` → SSE stream of `{ type: output_text|activity|tool_call|session|turn_complete|error }` plus a first `{ type: turn_started, id }`; `DELETE chat/turns/:id` → `queue.closeStdin(mainJid)` (graceful `_close`, the same wind-down Odysseus uses — never `docker kill`) |
| Tasks | `GET tasks`; `POST tasks { group_folder, prompt, schedule_type, schedule_value, context_mode, agent_backend? }` (id = `task-<ts>-<rand>` like the container tool; `next_run` via `computeNextRun`); `PATCH tasks/:id { prompt?, schedule_type?, schedule_value?, status? }`; `POST tasks/:id/run` (sets `next_run = now`; the scheduler polls every 60 s — the UI says so); `DELETE tasks/:id` (`X-Confirm`); `GET tasks/:id/runs?limit=50` |
| Channels | `GET channels` → `[ { name, configured, connected, groups: [folder], pairing?: { needs_pairing, qr_available, pairing_code_available } } ]`; `GET channels/whatsapp/qr` → the QR payload text for client-side rendering, only while `store/auth/creds.json` is absent |
| Memory | `GET memory/tree` (vault `memory/`, `groups/`, `Session-Logs/`, `Checkpoints/`; repo `groups/<folder>/*.md`); `GET memory/file?path=`; `PUT memory/file { path, content }` (`X-Confirm-Edit: 1`, path must resolve inside an allowed root, `.bak-<ts>`) |
| Containers | `GET containers` → `docker ps -a --format '{{json .}}'` filtered to `deus-*` names and `deus-agent:*` images + `docker stats --no-stream` merged; `POST containers/:name/stop` (`X-Confirm`); `POST containers/:name/start` (non-`--rm` containers only); `POST containers/rebuild` → spawns `container/build.sh`, streams stdout as `build` SSE events, one build at a time |
| Logs | `GET logs?source=deus|error|group:<folder>&level=&q=&lines=500` → parsed pino lines; `GET logs/export?…` → `text/plain` attachment; live lines arrive as `log` SSE events while a client subscribes (`POST logs/follow { source }` / `DELETE logs/follow`) |
| System | `GET system` → `{ uptime, load, mem, disk: [ { mount, used_pct } ], docker_df, alerts }`; `used_pct ≥ 85` raises an `alert` SSE event and a banner |
| Config | `GET config` → allowlisted keys from `.env` + selected `config.ts` constants; any key matching `/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i` is **absent** from the response, not masked; `PATCH config { key, value }` only for `CONTROL_UI_EDITABLE_KEYS` (`LOG_LEVEL`, `MAX_CONCURRENT_CONTAINERS`, `CONTAINER_TIMEOUT`, `SCHEDULER_TIMEZONE`, `ASSISTANT_NAME`), rewrites `.env` in place with `.bak-<ts>`, and returns `{ restart_required: true }` |
| Debug | `GET debug/health` → probes `{ db, docker, channels, queue_slots, disk, credential_file }`; `GET debug/counts` → row counts per table; `GET debug/events?limit=` → audit ring buffer; `GET debug/trace?message_id=` → ordered steps `{ step, ok, detail }`: message found → chat registered → trigger required/matched → from-me/bot skip → session at that time → task/container log lines ± 2 min → outbound message after |

Common rules: 256 KB body cap (1 MB for the two file `PUT`s), every handler
inside a try/catch that returns `{ error }` with a nonce and logs the stack —
never the stack itself, never env. Timeouts on every `docker` call (15 s).

## Live updates

`GET /api/v1/events` is an authenticated SSE stream. Event types: `queue`
(diffed `snapshot()` every 2 s), `task`, `container`, `system` (every 30 s),
`log`, `build`, `alert`, `ping` (20 s keepalive). Max 8 clients; the 9th gets
503. The client uses `EventSource`, re-syncs on `visibilitychange` and
`online`, and falls back to 10 s polling of the affected views while the stream
is down. WebSocket was considered and rejected: it adds either a dependency or
a hand-written frame parser, and nothing here needs client→server streaming.

## Frontend (`web/control/`)

- `index.html`, `app.css`, `app.js` + `views/*.js` as native ES modules; hash
  routing (`#/chat`, `#/agents`, …). No framework, no bundler, no CDN.
- Dark by default with `prefers-color-scheme` honoured; tokens on `:root`.
- Mobile-first: bottom tab bar (Chat · Agents · Tasks · Logs · More) under
  768 px, left sidebar above. 16 px gutters, no horizontal scroll, 44 px touch
  targets.
- PWA: `manifest.webmanifest`, `sw.js` caching the app shell only (never
  `/api/`), icons in `web/control/icons/`.
- Login screen is the same page: any 401 flips the app to the password form.
- Chat history is kept per group in `localStorage` and replayed to the server
  like Odysseus clients do; the server stores nothing. Tool calls render as
  collapsible rows as they stream.
- Typed-confirmation dialog component used by every destructive verb.

## Error handling

- Client reset mid-stream: `req`/`res` `error` listeners swallow and log, the
  turn's `finalize` releases its slot (lifted verbatim from Odysseus).
- Docker missing or unreachable: Containers/System views show the probe error;
  everything else keeps working.
- Credential file unreadable at runtime (after a successful start): logins fail
  closed with 503 and an audit line.
- SSE client backpressure: if `res.write` returns false twice in a row the
  client is dropped; it reconnects with `Last-Event-ID` and replays the ring.

## Security controls (summary for the threat-modeler)

Bind `127.0.0.1` only; SSH is the transport security. Password hashed with
scrypt; constant-time compare; per-IP and global lockout; audit of every auth
attempt. `HttpOnly` + `SameSite=Strict` cookie, `Secure` when TLS.
CSRF header + Origin check on mutations. Secrets never rendered (absent, not
masked), never logged. No shell from the browser: every action maps to a fixed
`execFile` argv or a DB call. File reads/writes confined to an allowlist of
roots with `realpath` checks. Typed confirmation for every destructive verb.
Body caps, rate limit on login, client caps on SSE. No new host mounts, no
change to container args.

## Testing

- Unit (vitest): `auth` (hash/verify, lockout, cookie flags, expiry),
  `static` (traversal, types), `router`, `agents` parser, `wardens` toggle on a
  temp dir, `config` redaction (property test over generated key names),
  `logs` parser, `debug` trace steps, `events` ring buffer + backpressure.
- Integration: `server.test.ts` boots the server on port 0 with fake
  `ControlDeps`, logs in, exercises every route incl. 401/403/405/428 paths.
- `odysseus-server.test.ts` must pass unchanged after the `web-turn` refactor.
- Manual (Phase 5 checklist in `docs/control-ui-notes.md`): cold reboot,
  tunnel, every tab shows real data, chat round trip, task create/run/disable
  persists, container stop/start, lockout, nothing public answers, channels
  still deliver.

## Phasing

1. Server skeleton, auth, static, SSE hub, Agents/Wardens/MCPs.
2. `web-turn` refactor, Chat, Sessions, Groups.
3. Tasks, Channels, Memory.
4. Containers, Logs, System, Config, Debug.
5. Deploy into `deus-newly.service` (env `CONTROL_UI_ENABLED=1`,
   `CONTROL_UI_PORT=3017`), credential generation, verification, final report.

Each phase: plan-reviewer SHIP (and threat-modeler for 1, 2, 3, 4 — all have
write paths) → TDD → code-reviewer SHIP → commit on `control-ui`.

## Deployment

No new unit: the server runs inside `deus-newly.service` (already
`Restart=always`, `After=docker.service`, enabled at boot, logging to
`logs/deus.log`). Deployment = merge `control-ui` into the main checkout,
`npm run build`, add the two env lines to the unit, `systemctl daemon-reload`,
`systemctl restart deus-newly`, confirm `ss -ltnp` shows only `127.0.0.1:3017`.
Access: `ssh -L 3017:127.0.0.1:3017 root@<host>` then `http://localhost:3017`.
The firewall stays as it is (only 22/tcp).

## Decisions taken without asking

See "Assumptions" in `docs/control-ui-notes.md` — Amos only, port 3017,
password + cookie auth, SSE instead of WebSocket, no build step, branch base,
autonomous commits, cost shown only when present, config allowlist, rebuild
semantics.
