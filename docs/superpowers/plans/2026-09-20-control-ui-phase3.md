# Control UI — Phase 3 Implementation Plan (Tasks, Channels, Memory)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage scheduled tasks (list, create, edit, pause/resume, run now, delete, run history), see channel adapters with connection state, group wiring and WhatsApp pairing state, and browse/edit memory files (vault + per-group) behind an explicit edit toggle.

**Architecture:** Three new API modules behind the Phase 2 `ControlStore`/`ControlDeps` seams (`store` gains the task functions and `onTasksChanged`; `deps` gains `channels()`, `vaultPath` and `whatsappAuthDir`), one new DB reader (`getTaskRunLogs`), routes in `server.ts`, three views. The vault path comes from the already-exported `resolveVaultPath` in `src/solutions/store.ts` (the same helper `auto-compress.ts`, `consolidation-core.ts` and `linear-dispatcher.ts` use). Task validation mirrors `src/ipc.ts:243-313` (the container's `schedule_task` path) so a dashboard-created task is indistinguishable from an agent-created one.

**Tech Stack:** unchanged. `qrcode-terminal` (an existing root dependency) renders an ASCII QR through a lazy dynamic import; on failure the API returns the text only.

**Spec:** `docs/superpowers/specs/2026-09-20-control-ui-design.md` (API rows Tasks, Channels, Memory; "What a session really grants"; read-only mode). Prior plans: Phase 1 and Phase 2 in the same directory.

## Global Constraints

- Everything from Phases 1–2 (localhost bind, no new runtime deps, text-node DOM, generic names, X-Deus-Session on mutations, read-only refuses every mutation, Prettier).
- A scheduled task's prompt is agent instruction text with the target group's privileges, and its **output is delivered to a real chat destination** — a new boundary (dashboard → scheduler → channel → recipients). The create body therefore names the destination `chat_jid` explicitly (validated to be a registered jid of the chosen folder); it is shown in the form and carried in the audit line. Create/update/run/pause are mutations (403 in read-only) with a 6/min per-session limiter on create and run-now, an interval floor of `SCHEDULER_POLL_INTERVAL` (60 000 ms) enforced on create **and** update, a cap of 50 creates per session, and a cap of 100 **active** tasks in total (a dashboard create is refused with 429 above it). Stated ceiling: a 6-field cron (`* * * * * *`) is perpetually due and runs once per 60 s poll like a floor interval, so the binding bound is the active-task cap — at most 100 container runs and 100 outbound messages per minute, the same order as the pre-existing IPC path allows; **delete requires `X-Confirm: <task id>`**; create and run-now are audited with a prompt hash. `DELETE` exposes the pre-existing hard `deleteTask` (`src/db.ts:673`, already reachable by agents through IPC `delete_task`); `docs/decisions/no-db-deletion.md` predates this UI and its soft-delete migration for `scheduled_tasks` is a separate follow-up, not reworked here.
- Memory roots: the vault (Deus's own long-term memory) and `groups/` in the repo. **In read-only mode the vault root is excluded entirely** — read-only is the phone deployment and the vault is the personal corpus. Within the vault, `Persona/`, `Atoms/` (mirrored from the memory DB) and the root `CLAUDE.md` (global core memory) are **read-only from the dashboard**; every other vault write returns `index_not_updated: true` because the semantic index is not rebuilt by a file write. `groups/**/CLAUDE.md` is refused in `/memory/file` (409 pointing at the `/groups` route) so one asset has one gate.
- Memory writes: `.md` files only, **existing files only**, 1 MB cap, `.bak-<ts>-<rand>` with the newest 10 kept (aligned with the groups route), 12/min per session, `X-Confirm-Edit: 1` on every write. Reads are audited (`root` + `path` only).
- Symlinks: the tree walk `lstat`-skips symlinks; reads and writes resolve `realpath` on root and target and act on the resolved path; anything resolving outside its root is 404.
- The WhatsApp QR is credential issuance: the route is a **mutation** (403 in read-only), requires typed `X-Confirm: whatsapp`, is audited on every fetch (`control_ui_whatsapp_qr {actor, remoteAddr}`), is served only while unpaired (409 once `creds.json` exists), and the UI states the revocation path (WhatsApp → Linked devices → unlink). The pairing files are resolved exactly as the adapter does: `WHATSAPP_AUTH_DIR` if set, else `<repoRoot>/store/auth`, with `qr-data.txt` and `pairing-code.txt` in its parent directory.
- Run-log `result`/`error` are truncated to 4 096 characters per row in the reader (agents store untruncated output).
- Rotation runbook (notes): rotating the password revokes sessions, not tasks — review the task list and `control_ui_task_create` audit lines after a rotation.
- Screenshots use the generic assistant name and synthetic fixtures (notes assumption 11).
- Rollback: unset `CONTROL_UI_ENABLED`; additive files plus one hoisted closure in `src/index.ts`.

## Design (patterns and data structures)

- **Validation mirror, one notch stricter** — `resolveNextRun(type, value, now)` in `api/tasks.ts` reproduces the IPC rules (cron → `parseCronExpression(value, TIMEZONE).next()`, interval → `now + ms`, once → a valid date) and returns `{ ok, next_run } | { error }`; **the 60 000 ms interval floor is checked inside this shared function**, so create and update enforce it identically and a task cannot be patched below it. IPC only requires `ms > 0`; the dashboard is deliberately stricter on the human-facing surface, so a dashboard task is agent-equivalent in shape but never sub-minute. The dashboard may target any registered folder (the IPC path restricts a non-control group to itself) because a dashboard session is control-group-equivalent by design. Duplicating ~20 lines is chosen over touching `src/ipc.ts` (heavily tested, out of scope); recorded as a follow-up dedupe.
- **Store seam extension** — `ControlStore` grows `getAllTasks/getTaskById/createTask/updateTask/deleteTask/getTaskRunLogs/onTasksChanged`; `index.ts` hoists its existing `onTasksChanged` closure (`src/index.ts:724`) into `const refreshTaskSnapshots` declared **before the `startControlServer` call at `:518`** (everything it uses — `state`, `getAllTasks`, `writeTasksSnapshot` — is in scope from `:126`), used by both IPC and the control UI.
- **Root-confined file access** — `memory.ts` keeps a `Map<rootName, absolutePath>` (`vault`, `groups`; `vault` omitted in read-only), lists with a bounded, iterative walk (depth ≤ 4, ≤ 2000 entries, `.md` only, `lstat`-skips symlinks, skips dot-dirs and `node_modules`), resolves every request through `fs.realpathSync` on root and target + `startsWith(root + sep)`, and applies a per-root **write policy**: vault `Persona/`, `Atoms/`, root `CLAUDE.md` → read-only; `groups/**/CLAUDE.md` → refused here (409).
- **Channel wiring by ownership** — for each live `Channel`, `groups` = registered folders whose jid satisfies `channel.ownsJid(jid)`; the adapter list is the fixed set of packages so unconfigured ones still appear. Pairing paths derive from one `whatsappAuthDir` value passed in by `index.ts`.
- **Explicit destination** — `createTaskFromBody` requires `chat_jid`; `registeredGroups()[chat_jid]?.folder === group_folder` or 400. No implicit "first jid".
- **Retention** — memory and groups both keep the newest 10 backups; memory's limiter is 12/min (browse-and-tweak usage) vs groups' 6/min (rare instruction edits) — stated so the difference is deliberate.
- **Optional renderer** — `qrcode-terminal` is loaded with a dynamic `import()` inside a try/catch; the API shape is the same either way (`{ qr, ascii: string | null }`).

## File map

| Path | Responsibility |
|------|----------------|
| `src/db.ts` (modify) | `getTaskRunLogs(taskId, limit)` |
| `src/db.test.ts` (modify) | one case |
| `src/control-ui/store.ts` (modify) | task functions + `onTasksChanged` on `ControlStore` |
| `src/control-ui/api/tasks.ts`, `channels.ts`, `memory.ts` (create) + tests | tab data + mutations |
| `src/control-ui/api/mcps.ts` (modify: export `CHANNEL_CONFIGURED`) | reuse the configured-signal map |
| `src/control-ui/server.ts` (modify) | `ControlDeps.channels?`, `vaultPath?`; routes; limiter; `task` broadcasts |
| `src/control-ui/server.test.ts` (modify) | route tests |
| `src/index.ts` (modify) | hoist `onTasksChanged` above `:518`, pass `channels`, `vaultPath` (from `src/solutions/store.ts`), `whatsappAuthDir`, task store functions |
| `web/control/views/tasks.js`, `channels.js`, `memory.js` (create); `app.js`, `app.css`, `sw.js` (modify) | UI |
| `docs/control-ui-notes.md`, `docs/control-ui-progress.md`, `docs/control-ui/artifacts/phase3-*.png` | record |

Consuming call sites: the three views are mounted by `app.js` `VIEWS`; served by `static.ts` → `server.ts` → `index.ts`. Confirmed by the capture step.

## API surface verified

- `createTask(task: Omit<ScheduledTask,'last_run'|'last_result'>)` — `src/db.ts:589` (inserts `context_mode || 'isolated'`, `agent_backend ?? null`); `getTaskById(id)` `:612`; `getAllTasks()` `:617`; `updateTask(id, Partial<Pick<…,'prompt'|'schedule_type'|'schedule_value'|'next_run'|'status'|'agent_backend'>>)` `:623` (no-op on empty updates); `deleteTask(id)` `:673` (also deletes run logs); `logTaskRun` is the only writer of `task_run_logs`; no reader exists.
- IPC task rules — `src/ipc.ts:243-313` (create: cron via `parseCronExpression(value, TIMEZONE)`, interval `parseInt` > 0 → `now + ms`, once → valid date; id `task-<Date.now()>-<6 base36>`; `context_mode` group|isolated default isolated; `agent_backend` via `parseAgentBackend`) and `:405-462` (update recomputes `next_run` when the schedule changed; interval falls back silently when invalid; cron invalid → abort).
- `parseCronExpression(value, tz)` — `src/cron.ts:11`; `TIMEZONE` — `src/config.ts:289`; `parseAgentBackend(value): AgentRuntimeId | undefined` — `src/agent-runtimes/types.ts:8`; `computeNextRun(task)` — `src/task-scheduler.ts:48` (used after a run; not for creation); scheduler polls every `SCHEDULER_POLL_INTERVAL = 60000`.
- `onTasksChanged` — `src/index.ts:724` (rewrites the tasks snapshot for every registered group from `getAllTasks()`).
- `Channel { name, connect, sendMessage, isConnected(), ownsJid(jid), disconnect, setTyping?, syncGroups? }` — `src/types.ts`; channels are created in `src/index.ts:416-432` into a local `channels: Channel[]` (`:145`); registered names `whatsapp|telegram|discord|slack|gmail|outlook|teams` (`src/channels/mcp-*.ts`), plus package `mcp-x`; WhatsApp `AUTH_DIR = WHATSAPP_AUTH_DIR || <cwd>/store/auth` and the QR is written to `<dirname(AUTH_DIR)>/qr-data.txt` — `packages/mcp-whatsapp/src/whatsapp.ts:54,174`; `pairing-code.txt` is written by `scripts/whatsapp-auth.ts` next to it.
- `CHANNEL_CONFIGURED` map — `src/control-ui/api/mcps.ts` (Phase 1).
- `resolveVaultPath(): string | null` — **exported** from `src/solutions/store.ts:64` (mirrors `container-mounter.ts:43`; already used by `src/auto-compress.ts:11`, `src/consolidation-core.ts:5`, `src/linear-dispatcher.ts:35`); the `container-mounter.ts` copy stays private and untouched.
- `SCHEDULER_POLL_INTERVAL = 60000` — `src/config.ts:40` (interval floor).
- `docs/decisions/no-db-deletion.md` — scopes all DB deletes; `deleteTask` (`src/db.ts:673`) predates it and is reachable via `src/ipc.ts:386`; this plan exposes it unchanged.
- `qrcode-terminal` — a root dependency (`package.json:77`, also `packages/mcp-whatsapp/package.json:20`), untyped; loaded lazily with a dynamic `import()` and a local minimal type so the tasks/memory paths never load it, with a null fallback if the import ever fails.

## Verification strategy (frozen before implementation)

| Check | Command | Expected |
|-------|---------|----------|
| Units | `npx vitest run src/control-ui src/db` | tasks/channels/memory modules + server routes green; `getTaskRunLogs` case green |
| Whole suite / tsc / eslint / prettier | as before | green / 0 / 0 / clean |
| Tasks create | `POST /api/v1/tasks {group_folder:'main',chat_jid:'main@x',prompt:'p',schedule_type:'interval',schedule_value:'60000'}` (also: with 100 active tasks already in the store → `429`) | `201` with `id` matching `task-\d+-[a-z0-9]{6}`, `chat_jid:'main@x'`, `next_run` ≈ now+60 s, `status:'active'`; `onTasksChanged` called once; bad cron → `400 {"error":"invalid cron expression"}`; unregistered folder → `404`; `chat_jid` of another folder → `400`; missing `chat_jid` → `400`; `schedule_type:'weekly'` → `400`; interval `1000` → `400 {"error":"interval must be at least 60000 ms"}`; 7th create in a minute → `429`; 51st create in a session → `429` |
| Tasks update | `PATCH /api/v1/tasks/:id {schedule_value:'120000'}` → `200`, `next_run` recomputed; `{schedule_value:'1000'}` on an interval task → `400 {"error":"interval must be at least 60000 ms"}`; `{status:'paused'}` → `200`; `{status:'completed'}` → `400`; unknown id → `404` |
| Run now | `POST /api/v1/tasks/:id/run` → `200 {next_run:<now>}`; on a paused task → `409`; audit line carries `promptHash` and `chat_jid`; 7th create-or-run in a minute → `429` (shared limiter, asserted with a mix of creates and runs) |
| Delete | no `X-Confirm` → `428`; with `X-Confirm: <id>` → `204`; `getTaskRunLogs` for it → `[]` |
| Runs | `GET /api/v1/tasks/:id/runs` → newest first, `limit` honoured, `result`/`error` ≤ 4 096 chars (unit on the db reader: 3 rows + one 10 000-char result) |
| Read-only | every task mutation → `403` |
| Channels | `GET /api/v1/channels` → 8 adapters; a fake live channel `telegram` (connected, owns `main@x`) → `connected:true, groups:['main']`; `whatsapp` with no creds and a `qr-data.txt` present under the injected `whatsappAuthDir`'s parent → `pairing:{needs_pairing:true,qr_available:true,pairing_code_available:false}`; `POST /api/v1/channels/whatsapp/qr` without `X-Confirm` → `428`, with `X-Confirm: whatsapp` → `200 {qr:'…', ascii}` + audit `control_ui_whatsapp_qr`, `409` once `creds.json` exists, `403` in read-only |
| Memory tree | two roots, `.md` only, entries carry `root/path/bytes/mtime`, dot-dirs and symlinked dirs skipped; **read-only server → only the `groups` root** |
| Memory read | `GET /api/v1/memory/file?root=vault&path=memory/a.md` → content + audit `control_ui_memory_read {root,path}`; `path=../secret.md` → `404`; a symlink inside the root pointing outside → `404`; `.txt` → `404`; read-only server + `root=vault` → `404` |
| Memory write | without `X-Confirm-Edit` → `428`; with it → `200 {bytes_before,bytes_after,backup,index_not_updated:true}` for a vault file (no flag for `groups`); 2nd write → distinct backup; 12 writes keep 10 backups; a missing file → `404` (no creation); `vault:CLAUDE.md`, `vault:Persona/x.md`, `vault:Atoms/x.md` → `403 {"error":"read-only from the dashboard"}`; `groups:main/CLAUDE.md` → `409` pointing at `/api/v1/groups/main/claude-md`; 1.2 MB → `413`; 13th write in a minute → `429`; read-only → `403` |
| Visual | fixture with three synthetic tasks (one paused, one with two run logs), fake channels (one connected), a synthetic vault; PNGs `phase3-{tasks,channels,memory}-{mobile,desktop}.png`; reviewed for placeholder-only content | record in notes with PASS/FAIL |

Not covered: a real scheduled run through the live scheduler (Phase 5's deploy check creates a one-off task and watches it run).

Taste-pass: skipped (design given). Oracle: no new credential surface; the existing db/IPC tests are the reference for task semantics.

---

### Task 1: `getTaskRunLogs` and the store seam

- [ ] **Step 1: failing db test** — append to `src/db.test.ts`:

```ts
describe('control-ui task run logs', () => {
  it('lists runs newest first with a limit', () => {
    createTask({ id: 'task-r', group_folder: 'main', chat_jid: 'g@x', prompt: 'p', schedule_type: 'once', schedule_value: '2024-06-01T00:00:00.000Z', context_mode: 'isolated', next_run: null, status: 'active', created_at: '2024-01-01T00:00:00.000Z' });
    for (const i of [1, 2, 3]) logTaskRun({ task_id: 'task-r', run_at: `2024-06-0${i}T00:00:00.000Z`, duration_ms: i, status: 'success', result: i === 3 ? 'x'.repeat(10_000) : `r${i}`, error: null });
    const runs = getTaskRunLogs('task-r', 2);
    expect(runs[0].result).toHaveLength(4096);
    expect(runs[1].result).toBe('r2');
    expect(getTaskRunLogs('nope', 5)).toEqual([]);
  });
});
```
(Add `getTaskRunLogs`, `logTaskRun` to that file's `./db.js` import block.)

- [ ] **Step 2: run red.** `npx vitest run src/db` → `getTaskRunLogs is not a function`.

- [ ] **Step 3: implement** in `src/db.ts` after `logTaskRun`:

```ts
export function getTaskRunLogs(taskId: string, limit = 50): TaskRunLog[] {
  return db
    .prepare(
      `SELECT task_id, run_at, duration_ms, status, result, error
       FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC, id DESC LIMIT ?`,
    )
    .all(taskId, limit) as TaskRunLog[];
}
```
Truncate in SQL: `substr(result, 1, 4096) AS result, substr(error, 1, 4096) AS error`. In `src/control-ui/store.ts` extend:

```ts
import type { ScheduledTask, TaskRunLog } from '../types.js';
export interface ControlStore {
  // Phase 2 members unchanged …
  getAllTasks(): ScheduledTask[];
  getTaskById(id: string): ScheduledTask | undefined;
  createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void;
  updateTask(id: string, updates: Partial<Pick<ScheduledTask, 'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status' | 'agent_backend'>>): void;
  deleteTask(id: string): void;
  getTaskRunLogs(taskId: string, limit: number): TaskRunLog[];
  onTasksChanged(): void;
}
```
Update the Phase 2 fakes in `sessions.test.ts`, `groups.test.ts` and `server.test.ts` with no-op implementations of the new members (a small `taskStoreStub()` helper in `server.test.ts` returning vi.fn()s over an in-memory `Map<string, ScheduledTask>` so the route tests can assert persistence).

- [ ] **Step 4: green + typecheck.** Commit `feat(host): add a truncating task run-log reader for the control UI`.

---

### Task 2: API modules

**Interfaces (Produces):**
- `api/tasks.ts`: `resolveNextRun(type: string, value: string, now?: number): { ok: true; next_run: string } | { ok: false; error: string }`; `listTasks(store): ScheduledTask[]` (sorted `status` active first, then `next_run`); `createTaskFromBody(store, runtime, body, now?): { ok: true; task: ScheduledTask } | { ok: false; status: 400 | 404; error: string }` (validates `group_folder` registered (404) and `chat_jid` present and registered for that folder (400); `prompt` non-empty string ≤ 32 KB; interval ≥ 60 000 ms; `context_mode`; `agent_backend` via `parseAgentBackend`; id `task-<now>-<6 base36>`); `updateTaskFromBody(store, id, body, now?)` (allowed keys `prompt`, `schedule_type`, `schedule_value`, `status` ∈ active|paused, `agent_backend`; recompute `next_run` when the schedule changes; `{ ok, task } | { status: 400|404, error }`); `runTaskNow(store, id, now?)`: active task → `updateTask(id, { next_run: now ISO })` → `{ ok, next_run, promptHash, chat_jid }`; paused/completed → `{ status: 409 }`; unknown → 404; `removeTask(store, id): boolean`.
- `api/channels.ts`: `const ADAPTERS = ['whatsapp','telegram','discord','slack','gmail','outlook','teams','x']`; `listChannels(deps: { repoRoot, envHas, channels(): Channel[], registeredGroups(), whatsappAuthDir: string }): ChannelView[]` with `ChannelView = { name, package, configured: boolean | null, connected: boolean, groups: string[], pairing?: { needs_pairing, qr_available, pairing_code_available } }` (pairing only for whatsapp: `creds.json` under `whatsappAuthDir`, `qr-data.txt` and `pairing-code.txt` under `dirname(whatsappAuthDir)`); `whatsappQr(whatsappAuthDir): Promise<{ qr: string; ascii: string | null } | { status: 404 | 409 }>` (409 when creds exist; 404 when no qr file; ascii via `await import('qrcode-terminal')` → `generate(qr, { small: true }, cb)` wrapped in a Promise, null on any failure).
- `api/memory.ts`: `interface MemoryRoots { vault: string | null; groups: string }`; `memoryTree(roots): { root: 'vault'|'groups'; path: string; bytes: number; mtime: string; writable: boolean }[]`; `resolveMemoryFile(roots, root, rel): string | null` (realpath-confined, `.md` only, must exist and be a regular file); `readMemoryFile(roots, root, rel): { content, bytes, mtime } | null`; `writePolicy(root, rel): 'ok' | 'read_only' | 'use_groups_route'` (vault `Persona/`, `Atoms/`, root `CLAUDE.md` → `read_only`; `groups` `*/CLAUDE.md` → `use_groups_route`); `writeMemoryFile(roots, root, rel, content): { bytes_before, bytes_after, backup, index_not_updated: boolean } | null` (existing files only; writes to the realpath; backup `<name>.bak-<ts>-<4 hex>`, newest 10 kept per file; `index_not_updated = root === 'vault'`).

- [ ] **Step 1: failing tests** — `api/tasks.test.ts` (resolveNextRun for the three types incl. invalid cron/interval/date and the 60 s floor; create happy path asserts id pattern, explicit `chat_jid`, `status:'active'`, `onTasksChanged` once; 404 for an unregistered folder; 400 for a jid of another folder or a missing jid; update recompute; run-now on paused → 409; remove → true/false), `api/channels.test.ts` (fake channels + a temp auth dir with/without creds and qr; `whatsappQr` 409/404/text), `api/memory.test.ts` (temp vault + groups dirs: tree excludes `.git`/`.hidden`/`notes.txt` and a symlinked dir; read confinement `../`, absolute path, symlink to `/etc/hostname` → null; write existing only; backups distinct and pruned to 10; `writePolicy` for `CLAUDE.md`, `Persona/a.md`, `Atoms/a.md`, `groups:main/CLAUDE.md`, `groups:main/notes.md`; `index_not_updated` true for vault, false for groups).

- [ ] **Step 2: run red.** **Step 3: implement** the three modules (memory uses `fs.realpathSync` on root and target; tree via an explicit stack, not recursion). Export `CHANNEL_CONFIGURED` from `mcps.ts`. **Step 4: green + commit** `feat(control-ui): add tasks, channels, and memory modules`.

---

### Task 3: Routes and host wiring

- [ ] **Step 1: failing server tests** (extend `boot()` with `channels` and `vaultPath`; a `taskStoreStub()` backed by a `Map`):
  - Tasks: `GET /api/v1/tasks` → list; `POST` happy → 201 (+ `task` SSE frame seen by an attached client); bad cron → 400; unregistered folder → 404; wrong/missing `chat_jid` → 400; interval 1000 → 400; 7th create in a minute → 429; `PATCH` → 200 with new `next_run`; `status:'completed'` → 400; `POST …/run` → 200 on active, 409 on paused; `DELETE` → 428 without confirm, 204 with `X-Confirm: <id>`; `GET …/runs` → array; read-only → 403 for POST/PATCH/run/DELETE.
  - Channels: 8 adapters; fake `telegram` connected owning `main@x` → `groups:['main']`; whatsapp pairing flags from the temp auth dir; `POST /channels/whatsapp/qr` → 428 without confirm, 200 `{qr}` with `X-Confirm: whatsapp` unpaired (+ audit), 409 after writing `creds.json`, 403 in read-only.
  - Memory: tree lists both roots (only `groups` on the read-only server); read ok (+ audit) / `../` 404 / `.txt` 404; write 428 without `X-Confirm-Edit`; 200 with backup and `index_not_updated`; vault `CLAUDE.md` / `Persona/` / `Atoms/` → 403; `groups:main/CLAUDE.md` → 409; missing file 404; 1.2 MB → 413; 13th write → 429; read-only → 403.
- [ ] **Step 2: red.** **Step 3: implement** in `server.ts`: `ControlDeps.channels?: () => Channel[]`, `vaultPath?: string | null`, `whatsappAuthDir?: string`; `taskLimiter = createRateLimiter(6, 60_000)`, a `Map<sid, count>` for the per-session create cap (50) that is cleared whenever the session store is cleared (rotation, revoke-all) and bounded to 1 000 entries (oldest dropped), and an active-task cap (`store.getAllTasks().filter(t => t.status === 'active').length >= 100` → 429); routes:
  - `GET /api/v1/tasks`; `POST /api/v1/tasks` → 201, audit `control_ui_task_create {taskId, folder, chat_jid, schedule_type, promptHash, actor}`, `store.onTasksChanged()`, broadcast `task`; `PATCH /api/v1/tasks/:id` (id `^[A-Za-z0-9_-]{1,80}$`), audit with `{from: {status,schedule}, to}`; `POST /api/v1/tasks/:id/run` → limiter → audit `control_ui_task_run {taskId, chat_jid, promptHash}`; `DELETE /api/v1/tasks/:id` (`X-Confirm: <id>`) → 204 + audit + broadcast; `GET /api/v1/tasks/:id/runs?limit=` (1..200).
  - `GET /api/v1/channels`; `POST /api/v1/channels/whatsapp/qr` (mutation; `X-Confirm: whatsapp` else 428; audit `control_ui_whatsapp_qr {actor, remoteAddr}`).
  - `GET /api/v1/memory/tree` (vault root omitted when `deps.readOnly`); `GET /api/v1/memory/file?root=&path=` (vault → 404 in read-only; audit `control_ui_memory_read {root, path, actor}`); `PUT /api/v1/memory/file {root, path, content}` (`maxBody` 1.5 MB; `X-Confirm-Edit: 1` else 428; `writePolicy` → 403 `read-only from the dashboard` / 409 `use /api/v1/groups/<folder>/claude-md`; content ≤ 1 MB else 413; `memoryLimiter = createRateLimiter(12, 60_000)` keyed by session → 429; audit `control_ui_memory_write {root, path, bytes_before, bytes_after, backup, index_not_updated, actor}`; broadcast `memory`).
  - Task/channel routes answer 503 without `store`/`runtime`; memory needs only `deps.repoRoot` (+ `vaultPath` may be null → one root).
- `src/index.ts`: declare `const refreshTaskSnapshots = () => {…}` (the body of the closure at `:724`) **above the `startControlServer` call**, use it in the IPC deps, pass it as `store.onTasksChanged`; pass `getAllTasks, getTaskById, createTask, updateTask, deleteTask, getTaskRunLogs`, `channels: () => channels`, `vaultPath: resolveVaultPath()` imported from `./solutions/store.js`, `whatsappAuthDir: path.resolve(process.env.WHATSAPP_AUTH_DIR || path.join(PROJECT_ROOT, 'store', 'auth'))` (resolved so a relative value cannot differ between host and adapter).
- [ ] **Step 4: green, tsc, eslint, prettier; commit** `feat(control-ui): add tasks, channels, and memory routes`.

---

### Task 4: Views and capture

- [ ] `views/tasks.js`: table (group, **destination jid**, schedule `cron … / every N min / once at …`, next run, last run + result badge, status, backend) with row actions Run now, Pause/Resume, Edit (inline form), Runs (expand: `GET …/runs`), Delete (typed confirm = id); a "New task" form (group `<select>` from `/api/v1/groups` whose choice fills a **destination `<select>` of that folder's registered jids**, prompt textarea, type select, value input with a hint per type incl. the 60 s interval floor, context mode, backend); refresh on `task`/`refresh`; all write controls hidden in read-only.
- [ ] `views/channels.js`: a card per adapter with configured/connected badges and wired group chips; WhatsApp card shows the pairing panel when `needs_pairing`: a "Show pairing QR" button → `confirmTyped('whatsapp', 'This links a phone as the assistant\'s WhatsApp. Unlink later from WhatsApp → Linked devices.')` → `POST /channels/whatsapp/qr` with `X-Confirm` → renders `ascii` in a `<pre class="qr">` (or the raw text when `ascii` is null); hidden in read-only.
- [ ] `views/memory.js`: left list (root + path, filter box, a lock glyph on non-writable entries), right viewer: read-only `<pre>` by default; "Edit" toggle (only when `writable`) → textarea + Save (plain confirm, sends `X-Confirm-Edit: 1`); shows "semantic index not updated" after a vault write; a `groups/**/CLAUDE.md` entry links to the Groups tab instead of editing; hidden in read-only.
- [ ] `app.js` VIEWS add `tasks` ('◷'), `channels` ('⌁'), `memory` ('▥'); SSE types add `task`, `memory`; `sw.js` shell list; CSS for `.qr` (monospace, line-height 1, letter-spacing 0), task table actions, memory two-pane (stacked under 768 px).
- [ ] Capture with a synthetic fixture (three tasks incl. a paused one and one with two run logs; fake `telegram` connected; whatsapp unpaired with a fixture `qr-data.txt` of `example-qr-payload`; a temp vault with two placeholder `.md` files) → `phase3-{tasks,channels,memory}-{mobile,desktop}.png`; review each PNG for placeholder-only content; record in notes; progress row.
- [ ] Commit `feat(control-ui): add Tasks, Channels, and Memory tabs` (or fold into one Phase 3 commit — gate hashing, as before).

## Self-review

- Spec coverage: Tasks CRUD + run-now + run logs ✓; Channels + wiring + pairing/QR ✓; Memory browse + explicit edit toggle + confinement ✓; read-only respected ✓; confirmations on destructive/instruction writes ✓; audit with prompt hashes ✓.
- Placeholders: none — every step names exact routes, headers, status codes, validation rules and test cases.
- Type consistency: `ControlStore` task members match `db.ts` signatures verbatim; `ChannelView.pairing` optional only for whatsapp; `MemoryRoots.vault` nullable and handled in tree/resolve; `writePolicy` values map 1:1 to the 403/409 responses.
- Threat-model decisions recorded: read-only excludes the vault; QR is a confirmed, audited mutation; explicit `chat_jid`; vault `Persona/`/`Atoms/`/root `CLAUDE.md` read-only; one gate per `CLAUDE.md`; limiter/floor/cap on tasks; truncated run logs; symlink-safe walk; audited reads; rotation runbook line.
