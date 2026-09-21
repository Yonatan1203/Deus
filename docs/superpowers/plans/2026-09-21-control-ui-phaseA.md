# Control UI Phase A — Live artifacts tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Artifacts" tab listing the live artifact apps, reports and previews the operator chose to keep at hand (the Supplier Line, the posts preview, the product-image preview…), each a link, fed by a small registry the operator curates.

**Architecture:** one JSON file `CONFIG_DIR/control-ui/artifacts.json` (outside the repo, never mounted into containers) holding `{ v: 1, rev, artifacts: [...] }`, written by `scripts/artifact-registry.mjs` and by two dashboard routes (add, remove) through `src/control-ui/api/artifacts.ts`, read with the Phase W confinement (`O_NOFOLLOW`, `fstat` bound, one parse, fresh literals, closed reason enum) and the shared `isAllowedUrl`. A standing instruction in `AGENTS.md` tells sessions to **ask the operator** after publishing an artifact whether to add it, then run the CLI. The view is cards grouped by kind.

**Tech Stack:** Node `fs` (sync, confined), vitest, vanilla ES modules with `h()` text nodes, Playwright capture.

**Spec:** `docs/superpowers/specs/2026-09-21-control-ui-scope2-design.md` § A. Phase W (`docs/superpowers/plans/2026-09-21-control-ui-phaseW.md`) owns `api/allowed-url.ts` and the read-path pattern this phase copies.

## Global Constraints

- **The registry file is an input boundary.** Anything running as the operator can write it. Read path: `CONFIG_DIR/control-ui` must `lstat` as a real directory; the file is opened `O_RDONLY | O_NOFOLLOW`, `fstat`-ed (regular file, ≤ 256 KB else `too-large`; both writers refuse to produce a file above a **192 KB byte budget** — serialised before writing — with 409 `registry full` / exit 3, so our own writers can never reach the read cliff; only a hand-edited file can), read once from the fd, parsed once; `validateRegistry(raw)` builds a **fresh literal** — `{ v: 1, rev, artifacts }` with every entry rebuilt field by field — and returns `{ ok: true, registry }` or `{ ok: false, reason }` with `reason` a closed enum `unreadable | too-large | not-json | bad-schema`. A registry that fails validation is reported to the browser as `{ artifacts: [], rev: 0, invalid: true, reason }` (`rev` is always present: 0 for missing or invalid) — never the file's text, never `err.message`. A missing file is an empty registry, not an error. **Recovery from an unreadable registry is a host action**, deliberately: the tab shows the closed reason plus "fix or move `artifacts.json` on the host", and no browser write ever overwrites a file the server could not validate: `addArtifact`/`removeArtifact` against an invalid registry return 503 `{ error: 'registry unreadable', reason }` and the CLI exits 3 — never a rebuild from empty (that would erase every entry outside the corrupt field).
- **Entry schema (v1):** `{ id: /^art-[0-9a-f]{12}$/, title: 1..100 chars, first char \p{L}|\p{N}, no \p{Cc}/\p{Cf}, url: string (shape-valid per `checkUrl`), kind: 'app'|'report'|'preview', description?: ≤ 300, added_at: ISO ms, added_by: 'cli'|'dashboard' }`; ≤ 200 entries; ids unique (duplicate → `bad-schema`). `rev` integer ≥ 1. Every write — CLI or route — builds a new literal from the validated registry plus the change, bumps `rev`, writes `artifacts.json.tmp-<rand>` (`wx`, 0600) into the same dir and `renameSync`s over the file after re-reading and comparing `rev` (409 / exit 3 on a change). The read-modify-write in **both** writers runs under `artifacts.json.lock` (opened `wx`, 0600, holding a random nonce; released in `finally` **only if the file still holds our nonce**; broken when its `lstat` mtime is older than 5 s); a failed write (`rev` mismatch, budget, validation) unlinks its own `artifacts.json.tmp-*` and every run sweeps `artifacts.json.tmp-*` older than one hour by name (the Phase W `sweepTmp` shape); the CLI retries a busy lock three times 200 ms apart before exit 3, the route answers 409 `registry busy` at once; the `rev` compare stays as the backstop, so the CLI-vs-dashboard window the shared file introduces is closed rather than accepted. `CONFIG_DIR/control-ui` is created 0700 when missing.
- **URL policy = Phase W's `checkUrl`.** On read, a policy-failed URL is withheld (`url: null, blocked: <enum>`) exactly as Phase W does — it never reaches the browser as text. On **write** (CLI `add` and the dashboard route), a URL that fails `checkUrl` (shape or policy, using the same `CONTROL_UI_PREVIEW_HOSTS` allow-list) is **rejected** with the block reason (`400 { error: 'url not allowed', blocked }` / exit 3) so the registry never stores a link the tab cannot show. **The read-time check is the security control; the write-time check is UX** — a session can run the CLI with its own `CONTROL_UI_PREVIEW_HOSTS`, and the entry it stores is still withheld by the server's read-time `checkUrl` against the server's allow-list. Never drop the read-time check as redundant. The default allow-list is `https://claude.ai/…` plus exact local `http:` hosts, matching the spec's "only claude.ai" when the env var is empty.
- **Mutations from the browser:** `POST /api/v1/artifacts` `{ title, url, kind, description? }` → 201 `{ id }` (no typed confirmation — not destructive; 6/min per session, 403 read-only, audited `control_ui_artifact_add` with id + hostname, never the full URL in the log), and `DELETE /api/v1/artifacts/:id` with `X-Confirm: <the entry's id>` → 204 (the dialog shows the title and asks for the id, as the Tasks and Claude tabs do — a title is any `\p{L}` and `fetch` header values are ByteStrings, so a Hebrew or `Café` title could never cross the boundary; 428 on mismatch, 404 unknown id, 6/min shared with add, 403 read-only, audited `control_ui_artifact_remove`). The `:id` param is regex-checked before use; ids never touch a path (single file). `GET /api/v1/artifacts` 60/min per session.
- **Display strings** (`title`, `description`) pass `redactSecrets` and `\p{Cc}`/`\p{Cf}` stripping on read; URLs never do. Read-only withholds `description` (sessions write it under the convention) **and `url`** — the same line Phase W draws for a preview link, which is a capability — keeping `title`, `kind`, `hostname` and the dates so the list still reads; it refuses both mutations. Removals — CLI or dashboard — append the removed entry as one JSON line to `CONFIG_DIR/control-ui/artifacts-removed.jsonl` (opened `O_APPEND | O_CREAT | O_NOFOLLOW`, 0600; rotated to `artifacts-removed.jsonl.1` — replacing any older `.1` — once it passes 1 MB, so it never grows unbounded) so a delete is never silent and is re-addable; the CLI also prints it on stdout.
- **Live updates:** the existing `createWorkflowWatcher` is generalised to `createDirWatcher(dir, onChange, opts)` (same code, exported under the new name with `createWorkflowWatcher` kept as an alias) and pointed at `CONFIG_DIR/control-ui`, which the server creates (0700) at boot before constructing the watcher — a `null` watcher on a fresh instance would otherwise never retry; the callback re-reads the registry and broadcasts an `artifact` SSE frame only when the projected JSON changed (the dir also holds the Claude ledger and env backups, so most events are no-ops). Route and watcher use the same `listArtifacts(dir, { hosts, readOnly })` (the `readOnly` slot is where the withholding lives, as `ListOptions.readOnly` does in Phase W).
- **Seeds are instance data.** The repo ships no URLs. At deploy the operator's instance registry is seeded through the CLI with the three the spec names (Supplier Line, the current posts preview, the product-image preview); every other published artifact is added only when the operator says so — that is the whole point of the ask-to-register convention.
- **Convention text** (`AGENTS.md`, new "Publishing artifacts" heading; one line in `CLAUDE.md`): "After publishing an artifact app, report or preview that the operator may want to reopen later, **ask them** whether to add it to the dashboard's Artifacts tab. Only on a yes, run `node scripts/artifact-registry.mjs add --title "…" --url https://claude.ai/artifact/… --kind app|report|preview [--description "…"]`. Never add without asking; never add scratch or one-off artifacts."
- Public-repo generic: fixtures and screenshots use synthetic titles and `https://claude.ai/artifact/fixture-…` URLs.
- Visual language: existing tokens, `header()`, `.card` grid as the Workflows tab; no new direction.

## Design

- `scripts/artifact-registry.mjs` — `add --title --url --kind [--description] [--registry <file>]` (prints the new id, `art-` + `crypto.randomBytes(6).toString('hex')` as Phase W does), `remove <id>`, `list [--json]`; validator duplicated from `api/artifacts.ts` with an agreement test over 8 fixtures (`__fixtures__/artifacts/`), same rationale as Phase W (no `allowJs`). URL check in the CLI: shape + the same policy rules with `CONTROL_UI_PREVIEW_HOSTS` read from the environment (documented), so the CLI and the server agree on what is storable. Exit codes 0/2/3/4.
- `src/control-ui/api/artifacts.ts` — `validateRegistry(raw)`; reading reuses Phase W's `readRecordFile(file, maxBytes?)` (the size bound becomes a parameter, default unchanged at 64 KB; artifacts pass 256 KB) instead of a second copy of the confinement; `listArtifacts(dir, { hosts, readOnly })` → `{ artifacts: ArtifactView[], rev, invalid?, reason? }` with `ArtifactView = { id, title, kind, description?, added_at, added_by, hostname, url?: string | null, blocked? }` — three link states the card can tell apart: `url` a string (link), `url: null` + `blocked` (policy-withheld, inert enum text), `url` **absent** (read-only: title as plain text with the hostname chip and no "withheld" wording), `addArtifact(dir, entry, { hosts, now })` → `{ status: 201, id } | { status: 400 | 409 | 503, error, blocked? }`, `removeArtifact(dir, id, confirmId)` → `{ status: 204 } | { status: 404 | 409 | 428 | 503, error }` (428 when `X-Confirm` does not equal the entry's id — an exact ASCII compare). Both writes reuse one `writeRegistry(dir, next, expectRev)`.
- `server.ts` — `artifactReadLimiter` 60/min, `artifactWriteLimiter` 6/min; routes above; watcher as described; `deps.previewHosts` already exists.
- `web/control/views/artifacts.js` — header with **Add artifact** (inline form: title, URL, kind select, description; client-side hint that only claude.ai links are accepted unless the operator configured more hosts), sections per kind (Apps, Reports, Previews) of `.card`s: title as the link (label + hostname, `target=_blank rel="noopener noreferrer"`), description, "added <date> · by cli/dashboard", **Remove** (typed title). Withheld links render as inert enum text. Empty state explains the convention. Text nodes only. `app.js`: VIEWS `artifacts` in *Operate*, SSE type `artifact`; `sw.js` v8; `app.css` block; icon `artifacts`; screenshot step waits `.art-card, .empty`.
- Workflows tab tie-in (small): a done workflow card with a shown `preview_url` gets an **Add to artifacts** button (only when `preview_url` is a string — never for a withheld link) that opens the same POST with title = workflow name, kind = `preview` — the browser-side counterpart of the ask-to-register rule (the operator clicks, so nobody has to ask).

## API surface verified

| Symbol | Where | Use |
|---|---|---|
| `checkUrl`, `parsePreviewHosts` | `src/control-ui/api/allowed-url.ts` | write-time rejection and read-time withholding |
| `readRecordFile(file)` (`workflows.ts:192-211`, bound hard-coded today → gains `maxBytes`), `createWorkflowWatcher` (`:477-524`) | `src/control-ui/api/workflows.ts` | confined read reused with a 256 KB bound; watcher generalised |
| `redactSecrets` | `src/control-ui/api/logs.ts` | display-string backstop |
| `header`, `h`, `badge`, `confirmTyped`, `toast`, `fmtTime` | `web/control/*` | view |
| `deps.configDir`, `deps.previewHosts`, `sid(ctx)`, `header(ctx.req, …)`, `actor()` | `src/control-ui/server.ts` | routes |

## Verification strategy (frozen)

| Surface | Predicted |
|---|---|
| CLI | `add` prints `art-<12hex>`, file 0600 with `rev: 1`; second `add` → `rev: 2`; `add` with `https://claude.ai@evil.example/` → exit 3 mentioning `userinfo`; with `?token=` → exit 3; with a 101-char title → exit 3; `add` whose serialised registry would exceed 192 KB → exit 3 `registry full`; `remove <id>` → 0, prints the entry as JSON, appends it to `artifacts-removed.jsonl`, and the entry is gone; a Hebrew title and `Café` round-trip through add/list/remove; unknown id → 4; a planted `__proto__` key is not written back; `rev` bumped on disk between read and rename → exit 3; `list --json` shows entries |
| Validator agreement | 8 fixtures (4 valid, 4 invalid) yield identical verdicts from the CLI and `validateRegistry` |
| API | missing file → `{ artifacts: [], rev: 0 }`; symlinked file (to a temp holding `KEY=value`) → `rev: 0, invalid: true, reason: 'unreadable'` and the value appears nowhere; POST and DELETE against that invalid registry → 503 with the closed reason and the file untouched; 300 KB file → `too-large`; a stored entry whose host was later removed from `CONTROL_UI_PREVIEW_HOSTS` → `url: null, blocked: 'host'`; a hand-planted entry with `"url": "javascript:alert(1)"` → `url: null, blocked: 'protocol'` (the read-time check is the control); POST 401 unauthenticated; POST valid → 201 and the file has `rev + 1`; POST `javascript:` / `https://evil.example/` / `?api_key=` → 400 with `blocked`; POST 201st entry → 409; POST that would push the file past 192 KB → 409 `registry full`; DELETE without `X-Confirm` → 428, wrong id → 428, right id → 204, the file no longer has the id and `artifacts-removed.jsonl` gained one line; a Hebrew-titled entry removes cleanly; a stale `artifacts.json.lock` (6 s old) is broken and the write succeeds, a fresh one (1 s) → 409 `registry busy`; CLI `add` while a test holds the lock for 300 ms → exit 0 after a retry, held for 2 s → exit 3 `registry busy`; every Phase W fixture `name` passes the title rule (the workflow `NAME_RE` is a subset of it, so the Workflows tie-in can never post an unacceptable title — asserted, not assumed); read-only → 403 on both and the list carries no `description` and no `url` (hostname kept); a lock holding another nonce is left alone by our `finally`; a failed add leaves no `artifacts.json.tmp-*` behind; a 1 MB removed-log rotates to `.1` on the next remove; `:id` `../x` → 404 before any read; read-only → 403 on both; 7th write/min → 429; 61st read/min → 429; audit lines carry the id and hostname, not the URL |
| Watcher | writing the file yields one `artifact` frame within 1 s; touching the Claude ledger in the same dir yields no `artifact` frame |
| Visual | `phaseA-artifacts-{mobile,desktop}.png` from a fixture with 2 apps, 1 report, 1 preview, one withheld link; Workflows card shows **Add to artifacts** on the done fixture |

---

### Task 1: CLI + validator + module

**Files:** create `scripts/artifact-registry.mjs`, `scripts/tests/artifact-registry.test.ts`, `src/control-ui/api/artifacts.ts` (+test, +8 fixtures under `src/control-ui/api/__fixtures__/artifacts/`); modify `src/control-ui/api/workflows.ts`: export `createDirWatcher` (keep the `createWorkflowWatcher` alias) **and extend `readRecordFile(file, maxBytes = RECORD_MAX_BYTES)`** with an optional bound — today it hard-codes the module constant (`workflows.ts:198`); the existing single-argument callers in `listWorkflows`/`archiveWorkflows` are unaffected by the default.

- [ ] Step 1: failing tests per the CLI, agreement and module rows.
- [ ] Step 2: implement; `npx vitest run src/control-ui/api scripts/tests/artifact-registry.test.ts`; tsc; eslint; `node --check`.

### Task 2: routes + watcher + convention

**Files:** modify `src/control-ui/server.ts`, `src/control-ui/server.test.ts` (describe "artifacts"), `AGENTS.md`, `CLAUDE.md`.

- [ ] Step 1: integration tests per the API and Watcher rows.
- [ ] Step 2: implement; full control-ui suite; tsc; eslint; prettier.

### Task 3: view + Workflows tie-in + capture + docs

**Files:** create `web/control/views/artifacts.js`; modify `web/control/views/workflows.js` (Add to artifacts), `app.js`, `sw.js`, `app.css`, `icons.js`, `scripts/control-ui-screenshot.mjs`; fixture launcher writes a registry; `docs/control-ui-notes.md` Phase A record, `docs/control-ui-progress.md`.

- [ ] Step 1: view; `node --check`; capture at 390/1280; overflow probe 0 px on 17 tabs; record; gates; commit `feat(control-ui): add the Artifacts tab and registry (Phase A)`.

## Threat-model round 1 — controls folded in

| Finding | Folded as |
|---|---|
| Typed title cannot cross the header boundary for non-ASCII titles | confirm on the ASCII id (in-repo precedent), title shown in the dialog — named under Deviations |
| Read bound below what the schema permits | 192 KB write budget in both writers, 256 KB read bound |
| CLI-vs-dashboard lost update on one shared file | `artifacts.json.lock` (`wx`, `finally`, 5 s stale break) in both writers; `rev` backstop |
| CLI remove unlogged and irreversible | removed entry printed and appended to `artifacts-removed.jsonl` by both writers |
| Load-bearing check misnamed | read-time `checkUrl` named as the security control |
| Watcher `null` on a fresh instance | dir created at boot before the watcher |
| Add-to-artifacts on a withheld preview | button only for a string `preview_url` |
| Q1 read-only and session-written descriptions | read-only withholds `description` |
| Q2 recovery from an unreadable registry | host action by design; the tab says so |

## Plan-review round 1 — folded in

| Finding | Folded as |
|---|---|
| Envelope vs the spec's bare array undisclosed | named under Deviations |
| Writes against an already-invalid registry unspecified | refuse (503 / exit 3, closed reason), never rebuild; verification row |
| `readRegistry` duplicated the confinement | reuse `readRecordFile(file, maxBytes?)` |
| id generation unstated | `art-` + 6 random bytes hex |
| Q1 Add-to-artifacts condition | only for a string `preview_url` (also from the threat round) |
| Q2 `rev` in the invalid shape | always present, 0 when missing/invalid |

## Threat-model round 2 — controls folded in

| Finding | Folded as |
|---|---|
| TM-A0 Design row still compared titles | `removeArtifact(dir, id, confirmId)`, exact id compare |
| TM-A4 read-only kept live links while Phase W withholds them | read-only withholds `url` too, keeps `hostname`; verification row |
| TM-A2 removed-log unbounded | `O_NOFOLLOW` append, rotate to `.1` past 1 MB |
| TM-A1 lock ABA | nonce in the lock, unlink only on match, age by `lstat` |
| TM-A5/A3 tmp orphans, append follows symlinks | unlink on failure + hourly name-scoped sweep; `O_NOFOLLOW` on the append |
| read-path `javascript:` fixture | verification row |
| Q1 CLI on a busy lock | three retries 200 ms apart, then exit 3 |
| Q2 lock age | `lstat` |

## Plan-review round 2 — folded in

| Finding | Folded as |
|---|---|
| `readRecordFile` signature change unnamed in Task 1 | named in Task 1's file list and the API table |

## Threat-model round 3 — SHIP; recommendations folded in

| Finding | Folded as |
|---|---|
| `listArtifacts` had no `readOnly` slot | `listArtifacts(dir, { hosts, readOnly })` |
| read-only-withheld vs policy-withheld links indistinguishable | three link states: string / `null`+`blocked` / absent |
| CLI retry path and tie-in title rule unverified | verification rows |
| stale-lock break by bare unlink | accepted: the `rev` backstop bounds it to a 409 (row kept) |
| secret in a URL fragment | Phase W surface; follow-up, not here |

## Deviations from the spec

- The spec lists W's `finish --preview` as a registry writer. It is **not**: a finished workflow shows its preview on its own card, and the operator adds it to Artifacts with one click (or a session asks first). Automatic registration would defeat the ask-first rule the operator asked for.
- `id` is `art-<12hex>` (the spec left the id shape open).
- The file is an envelope `{ v: 1, rev, artifacts: [...] }`, not the spec's bare array: `rev` carries the optimistic-concurrency token both writers compare, as Phase W's records do.
- Add from the dashboard has no typed confirmation (not destructive). Remove is typed, but on the entry's **id**, not its title: a title may be Hebrew, and `fetch` cannot send that in a header. The dialog shows the title.

## Self-review

Spec coverage: registry file ✓, CLI ✓, ask-to-register convention ✓, Add form ✓, typed Remove ✓, new-tab links with `noopener noreferrer` ✓, no artifact content fetched ✓, allow-list not denylist ✓ (shared with W; env widening documented in W). Placeholders: none. Type consistency: `validateRegistry`, `listArtifacts`, `addArtifact`, `removeArtifact`, `createDirWatcher` used identically across Tasks 1–3.
