# Control UI Phase 4 — Containers, Logs, System, Config, Debug

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Land the five system tabs from the spec's route table — Containers, Logs, System, Config, Debug — as read-mostly surfaces with three narrow, confirmed mutations (stop a container, rebuild the image, change one allow-listed `.env` key), without any shell reachable from the browser.

**Architecture:** Five new API modules under `src/control-ui/api/` following the Phase 1–3 seams (pure functions over injected deps, `server.ts` routes them, `web/control/views/*.js` render them through `h()`). Docker is only ever reached through `execFile`/`spawn` with a fixed argv and a 15 s timeout; container names are validated against this instance's own naming pattern before they reach argv. Host logs come from an in-process ring buffer fed by the existing pino logger (a `multistream` — stdout/pretty output is unchanged); container logs come from `docker logs --tail`. `.env` edits are limited to an explicit allowlist with per-key validation and a `.bak-<ts>-<rand>` backup, and always answer `restart_required: true`.

**Tech Stack:** Node built-ins (`child_process.execFile/spawn`, `fs.statfs`, `os`), pino `multistream`, existing `EventHub`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-control-ui-design.md` — route rows "Containers", "Logs", "System", "Config", "Debug"; "Live updates" (`container`, `system`, `log`, `build`, `alert` events); "Error handling" (Docker missing → probe error, rest keeps working); "Security controls" (no shell from the browser — fixed `execFile` argv; secrets absent, not masked).

## Global Constraints

- **No shell from the browser.** Every runtime call is `execFile(CONTAINER_RUNTIME_BIN, [...fixed argv], { timeout: 15000 })` or `spawn(<absolute script path>, [])`; no string from a request ever becomes an argv element except a container name that already matched `CONTAINER_NAME_RE` **and** this instance's suffix.
- **Secrets absent, not masked.** Config omits any key matching `/TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/i`; log lines pass `redactSecrets()` before leaving the process (backstop only — the repo already forbids logging secrets).
- **Read-only mode** refuses stop/rebuild/config writes with 403 (same `mutation` flag as Phase 2–3 routes) and still serves every read.
- **Destructive = typed confirmation.** `X-Confirm: <container name>` for stop, `X-Confirm: rebuild` for rebuild, `X-Confirm: <KEY>` for config writes; 428 without.
- **Audit** every mutation with `{ actor, target }`; never the value written to `.env` (log the key only).
- **Cross-platform:** `fs.statfs` for disk (Node ≥ 18.15; the repo runs 22), `os` for load/mem. `container/build.sh` is bash → rebuild answers `501 { error: 'rebuild needs a POSIX host' }` when `IS_WINDOWS` (flagged in the notes as the one OS-specific route).
- **Instance scoping:** container names are `deus-<part>-<ms>-i<8 hex>` (`src/container-runner.ts:506`); the name part is `group.folder.replace(/[^a-zA-Z0-9-]/g, '-')` (`src/container-runner.ts:489`) and folders are mixed-case (`src/group-folder.ts:5` `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`), so `CONTAINER_NAME_RE = /^deus-[A-Za-z0-9][A-Za-z0-9-]{0,80}-\d{10,16}-i[0-9a-f]{8}$/` (case-preserving) and `isOwnContainer(name, instanceId)` = regex match **and** `name.endsWith('-i' + instanceId)` (`deusInstanceId()` is lowercase hex, `src/config.ts:80-88`) — other Deus instances' containers on the same host are never listed or touched.
- Body cap 256 KB; whole-request error boundary unchanged; SSE client cap unchanged.
- **`.env` is the credential store — treat every write as credential handling.** Values are rejected before per-key validation if they contain `\n`, `\r`, `\0`, `"`, `'`, `` ` `` or `$`; ints must match `/^\d{1,9}$/` and the range; the **normalized** value (`String(parsed)` / the matched enum member) is written, never the request string. The file is rewritten atomically (temp file `mode 0o600` in the same dir + `renameSync`), refused when `envPath` is a symlink (409), serialized through one in-process promise chain, and refused with 409 when `{ mtimeMs, size }` changed between read and write. Backups go to `CONFIG_DIR/control-ui/env-backups/` (dir 0700, files 0600, newest 10) — **never** inside `PROJECT_ROOT`, which the control group mounts at `/workspace/project` and whose credential shadow (`src/project-registry.ts:155-168`, exact names only, computed at container start) could not cover a random-suffixed backup. The atomic-rename **temp file** must stay on the same filesystem as `.env`, so it is written under `PROJECT_ROOT/.deus-tmp/` and that directory is added to `SENSITIVE_DIR_PATTERNS` (`src/project-registry.ts:174`) so `pushProjectShadows` (`src/container-mounter.ts:90-100`) mounts an empty directory over it. The shadow is `existsSync`-gated **at each container's start**, so ordering is load-bearing: `ensureControlTmpDir(PROJECT_ROOT)` (mkdir 0700, idempotent, gitignored) runs in `src/index.ts` **before** the channel-connect loop (`:439`) and therefore before any container can be spawned; it **degrades, never kills boot**: a `mkdirSync` failure (EACCES, or the path existing as a file) is caught, logged at `error`, and the assistant starts normally — `writeConfig` then answers 503. `writeConfig` gates on `lstatSync(tmpDir)` being a real directory (not a symlink, not absent) → 503 `{ error: 'temp dir unavailable' }`, never creating it lazily, because absence means live containers may have been mounted without the shadow. `.deus-tmp/` is gitignored, which puts it inside `git clean -fdx`'s blast radius — a human command no grep finds — so the 503-not-recreate half is load-bearing, not belt-and-braces. The serialized write chain always settles and never leaves a dangling rejection — `const p = chain.then(run, run); chain = p.then(noop, noop); return p;` — so one failed write neither wedges later ones nor leaves an unhandled rejection (`chain = p.then(noop, noop)` is itself the handler on `p`).
- **Read-only mode withholds, not just refuses — on every path.** Read-only is the less-trusted viewer (the spec's phone deployment), so: `logs?source=container:*` → 403; `GET /logs/export` → 403; the `log` SSE broadcaster is **not started** when `deps.readOnly` (the hub has one shared frame + a replay ring, so per-client projection is not an option); host-ring queries return `{ seq, time, level, msg }` only (no `fields`, no `line`); `GET /config` returns only the six editable keys. The spec's read-only paragraph gains one sentence saying so. Per-session read-only is not planned; if it ever is, the shared hub frame is the structural blocker to solve first (recorded in the notes).
- **The ring stores `info` and above only** — `logger.debug({ container }, line)` at `src/container-runner.ts:662` carries the agent's stderr stream (SDK debug output, which can include prompt/vault text), and it stays out of the dashboard by construction rather than by redaction.
- **Redaction is structural first, string second.** Ring entries are parsed, then any field whose key matches `/^(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|session|private[_-]?key)$/i` (recursively) is replaced with `[redacted]` **before** re-serialization; the string pass runs on the result and on every container-log line with patterns for `"?(api[_-]?key|token|secret|password|passwd|credential|authorization)"?\s*[:=]\s*"?[^"\s,}]+`, known prefixes `\b(ghp_|gho_|ghs_|glpat-|xox[baprs]-|AIza|sk-|eyJ[A-Za-z0-9_-]{10,})\S+`, and URL userinfo `https?://[^/\s@]*:[^/\s@]*@`. Container-log redaction is best-effort (container-authored text), which is why the read-only clamp above exists.
- **Every docker invocation** goes through one helper: ≤ 2 in flight (a small semaphore), 15 s timeout, `ETIMEDOUT`/`ENOENT`/non-zero exit all mapped to `{ error }` (never thrown to the route), unparsable `ps` rows skipped; docker-backed reads (`containers`, `system`, `logs?source=container:`) share a 30/min per-session limiter; `docker version` / `system df` results are cached 30 s; the system poller runs only while `hub.clientCount() > 0`.
- **No logging on the SSE write path.** The log→SSE broadcaster skips entries whose `fields.event` starts with `control_ui_`, sends at most 100 entries per frame with a `dropped: n` counter, and nothing in the hub or the SSE error handlers calls `logger` (an error-log → broadcast → error loop would evict every real line). Browser-supplied strings that are audited (the refused stop name) go into a structured field sliced to 128 chars, never into `msg`.
- **Ownership has one definition.** `src/container-runtime.ts` exports `isOwnContainer(name, instanceId)` built on its existing `INSTANCE_SUFFIX_RE` (`:120`) plus the case-preserving name class; Phase 4 imports it — no second matcher.
- Public-repo generic: screenshots use the synthetic fixture (`assistantName: 'Deus'`); the fixture's "docker" is a stub binary (see Task 6) so no real container or host name is captured.

## Design (patterns and data structures)

- **Two `docker stop` call sites, on purpose.** `ControlStore.stopContainer(name)` → `stopContainerSync` (`src/container-runtime.ts:48-53`, `['stop','-t','1',name]`, sync) serves `killSession`, which takes names from the queue snapshot (trusted, internal). Phase 4's `stopContainer(deps, name)` in `api/containers.ts` takes a **browser-supplied** name, so it validates with `isOwnContainer` first, runs async `execFile` (the shared event loop must never block), and uses `-t 5` so an agent mid-turn gets a graceful window. Do not merge them: the difference is the trust level of the argument.
- **Fresh `.env` parser, not `readEnvFile`.** `src/env.ts:11` `readEnvFile(keys)` returns values for named keys only and discards comments/order; a rewrite must preserve unrelated lines byte-for-byte, so `config.ts` keeps its own line-oriented `parseEnvText` (array of `{ raw, key?, value? }` lines) and uses `readEnvFile` for nothing.
- **Ring as a `Writable`.** pino's `multistream` accepts any writable next to `pino.destination(1)` or `pino.transport(...)` (spiked on this host: both modes delivered every line to the ring). Entries are parsed once on write, not on read.
- **Build runner is a singleton per server** with a 200-line ring and a `running` flag; a second `start()` returns `'running'` (409 at the route). Output goes through `redactSecrets` before the ring and the hub.
- **Pollers:** system every 30 s (broadcast `system`; `alert` only on a rising edge of `used_pct >= 85`), `log` batched every 500 ms and only while `hub.clientCount() > 0`, `container` rides the existing 2 s queue poll-and-diff (`server.ts:826-836`).

## API surface verified

| Symbol | Where | Signature / fact used |
|---|---|---|
| container name template | `src/container-runner.ts:506` | `` `deus-${namePart}-${Date.now()}-i${deusInstanceId()}` `` |
| `safeName` charset | `src/container-runner.ts:489` | `group.folder.replace(/[^a-zA-Z0-9-]/g, '-')` — uppercase preserved |
| `GROUP_FOLDER_PATTERN` | `src/group-folder.ts:5` | `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` |
| `--rm` | `src/container-runner.ts:126` | `['run', '-i', '--rm', '--name', containerName]` |
| `deusInstanceId()` | `src/config.ts:80-88` | 8 lowercase hex chars |
| `CONTAINER_RUNTIME_BIN` | `src/container-runtime.ts:13` | `process.env.CONTAINER_RUNTIME \|\| 'docker'` |
| `stopContainerSync` | `src/container-runtime.ts:48` | `(name) => void`, `['stop','-t','1',name]`, 15 s |
| `EventHub` | `src/control-ui/events.ts:3-8` | `broadcast(type, data)`, `clientCount()`, `attach`, `close`; ring of `{ id, frame }` |
| `createRateLimiter` | `src/rate-limiter.ts` via `server.ts:214-217` | `(max, windowMs)`; one instance per feature |
| queue poll-and-diff | `src/control-ui/server.ts:826-836` | `hub.broadcast('queue', snap)` on change |
| `GroupSnapshot` (`snapshot()` at `:309`) | `src/group-queue.ts:30-39` | `{ jid, active, idleWaiting, isTaskContainer, runningTaskId, containerName, groupFolder, pendingTaskCount, retryCount }` |
| `readEnvFile` | `src/env.ts:11` | `(keys: string[]) => Record<string,string>` — keyed lookup only |
| `logger` | `src/logger.ts:4-12` | `pino({ level, transport? })` — transport only on a TTY |
| `fs.promises.statfs` | Node 22.22 (spiked) | `{ type, bsize, blocks, bfree, bavail, files, ffree }` |
| `messages` table | `src/db.ts:35-46` | `id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message` — trace selects none of `sender*`/`content` |
| `container/build.sh` | repo root | bash, no required args, honours `CONTAINER_IMAGE`/`CONTAINER_RUNTIME` from env |

## Verification strategy (frozen before implementation)

| Surface | Predicted observation |
|---|---|
| Units | new tests in `log-ring`, `logs`, `containers`, `system`, `config`, `debug`, `db` all green; whole suite count grows only by the new files; `tsc` 0; eslint 0; prettier clean |
| Containers list (fixture stub docker) | rows for two own containers incl. one mixed-case name; the foreign-suffix row absent; `group_folder`/task fields joined from the snapshot; stub ENOENT → `{ containers: [], probe_error }` with HTTP 200 |
| Stop | 428 without confirm; 404 foreign/malformed; 200 `{ stopped: true }` and an audit line `control_ui_container_stop` with the name; stub docker exit 1 → 502 `{ error }`; read-only 403 |
| Rebuild | 428 → 200 `{ started: true }`; second → 409; `build` SSE frames end with `{ done: true, code }`; read-only 403; `IS_WINDOWS` → 501 |
| Logs | host: `lines=5` returns the 5 newest, `level=warn` drops info, `q=` filters, no `hostname`/`pid` in entries, a planted `api_key=abc` line comes back `[redacted]`; container: 404 foreign, 200 lines from the stub; export: `text/plain` + attachment header + audit line |
| System | `disk.used_pct` matches `statfs` math; `alert: 'disk'` when the injected `statfs` reports 90 %; docker ENOENT → `docker.error` with HTTP 200 |
| Config | secret keys absent and counted; `PATCH` unknown key 400, `LOG_LEVEL=verbose` 400, `LOG_LEVEL=debug` 200 `{ restart_required: true, backup }`, `.env` comments preserved, one `.env.bak-*`, 7th write in a minute 429; read-only 403 |
| Debug | health shows docker/db/channels/sse; counts match the fixture; events lists recent frame types; trace `..` → 400, unknown id → `{ messages: [] }`, known id → row without `content`/`sender` |
| Visual | `phase4-{containers,logs,system,config,debug}-{mobile,desktop}.png` reviewed for host names/paths/jids (stub data only) |

---

### Task 1: Log ring + logger wiring + `logs` API

**Files:**
- Create: `src/log-ring.ts`, `src/log-ring.test.ts`
- Modify: `src/logger.ts` (multistream: stdout/pretty as before + ring)
- Create: `src/control-ui/api/logs.ts`, `src/control-ui/api/logs.test.ts`

**Interfaces:**
- Produces: `createLogRing(size = 1000): LogRing` with `stream: Writable` (pino writes NDJSON lines), `entries(): LogEntry[]` (oldest→newest), `onEntry(fn): () => void`. `LogEntry = { seq: number; time: number; level: number; msg: string; fields: Record<string, unknown>; line: string }` where `fields` is the parsed object minus `time`, `level`, `msg`, `pid`, `hostname` (the host name and pid never leave the process — they are noise in a single-process dashboard and would put the machine name into screenshots) and `line` is the re-serialised entry truncated to 4096 chars.
- Produces: `redactSecrets(s: string): string`; `containerLogs(docker: DockerRunner, name, lines, instanceId): Promise<{ lines: string[] } | { error: string }>` (`DockerRunner` is defined in Task 2 — `run(argv, opts?)` / `cached(key, ttlMs, argv)`; Task 1's tests inject a fake object with the same `run` shape); `queryLogs(ring, { level?, q?, lines, readOnly })`.
- `logger.ts` exports `logRing` alongside `logger`.

- [ ] Step 1: Failing tests (`log-ring.test.ts`): ring keeps the last N; a non-JSON line still lands with `level: 30, msg: ''`; a 10 KB line is stored truncated to 4096; `onEntry` fires per push and the unsubscribe stops it.
- [ ] Step 2: Implement `createLogRing`: a `Writable` (`decodeStrings: false`) that splits chunks on `\n`, `JSON.parse` each line inside try/catch, **drops entries with `level < 30`**, deletes `pid`/`hostname`, applies the structural key denylist recursively (`redactFields`, exported), then pushes `{ seq, time, level, msg, fields, line: JSON.stringify(sanitized).slice(0, 4096) }` and evicts beyond `size`. Tests add: a debug line is not stored; `{"token":"xoxb-1"}` is stored as `[redacted]`; `hostname` is absent.
- [ ] Step 3: `logger.ts`:

```ts
import { createLogRing } from './log-ring.js';
export const logRing = createLogRing(1000);
const out = isInteractiveTerminal()
  ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
  : pino.destination(1);
export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  pino.multistream([{ level: 'trace', stream: out }, { level: 'trace', stream: logRing.stream }]),
);
```

  Run `npx vitest run src/logger src/log-ring` and the whole suite once (`npx vitest run`) — the logger is imported everywhere, so this is the one change with a wide blast radius; expected unchanged counts.
- [ ] Step 4: Failing tests (`logs.test.ts`): `redactSecrets` masks `api_key=abc123`, `Authorization: Bearer xyz`, `sk-` + 20 chars, `password: hunter2` → `[redacted]`, leaves ordinary text alone; `queryLogs` filters by min level (`warn` → ≥ 40), substring `q` (case-insensitive), caps `lines` at 1000 and returns newest last; `containerLogs` rejects a name with the wrong instance suffix without calling the runner (inject a fake `DockerRunner` whose `run` records argv), calls `run(['logs', '--tail', '<n>', name], { maxBuffer })` otherwise, and maps a runner `{ ok: false, error }` to `{ error }`.
- [ ] Step 5: Implement `logs.ts`: `SECRET_PATTERNS` = the three families in Global Constraints (quoted/unquoted key:value, known prefixes, URL userinfo) — tests cover `{"token":"xoxb-1234"}` → valid JSON with `[redacted]`, `ghp_16C7e42F292c69`, `http://u:p@host/` and a `Bearer` header inside JSON without eating the closing quote; `queryLogs(ring, { level, q, lines, readOnly })` clamps `lines` to 1..1000, filters, and in read-only projects to `{ seq, time, level, msg }`; `containerLogs` clamps `lines` itself, validates with `isOwnContainer` from `src/container-runtime.ts`, then calls `docker.run(['logs', '--tail', String(lines), name], { maxBuffer: 4 * 1024 * 1024 })` on the injected `DockerRunner` (created in Task 2's `docker.ts`; Task 1 depends only on the interface), splitting stdout+stderr lines and redacting.
- [ ] Step 6: Run the tests → pass. `npx tsc --noEmit -p tsconfig.json`, `npx eslint src/log-ring.ts src/logger.ts src/control-ui/api/logs.ts`.

### Task 2: Containers API (list, stop, rebuild)

**Files:**
- Create: `src/control-ui/api/docker.ts` (`createDockerRunner(bin, { maxInFlight: 2, timeoutMs: 15000, now? }) → DockerRunner` with `run(argv, opts?)` and `cached(key, ttlMs, argv)` — the only `execFile` site for docker), `src/control-ui/api/containers.ts`, `src/control-ui/api/containers.test.ts`
- Modify: `src/container-runtime.ts` (export `CONTAINER_NAME_RE` and `isOwnContainer(name, instanceId)` next to `INSTANCE_SUFFIX_RE`), `src/container-runtime.test.ts`

**Interfaces:**
- Produces: `listContainers(deps: { docker: DockerRunner, instanceId, snapshot: () => GroupSnapshot[] })` → `{ containers: ContainerView[], probe_error?: string }`, `ContainerView = { name, image, state, status, created_at, group_folder?, jid?, is_task_container?, running_task_id? }`.
- Produces: `DockerRunner = { run(argv: string[], opts?: { maxBuffer?: number }): Promise<{ ok: true, stdout: string, stderr: string } | { ok: false, error: string }>; cached(key: string, ttlMs: number, argv: string[]): Promise<same> }` from `createDockerRunner(bin, { maxInFlight: 2, timeoutMs: 15000, now? })` in `api/docker.ts` — the **only** place `execFile` is called for docker; `listContainers`, `stopContainer`, `containerLogs` and `readSystem` all take a `docker: DockerRunner` dep (tests inject a fake runner keyed by argv). `stopContainer(deps, name)` → `Promise<{ stopped: true } | { status: 404 } | { error: string }>` (404 = not an own container; `error` = docker refused/timed out, answered 502 by the route); `createBuildRunner({ repoRoot, hub, spawn?, setTimeout? })` (injectable timers — tests use `vi.useFakeTimers()` and advance 30 min + 10 s) → `{ start(): 'started' | 'running' | 'unsupported'; status(): { running, started_at, code, lines: string[] } }`.

- [ ] Step 1: Failing tests: `createDockerRunner` — a third concurrent `run` waits until one of the first two settles (fake execFile with deferred callbacks), a call exceeding `timeoutMs` resolves `{ ok: false, error: 'timeout' }`, ENOENT → `{ ok: false, error }`, non-zero exit → `{ ok: false }`, `cached` returns the first result for the same key within `ttlMs` and re-runs after; a mixed-case own name `deus-MyProject-1758000000000-i<id>` is listed **and** stoppable (the regression the plan review caught); `listContainers` parses `docker ps -a --filter name=^deus- --format {{json .}}` NDJSON via the fake runner (two rows, one with a foreign instance suffix → excluded, one unparsable line → skipped), joins `group_folder`/`jid`/task fields from the snapshot by `containerName`, and returns `probe_error` (no throw) when the runner answers `{ ok: false }`; `stopContainer` refuses a foreign or malformed name without touching the runner (404), calls `['stop', '-t', '5', name]` otherwise, and maps a runner `{ ok: false }` to `{ error }`; `createBuildRunner().start()` twice → second is `'running'`; lines stream into `status().lines` (cap 200) and the injected hub receives `build` events `{ line }` then `{ done: true, code }`; with fake timers, a child that never exits gets `SIGTERM` at 30 min and `SIGKILL` 10 s later and `start()` stays `'running'` until the fake child emits `close`; `git rev-parse` failing → `{ head: null, dirty: null }` and the build still starts; on Windows (`IS_WINDOWS` mocked true) → `'unsupported'`.
- [ ] Step 2: Implement. `docker ps` argv is fixed: `['ps', '-a', '--filter', 'name=^deus-', '--format', '{{json .}}']`; rows that fail `JSON.parse` are skipped. Build runner: `spawn(path.join(repoRoot, 'container', 'build.sh'), [], { cwd: repoRoot, env: pick(process.env, ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CONTAINER_IMAGE', 'CONTAINER_RUNTIME', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']) }) — an allowlist because build stdout is broadcast to the browser; nothing matching `KEY|TOKEN|SECRET` is ever passed. Stated exemption: the proxy variables may carry `user:pass@`; docker needs them, and the URL-userinfo redaction pattern is the control on that path (`build.sh` has no `set -x`/`env`) — an explicit env, not the host's; before spawning, resolve `image_ref` (`CONTAINER_IMAGE` or `deus-agent:latest`) and, best-effort with a 5 s timeout and the same explicit child env, `git rev-parse HEAD` + `git status --porcelain` (fixed argv; any failure → `head: null, dirty: null`, never blocks the build) and put `{ image_ref, head, dirty }` (`dirty` is a **boolean**; porcelain output is never stored or shown) in the audit line and in `status()`; line-split stdout/stderr, redact, push to a 200-line ring, `hub.broadcast('build', ...)`; `close` → `{ done: true, code }` and releases the lock; at 30 min the child gets `SIGTERM` then `SIGKILL` after 10 s and the lock is held until `close` fires (one-at-a-time is an invariant, not a hint). Residual, recorded in the notes: a host-side `./container/build.sh` running concurrently is not detected (`build.sh` takes no lock).
- [ ] Step 3: Tests pass; tsc; eslint.

### Task 3: System + Config + Debug APIs

**Files:**
- Create: `src/control-ui/api/system.ts` (+ test), `src/control-ui/api/config.ts` (+ test), `src/control-ui/api/debug.ts` (+ test)
- Modify: `src/project-registry.ts` (`SENSITIVE_DIR_PATTERNS` gains `'.deus-tmp'`), `src/container-mounter.test.ts` (the control-group mounts include an empty-dir shadow over `/workspace/project/.deus-tmp` when the dir exists), `.gitignore` (`.deus-tmp/`)
- Modify: `src/db.ts` (`countMessages(): number`, `findMessagesById(id): MessageTrace[]` selecting `id, chat_jid, timestamp, is_from_me, is_bot_message, length(content) AS content_length` — never `content` or `sender`), `src/db.test.ts`
- Modify: `src/control-ui/store.ts` (`countMessages`, `findMessagesById`, `dbPing(): boolean`)
- Modify: `src/control-ui/events.ts` (`recent(n): { id, type, at }[]` — the ring already keeps frames; store `type` and `at` beside each frame)

**Interfaces:**
- `readSystem(deps: { repoRoot, docker: DockerRunner, version, statfs? })` — `docker.cached('version', 30_000, ['version', '--format', '{{.Server.Version}}'])` and `docker.cached('df', 30_000, ['system', 'df', '--format', '{{json .}}'])` → `{ platform, arch, node, version, pid_uptime_s, os_uptime_s, load: [1,5,15], mem: { total, free, rss }, disk: { total, free, used_pct, path: 'repo' }, docker: { version?, df?: DfRow[], error? }, alert?: 'disk' }` — `alert` when `used_pct >= 85`.
- `parseEnvText(text)` → `EnvLine[]` where `EnvLine = { raw: string; key?: string; value?: string }` — one element per source line in order (comments and blank lines are `{ raw }` only; `value` has surrounding quotes stripped); `writeConfig` edits that same array (replace the last element whose `key` matches, else append) and joins `raw` back with `\n`, so unrelated lines are byte-identical; `readConfig({ envPath, processEnv })` → `{ keys: ConfigRow[], secret_keys_omitted: number }`, `ConfigRow = { key, value, source: 'file' | 'process' | 'both', editable }`; `EDITABLE = { LOG_LEVEL: enum(fatal|error|warn|info|debug|trace), CONTAINER_TIMEOUT: int 10000..3600000, IDLE_TIMEOUT: int 60000..86400000, MAX_CONCURRENT_CONTAINERS: int 1..32, TIMEZONE: /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/ (digits allowed — `Etc/GMT+9`) and `Intl.DateTimeFormat` accepts it, ASSISTANT_NAME: 1..40 printable chars }`; `writeConfig({ envPath, backupDir }, key, value)` → `Promise<{ restart_required: true, backup } | { status: 400 | 404 | 409 }>` — applies the Global-Constraints credential-store rules: pre-validation character rejection, normalized value, `lstat` symlink → 409, read `{ mtimeMs, size }`, rewrite the matching `KEY=` line in place (or append) keeping comments/order, backup to `backupDir/env.bak-<ts>-<rand>` (0600, newest 10, dir created 0700), write `tmpDir/env.<rand>` (`tmpDir = path.join(PROJECT_ROOT, '.deus-tmp')`, created 0700, shadowed for containers) with `{ mode: 0o600, flag: 'wx' }` (exclusive create — a pre-planted symlink at the temp path is never followed) then `renameSync` onto `envPath` (same filesystem); the temp file is unlinked in a `finally` if the rename did not happen; all writes funnel through one module-level promise chain (`const p = chain.then(run, run); chain = p.then(noop, noop); return p;`) and re-check `{ mtimeMs, size }` → 409 on drift; `tmpDir` absent → 503. `SECRET_KEY_RE = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|_URL|_DSN|_WEBHOOK|_SID|_PAT|_PASSPHRASE|_PIN|_COOKIE|_SESSION|_SALT|_HASH|_PRIVATE/i`; every surviving value passes `redactSecrets` before leaving the process; `ASSISTANT_NAME` must match `/^[\p{L}\p{N} ._-]{1,40}$/u`.
- `ensureControlTmpDir(root: string): boolean` (in `config.ts`: `mkdirSync(path.join(root, '.deus-tmp'), { mode: 0o700, recursive: false })`, `true` on success or on an existing real directory, `false` after `logger.error` when the path is a file or mkdir throws — never throws); `debugHealth(deps)` → `{ docker: { ok, version?, error? }, db: { ok }, channels: [{ name, connected }], sse_clients, build_running, uptime_s }`; `debugCounts(deps)` → `{ groups, tasks: { active, paused }, sessions, containers_active, messages, sse_clients }`; `debugTrace(deps, messageId)` → `{ messages: MessageTrace[], queue?: GroupSnapshot, session?: { backend, last_used_at, orphaned_at } }` with `MESSAGE_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/`.

- [ ] Step 1: Failing tests for each: system (`statfs` injected → `used_pct` math, alert at 85 on a rising edge only, docker ENOENT and ETIMEDOUT → `docker.error` without throw, `df` cached across two calls within 30 s); config (parser keeps comments and quotes, secret keys absent and counted incl. `OPENAI_BASE_URL`, `source` resolution, validation per key incl. rejecting `LOG_LEVEL=verbose`, `TIMEZONE=../x`, `CONTAINER_TIMEOUT="20000\nGITHUB_WEBHOOK_SECRET=x"` (the file must contain no new key afterwards), `ASSISTANT_NAME="a$(b)"`; normalized write (`" 20000 "` → `20000`); rewrite preserves unrelated lines byte-for-byte; backup lands in `backupDir` (0600) not beside `.env`, rotation keeps 10; symlinked `.env` → 409; mtime drift between read and write → 409; two concurrent writes serialize (both land); a write whose validation throws is followed by one that succeeds (chain settles); a throwing write with **no** follow-up leaves no unhandled rejection (`process.on('unhandledRejection')` spy stays uncalled); `tmpDir` removed → 503 and no lazy mkdir; `tmpDir` replaced by a symlink to a directory → 503; after both a successful and a failed write, `PROJECT_ROOT` contains no `.env*` file other than `.env` and `.deus-tmp/` is empty; missing `.env` → 404; a value containing `user:pass@` in a non-secret key is returned redacted); debug (trace never includes `content`/`sender`; bad id → 400 at the route); `ensureControlTmpDir` in `config.test.ts` (creates 0700, idempotent on an existing correct dir, returns `false` and logs `error` without throwing when the path is a regular file or when `mkdirSync` throws EACCES — a read-only temp parent).
- [ ] Step 2: Implement; db functions with prepared statements; tests pass; tsc; eslint.

### Task 4: Routes, pollers, wiring

**Files:**
- Modify: `src/control-ui/server.ts` (deps: `bin`, `instanceId`, `logRing`, `envPath`, `configDir` (→ `backupDir = path.join(configDir, 'control-ui', 'env-backups')`); a `dockerReadLimiter = createRateLimiter(30, 60_000)` and `configLimiter = createRateLimiter(6, 60_000)`; one `docker = createDockerRunner(deps.bin)` shared by every route; the `log` broadcaster (500 ms, ≤100 entries/frame + `dropped`, skips `control_ui_*`) started only when `!deps.readOnly`; read audits deduplicated per session with `readAudits: Map<sid, Set<string>>` (keys `logs:<source>` / `config`) bounded exactly like `createCounts` (`server.ts:220-230`): FIFO eviction at `SESSION_COUNTERS_MAX = 1000` and cleared at both sites `createCounts` is cleared — credential rotation (`:239-240`) and revoke-all (`:353-354`) — the session store has no cap and no removal hook, so this is the only bound; eviction can only produce a duplicate audit line, never a missing one; routes below; a 30 s system poller broadcasting `system` and `alert`; a 500 ms batched `log` broadcaster subscribed to the ring while `hub.clientCount() > 0`; 2 s `container` broadcast rides the existing queue poll-and-diff), `src/control-ui/server.test.ts`
- Modify: `src/index.ts` (`ensureControlTmpDir(PROJECT_ROOT)` from `api/config.ts` called before the `channel.connect()` loop (`:439`); its unit test asserts mode 0700, idempotence, and that a path already occupied by a regular file is logged and swallowed (returns `false`, no throw); then pass `bin: CONTAINER_RUNTIME_BIN`, `instanceId: deusInstanceId()`, `logRing`, `envPath: path.join(PROJECT_ROOT, '.env')`, `configDir: CONFIG_DIR`, store additions)
- Modify: `docs/superpowers/specs/2026-09-20-control-ui-design.md` (read-only paragraph: what read-only withholds from Logs/Config)
- Modify: `docs/superpowers/specs/2026-09-20-control-ui-design.md` (Containers row: mark `POST containers/:name/start` as dropped — agent containers run with `--rm`)

Routes (all `auth: 'session'`):
| Route | Mutation | Notes |
|---|---|---|
| `GET /api/v1/containers` | no | list + `probe_error` |
| `POST /api/v1/containers/:name/stop` | yes | `X-Confirm: <name>`; 404 unknown/foreign **and audited as `control_ui_container_stop_refused` with the rejected name** (a foreign-instance name is boundary probing); audited on success |
| `POST /api/v1/containers/rebuild` | yes | `X-Confirm: rebuild`; 409 running; 501 Windows; audited with `{ image_ref, head, dirty }` |
| `GET /api/v1/containers/build` | no | build status + last 200 lines |
| `GET /api/v1/logs?source=host\|container:<name>&level=&q=&lines=` | no | `lines` 1..1000 default 200; container source 404 on foreign name, **403 in read-only**; host source projected to `{seq,time,level,msg}` in read-only; audited once per session per source (`control_ui_logs_read`) |
| `GET /api/v1/logs/export?level=&q=` | no | **403 in read-only**; `text/plain; charset=utf-8`, `Content-Disposition: attachment; filename="deus-control-logs.txt"`; audited |
| `GET /api/v1/system` | no | |
| `GET /api/v1/config` | no | read-only → editable keys only; audited once per session (`control_ui_config_read`) |
| `PATCH /api/v1/config { key, value }` | yes | `X-Confirm: <key>`; 400 unknown/invalid; 6/min per session via a **new** `configLimiter = createRateLimiter(CONFIG_WRITES_PER_MIN, 60_000)` — its own instance like `claudeMdLimiter`/`taskLimiter`/`memoryLimiter` (`server.ts:214-217`), never shared, so task creates and config edits cannot drain each other; audited with the key only |
| `GET /api/v1/debug/health` · `counts` · `events` · `trace?message_id=` | no | trace 400 on bad id |

- [ ] Step 1: Integration tests in `server.test.ts` with an injected fake `DockerRunner`, a temp `.env` and a temp `configDir`: read-only → `logs?source=container:` 403, `logs/export` 403, host logs carry no `fields`/`line`, a captured SSE stream receives **no** `log` frame after a ring push, `config` lists only the six editable keys; read-write → a ring push yields one `log` frame within 600 ms, 150 pushes yield a frame with 100 entries and `dropped: 50`, a `control_ui_*` audit entry is never broadcast; stop with the fake runner answering `{ ok: false }` → 502; a refused stop writes `control_ui_container_stop_refused` with `fields.name` ≤ 128 chars; two `GET /logs?source=host` calls in one session write exactly one `control_ui_logs_read` line and a `source=container:` read writes another; two `GET /config` calls write one `control_ui_config_read`; rebuild audit line carries `image_ref`, `head`, `dirty`; the 31st docker-backed read in a minute → 429; each route's happy path; 428 without confirm on the three mutations; 403 for all three in read-only; 404 for a foreign container name on stop and on `logs?source=container:`; 409 on a second rebuild; `PATCH config` with a secret key → 400 (not editable), with an invalid value → 400, success rewrites the temp `.env`, keeps a comment line, creates one backup and answers `restart_required: true`; `logs/export` sets the attachment headers and contains a redacted line; `debug/trace` with `..` → 400.
- [ ] Step 2: Implement routes; wire pollers; `index.ts` deps. Run `npx vitest run src/control-ui src/db`, tsc, eslint, prettier on staged `.ts`.

### Task 5: Views + nav

**Files:**
- Create: `web/control/views/{containers,logs,system,config,debug}.js`
- Modify: `web/control/app.js` (VIEWS gain the five with `group: 'System'`; the More sheet lists Configure and System groups), `web/control/sw.js` (shell list), `web/control/app.css` (log viewer, stat tiles, key/value table, build console)

- Containers: hairline list — name (mono), group + task badge, state badge, age; **Stop** (danger, typed confirm) per row; header action **Rebuild image** (typed `rebuild`) opening a build console (`pre.console`) that follows `build` events; probe error shown as an `.empty` with the message.
- Logs: toolbar — source select (Host + one per listed container), level select, search input, lines select (100/200/500/1000), **Follow** switch (subscribes to `log` bus events and appends when source is host), **Export** (fetch with the session header → `Blob` → `a[download]` — no inline handler, the anchor is created via `h()`). Rows in `pre.log` with a level dot; `q` highlighting is plain text (no markup).
- System: stat tiles (uptime, load, RAM, disk with a bar and the ≥85 % alert badge, Node/app version, runtime), docker `df` table; refreshes on `system` events.
- Config: table of key / value / source; editable rows get an **Edit** button → inline input + Save (typed confirm = key) → toast "Saved — restart required" and a persistent banner "Configuration changed on disk; restart the service to apply."; a line "N secret keys are not shown".
- Debug: health list with dots, counts grid, last 50 events (type/id/time), trace form (message id → result table) — all mono.
- Icons: `containers`, `logs`, `system`, `config`, `debug` already exist in `icons.js`.

- [ ] Step 1: Build each view with the `header()` helper and existing primitives; `node --check` all files.
- [ ] Step 2: Smoke every view in the browser against the Task 6 fixture; no page errors.

### Task 6: Fixture, capture, record, gates

**Files:**
- Modify: `scripts/control-ui-screenshot.mjs` (steps: `containers` waits `.row|.empty`; `logs` waits `pre.log`; `config` clicks the first Edit; `debug` waits `.health`)
- Create: `docs/control-ui/artifacts/phase4-{containers,logs,system,config,debug}-{mobile,desktop}.png`
- Modify: `docs/control-ui-notes.md` (Phase 4 verification record, the Windows-501 note, the `start` deviation), `docs/control-ui-progress.md`

- [ ] Step 1: Fixture: extend the throwaway launcher with a stub `docker` script on `PATH`-free absolute path passed as `bin` (a tiny node script answering `ps`, `logs`, `version`, `system df` with canned generic output) so captures never touch the real daemon or reveal host containers; a temp `.env` with generic keys.
- [ ] Step 2: Capture at 390/1280; review PNGs for instance names/paths/jids; loop until clean.
- [ ] Step 3: Full checks; stage; `code-reviewer` + `verification-gate` (the gate drives every route over HTTP against the fixture, including a real `docker ps` on the host to confirm the instance filter excludes foreign containers — reported as counts only); marks; one commit `feat(control-ui): add Containers, Logs, System, Config and Debug (Phase 4)`.

## Deviations from the spec (stated up front)

- `POST containers/:name/start` is **dropped**: agent containers run with `--rm` (`src/container-runner.ts:126`), so there is nothing to start; the row would have no caller.
- Rebuild is POSIX-only (bash script); Windows answers 501 rather than shelling through `cmd`.
- `logs?source=` accepts `host` and `container:<own name>`; a journald source is deliberately out of scope (host-specific, and the ring already carries everything this process logs).

## Threat-model round 1 — controls folded in

| Finding | Control (where) |
|---|---|
| B1 newline/quote injection through int values → `.env` override | pre-validation char rejection, `/^\d{1,9}$/`, normalized write (Task 3) |
| B2 `.env.bak-*` inside the container-mounted project root | backups in `CONFIG_DIR/control-ui/env-backups/` 0700/0600 (Task 3, Task 4 deps) |
| B3 non-atomic / unserialized / symlink-blind rewrite | temp + rename 0600, `lstat` 409, promise chain + mtime/size 409 (Task 3) |
| B4 read-only leaks agent output via logs/config | ring stores `info+` only; read-only: container logs 403, host projection, editable keys only (Tasks 1, 4) |
| B5 string-only redaction misses NDJSON shapes | structural field denylist in the ring + three string pattern families; container logs best-effort (Task 1) |
| W1 log→SSE amplification | skip `control_ui_*` entries in the broadcaster; no `logger` calls on the SSE path (Task 4) |
| W2 second ownership matcher | `isOwnContainer` exported from `src/container-runtime.ts` (Task 2) |
| W3 unbounded docker reads | `DockerRunner` semaphore 2 + timeout + error mapping, 30/min limiter, 30 s cache, poller gated on clients (Tasks 2, 3, 4) |
| W4 stale build not killed | SIGTERM→SIGKILL at 30 min (fake-timer test), lock held to `close`; host-side concurrent build recorded as residual (Task 2) |
| W5 rebuild audit + env passthrough | `{ image_ref, head, dirty }` audited; explicit child env (Task 2) |
| W6 audit symmetry + denylist | `config`/`logs` reads audited; refused stops audited; extended `SECRET_KEY_RE`; values redacted (Tasks 3, 4) |
| W7 `ASSISTANT_NAME` charset; `lines` clamp | `/^[\p{L}\p{N} ._-]{1,40}$/u`; clamp inside `containerLogs` (Tasks 1, 3) |

Round 2 additions: B6 (temp file inside the mounted project root) → `PROJECT_ROOT/.deus-tmp/` shadowed via `SENSITIVE_DIR_PATTERNS`, unlink-in-finally, tests that no `.env*` sibling survives; B7 (read-only bypass via SSE and export) → no `log` broadcaster and export 403 in read-only, SSE test; W8 chain settles; W9 git best-effort/5 s/null; W10 wider explicit child env; W11 100-entry frames + `dropped`; W12 refused name in a sliced structured field; W13 host paths (`WHISPER_BIN`, `LLAMA_CPP_MODEL`, `DEUS_VAULT_PATH`) survive the denylist and are shown to the operator — recorded in the notes so exports/captures are handled with that in mind. Round 3: `.deus-tmp` created before channels connect and 503 when absent, no dangling rejection, proxy-var exemption stated, `dirty` boolean, and the notes record that `chat_jid` is deliberately in scope for the read-only viewer (Groups/Sessions already expose it) while agent output is not. Read-only is the less-trusted viewer (spec), so the withholding controls are not optional.

Answers: (1) `GET /config` returns every non-secret key in read-write mode (values redacted) and only the six editable keys in read-only. (2) The service unit sets `process.env` with explicit `Environment=` lines and no `EnvironmentFile`; `.env` is read by `readEnvFile` per key — so B1 reached credential overrides, not the runtime binary; blocking either way and closed by the controls above. (3) The ring holds `info` and above only; the Logs tab cannot show debug, by design.

## Self-review

- Spec coverage: Containers (list/stop/rebuild + `build` events) ✓, Logs (query/export/`log` events) ✓, System (`system`/`alert` events, `docker system df`) ✓, Config (absent secrets, allowlist, backup, `restart_required`) ✓, Debug (health/counts/events/trace) ✓, Docker-missing error handling ✓.
- Placeholders: none. Type consistency: `isOwnContainer`, `CONTAINER_NAME_RE`, `DockerRunner`/`createDockerRunner`, `GroupSnapshot`, `ensureControlTmpDir`, `createBuildRunner`, `readSystem`, `parseEnvText` (`EnvLine[]` in Design, Task 3 and `writeConfig`), `readConfig`/`writeConfig`, `debugHealth/Counts/Trace` used with the same names across Tasks 1–4.
