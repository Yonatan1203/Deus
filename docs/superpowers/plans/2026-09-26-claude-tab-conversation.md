# Claude Tab Conversation View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Claude tab shows the open session in the Claude-app style (approved mockup, 2026-09-26). It reads the session's own transcript and is driven by the same live terminal session. The raw terminal stays one click away.

**Architecture:** The live view (`claude attach` in the dashboard's private tmux) stays exactly as it is and remains the only way input reaches a session. A new read route, keyed by the live view id, returns the session's transcript shaped into conversation items. The browser polls it while the Conversation mode is showing. The message box, model picker, effort picker and interrupt button all send keystrokes through the existing live input route. A second new read route lists the slash commands for the `/` menu.

**Tech Stack:** Node/TypeScript server (`src/control-ui`), vanilla ES modules (`web/control`), vitest.

**Spec:** the operator's request in this session: the Claude tab should look like the Claude app but keep the terminal's function. The mockup is at `docs/control-ui/artifacts/claude-conversation-mockup.png`, with sample content only.

## Global Constraints

- The security brief still applies. Nothing that renders keys, tokens or channel auth state. Every transcript string passes through `redactSecrets` on the server. Every string is rendered as text through `h()`, never as markup.
- CSP stays unchanged: `style-src 'self'`, no CDN and no inline script.
- Input reaches a session only through `POST /api/v1/claude/live/:vid/input`, the existing owner-checked route with its existing limits. No new write route.
- There is no typed confirmation for typing into a session (the operator's decision). Stop keeps its confirmation.
- Read-only mode gets no live view, so it gets no conversation either, the same as today.
- Links rendered from a transcript are `https:`/`http:` only and open with `noopener,noreferrer`. Artifact cards link only to `https://claude.ai/...` URLs.
- Real session names and contents are never committed. Screenshots use throwaway sessions.
- Cross-platform: file reads use `path`/`os`, no shell.

## Verified facts this plan relies on

- The transcript is at `<claudeProjectsDir>/<dir>/<session_id>.jsonl`, found by `transcriptPath()` (`src/control-ui/api/claude-sessions.ts:196`). `readTail()` (`:167`) reads its tail.
- Record kinds seen in real transcripts:
  - `assistant` with `text`, `thinking` and `tool_use` blocks.
  - `user` with a string, `text` blocks or `tool_result` blocks.
  - `isMeta` user records: skill bodies, hand-backs and image notes.
  - Strings starting with `<command-message>`/`<command-name>`, `<local-command-stdout>` or `<task-notification>`.
  - The "This session is being continued…" summary.
- Claude Code 2.1.283 has the `/model` command (aliases `opus`, `sonnet`, `haiku`, `fable`) and the `/effort` command (levels `low`, `medium`, `high`, `xhigh`, `max`). It also has `/compact`, `/clear` and `/context`, all confirmed as `name:"…"` entries in the binary.
- `claudeRow()` runs the CLI on every call (`server.ts:1473`, `claudeList(true)`). `claudeList(false)` is cached for `CLAUDE_POLL_MS`. The conversation route uses the cached list only.

## File Structure

- Create `src/control-ui/api/claude-conversation.ts`: transcript rows become conversation items. Pure and tested.
- Create `src/control-ui/api/claude-commands.ts`: reads the slash command list (name + one-line description). Tested with a temp dir.
- Modify `src/control-ui/api/claude-live.ts`: add one accessor, `meta(vid): { owner: string; claudeId: string } | null`, read straight off the existing `views` map (null when the view is missing or closed). No second registry.
- Modify `src/control-ui/server.ts`: two GET routes.
- Create `web/control/markdown.js`: a small safe markdown parser. It produces blocks that are rendered with `h()`. Pure parser, tested.
- Create `web/control/conversation.js`: groups tool items ("Ran 2 commands, edited 1 file") and renders items. `groupItems` is pure and tested.
- Modify `web/control/views/claude.js`: the Conversation | Terminal switch, the conversation pane, the message box, the pickers, the interrupt button and the waiting banner.
- Modify `web/control/app.css`, `web/control/sw.js` (cache v15, new files in SHELL) and `scripts/control-ui-screenshot.mjs` (waits for the conversation).
- Tests:
  - `src/control-ui/api/claude-conversation.test.ts`
  - `src/control-ui/api/claude-commands.test.ts`
  - Server route tests in `src/control-ui/server.test.ts` (or its live-route test file, following the existing live tests).
  - `scripts/tests/control-ui-markdown.test.ts`
  - `scripts/tests/control-ui-conversation.test.ts`

---

### Task 1: Transcript → conversation items

**Files:** Create `src/control-ui/api/claude-conversation.ts` and its test.

**Interfaces (produces):**

```ts
export type ConvItem =
  | { k: 'user'; text: string }
  | { k: 'assistant'; text: string }
  | { k: 'tool'; tool: string; summary: string; file?: string; added?: number; removed?: number; url?: string }
  | { k: 'ask'; question: string; options: string[]; answered: boolean }
  | { k: 'command'; name: string; args: string; output?: string }
  | { k: 'note'; text: string }; // "Continued from an earlier conversation", "Interrupted", "Image"
export interface Conversation { items: ConvItem[]; truncated: boolean; model: string | null; effort: string | null }
export function buildConversation(rows: Record<string, unknown>[], limit?: number): Conversation; // default limit 300
export function createConversationReader(projectsDir: string): (sessionId: string) => { version: string; conv: Conversation } | null;
```

Rules (each one gets a test):

1. Skip `isSidechain` and `isMeta` records, `thinking` blocks, `tool_result` blocks, and strings that start with `<system-reminder>` or `<task-notification>`.
2. For user strings and user text blocks:
   - `<command-name>/x</command-name>` (with optional `<command-args>`) becomes `command`.
   - `<local-command-stdout>…` attaches `output` (first 300 characters, tags stripped) to the previous `command`. If there is no previous command, it becomes a `note`.
   - "This session is being continued…" becomes `note: 'Continued from an earlier conversation'`.
   - `[Request interrupted by user…` becomes `note: 'Interrupted'`.
   - An `image` block becomes `note: 'Image'`.
   - Anything else becomes `user`.
3. A `tool_use` becomes `tool` with `summary` from the first string of `description`, `command`, `file_path`, `pattern`, `url` or `prompt` (120 characters).
   - `Edit`: `file` = basename; `added` and `removed` = the line counts of `new_string` and `old_string`.
   - `MultiEdit`: the same, summed over `edits`.
   - `Write`: `added` = the line count of `content`, `removed` = 0.
   - `Artifact`: `url` = the first `https://claude.ai/…artifact…` URL found in the matching `tool_result` (matched by `tool_use_id`), if any.
4. An `AskUserQuestion` tool_use becomes `ask`, with the first question's text and its option labels (max 6, 80 characters each). It is `answered` when a `tool_result` with its id exists.
5. `model` is the last assistant `message.model`. `effort` is the level from the last "Set effort level to X" in a local-command output, matched against the five known levels. Otherwise it is null.
6. Every string passes through `redactSecrets`. User and assistant text is capped at 20,000 characters. Items are capped at `limit` (keep the newest); `truncated` is true when either the read or the cap cut anything.
7. `TAIL_TRANSCRIPT_BYTES = 8 * 1024 * 1024` (Deviation: 2 MiB held only ~5 replies of a real session; 8 MiB ~30, 49 ms parse, memoized) and the memo live in `claude-conversation.ts` (`claude-sessions.ts` is untouched apart from its existing exports being imported). The reader reads the tail through `readTail(file, TAIL_TRANSCRIPT_BYTES)`. It memoizes on `mtimeMs:size`, which is also the returned `version`, and keeps at most 20 memo entries.

- [ ] Write the tests: a synthetic JSONL fixture built in the test that covers every rule, plus redaction of a fake `sk-ant-…` key. Run them and see them fail.
- [ ] Implement it and run the tests until they pass.

### Task 2: Slash command list

**Files:** Create `src/control-ui/api/claude-commands.ts` and its test.

```ts
export interface SlashCommand { name: string; description: string; source: 'built-in' | 'project' | 'personal' }
export function readSlashCommands(repoRoot: string, homeDir: string): SlashCommand[];
```

- Sources, in precedence order (first one wins on a name clash):
  1. `<repoRoot>/.claude/skills/*/SKILL.md` and `<repoRoot>/.claude/commands/*.md` (project).
  2. `<homeDir>/.claude/skills/*/SKILL.md` and `<homeDir>/.claude/commands/*.md` (personal).
  3. The built-ins `model`, `effort`, `compact`, `clear` and `context`, with fixed descriptions.
- The name comes from the frontmatter `name:` (or the directory or file name). The description is the first line of the frontmatter `description:`, capped at 160 characters and redacted.
- Skip entries whose frontmatter has `user-invocable: false`, entries whose name fails `^[a-z0-9][a-z0-9:_-]{0,63}$`, symlinks that resolve outside their source dir, and files over 64 KiB. Cap the list at 300 entries, sorted by name.
- Memoized for 60 s.

- [ ] Tests (a temp dir with each case), then the implementation. All green.

### Task 3: Server routes

**Files:** Modify `src/control-ui/server.ts` and add route tests.

- `liveViews.meta(vid)` (new accessor, with a unit test in `claude-live.test.ts`: returns owner and claudeId for an open view, and null after `closeOwned`, `closeOwner`, `closeAll` or for an unknown vid) is the only source of a view's owner and session job id. There is no bookkeeping in `server.ts`.
- `GET /api/v1/claude/live/:vid/conversation?v=<version>`:
  - `liveGate`.
  - `const m = liveViews.meta(vid)`; `m` must be non-null with `m.owner === ctx.session.id`. Otherwise 404.
  - Its own limiter: 120 per minute per login, else 429.
  - Resolve `m.claudeId` to its transcript session id through `claudeList(false)` (cached, no CLI call on every poll), so a `/clear` that starts a new transcript is followed. If the row is gone: 404.
  - If `v` equals the current version, answer `{ unchanged: true, version }`.
  - Otherwise answer `{ version, items, truncated, model, effort }`.
  - `auditRead(..., 'claude-conversation:<claudeId>', 'control_ui_claude_read')` once per vid, not on every poll.
- `GET /api/v1/claude/commands`: `claudeRead` limiter, not in read-only mode, answers `{ commands }`.
- Tests:
  - Another login's vid gives 404.
  - An unknown vid gives 404.
  - An unchanged version gives `unchanged`.
  - The limiter gives 429.
  - Read-only gives 403 or no route.
  - Commands happy path.
  - Use a fake `liveViews` object with `meta`/`has`/`open` stubs, following the existing live-route tests.

- [ ] Tests first, then the routes. `npm run build` and `npx vitest run src/control-ui` pass.

### Task 4: Markdown and grouping (browser, pure)

**Files:** Create `web/control/markdown.js` and `web/control/conversation.js`, plus their tests.

- `parseMarkdown(text) → Block[]`. Blocks:
  - `p`, `h` (levels 1–3), `ul`/`ol` (flat items), `code` (fenced, with `lang`), `quote`, `hr`.
  - Inline: `text`, `strong`, `em`, `code`, `link` (http/https only; anything else stays text).
  - A table becomes a `code` block, so it keeps its alignment.
- `renderBlocks(blocks, h)` builds DOM with `h()` only.
- `groupItems(items)` folds consecutive `tool` items into `{ k: 'tools', label, calls, files, artifacts }`. The label is "Ran N commands, read N files, edited N files, searched N times", with plurals right and zero parts dropped. Artifacts and file changes stay visible outside the fold.
- `renderConversation(el, items, handlers)` redraws the list.
- Tests:
  - A `javascript:` link stays text.
  - An unclosed fence stays one code block.
  - Nested markers.
  - Group labels for 1 and many.
  - Artifacts pulled out of the fold.

- [ ] Tests first, then the implementation. All green.

### Task 5: Claude tab UI

**Files:** Modify `web/control/views/claude.js` and `web/control/app.css`.

- The top bar gets a segmented control, **Conversation | Terminal**. The choice is remembered in `localStorage` (inside try/catch). Conversation is the default.
- The live view opens as today in both modes.
  - In Conversation mode the terminal host is hidden, and the ResizeObserver skips `fit()`/resize while the host has zero size.
  - Switching to Terminal runs `fit()` and sends the size.
- The conversation pane:
  - Polls `/live/:vid/conversation?v=` every 1.5 s while Conversation is showing and the page is visible, and pauses otherwise.
  - Redraws only on a new version.
  - Stays pinned to the bottom unless the user has scrolled up.
  - Shows "Earlier messages are in the Terminal view" when `truncated`.
- The message box is a textarea that grows to 8 lines. Enter sends and Shift+Enter makes a new line.
  - Before sending, the text is stripped of C0 controls except `\n`/`\t`, and of DEL.
  - A single line is sent as its bytes, followed by `\r`.
  - Several lines are sent as bracketed paste (`ESC[200~ … ESC[201~`) followed by `\r`.
  - After sending, the box clears.
- The `/` menu opens when the box starts with `/`. It filters `GET /api/v1/claude/commands` by prefix. Arrow keys and Enter pick a command, which inserts `/name `. A recognised command at the start of the box shows as an orange token above it ("marked when typed").
- The footer shows "Auto mode", a model menu (Opus, Sonnet, Haiku, Fable → sends `/model <alias>` + `\r`) and an effort menu (Low … Max → sends `/effort <level>` + `\r`). The current values come from the conversation response. Both menus are disabled while the session is `working`, with the title "Wait until Claude finishes".
- While the session is `working`, the send button becomes a square **Stop** that sends `ESC` (interrupt, the same key as in the terminal). Clicking it needs no confirmation.
- When the session is `needs you`, a banner above the box says "Claude is waiting for you in the terminal" and has an **Open terminal** button.
- An unanswered `ask` item renders as a card with the question and its options as read-only chips, plus **Answer in terminal**. Buttons that answer directly are a follow-up, built only if a real test shows which keys pick an option.
- On phones, Conversation is full height with the box at the bottom. The key bar shows only in Terminal mode.
- Every string is rendered through `h()`. The icons come from `icons.js`.

Checkpoints. Each one is driven on the fixture server against a throwaway session before the next one starts:

- [ ] **5a: Mode switch and conversation pane.** Conversation | Terminal, the hidden-terminal resize guard, polling, rendering and bottom pinning. Check: the first message appears; switching both ways keeps the terminal size right.
- [ ] **5b: Message box and send.** Stripping, single-line vs bracketed paste, Stop (ESC) while working, and the waiting banner. Check: a typed message shows in both views; Stop interrupts a long reply.
- [ ] **5c: `/` menu and command token.** Check: `/ef` filters to effort; Enter inserts `/effort `; the token shows.
- [ ] **5d: Model and effort pickers, ask card, mobile layout.** Check: the effort picker shows High after `/effort high`; the model picker switches the model and the next reply's model matches; 390 px has no overflow.

### Task 6: Wiring, docs, verification

- `sw.js` gets cache `deus-control-v15`, with `markdown.js` and `conversation.js` added to SHELL.
- The screenshot script's Claude step waits for `.conv-list`.
- `docs/control-ui-notes.md` gets a verification record.
- Commit the mockup PNG, with sample content only, to `docs/control-ui/artifacts/`.
- Full gates:
  1. `npm run build`.
  2. `npx vitest run` over control-ui and the scripts tests.
  3. eslint and prettier.
  4. The screenshot script at all 3 viewports.
  5. code-reviewer, then verification.
- Then commit, merge to the live checkout and verify it is served. Only static files and server routes change, so the service restarts once for the new routes.

## Out of scope

- Answering `AskUserQuestion` by button, before its keys are verified.
- A WebSocket transport.
- Finger-drag scrolling (#27).
- The Chat tab (#28).
