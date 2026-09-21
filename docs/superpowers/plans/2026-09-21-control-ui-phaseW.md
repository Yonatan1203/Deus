# Control UI Phase W — Workflows tab and the progress registry

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A "Workflows" tab that shows every long-running order (create posts, product images, site images, …) as a card with a percentage, the current step, the linked Claude session's state, and the preview link when it finishes — fed by one small CLI that sessions and pipeline scripts call, never by inference.

**Architecture:** a JSON-record registry under `CONFIG_DIR/control-ui/workflows/` (outside the repo, never mounted into containers), written only by `scripts/workflow.mjs` (host side, atomic temp+rename inside the registry dir) and read by a new API module `src/control-ui/api/workflows.ts` with strict validation on read; `server.ts` serves the list, a typed-confirm archive action, and `workflow` SSE events from a debounced directory watcher; `web/control/views/workflows.js` renders cards. A standing instruction in the repo's `AGENTS.md`/`CLAUDE.md` tells sessions to report through the CLI for any order that takes more than a minute.

**Tech stack:** Node built-ins (`fs.watch`, `fs.renameSync`), vitest; no new dependency. The CLI is plain ESM with no imports from `src/` (it must run from any session's shell without a build).

**Spec:** `docs/superpowers/specs/2026-09-21-control-ui-scope2-design.md` §W. Phase C (`docs/superpowers/plans/2026-09-21-control-ui-phaseC.md`) supplies the session join.

## Global Constraints

- **The registry is an input boundary — anything running as the operator can write there.** "Written only by the CLI" is a convention; the controls are on the read path: (i) the registry dir and `archive/` are created 0700 and `lstat`-checked on every list — a symlink or a non-directory refuses to list *and* to watch; (ii) enumeration is `readdirSync(dir, { withFileTypes: true })` keeping only `isFile()` entries whose name matches `/^wf-[0-9a-f]{12}\.json$/`; (iii) each file is opened once with `fs.openSync(p, O_RDONLY | O_NOFOLLOW)`, `fstat`-ed on the fd (regular file, ≤ 64 KB, else `too-large`/`unreadable`), read from that fd, parsed once, and everything downstream uses the parsed value — no route ever re-reads `<id>.json` after validation (no validate→render TOCTOU); (iv) `validateRecord` **constructs a fresh object literal field by field** — never the parsed value, never a spread of it — so own `toJSON`/`__proto__`/`constructor` keys cannot reach the SSE frame or the disk; (v) a record that fails validation is listed as `{ id, invalid: true, reason }` where `reason` is a **closed enum** `unreadable | too-large | not-json | bad-id | bad-kind | bad-percent | bad-url | bad-schema` — never `err.message`, never an echoed field (`JSON.parse`'s message quotes the input; a symlinked `.env` would otherwise reach the browser). The dashboard executes nothing from a record and never fetches a record URL.
- **Record schema (v1):** `{ v: 1, id, name, kind: 'posts'|'product_images'|'site_images'|'other', status: 'running'|'waiting'|'done'|'failed', percent: 0..100 (integer), step?: string ≤ 200, steps_total?: 1..999, message?: string ≤ 500, session_id?: 8-hex job id, preview_url?: string, outputs: [{ label ≤ 80, url }] ≤ 20, started_at, updated_at, finished_at? (ISO-8601 with millisecond resolution), rev: integer ≥ 1 (bumped by every CLI write) }`; ids `/^wf-[0-9a-f]{12}$/`; URLs pass one shared `isAllowedUrl(u)` living in a new `src/control-ui/api/allowed-url.ts` (owned by Phase W; Phase A imports it — one copy, and `CONTROL_UI_PREVIEW_HOSTS` therefore widens Phase A's allow-list too, recorded in the notes): `new URL()` parses, length ≤ 2048, `username === '' && password === ''` (so `https://claude.ai@evil.example/` fails), and either `protocol === 'https:'` with `hostname` in the allow-list — `claude.ai` plus hosts from the operator-set `CONTROL_UI_PREVIEW_HOSTS` (comma-separated, exact match) — or `protocol === 'http:'` with `hostname` exactly `localhost`, `127.0.0.1` or `[::1]` (exact comparison, never a prefix test); any search-param key matching `SECRET_KEYS` (`api/logs.ts`, a regex-source alternation, so the test is anchored `new RegExp(`^(${SECRET_KEYS})$`, 'i')` — over-rejection fails closed to inert text) rejects the URL rather than mangling it. **Two failure classes, one rule:** a *shape* failure (`preview_url`/`outputs[].url` not a string, longer than 2048, or `new URL()` throws) is `bad-url` and invalidates the whole record — the CLI refuses to write such a record, so only a hand-edited file reaches it; a *policy* failure (userinfo present, hostname not on the allow-list, wrong protocol, secret-looking query key) keeps the record valid and **withholds the URL entirely**: the server emits `preview_url: null, preview_blocked: 'userinfo' | 'host' | 'protocol' | 'secret-query'` (and per output `url: null, blocked: <same enum>`), so a disallowed URL — which may carry a secret — never reaches the browser even as text. `CONTROL_UI_PREVIEW_HOSTS` entries are trimmed, lower-cased and empties dropped, and the docs say they are exact hostnames (`.example.com` / `*.example.com` never match — fails closed); the card shows a withheld URL as inert text built from the enum (`Preview withheld · host not allowed`), never from the URL. Display strings (`name`, `step`, `message`, `outputs[].label`) pass `redactSecrets` on read and have `\p{Cc}`/`\p{Cf}` stripped (bidi/zero-width spoofing of the link label); URLs never do; names `/^[\p{L}\p{N}][\p{L}\p{N} ._()/-]{0,79}$/u`.
- **Registry layout:** `CONFIG_DIR/control-ui/workflows/<id>.json` (0600, dir 0700), archive under `…/workflows/archive/`. Only `<id>.json` files matching the id regex are ever read; anything else in the dir is ignored.
- **Writers:** `scripts/workflow.mjs` (plus the dashboard's archive action, which moves files). The CLI writes `<id>.json.tmp-<rand>` with `flag: 'wx'` + `mode 0o600` then `renameSync`; on `progress`/`finish`/`fail` it reads with the same confinement (`O_NOFOLLOW`, size cap), validates, captures `rev`, builds a **new literal** (with `rev + 1`) from validated fields plus the patch (never `Object.assign(raw, patch)`), re-reads and compares `rev` immediately before `renameSync` and exits 3 on mismatch (an integer, so two writes in one clock tick cannot compare equal) (two writers on one id never lose an update silently); it refuses to touch a terminal record (`done`/`failed`) except `finish`/`fail` re-runs that only add outputs; every run sweeps `*.tmp-*` older than one hour. Exit codes: 0 ok, 2 usage, 3 validation/conflict, 4 not found.
- **Mutations from the browser:** exactly one — `POST /api/v1/workflows/archive` with `X-Confirm: archive`, which moves records with a terminal status and `finished_at` older than 30 days (or, with body `{ id }`, that one terminal record) into `archive/`. The `{ id }` is the only browser string that reaches a path: it must be `typeof id === 'string'` and match `/^wf-[0-9a-f]{12}$/` **before** any `path.join`, the source is `lstat`-ed (regular file, not a symlink), and the move refuses with 409 when `archive/<id>.json` already exists (`renameSync` would overwrite). The `{ id }` form has three outcomes: 200 `{ archived: 1 }` for a terminal record; 200 `{ archived: 1, stale: true }` for a non-terminal record whose file mtime is older than 24 h; 409 `{ error: 'workflow still active' }` for a non-terminal record fresher than that (same code the tasks API uses for a state conflict, `api/tasks.ts:194`). 404 for an unknown id. No create/edit/delete from the browser; 6/min per session; audited with ids. 403 in read-only.
- **Watcher:** `fs.watch(dir)` (non-recursive, `persistent: false`, refused if the dir is a symlink) debounced 500 ms → re-list → `workflow` SSE `{ workflows, truncated }` frame, only while `hub.clientCount() > 0`; on watcher error (unsupported fs, ENOSPC), fall back to a 10 s poll, never throw. **Bounded list, two bounds:** `readdir` (refused above 5 000 entries) + `stat` on every matching entry; the newest **600** by mtime form the *parse candidate set* — only those files are opened — then the ranking below is applied and the list is cut to 200; the response carries `scanned` and `candidates` counts alongside `truncated` = scanned − 200, so the notice can say which bound bit. **Accepted residuals** (stated so the code review does not re-litigate them): the staleness-check→`renameSync` window in archive and the `rev` compare→`renameSync` window in the CLI are irreducible without a lock; both are operator-initiated or trusted-writer cases, audited, and recoverable by a host-side `mv` (same class as the LIA-550 TOCTOU). A runaway pipeline loop is the realistic trigger; one list call never opens more than 600 files. The list route also re-reads on demand; `GET` is 60/min per session (its own limiter instance).
- **Session join:** `session_id` is self-asserted by the writer, so it is a display hint only: the tab joins it with the Phase C list in the browser and shows the session's state **only when that id is present in the list**, labelled "reported session"; otherwise no badge at all. The CLI's `--session` is explicit only — there is no env-var default and no guessing.
- **Read-only withholds session-authored prose,** the same line Phase C draws for transcripts: `listWorkflows(dir, { readOnly })` projects **on the data path**, so the `GET` list and every watcher-driven `workflow` SSE frame carry the same projected shape — the list is projected to `{ id, name, kind, status, percent, steps_total, started_at, updated_at, finished_at, invalid?, reason? }` — no `step`, `message`, `outputs`, `preview_url`, `session_id`; archive refused. `name` is kept deliberately: the card needs an identity, and Phase C keeps session names in read-only for the same reason.
- **Convention text** (added to `AGENTS.md` under a new "Reporting long-running work" heading, and referenced from `CLAUDE.md`): "For any order that takes more than a minute (creating posts, product images, site images…), report progress with `node scripts/workflow.mjs start --name … --kind …` → `progress <id> --percent N --step …` → `finish <id> --preview <url>` / `fail <id> --message …`. The dashboard's Workflows tab reads only these records. A non-zero exit from the CLI (for example exit 4 after the operator archived the record) is bookkeeping, never a reason to abort the order itself." Pipeline scripts (`marketing/pipeline/*.py`) gain a `--workflow <id>` flag in a **follow-up**, not here.
- Public-repo generic: the fixture writes synthetic records; screenshots show fixture names only.
- **Visual language:** the tab follows the existing dashboard system (v2 tokens, `header()`, `.card`, `.badge`, `<progress>` as on the System tab, hairline lists) — no new design direction, so no taste-pass round is needed.

## Design (patterns and data structures)

- `scripts/workflow.mjs` — subcommands `start`, `progress`, `finish`, `fail`, `show`, `list`; `--registry <dir>` overrides the default `path.join(os.homedir(), '.config', 'deus', 'control-ui', 'workflows')` — `os.homedir()`, the same primitive `src/platform.ts:35` wraps, never `process.env.HOME` (`scripts/` is outside the lint rule that would catch it); `--session <8-hex>` is optional on `start` and defaults to `$CLAUDE_JOB_ID`-style discovery **only if** an env var of that exact name is set — otherwise absent (no guessing). `start` prints the new id on stdout and nothing else, so `WF=$(node scripts/workflow.mjs start …)` works.
- `src/control-ui/api/workflows.ts` — `validateRecord(raw): { ok: true, record } | { ok: false, reason }`. The ~40-line validator is duplicated in the CLI with an agreement test over a shared fixture set. Alternative considered and rejected: a plain `.mjs` validator inside `src/control-ui/` imported by both — it would need `allowJs` in `tsconfig.json`, which widens what `tsc` resolves repo-wide for one file; the duplication plus the agreement test is the smaller change (recorded in the notes). `listWorkflows(dir, { readOnly })` — the read-only projection lives **inside** the list function (Phase C's `listClaudeSessions` accepts a `readOnly` option but never reads it — its withholding is route-level — so this is the **first** real data-path projection in the codebase; the SSE verification row is what pins it, and Task 2 removes Phase C's vestigial option so nobody copies an ignored parameter), so both producers of the record shape — the `GET` route and the watcher's re-list → `workflow` SSE broadcast — emit the projected shape; the hub is process-wide with no per-client filtering, so a route-only projection would leak within one debounce. `validateRecord` also requires `record.id === basename(file, '.json')` (else `bad-id`), so a file cannot advertise another record's id and defeat its own archive. `archiveWorkflows(dir, { olderThanDays, id? })` — the 30-day sweep **skips and counts** an existing archive target (`{ archived: n, skipped: n }`); only the single-`{ id }` form hard-409s (a re-created archived id must not block every later sweep). `listWorkflows` refuses to scan more than 5 000 entries (`{ workflows: [], truncated: -1, reason: 'too-many' }`, one warn log) so the synchronous `readdir`+`stat` sweep per debounce stays bounded; the ranking runs over the 600-file parse candidate set only (status is known only after parsing, so the candidate set is the parse bound): **fresh non-terminal** (`running`/`waiting` whose file **mtime** — from the `stat` that built the candidate set, unforgeable by the writer, never the writer-asserted `updated_at` — is within 24 h) → **terminal** → **stale non-terminal**, each tier newest-first, then cut to 200 — a busy registry pushes finished work out before a live `waiting` record, and a crashed writer's stale `running` record can never permanently evict finished work; the status filter is client-side over the truncated set (say so in the view's truncation notice). As the dashboard's remedy for its own failure mode, the single-`{ id }` archive form also accepts a **non-terminal record whose file mtime is older than 24 h** (still typed-confirm, still audited, logged as `stale: true`); the bulk sweep stays terminal-only, `createWorkflowWatcher(dir, onChange, { debounceMs, pollMs })`.
- View: cards (name, kind chip, status badge, `<progress>` bar + percent, step "3/7 · rendering hero shots", elapsed, message, the reported session's state when it is in the Phase C list, outputs and the preview as links whose **visible text is the label followed by the hostname in muted text** (`Preview · claude.ai`) — never the raw URL — with `target="_blank" rel="noopener noreferrer"`; a withheld URL is shown as inert enum text, e.g. `Preview withheld · host not allowed`), filter by status, header action **Archive finished** (typed `archive`). Invalid records show as a muted card with the enum reason. Text nodes only; `h()` sets `href` through `setAttribute`, so the validator is the control for the first server-supplied string that reaches an `href` in this UI.

## API surface verified

| Symbol | Where | Fact used |
|---|---|---|
| `CONFIG_DIR` | `src/config.ts:45` | `~/.config/deus`; already passed to the server as `deps.configDir` (Phase 4) |
| `createRateLimiter(max, windowMs)` | `src/rate-limiter.ts:12` | per-feature limiter instances (`server.ts`) |
| `readAudits`, `actor`, `header`, `writeJson`, `hub.broadcast`, `hub.clientCount` | `src/control-ui/server.ts` | existing route helpers and SSE hub |
| `redactSecrets`, `SECRET_KEYS` | `src/control-ui/api/logs.ts` | display-string backstop; `SECRET_KEYS` rejects URLs whose query keys look secret |
| `h()` attributes | `web/control/dom.js:1-14` | every attribute via `setAttribute`, no scheme filter — `href` values must be validated server-side |
| `CONFIG_DIR` not mounted | `src/config.ts`, `src/container-mounter.ts` | containers cannot write records |
| `fs.watch` | Node 22 | non-recursive watch; may emit duplicate events (hence debounce) and may fail on some filesystems (hence poll fallback) |
| Phase C list shape | `src/control-ui/api/claude-sessions.ts` `ClaudeSession` | `{ id, state, waiting_on }` used for the browser-side join |
| `publishing/config.json` `preview_url` | vault atom + `marketing/publishing/config.json` (instance) | existing per-batch preview convention — `finish --preview` carries the same URL into the registry; the config file is not read by the dashboard |

## Verification strategy (frozen)

| Surface | Predicted |
|---|---|
| CLI (spawned in tests with `--registry <tmp>`) | `start` prints `wf-<12hex>` and writes a 0600 file; `progress` merges into a new literal and bumps `updated_at`; `finish` sets `done`, `percent: 100`, `finished_at`, `preview_url`; `fail` sets `failed` + message; `progress` on a done record → exit 3; unknown id → 4; bad kind/percent/url → 3 with the file untouched; a `rev` changed under it → 3; `rev` is bumped by every write; a stale `*.tmp-*` older than 1 h is swept; `--session` absent when not given (no env default); a `__proto__` key in a planted record is not written back |
| Validator agreement | 12 fixture records (6 valid, 6 invalid) yield identical verdicts from the CLI validator and `validateRecord` |
| API | list returns valid records newest-first and invalid ones flagged with an enum reason; a symlinked `<id>.json` (to a temp file holding `KEY=value`) → `unreadable` and the value never appears in the response; a 70 KB file → `too-large`; a record with own `toJSON`/`__proto__` keys → the frame carries only v1 fields; a `https://claude.ai@evil.example/` preview → record valid, `preview_url: null, preview_blocked: 'userinfo'`; `http://localhost.evil/` → `preview_blocked: 'host'`; a URL with `?token=…` → `preview_blocked: 'secret-query'` and the token value appears nowhere in the response; a 3 000-character URL or `preview_url: 42` → whole record `bad-url`; 250 records → 200 newest + `truncated: 50`; a symlinked registry dir → 503 and no watcher; `archive` 428 without confirm, 200 `{ archived: n }`, moves only terminal records older than 30 days (fake clock), `{ id }` form moves one, `{ id: '../x' }` → 400 before any path is built, existing archive target → 409, running record updated 1 h ago → 409, running record updated 25 h ago via `{ id }` → 200 with `stale: true`; read-only → 403 and the list carries no `step`/`message`/`outputs`/`preview_url`/`session_id`; **read-only + a registry write → the `workflow` SSE frame carries none of those fields either**; a file `wf-aaaaaaaaaaaa.json` whose body says `id: 'wf-bbbbbbbbbbbb'` → `bad-id`; sweep with one existing archive target → `{ archived: n-1, skipped: 1 }` and 200; 5 001 entries → `truncated: -1`; 1 000 entries → at most 600 files opened (counted through an injected `open` spy) and `truncated: 800`; 250 stale `running` + 10 `done` → the 10 `done` are listed ahead of the stale ones; a fresh `waiting` record whose mtime falls outside the newest 600 is absent from the list and the response says `scanned: 601, candidates: 600, truncated: 401`; a record whose body claims `updated_at` in the future but whose mtime is 25 h old ranks as stale; a `waiting` record older than 200 `done` ones stays in the list; a label containing U+202E → rendered without it; 61st list/min → 429 |
| Watcher | writing a file under the dir yields one `workflow` frame within 1 s (debounced: three writes → one frame); watcher failure → poll fallback still yields a frame |
| Visual | `phaseW-workflows-{mobile,desktop}.png` from a fixture with 4 records (running 40 %, waiting with a linked blocked session, done with preview + outputs, failed) and one invalid file |

---

### Task 1: CLI + validator

**Files:** create `scripts/workflow.mjs`, `scripts/tests/workflow.test.ts` (vitest, spawns the CLI), `src/control-ui/api/allowed-url.ts` (+test: userinfo, exact-host, localhost-only http, secret query keys, length), `src/control-ui/api/workflows.ts` (+test incl. the agreement fixtures under `src/control-ui/api/__fixtures__/workflows/`).

- [ ] Step 1: failing tests per the CLI and validator rows above.
- [ ] Step 2: implement; `npx vitest run scripts/tests/workflow.test.ts src/control-ui/api/workflows.test.ts`; tsc; eslint (`scripts/` is not linted — `node --check`).

### Task 2: routes + watcher + convention

**Files:** modify `src/control-ui/api/claude-sessions.ts` (drop the unused `readOnly` option; call site in `server.ts`), `src/control-ui/server.ts` (deps: none new — uses `deps.configDir`; routes; `workflowLimiter` 60/min, `workflowArchiveLimiter` 6/min; watcher started when `configDir` is set), `src/control-ui/server.test.ts`, `AGENTS.md` (new section), `CLAUDE.md` (one line under Development Rules that names the CLI directly — "For orders that take more than a minute, report progress with `node scripts/workflow.mjs start|progress|finish|fail` (see AGENTS.md § Reporting long-running work)" — because `CLAUDE.md` is force-loaded every turn and `AGENTS.md` is only reached through it).

- [ ] Step 1: integration tests per the API and Watcher rows (temp `configDir`, fake clock for the 30-day rule).
- [ ] Step 2: implement; full control-ui suite; tsc; eslint; prettier.

### Task 3: view + capture + docs

**Files:** create `web/control/views/workflows.js`; modify `web/control/app.js` (VIEWS `workflows` in *Operate*, SSE type `workflow`), `sw.js`, `app.css`, `scripts/control-ui-screenshot.mjs` (`workflows` waits `.wf-card`), fixture launcher writes 4 records + 1 invalid file; `docs/control-ui-notes.md` Phase W record, `docs/control-ui-progress.md`.

- [ ] Step 1: view; `node --check`; capture at 390/1280; overflow probe 0 px on 16 tabs; record; gates; commit `feat(control-ui): add the Workflows tab and the progress registry (Phase W)`.

## Threat-model round 1 — controls folded in

| Finding | Control |
|---|---|
| B1 no fs confinement on read | dir/archive `lstat`, `isFile` dirents, `O_NOFOLLOW` + `fstat` ≤ 64 KB, single read, no re-read |
| B2 `reason` echoes file bytes | closed enum |
| B3 archive `{ id }` reaches a path | regex before `path.join`, `lstat` source, 409 on existing target |
| B4 `https:`-only insufficient | shared `isAllowedUrl`: no userinfo, exact hostnames, allow-list (`claude.ai` + `CONTROL_UI_PREVIEW_HOSTS` + local), ≤ 2048, secret-looking query keys rejected, URL withheld (`preview_blocked` enum) on a policy failure, label/hostname as link text |
| B5 parsed object reaches the frame | fresh literal from the validator; CLI merges into a new literal |
| DoS on re-list | newest 200 by mtime + `truncated` |
| read-only prose | projected list without step/message/outputs/urls/session_id |
| redaction vs URLs | display strings only; URLs rejected, never mangled |
| CLI hygiene | tmp sweep, `updated_at` optimistic check |
| self-asserted `session_id` | join only when listed, "reported session" label, no env default |

Answers: (1) URL policy is the shared allow-list, not any-`https:`; extra preview hosts are an explicit env list. (2) Read-only serving everything was an omission — it now withholds. (3) `finish --preview` writes only the workflow record; feeding Phase A's artifact registry is Phase A's own gated write, with the same `isAllowedUrl`. (4) `--session` has no env default; `session_id` is a display hint, trusted for nothing.

## Threat-model round 2 — controls folded in

| Finding | Folded as |
|---|---|
| Blocking: read-only projection specified on the route, not the data path (watcher SSE leaked withheld prose) | `listWorkflows(dir, { readOnly })` projects inside the list function; both the route and the watcher use it; verification row added |
| R1 record id not bound to filename | `record.id === basename(file, '.json')` else `bad-id` |
| R2 bulk archive aborts on an existing target | sweep skips and counts; hard 409 only for `{ id }` |
| R3 scan unbounded before the 200-cap | refuse above 5 000 entries with `truncated: -1` |
| R4 cap by mtime evicts stuck `waiting` records first | non-terminal ranked ahead of terminal inside the cap; client-side filter caveat in the notice |
| R5 bidi/homoglyph label spoofing, `SECRET_KEYS` unanchored, env parsing | `\p{Cc}`/`\p{Cf}` stripped, hostname shown beside the label, anchored `^(…)$`, trimmed/lower-cased exact hostnames |

Later, not now (recorded in the notes): `O_NONBLOCK` on the open, fd `try/finally`, read ≤ 64 KB from the fd rather than to EOF, `DT_UNKNOWN` dirents on exotic filesystems. Answers: `isAllowedUrl` lives in `api/allowed-url.ts`; the archive `{ id }` is `typeof`-checked before the regex.

## Threat-model round 3 — controls folded in

| Finding | Folded as |
|---|---|
| W1 status ranking needs parsing, contradicting the scan bound | explicit parse bound: newest 600 by mtime are the only files opened; ranking runs over that set; open-count verification row |
| W2 ≥ 200 stuck non-terminal records hide finished work with no browser remedy | three-tier ranking (fresh non-terminal → terminal → stale non-terminal); `{ id }` archive accepts a non-terminal record stale > 24 h |
| W3 shared allow-list widening not a named deviation | listed under Deviations from the spec |
| W4 `updated_at` optimistic check can compare equal | integer `rev` bumped per write is the optimistic token; timestamps are millisecond ISO |
| Note: read-only keeps `name` | stated at the read-only line |

## Threat-model round 4 — SHIP; recommendations folded in

| Finding | Folded as |
|---|---|
| R1 freshness keyed on writer-asserted `updated_at` | both the tier test and the stale-archive gate use the file mtime from the candidate-set `stat` |
| R2 archive / `rev` TOCTOU windows | stated as accepted residuals in the Watcher bullet |
| R3 exit 4 now reachable mid-order | convention text says a CLI failure never aborts the order |
| R4 >600-candidate case | verification row (`scanned`/`candidates`/`truncated`) |
| R5 `truncated` conflates two bounds | response carries `scanned` and `candidates` |
| Precedent inaccuracy: Phase C's `readOnly` option is vestigial | corrected in Design; Task 2 removes the unused option |

## Plan-review round 2 — folded in

| Finding | Folded as |
|---|---|
| URL rejection specified two ways | shape failures → `bad-url` (whole record); policy failures → record valid, URL withheld with a `preview_blocked` / `blocked` enum; verification rows corrected |
| `preview_link` undefined | removed; the withheld state is `preview_url: null` + `preview_blocked` |

The withheld-URL rule narrows the data flow the threat model SHIPped (round 4 reviewed "URL as inert text"; now a policy-failed URL never leaves the server), so no further threat round is needed for it — noted here so the next reviewer sees the delta.

## Deviations from the spec

- `CONTROL_UI_PREVIEW_HOSTS` widens the preview allow-list beyond the spec's "only `https://claude.ai/…`" — and because `isAllowedUrl` is shared, it widens Phase A's artifact allow-list by the same env entries. Operator-set, exact hostnames, empty by default (so the default behaviour equals the spec).
- `Clear finished` is named **Archive finished** and moves files rather than deleting them (no-deletion ADR instinct; the archive dir is outside the repo).
- The validator is duplicated between the CLI (plain JS) and the API (TS) with an agreement test, because scripts cannot import from `src/`.

## Self-review

Spec coverage: registry ✓, CLI ✓, validation ✓, SSE ✓, cards with percent/step/session/preview ✓, archive ✓, convention ✓, pipeline flag deferred ✓. Placeholders: none. Type consistency: `validateRecord`, `listWorkflows`, `archiveWorkflows`, `createWorkflowWatcher`, limiter names used identically across Tasks 1–3.
