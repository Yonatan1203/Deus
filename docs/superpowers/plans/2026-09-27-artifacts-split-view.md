# Artifacts split view — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Like the Claude app, the operator sees the conversation on the left and an artifact on the right, on the same page, and the artifact reloads as the agent changes it.

**Architecture:** claude.ai artifact pages refuse to be framed (`X-Frame-Options: sameorigin`, verified in Chromium 2026-09-26), so the dashboard shows a **local copy**: every artifact starts as an HTML file the session writes before publishing, and `artifact-registry.mjs add --file <path>` copies it into `CONFIG_DIR/control-ui/artifacts/<id>.html` and records the source's realpath and owner. The control server serves **only the copy** at a **ticketed** URL; it follows the agent's edits by **re-copying the source when it changes, under the same checks as `add`** (threat-model round 1: a path in a shared directory can be swapped by another local user, so the source is never read straight into a response) (the single-use tickets `POST /api/v1/events/ticket` already issues for streams) with the document's own CSP and a `sandbox` directive, inside an `<iframe sandbox="allow-scripts">` in a new right pane on the Claude tab; a 2 s version poll reloads the frame when the file changes. The dashboard's CSP gains `frame-src 'self'`.

**Tech Stack:** Node `fs`/`http` (server), vanilla ES modules with `h()`, vitest, Playwright drive on the fake-claude fixture.

**Spec:** the operator's request (2026-09-26): "the web GUI will be able to open an artifact on the same page and there is a two screen view like in claude app", and the framing finding recorded in this session.

## Global Constraints

- The framed document never shares the dashboard's origin: `sandbox allow-scripts` (no `allow-same-origin`) both as an iframe attribute and as a CSP `sandbox` directive on the served document, so artifact scripts cannot read the dashboard's cookies, storage or DOM.
- The served document's CSP allows what artifacts are authored with (scripts from cdnjs.cloudflare.com and cdn.jsdelivr.net, inline scripts and styles, Google Fonts, `img-src * data:`), sets `connect-src 'none'` and `frame-ancestors 'self'`; no `X-Frame-Options` on this route.
- Ticket URLs are single-use and short-lived (the existing ticket store); the route never accepts the session cookie as the only auth on a framed request and never appears in the service-worker shell.
- Copies are bounded: `.html` only, regular file (no symlink), ≤ 4 MiB, stored 0600 in a 0700 dir, at most one per artifact, removed with the artifact (by the CLI `remove` **and** by the dashboard's `DELETE`).
- The source is re-read only by the refresh step, never by the page route, and only when: opened `O_NOFOLLOW` and `fstat`-ed (not stat-then-read), regular, `.html`/`.htm`, ≤ 4 MiB, `realpath(source)` equals the realpath recorded at `add`, `st_uid` equals the uid recorded at `add`, `st_nlink === 1`, and the fd's fstat dev/ino equal a stat of the recorded realpath taken after the open. Any mismatch keeps the existing copy and the pane says so. A read-only server never runs the refresh (it only reports the copy's version, `following: false`).
- No HTML strings in the dashboard (`h()`), CSP `style-src 'self'` unchanged for the dashboard itself; sw.js v25; verification record with screenshots.

---

### Task 1: Registry — `add --file`, the copy, the validator

**Files:**
- Modify: `scripts/artifact-registry.mjs` (`add --file <path>`; `remove` deletes the copy), `src/control-ui/api/artifacts.ts` (validator kept in lockstep: optional `local: { source: string; copied_at: iso; bytes: number }`; `copyPath(dir, id)` helper), tests `scripts/tests/artifact-registry.test.ts` (existing) and `src/control-ui/api/artifacts.test.ts` (existing).

**Interfaces:**
- CLI: `add … [--file <path>]` — resolves the path, refuses unless it is a regular file (lstat, no symlink) named `*.html`/`*.htm` ≤ 4 MiB; copies to `<registry dir>/artifacts/<id>.html` (`wx`, 0600; dir 0700) and stores `local: { source: <realpath>, uid: <st_uid>, copied_at, bytes, source_mtime_ms }`; appends an audit line `{ id, source, uid, bytes, at }` to `artifacts-added.jsonl` beside the removal log. Exit 3 with a plain message on refusal. `remove <id>` unlinks the copy if present.
- Validator (`src/control-ui/api/artifacts.ts`): `local` optional; `source` absolute path ≤ 1024 chars; `uid` int ≥ 0; `bytes` int 1..4 MiB; `source_mtime_ms` number; unknown keys stripped as today. `addArtifact`/`removeArtifact` round-trip entries through the validator, so `local` must survive them (test: an entry with `local` stays intact after an unrelated dashboard add and remove). `removeArtifact(id)` also unlinks `artifacts/<id>.html`.

- [ ] **Step 1: Tests** — `add --file` with a temp `.html`: entry has `local`, the copy exists 0600 with identical bytes; a symlink, a `.txt`, a 5 MiB file → exit 3, no copy, no entry; `remove` deletes the copy; validator accepts/rejects the shapes.
- [ ] **Step 2–4:** red → implement → green.

### Task 2: Server — the framed page, its version, the ticket, the CSP

**Files:**
- Modify: `src/control-ui/server.ts`; `src/control-ui/static.ts` (dashboard CSP gains `frame-src 'self'`); tests in `server.test.ts`, `static.test.ts`.

**Interfaces:**
- `GET /api/v1/artifacts/:id/page?ticket=<t>` — ticket from `POST /api/v1/events/ticket` (single-use, 60 s, bound to the session, redeemed before the body is sent); 401 without a valid ticket; 404 (`{ error: 'no-local' }`) when the artifact has no `local`, 404 (`{ error: 'no-copy' }`) when the copy file is missing (the pane then shows "The copy is gone — open on claude.ai"); body: **the copy, always**; headers set by **replacing** the global security headers on this response (`SECURITY_HEADERS` is applied to every response at server.ts ~3076 — this route calls `ctx.res.removeHeader('X-Frame-Options')` and `setHeader('Content-Security-Policy', …)` **after** the global headers were applied — Node's `writeHead` merges, it does not clear — and the test asserts the XFO header is absent and exactly one CSP header is present): `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src * data: blob:; media-src * data: blob:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. Read-only viewers may view (same content class as the list; the copy is the only thing ever served).
- `GET /api/v1/artifacts/:id/version` (session auth; its own limiter, 120/min, stat-only) → runs the **refresh step** first: if the recorded source passes every check in Global Constraints and its mtime is newer than `source_mtime_ms`, it is re-copied atomically (temp + rename, 0600) and `local.source_mtime_ms`/`copied_at`/`bytes` updated in the registry under its lock; reply `{ version: '<copy mtimeMs>:<size>', following: true|false }` (`following` false when the source is gone or failed a check — the pane then says "Showing the copy from <date>"); 404 without `local`.
- `GET /api/v1/artifacts` entries gain `local: true|false` (never the path) — the pane only offers "Open beside" when true. In `projectEntry` (`artifacts.ts` ~175) the flag is set **before** the `if (opts.readOnly) return v;` early return, so read-only viewers get it too.

- [ ] **Step 1: Tests** — page: 401 no ticket, 401 reused ticket, 404 no local, **serves the copy, always** (editing or deleting the source without calling `version` leaves the page byte-identical), exactly one CSP header (the specified one), no `X-Frame-Options`, nosniff, no-store; version: unchanged until the source changes; after a valid change, `version` refreshes the copy and the page shows the new bytes; a source replaced by a symlink, by a file owned by another uid, by a non-`.html` file, by a hardlink to another file (`st_nlink !== 1`), or by a file whose fstat dev/ino differs from a stat of the recorded realpath → not re-copied, `following: false`, page unchanged; on a read-only server (`deps.readOnly`) `version` never writes (no re-copy, `following: false`); list carries `local` boolean only; static CSP contains `frame-src 'self'` and still `frame-ancestors 'none'`.
- [ ] **Step 2–4:** red → implement → green; `npm run build`.

### Task 3: The pane on the Claude tab, and the way in

**Files:**
- Create: `web/control/artifact-pane.js` — `createArtifactPane(api)` → `{ el, open(artifact), close(), dispose() }`; the pane: a persistent header that names what it is — "Page written by a session" — with the title, kind chip, "Open on claude.ai" link and Close; an `<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="<title>">`; a footer note when not following ("Showing the copy from <date>"). `open()` fetches a ticket, sets `src`, starts a 2 s version poll; on change: new ticket, reload; a `load` event that was not caused by the pane's own reload shows "This page navigated away — Reload"; `dispose()` stops the poll.
- Modify: `web/control/app.js` — `currentView()` (~line 186) strips a `?…` query from the hash before taking the view key (`location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0]`), and exports `hashQuery()` → `URLSearchParams` of the part after `?` (empty when none).
- Modify: `web/control/views/claude.js` — `wantedId` (~line 748) likewise takes the session id from the hash with the query stripped; the layout gets a third column when a pane is open (`.claude-layout.with-artifact`), the pane after the stage; `#/claude?artifact=<id>` and `#/claude/<session>?artifact=<id>` open it (read through `hashQuery().get('artifact')`, validated against the id regex); the conversation's artifact cards (`web/control/conversation.js`, `.conv-card`) gain "Open beside" when the registry lists that URL with `local: true` (the tab passes a lookup map into `renderConversation` handlers: `handlers.openArtifact(url)`); `web/control/views/artifacts.js` cards gain "Open beside Claude" (→ `#/claude?artifact=<id>`) when `local`.
- Modify: `web/control/app.css` — desktop ≥ 1100 px: `grid-template-columns: 280px minmax(0, 1fr) minmax(360px, 42%)`; below: the pane is a full-height sheet over the stage with the header's Close and a "Conversation" toggle; phone: the same sheet; the iframe fills its box.
- Modify: `web/control/sw.js` — v25, `'/artifact-pane.js'` in SHELL.

- [ ] **Step 1:** build with `h()`; strings sentence case; the frame never gets `allow-same-origin`.
- [ ] **Step 2:** tests where possible without a DOM: none (browser module); the drive covers it.

### Task 4: Guidance and the Create-artifact prompt

**Files:**
- Modify: `AGENTS.md § Publishing artifacts` — the `add` line gains `--file <the HTML file you published>` with one sentence: "With `--file`, the dashboard shows the artifact beside the conversation and follows your edits to that file."; `src/control-ui/api/artifact-creations.ts` `creationPrompt` registration line gains `--file <the html file you published from>`; the AI-eng warden is run on this diff (prompt text changed).

### Task 5: Drive, records, reviews

- Fixture: `serve-art.mjs` (fake claude) with a registry entry pointing at a fixture HTML in the job's tmp dir (registered through the real CLI with `--file`). Drive: Artifacts tab → card shows "Open beside Claude" → click → Claude tab with the pane; the frame renders the fixture (assert frame text via Playwright's frame API); edit the fixture file → within 3 s the frame shows the new text; Close; a card without `local` has no button; `#/claude?artifact=<id>` direct link; phone 390 px: sheet, overflow 0; screenshots `artifacts-split-desktop.png`, `artifacts-split-mobile.png`. Security check in the drive: inside the frame, `document.cookie` is empty and `window.parent.document` throws (sandbox); a `fetch` from the frame fails (`connect-src 'none'`); the page's response carries exactly one CSP header (the specified one) and no `X-Frame-Options`; swapping the source for a symlink to another file, or for a hardlink to a non-`.html` file made as root, does **not** change what the pane shows (the refresh refuses; `following: false`). Not testable here, stated: iOS Safari's handling of sandboxed frames and blocked downloads (the operator's phone) — the drive runs desktop Chromium and the 390 px viewport only.
- Record in `docs/control-ui-notes.md`; reviews: code-reviewer, threat-modeler (post-implementation check), ux-reviewer, copy-writer, ai-eng-warden (prompt line), verification-gate; commit (message shown first); merge; build; restart; confirm v25.

## Patterns

`createArtifactPane(api)` returning `{ el, open, close, dispose }` follows this codebase's factory-function convention (`createComposer`, `createCreations`, `createDirWatcher`); the ticketed page route reuses the single-use ticket store the SSE streams use, not a new auth mechanism.

## Self-review

- Coverage: local copy + CLI (T1), served page + version + CSP + tickets (T2), pane + entry points + layouts (T3), guidance/prompt (T4), verification (T5).
- Types: `local` shape identical in CLI, validator and list (boolean only on the wire) ✔; ticket store reused, not forked ✔.
- Known limit, stated: artifacts that use claude.ai runtime features (`window.claude.*`, shared DB) run as static pages in the pane; "Open on claude.ai" stays one click away.
