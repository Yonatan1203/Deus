# Create Artifact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Artifacts tab, **Create artifact** takes a title and a description, starts a Claude session that builds and publishes the artifact and registers it, and shows the new link on the tab when it lands.

**Architecture:** The dashboard never publishes anything itself. `POST /api/v1/artifacts/create` composes a fixed prompt from the title, kind and description and starts a background Claude session through the very same code as `POST /api/v1/claude/sessions` (limiter, live cap, ledger, audit). The session id, title and kind go into `artifact-creations.json`. `GET /api/v1/artifacts` adds a `creating` list joined with the cached session list, so the tab shows "Creating…" cards with the session's state and a link to it on the Claude tab. When the session runs `artifact-registry.mjs add`, the registry watcher already broadcasts the new entry; the creating card drops as soon as a registry entry with that title exists.

**Tech Stack:** Node/TypeScript server, vanilla ES modules, vitest.

**Spec:** the operator, 2026-09-25: "Lets do that the +Add artifact actually works… send a prompt of a 'create artifact prompt' + 'description' and then it creates a link". Feasibility verified 2026-09-26: dashboard-style background sessions (for example the operator's "Shopify" session, id 0d8d9842) have published artifacts with the Artifact tool.

## Global Constraints

- The security brief applies. No new host capability: the session is started exactly as New session on the Claude tab, in auto mode, from the repo.
- Registration is the session's action (`node scripts/artifact-registry.mjs add`), inside the existing convention (AGENTS.md § Publishing artifacts): the operator's click **is** the approval, and the prompt says so, so the session does not ask again.
- Title: validated against `CLAUDE_NAME_RE` (`api/claude-sessions.ts:12`: a letter or digit, then letters, digits, spaces, `.`, `_`, `-`, at most 60 characters). It is the stricter of the two rules, it satisfies `TITLE_RE` by construction, and it excludes `" \ $ \``, so the registration command line in the prompt cannot be broken by the title. The route validates title, kind and description itself, before anything is started; the shared start function receives values already known to be valid and re-checks them anyway (same code as today).
- Same title twice: while a creation record with that title is still live (its session listed and not `done`), a second Create is refused with 409 "already being created". This is a single-operator surface; the guard only stops a double click from spending two sessions.
- `AGENTS.md § Publishing artifacts` gets one sentence: when the operator started the session from the dashboard's Create artifact form (the prompt says so), that click is the approval and the session registers without asking again. This is the only carve-out.
- Description: 10–2000 characters, no control characters except `\n` and `\t` (stricter than `validatePrompt`, which only refuses NUL).
- Read-only mode: no Create button, and the route answers 403 like every mutation.
- Creation records: at most 20, mode 0600, atomic writes. Pruned when the session is no longer listed, when a registry entry with the same title was added after the record, or after 24 hours.

## Verified facts

- `POST /api/v1/claude/sessions` (`server.ts`): `X-Confirm: start`, `CLAUDE_NAME_RE`, `validatePrompt` (max 8192), `claudeStartLimiter`, `CLAUDE_LIVE_MAX`, `claudeLedger.add`, `control_ui_claude_start` audit line.
- `createLedger(file)` in `api/claude-sessions.ts` stores `{ id, started_at }[]` 0600.
- `listArtifacts(controlDir, …)` returns `{ artifacts, rev }`; the artifact watcher broadcasts `artifact` with the projected list.
- The Claude tab (`views/claude.js`) selects a session with `select(s)`; the hash router reads only the first segment, so `#/claude/<id>` can open a session directly.

## File Structure

- Create `src/control-ui/api/artifact-creations.ts` (+ test): `createCreations(file)` with `list()`, `add({ id, title, kind })`, `prune({ listedIds, registry, now })`; `creationPrompt({ title, kind, description })` (pure, tested for exact text).
- Modify `src/control-ui/server.ts`: extract the start-session body into `startDashboardSession(ctx, name, prompt)` used by both routes; add `POST /api/v1/artifacts/create`; extend `GET /api/v1/artifacts` with `creating`; the artifact watcher's broadcast also carries `creating`.
- Modify `web/control/views/artifacts.js`: **Create artifact** form and the "Creating" section; `web/control/views/claude.js`: open `#/claude/<id>`; `web/control/app.css`; `sw.js` v19.
- Tests: route tests for create (validation, read-only, limiter shared, record written, `creating` in the list, pruning), unit tests for the prompt and the records file.

---

### Task 1: Records and prompt

```ts
export interface Creation { id: string; title: string; kind: ArtifactKind; started_at: number }
export function createCreations(file: string): { list(): Creation[]; add(c: Creation): boolean; prune(o: { listedIds: Set<string>; registryTitles: { title: string; added_at: number }[]; now: number }): Creation[] }
export function creationPrompt(o: { title: string; kind: ArtifactKind; description: string }): string;
```

The prompt (exact):

```
The operator asked for a new artifact from the dashboard.

Title: <title>
Kind: <kind>
What it should be:
<description>

Build it and publish it privately with the Artifact tool (load the artifact-design skill first). If a decision is needed from the operator, ask before publishing.

When it is published, register it right away — the operator already approved this from the dashboard, so do not ask again:
node scripts/artifact-registry.mjs add --title "<title>" --url <the artifact url> --kind <kind> --description "<one line about it>"

Then reply with the link.
```

- [ ] Test: the prompt text is exactly as above for a sample input.
- [ ] Test: add/list round-trip and the cap of 20.
- [ ] Test: prune drops an unlisted session.
- [ ] Test: prune drops a record whose title was registered after it started, keeps one registered before.
- [ ] Test: prune drops a record older than 24 h.
- [ ] Test: a corrupt file reads as empty and is left alone until a later add.
- [ ] Implement until green.

### Task 2: Routes

- `startDashboardSession(ctx, name, prompt)` is the existing route body from the ledger read to the ledger write, returning `{ id, row } | null` (it has already answered on failure). `POST /api/v1/claude/sessions` calls it; behaviour unchanged.
- `POST /api/v1/artifacts/create` `{ title, kind, description }`: read-only → 403; validation → 400 (title by `CLAUDE_NAME_RE`, kind in `ARTIFACT_KINDS`, description as above); same title still live → 409; `X-Confirm: create`; then `startDashboardSession` with `name = title`; on success record the creation, audit `control_ui_artifact_create` (title, id, promptHash), broadcast `artifact`, answer `{ id }`.
- `GET /api/v1/artifacts` → `{ artifacts, rev, creating: [{ id, title, kind, started_at, state, status }] }`, `creating` pruned on every read with `claudeList(false)`.
- [ ] Route tests: happy path writes the record and starts with the exact prompt (fake CLI captures argv); bad title/description → 400 (`Q3: Sales (v2)`, a 5-character description, control characters); same live title → 409; missing confirm → 428; read-only → 403; `creating` appears, then disappears once a registry entry with that title is added later.
- [ ] Implement until green; the existing start-session tests still pass.

### Task 3: The tab

Taste pass: the "Creating" card reuses the running-session treatment the operator already saw and approved on the Claude tab today (orange dot + turning ✻ + tinted card), and the form is the existing Add-artifact form with one more field; no new visual language is introduced, so throwaway variants are skipped. The copy is reviewed by copy-writer in the whole-app pass (task #32).

- **Create artifact** (primary) beside **Add artifact** (now secondary, "Add a link"). The form: Title, Kind, "What should it be?" (textarea, 6 rows, counter to 2000), a hint "A Claude session builds and publishes it, then it appears here. You can watch it on the Claude tab.", **Create** with typed-less confirmation (the button is the action, like New session).
- A "Creating" section at the top when any exist: cards with a spinner, the title, the state (working / needs you / done), "started 3 min ago", and **Open session** → `#/claude/<id>`. A `done` session without a registry entry shows "Finished without registering — open the session to see why."
- `claude.js`: on render, if the hash names a session id that is listed, select it (after `load()`).
- [ ] Drive on the fixture (fake CLI): create → session started with the expected prompt, card appears with the state, Open session lands on the Claude tab with that session selected; adding a registry entry with the title removes the card and shows the artifact card; 390 px no overflow.

### Task 4: Verification and deploy

- Gates: build, vitest (control-ui + scripts), eslint/prettier, screenshot script (artifacts, claude), code-reviewer + ai-eng-warden (the prompt), verification.
- Record in `docs/control-ui-notes.md`; merge; restart once.
- Then one real run: create a small throwaway artifact from the live dashboard is the operator's to do (I don't hold the password); I'll ask for it and check the session and registry afterwards.

## Out of scope

- Editing or re-publishing an existing artifact from the tab.
- Uploading files as inputs.
