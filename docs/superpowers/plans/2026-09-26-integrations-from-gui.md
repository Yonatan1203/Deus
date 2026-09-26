# Integrations From the GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the MCPs tab and the Channels tab, the operator can pick an integration from a catalogue and set it up with one click. Setting up means a Claude session runs the repo's own `/add-<name>` skill, in the repo, guided, with the operator watching and answering on the Claude tab. Tasks #21 (MCPs from the GUI) and #22 (channels from the GUI).

**Architecture:** No new capability on the host. The catalogue is read from `.claude/skills/add-*/SKILL.md` frontmatter (name, description) plus a fixed table that says what kind each one is (channel, mcp, tool, backend, other) and which env keys signal "configured". **Set up** calls `POST /api/v1/integrations/:name/setup`, which starts a session through `startDashboardSession` (the shared path New session and Create artifact use: limiter, live cap, ledger, audit) with the prompt `/add-<name>` followed by a fixed note, then the tab opens that session on the Claude tab (`#/claude/<id>`). Secrets never pass through the dashboard or the session: the prompt tells the session to name the key and the file and to ask the operator to add it to `.env` themselves, then to confirm it is set without printing it. The dashboard's Config route keeps excluding secret keys.

**Tech Stack:** Node/TypeScript server, vanilla ES modules, vitest.

**Spec:** the operator's requests: "add MCPs from the GUI", "add channels from the GUI". Feasibility verified 2026-09-26: a background session started with a leading `/debug` line expanded the skill (`<command-name>/debug</command-name>` in the transcript, the skill body loaded as a meta message, the answer came from it).

## Global Constraints

- Security brief: nothing renders keys or tokens; the catalogue shows only key *names* ("needs TELEGRAM_BOT_TOKEN") and whether they are set (`envHas`), never values, and hides even that in read-only mode (the Config route shows read-only viewers only a count). No new write to `.env` from the dashboard. The rule is carried by the skills themselves, not only by the note: every credential-needing `add-*` skill has a "Started from the dashboard?" section that overrides its own collect-the-token step (a note alone could lose to the skill's specific, tool-backed step, which loads after it). The session is also told never to ask for a token value in the conversation: a pasted value would land in the transcript, the conversation view and the model provider, and `redactSecrets` does not know every token shape.
- The session is started exactly like New session (auto mode, repo cwd); the skill's own steps (installs, edits, restarts) are what the operator would run by hand from a terminal. The prompt says the operator started it from the dashboard and asks the session to explain each step, to ask before anything irreversible (deleting files, replacing a channel), and to make any service restart the last step, after its summary, with a warning that the dashboard disconnects briefly.
- Read-only mode: the catalogue is visible, **Set up** is hidden and the route answers 403.
- Name allow-list: `^add-[a-z0-9-]{1,40}$`, must exist in the catalogue; deprecated skills (description starting with `[DEPRECATED]`) are listed nowhere.
- One setup at a time, across all integrations: the skills edit the same files (`package.json`, the lockfile, the channel barrel, `.env`) and may restart the service. Setups are recorded in `integration-setups.json` (same shape and guards as `artifact-creations.json`); while any recorded setup's session is still working (fresh `claudeList(true)`, not the cache) → 409 `{ error: 'another setup is running', id }`.
- Setups run in the deployed checkout, like every dashboard-started session; the skills are written for that (they install and restart the running instance).
- "Ask before anything irreversible" is an instruction under auto mode, the same trust level as New session; the plan does not claim it is enforced.
- Skill resolution: checked on this host — no personal (`~/.claude/skills`, `~/.claude/commands`) or plugin skill is named `add-*`, so `/add-<name>` resolves to the repo's own `SKILL.md`. The route re-checks at request time: if a personal or plugin `add-<name>` exists, it refuses with 409 `{ error: 'a personal skill shadows this one' }`.

## Verified facts

- `readSkillDir(dir, source)` (`api/claude-commands.ts`) reads `SKILL.md` frontmatter with realpath/size/name guards and no built-ins; `.claude/skills` holds 27 `add-*` skills, one deprecated (`add-claude-context`) and one without a SKILL.md (`add-guardrails`, skipped by the reader).
- `startDashboardSession(ctx, name, prompt)` (`server.ts`) returns `{ id }` or answers the response itself; `CLAUDE_NAME_RE` allows `Add Telegram`.
- `listMcps` (`api/mcps.ts`) has `CHANNEL_CONFIGURED` for the channel packages; `GET /api/v1/channels` lists live channels. The MCPs tab is three tables (`views/mcps.js`, 31 lines); the Channels tab is cards (`views/channels.js`).
- `#/claude/<id>` opens a session on the Claude tab (shipped with Create artifact).

## File Structure

- Create `src/control-ui/api/integrations.ts` (+ test): it calls `readSkillDir(path.join(repoRoot, '.claude', 'skills'), 'project')` (no second frontmatter parser) and keeps only `add-*` names whose description does not start with `[DEPRECATED]`; `KINDS` table (name → kind, title, needs), `listIntegrations(repoRoot, envHas)` → `{ name, title, kind, description, needs: string[], configured: boolean | null }[]`, `setupPrompt(name, kind)`.
- Create `src/control-ui/api/integration-setups.ts` (+ test): the setups record file (`{ id, name, started_at }[]`, cap 20, 0600, atomic, prune unlisted/24 h) — a small sibling of `artifact-creations.ts`.
- Modify `src/control-ui/server.ts`: `GET /api/v1/integrations` and `POST /api/v1/integrations/:name/setup`.
- Create `web/control/integrations.js` (the catalogue panel, shared by both tabs); modify `web/control/views/mcps.js` and `web/control/views/channels.js` (an **Add…** action that toggles the catalogue); `web/control/app.css`; `web/control/sw.js` (v21, add `integrations.js`).
- Tests: `src/control-ui/api/integrations.test.ts`; route tests in `server.test.ts`.

---

### Task 1: Catalogue and prompt

```ts
export type IntegrationKind = 'channel' | 'mcp' | 'tool' | 'backend' | 'other';
export interface Integration { name: string; title: string; kind: IntegrationKind; description: string; needs: string[]; configured: boolean | null }
export function listIntegrations(repoRoot: string, envHas: (k: string) => boolean): Integration[];
export function setupPrompt(name: string, kind: IntegrationKind): string;
```

`KINDS` (fixed, in code):

| name | kind | title | needs |
|---|---|---|---|
| add-whatsapp | channel | WhatsApp | — (pairing) |
| add-telegram | channel | Telegram | TELEGRAM_BOT_TOKEN |
| add-telegram-swarm | channel | Telegram agent swarm | TELEGRAM_BOT_TOKEN |
| add-discord | channel | Discord | DISCORD_BOT_TOKEN |
| add-slack | channel | Slack | SLACK_BOT_TOKEN, SLACK_APP_TOKEN |
| add-msft-teams | channel | Microsoft Teams | TEAMS_APP_ID |
| add-linear | mcp | Linear | LINEAR_API_KEY |
| add-asana | mcp | Asana | ASANA_ACCESS_TOKEN |
| add-parallel | mcp | Parallel AI research | PARALLEL_API_KEY |
| add-youtube-transcript | mcp | YouTube transcripts | — |
| add-ollama-tool | mcp | Ollama (local models) | — |
| add-gcal | tool | Google Calendar | — (OAuth) |
| add-gmail | tool | Gmail | — (OAuth) |
| add-outlook | tool | Outlook | — (OAuth) |
| add-image-vision | tool | Image vision | — |
| add-pdf-reader | tool | PDF reading | — |
| add-voice-transcription | tool | Voice transcription | OPENAI_API_KEY |
| add-reactions | tool | WhatsApp reactions | — |
| add-codex | backend | OpenAI / Codex backend | OPENAI_API_KEY |
| add-connector | backend | Model connector | — |
| add-llama-cpp | backend | llama.cpp (local) | — |
| everything else | other | the name without `add-`, words capitalised | — |

`configured` = every key in `needs` is set (`envHas`), or null when `needs` is empty.

The prompt (exact; `<tab>` is `Channels` for kind channel, otherwise `MCPs`):

```
/add-<name>
The operator started this from the dashboard's <tab> tab. Walk them through the skill's steps here, one at a time, and say what each step changes. Ask before anything irreversible: replacing a channel or deleting files. If a token or key is needed, do not ask for its value here: name the key and the file (.env in this repo), ask the operator to add it themselves, then confirm it is set without printing it (for example grep -c '^KEY=' .env). If the service must be restarted, make that the very last step, after your summary, and say that the dashboard will disconnect for a moment. When done, say what changed.
```

- [ ] Test: catalogue from a temp skills dir — a channel, an mcp, an unknown `add-foo` → other with title "Foo", a deprecated one skipped, a folder without SKILL.md skipped.
- [ ] Test: `configured` true / false / null from `envHas`.
- [ ] Test: `setupPrompt('add-telegram', 'channel')` exact text with "Channels"; an mcp says "MCPs".
- [ ] Implement until green.

### Task 2: Routes

- `GET /api/v1/integrations` → `{ integrations }` (no limiter, a small local read like `GET /api/v1/mcps`).
- `POST /api/v1/integrations/:name/setup`: read-only 403 (the dispatcher's mutation check and the route's own check both hold); `X-Confirm: setup` else 428; name must match `^add-[a-z0-9-]{1,40}$` and exist in the catalogue else 404; a personal/plugin skill of the same name → 409; any recorded setup whose session is still working in a fresh `claudeList(true)` → 409 `{ error: 'another setup is running', id, name }`; `startDashboardSession(ctx, \`Add ${title}\`, setupPrompt(name, kind))`; record `{ id, name, started_at }`; audit `control_ui_integration_setup` (name, id); answer `{ id }`.
- [ ] Route test: list — deprecated absent; `configured` follows `envHas`.
- [ ] Route test: setup happy path — fake CLI argv has `--name=Add Telegram` and a prompt starting with `/add-telegram\n`; then `{ id }`.
- [ ] Route tests: 404 for `add-nope` and `..%2Fx`; 428 without confirm; 403 read-only (both the dispatcher's check and the route's); 409 while a recorded setup's session is working, even for a different integration; 409 when a personal `add-<name>` skill exists in the test home dir.
- [ ] Implement until green.

### Task 3: The tabs

- `web/control/integrations.js`: `catalogue(api, { kinds, readOnly })` returns a panel: a filter box and rows (the operator picked rows over cards, 2026-09-26): a two-letter mark, title, one-line description, kind chip, "needs KEY" chips coloured set / not set and a "configured" chip when known — omitted entirely in read-only mode), **Set up** (hidden read-only) → `POST …/setup` with `X-Confirm: setup` → toast "Setting up <title> — follow along on the Claude tab." → `location.hash = '#/claude/<id>'`; 409 → toast naming what is running ("<title> is already being set up — it's on the Claude tab.", or "Another setup is running (<title>) — finish it first.") and open that session's `id` on the Claude tab.
- MCPs tab: header action **Add MCP or tool** toggles the catalogue (kinds mcp, tool, backend) above the tables.
- Channels tab: header action **Add channel** toggles the catalogue (kind channel) above the cards.
- [ ] Build the panel and both toggles.
- [ ] Drive on the fake-claude fixture: open each catalogue, filter, Set up Telegram → a session `Add Telegram` appears in the fake state with the `/add-telegram` prompt, the page lands on the Claude tab with it selected; a second Set up → the 409 toast; 390 px no overflow; screenshots at 1440 and 390 for both tabs go to `docs/control-ui/artifacts/`.

### Task 4: Verification and deploy

- Gates: build, vitest (control-ui + scripts), eslint/prettier, screenshot script (mcps, channels) at 3 viewports, code-reviewer + ai-eng-warden (the prompt), verification; record in `docs/control-ui-notes.md`; merge; restart once.
- A real run is the operator's (they pick what to add); the dashboard side is verified end to end on the fixture.

## Out of scope

- Writing secrets from the dashboard (the Config route keeps excluding them; the session asks for them).
- Removing or disabling an integration from the GUI.
- Running a skill without the operator: the skills are interactive by design.
