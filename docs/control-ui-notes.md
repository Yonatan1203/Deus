# Control UI — recon notes, assumptions, and verification log

Working notes for the OpenClaw-style control web app for this Deus instance
(**Amos**, `deus-newly.service`). Every path and table name below was read from
code or the live host on 2026-09-20 — nothing is guessed. Secrets are never
recorded here.

## Phase 0 — recon

### Reach

- Running as root on the host (not inside an agent container). `docker`,
  `systemctl`, `ufw`, `nft` and `journalctl` all work. `/etc` is writable.
- Checkout under work: the instance checkout (branch `sync-upstream`), developed in
  the worktree `.claude/worktrees/control-ui` on branch `control-ui`.
  `node_modules` in the worktree is a symlink to the main checkout's.

### Host

| Item | Value |
|------|-------|
| OS | Ubuntu 24.04.3 LTS, kernel 6.8.0-136-generic |
| Docker | 29.1.3 |
| Service manager | systemd |
| Firewall | ufw active — only `22/tcp` allowed inbound; iptables INPUT policy DROP |
| Reverse proxy on host | none (no nginx/caddy/apache units) |
| Ports 80/443 | **occupied** by `docker-proxy` (Traefik for the n8n stack) — not free |
| Public listeners | 22 (sshd), 80/443 (docker-proxy), and docker-published ports on `172.17.0.1` |

Exposure choice is **C — localhost only, SSH tunnel**. That matches the firewall
(only SSH is open) and sidesteps the occupied 80/443.

### Deus instances on this box (three assistants, do not confuse)

| Unit | Checkout | Assistant | Ports |
|------|----------|-----------|-------|
| `deus-newly.service` | this checkout | **Amos** (this project) | credential-proxy 3011, tool-proxy 3013 (both on `172.17.0.1`), Odysseus 3015 (`127.0.0.1`) |
| `deus.service` | a second checkout (sibling fork) | Rafi | 3001, 3003, 3005 |
| `nanoclaw.service` | a third checkout | NanoClaw (Gmail fork) | — |

`deus-newly.service` facts (from `systemctl cat`): `After=docker.service`,
`Restart=always`, `RestartSec=5`, `KillMode=process`, stdout/stderr appended to
`<checkout>/logs/deus.log` and `logs/deus.error.log` (journald is empty for
this unit — the log files are the source of truth). Environment sets
`CONTAINER_IMAGE=deus-agent:newly`, `MAX_CONCURRENT_CONTAINERS=2`,
`DEUS_VAULT_PATH=<instance vault>`, `DEUS_DB=<instance>/.deus/memory.db`,
`DEUS_EVOLUTION_DB` and `DEUS_MEMORY_TREE_DB` under the same `<instance>/.deus/`, and the
Odysseus token (value not recorded). `DEUS_HOME` is **not** set, so
`scripts/cockpit_healthcheck.py` writes its artifacts to `~/.deus/` — shared
with Rafi. Recorded as a known wrinkle for the System tab.

### Data model (read from `src/db.ts`, `src/types.ts`)

SQLite at `store/messages.db` (WAL). Tables: `chats`, `messages`,
`scheduled_tasks`, `task_run_logs`, `router_state`, `sessions`,
`registered_groups`, `projects`, `auto_compress_state`, and the `linear_*`
pipeline tables.

- `registered_groups` → `RegisteredGroup { name, folder, trigger, added_at,
  containerConfig?, requiresTrigger?, isControlGroup?, projectId? }`. Readers:
  `getAllRegisteredGroups()`, `getRegisteredGroupByFolder()`; writer
  `setRegisteredGroup()`. Live copy lives in `RouterState.registeredGroups`.
- `scheduled_tasks` → `ScheduledTask { id, group_folder, chat_jid, prompt,
  schedule_type: cron|interval|once, schedule_value, context_mode:
  group|isolated, next_run, last_run, last_result, status:
  active|paused|completed, created_at, agent_backend?, agent_effort? }`.
  API: `createTask`, `getTaskById`, `getAllTasks`, `updateTask` (prompt,
  schedule_type, schedule_value, next_run, status, agent_backend),
  `deleteTask` (also deletes its run logs), `updateTaskAfterRun`.
- `task_run_logs` → `TaskRunLog { task_id, run_at, duration_ms, status, result,
  error }`. **No read accessor exists** — only INSERT/DELETE. The Tasks tab needs
  a new `getTaskRunLogs(taskId, limit)` in `db.ts`.
- `sessions` → one row per `(group_folder, backend)`: `session_id`,
  `resume_cursor`, `metadata_json`, `last_used_at`, `orphaned_at`,
  `orphan_reason`, `last_compacted_at`. Readers `getAllSessions()`,
  `getAllBackendSessions()`, `getSessionLastUsedAt()`. No token/cost columns —
  Sessions tab shows "n/a" for cost unless `metadata_json` carries it.
- `chats` / `messages` → `getAllChats()`, `getMessagesSince()`; used by the
  Debug "why no reply" trace.

### Runtime objects (in-process, `src/index.ts`)

- `GroupQueue` (`src/group-queue.ts`): per-jid `GroupState { active,
  idleWaiting, isTaskContainer, runningTaskId, pendingTasks, process,
  containerName, groupFolder, retryCount }` — **private map, no read accessor**.
  Containers/Sessions tabs need a read-only `snapshot()` added.
  `enqueueTask(jid, id, fn)`, `closeStdin(jid)`, `isShuttingDown()`,
  `availableSlots()`.
- `RuntimeRegistry` + `RuntimeEventSink = (event: RuntimeEvent) => void`.
  `RuntimeEvent` is `output_text | activity | tool_call{name,arguments} |
  session | turn_complete | error` — enough to stream text **and** tool calls
  live.
- Agent containers are named `deus-<group>-<ts>-i<instanceId>` and run with
  `--rm`; stop path is `docker stop -t 1 <name>` then `docker kill`
  (`container-runner.ts:697`). None running at recon time.
- Channels: `src/channels/index.ts` imports every `mcp-*` factory; each returns
  null if unconfigured. Live `Channel[]` is a local in `main()` (`index.ts:145`)
  with `isConnected()` per channel — needs to be passed into the control server.

### Files the panels read/write

| Panel | Source |
|-------|--------|
| Agents | `.claude/agents/*.md` frontmatter (27 files; fields `name`, `description`, `model`, `explores_code`, `color`, `version`, `linear_label`, `tools`) |
| Wardens | `.claude/wardens/config.json` (same file the Rust TUI writes, `tui/src/config/wardens.rs:87`). **Does not exist yet** on this checkout — only `config.json.example`. Rules files `.claude/wardens/*-rules.md` |
| MCPs | container `mcpServers` block (`container/agent-runner/src/index.ts:978`: `deus`, optional `gcal`, `linear`), skill MCPs from `container/agent-runner/src/skills/*/agent.ts` via `skill-mcp-registry.ts`, host channel packages `packages/mcp-*` |
| Groups / memory | `groups/<folder>/CLAUDE.md` (+ `.bak-*`), `groups/<folder>/logs/`; vault at `$DEUS_VAULT_PATH` (`memory/`, `groups/`, `Session-Logs/`) |
| Channels | live `Channel.isConnected()`; configured-ness per `tui/src/config/channels.rs` (`store/auth/creds.json` for WhatsApp, env keys for the rest) |
| Logs | `logs/deus.log`, `logs/deus.error.log` (pino JSON lines), `groups/<folder>/logs/` |
| Config | `.env` via `readEnvFile()` (`src/env.ts`, cwd-relative) + `~/.config/deus/config.json`, `mount-allowlist.json` |

### Existing server pattern to copy

`src/odysseus-server.ts`: Node built-in `http`, bind `127.0.0.1`, bearer token
≥32 chars from `readEnvFile` (fail-closed), constant-time compare, method gate
before auth, 64 KB body cap, in-memory rate limit, SSE keepalive, audit log with
no secrets, `req`/`res` error handlers so a client reset never crashes the host.
Wired in `src/index.ts:505` and pushed onto `webhookServers` for shutdown.
Tests: `src/odysseus-server.test.ts` (vitest, real `http` listener on port 0).

## Assumptions (decided without asking, per the brief)

1. **Amos only.** The server lives inside `deus-newly` and shows this instance.
   Rafi can adopt the same code by pulling the branch.
2. **Port 3017** on `127.0.0.1` (free; 3011/3013/3015 are taken here).
3. **Auth = login page + password.** Generated once, stored as an argon2/scrypt
   hash (Node `crypto.scrypt`, no new dependency) in `~/.config/deus/control-ui.json`
   mode 0600. Session cookie `HttpOnly; SameSite=Strict; Secure` is set only when
   the request arrived over TLS — through a plain-HTTP SSH tunnel `Secure` would
   make the cookie unusable, so it is omitted on `http://localhost` and enforced
   otherwise. Lockout after 5 failures per source for 15 minutes.
4. **No WebSocket.** Live updates use SSE with automatic reconnect and a polling
   fallback — SSE needs no dependency and matches the existing Odysseus path.
   The brief asks for WebSocket; SSE delivers the same UX here. Recorded.
5. **No build step, no CDN.** Vanilla HTML/CSS/JS under `web/control/`, served
   by the same server with a path-traversal guard. PWA manifest + service worker
   included.
6. **Branch from `sync-upstream`**, which is `origin/main` plus two local
   commits (voice transcription, OpenAI proxy route). Rebase onto `origin/main`
   before any upstream PR.
7. **Commits land autonomously** on `control-ui` (the brief says "small
   commits" and "don't stop to ask"); repo warden gates (plan-reviewer,
   threat-modeler, code-reviewer) still run per phase.
8. **Cost/tokens per session**: shown only if present in `metadata_json`;
   otherwise "n/a".
9. **Config editing** limited to an explicit allowlist of non-secret keys.
   Nothing that ends in `TOKEN`, `KEY`, `SECRET`, `PASSWORD` is ever rendered.
10. **Container "rebuild"** runs `container/build.sh` in the background and
    streams its log; it never touches mounts or isolation.

## Verification log

Filled in during Phase 5.
