# Agents Tab: Viewer and "Add agent" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agents easy to read and easy to add.
- Clicking an agent opens a panel with its full description, settings and instructions, rendered as formatted text.
- An **Add agent** button opens the Claude tab's New session form with an agent-creation prompt already written; the operator adds what the agent should do and presses Start.

**Architecture:** One new read route, `GET /api/v1/agents/:name`, returns one agent's frontmatter fields plus its body. It is confined to `<repoRoot>/.claude/agents`, size-capped and redacted. The viewer draws the body with the existing `markdown.js` (text only, no HTML). "Add agent" writes a draft to `sessionStorage` and routes to `#/claude`. The Claude tab opens its New session form with that draft once, then removes it.

**Tech Stack:** Node/TypeScript server, vanilla ES modules, vitest.

**Spec:** the operator's requests:
- "Agents tab create an add Agent tab… you will have a prompt ready for creating an agent, you just have to add the description."
- "create a better way to review and see the agent description/md file."
- Decision 2026-09-26: Add agent opens the **Claude tab**, because only a Claude session can write `.claude/agents/`; Amos in Chat runs sandboxed.

## Global Constraints

- The security brief applies: nothing that renders keys or tokens, since every string is redacted server-side and drawn as text.
- There is no new write route. The agent file is written by the Claude session the operator starts, in auto mode like every dashboard session. The dashboard itself never writes agent files.
- The route refuses anything that is not `^[a-z0-9][a-z0-9-]{0,63}$`:
  - The file must be a regular file (lstat, no symlinks) directly inside the agents folder after realpath.
  - The body is capped at 128 KiB; larger files return the first 128 KiB with `truncated: true`.
- Read-only mode may read agents (it already can list them) but gets no Add agent button.

## Verified facts

- `listAgents(agentsDir)` and `parseFrontmatter()` live in `src/control-ui/api/agents.ts`; `agentsDir = <repoRoot>/.claude/agents` (`server.ts:563`). There are 27 agent files today.
- The Claude tab's New session form (`web/control/views/claude.js`: `form`, `nameInput`, `promptInput`) starts sessions with `POST /api/v1/claude/sessions` and `X-Confirm: start`. The name must match `CLAUDE_NAME_RE` (letters, digits, space, `._-`, at most 60 characters). The prompt is at most `PROMPT_MAX` = 8192.
- `redactSecrets` is in `src/control-ui/api/logs.ts`.

---

### Task 1: One agent's file

**Files:** Modify `src/control-ui/api/agents.ts` and `src/control-ui/server.ts`; add tests to `src/control-ui/api/agents.test.ts` (create it if missing) and to the server route tests.

```ts
export interface AgentDetail extends AgentInfo { body: string; truncated: boolean }
export function readAgent(agentsDir: string, name: string): AgentDetail | null;
```

- It finds the file whose frontmatter `name` equals `name`, which may differ from the file name. It uses the same scan as `listAgents`, then applies the guards from Global Constraints.
- `body` is the text after the frontmatter, passed through `redactSecrets`.
- The route is `GET /api/v1/agents/:name`: 404 when not found, 200 with `AgentDetail` otherwise. It shares the existing read limits (no new limiter; this is a small file read).

- [ ] Tests:
  - A normal agent returns its body without the frontmatter.
  - An unknown name gives null.
  - A bad name (`../x`) gives null.
  - A symlink inside the folder pointing outside gives null.
  - A 200 KiB body is cut at 128 KiB with `truncated`.
  - A fake key in the body is redacted.
  - The route gives 404/200.
- [ ] Implement until all pass.

### Task 2: The viewer

**Files:** Modify `web/control/views/agents.js` and `web/control/app.css`.

- Cards become buttons (whole card, keyboard reachable). Opening one fetches the agent and shows a panel:
  - The name as title.
  - Badges: model, `v<version>`, "explores code".
  - Tools as chips.
  - The full description as a paragraph.
  - A divider, then the body rendered with `renderBlocks(parseMarkdown(body), h)`.
  - "File: `.claude/agents/<file>`" in muted text, a **Close** button, and Esc closes.
- Desktop (≥ 900 px): the panel sits beside the grid; the grid narrows to fit.
- Phone: the panel is a full-screen sheet with a back button.
- The URL keeps the open agent (`#/agents?name=<name>`), so a reload or a shared link reopens it.
- The search filter stays and also matches tools.

- [ ] Build, then drive it at 1440 and 390 px:
  - Open code-reviewer.
  - Its instructions render with headings and lists.
  - Esc and Close work.
  - A reload with `?name=` reopens it.
  - No sideways scroll.

### Task 3: Add agent

**Files:** Modify `web/control/views/agents.js` and `web/control/views/claude.js`.

- The Agents header gets **Add agent** (hidden in read-only mode). Clicking it stores `{ name: 'New agent', prompt: TEMPLATE }` in `sessionStorage['claude.draft']` (in try/catch) and routes to `#/claude`.
- `TEMPLATE` (under 1 KiB) reads:

  > Create a new Claude Code subagent for this repo as a file in .claude/agents/. Follow the format of the agents already there: frontmatter with name, description (when to use it, with one or two examples), tools and model; then clear instructions. Pick a short kebab-case name. Before writing, tell me the name and a one-paragraph summary and wait for my OK. What the agent should do:

  It is followed by a blank line where the cursor lands.
- `claude.js` on render: if `sessionStorage['claude.draft']` holds a valid draft (string name ≤ 60, prompt ≤ 8192), it:
  - removes it;
  - opens the New session form and fills both fields;
  - focuses the prompt with the cursor at the end.

  An invalid or missing draft does nothing.

- [ ] Drive it:
  - Add agent lands on the Claude tab with the form open and filled, cursor at the end.
  - Going back to Agents and to Claude again shows the form closed (the draft is used once).

### Task 4: Verification and deploy

- Gates:
  1. `npm run build`.
  2. `npx vitest run` over control-ui and scripts tests.
  3. eslint and prettier.
  4. The screenshot script (agents, claude) at 3 viewports.
  5. code-reviewer, then verification.
- Record the results in `docs/control-ui-notes.md` with screenshots of the viewer (these show agent files from the repo, not personal content).
- Merge, rebuild, restart once (new route).

## Out of scope

- Editing agent files from the dashboard.
- Deleting agents.
- Wardens (they have their own tab).
