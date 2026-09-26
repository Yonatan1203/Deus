# Whole-App Quality Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every finding from the 2026-09-26 UX audit (ux-reviewer) and copy audit (copy-writer) of the dashboard, add compression and validation caching to the static server, and give the Claude terminal finger-drag scrolling on phones — so the app reads as one finished product.

**Delivery:** three separate commits on `control-ui`, each with its own code review and verification, so each can be reverted alone: (1) copy + UX fixes (Tasks 1–2), (2) static compression (Task 3), (3) finger-drag scrolling (Task 4).

**Architecture:** Web-only fixes in `web/control/*` plus one server change in `src/control-ui/static.ts` (gzip + ETag). No new routes, no schema changes, no behaviour changes beyond the ones listed. Every user-visible string that comes from the server passes through a small map to a plain sentence; nothing raw is shown.

**Tech Stack:** vanilla ES modules, Node/TypeScript static server, vitest, Playwright drives on the fixtures.

**Spec:** the operator's bar (2026-09-26): "industry standard product… high end and high quality, fast working app"; "quality and UI/UX are the most important points". Inputs: the ux-reviewer punch list (P0 1, P1 2–4, P2 5) and the copy-writer table, both in this session.

## Global Constraints

- The security brief applies; CSP is unchanged (no inline styles/scripts).
- No string from the server is rendered unless it is mapped or on a short allow-list; the fallback is always a fixed sentence.
- Reduced motion keeps every state visible without animation.
- 390 px: no sideways scroll on any changed tab (the screenshot script exits 1 otherwise).
- Static compression: text types only (html, js, css, json, svg, webmanifest), gzip when the client accepts it, never for woff2/png; ETag (sha-1 of bytes) with `If-None-Match` → 304; the shell and `sw.js` stay `no-cache` (revalidate every time), assets keep `max-age=3600`.

## Verified facts

- `views/claude.js`: new-session `promptInput` is `rows: '3'` (line ~213); the draft handoff sets `scrollTop = scrollHeight` (~559). "Live view ended: ${why}." at ~381; "Could not open the live view: ${err.message}" at ~388; "Live view needs tmux…" at ~307; Details shows raw `s.kind` (~330) and label "Id" (~327). `openLive`'s `onEnd` reasons: `'the session view ended'` or `closed (<reason>)` where reason ∈ exited|error|closed|login-ended|abandoned (from `claude-live.ts` close reasons).
- `views/chat.js`: `typing()` default text `'Amos is working…'` (~51) vs `${who} is replying…` elsewhere; effort picker note "Only for this chat. Default is Amos's own." (~169); the composer `lead` is a static "Amos" span (~166); no `dir` attribute on `.chat-text`/`.conv-user`/`.conv-assistant` anywhere (grep: 0 hits in chat.js, conversation.js, index.html).
- `app.css`: `.card:hover` (~324) sets only a box-shadow, so `button:hover` (~130) paints `.agent-card` gray on hover.
- Eleven "Too many …" toasts across views with mixed punctuation: app.js 1, artifacts.js 3, browser.js 1, claude.js 4, workflows.js 2. All are in scope for the shared helper.
- `static.ts` (75 lines): reads the whole file, no encoding, no ETag; `serveStatic(rootDir, urlPath, res)` is called from `server.ts` (~3004) with `url.pathname` only.
- xterm.js on a phone: touch moves are delivered to the terminal as mouse events only when the app has mouse reporting on; Claude Code turns mouse reporting on (DECSET 1000/1002/1006 replayed at attach), so a finger drag is sent to Claude as mouse drag instead of scrolling the view.

## File Structure

- `web/control/ui.js`: add `limitToast(what, wait)` → "Too many <what> — wait <wait>." and `serverError(err, fallback)` (allow-list of safe short messages; else the fallback).
- `web/control/views/claude.js`: reason map `LIVE_END` for end reasons; `KIND_LABEL` reuse in Details; "ID"; autosize the new-session textarea (reuse the composer's approach: a small `autosize(el, maxRows)` helper in `composer.js`, exported); `pollSoon()` right after picker sends; finger-drag scrolling (Task 4).
- `web/control/views/chat.js`: `typing()` requires text; lead slot shows the chat's current settings ("Sonnet 5 · High" or "Amos's defaults") instead of the name; picker notes completed; import toast always shown; `dir="auto"` on message text.
- `web/control/conversation.js`: `dir="auto"` on `.conv-user` and `.conv-assistant`.
- `web/control/views/artifacts.js`: BLOCKED "protocol"; registry-unreadable sentence through the map only; empty-state copy.
- `web/control/views/agents.js`: "No agents match your filter."; TEMPLATE keeps its text but the operator's line is last and separated by a blank line (already so).
- `web/control/app.css`: `.agent-card:hover` themed; `.msg-col`/`conv-col` unchanged.
- `src/control-ui/static.ts` (+ `static.test.ts`): gzip + ETag; `serveStatic(rootDir, urlPath, res, req?)`; `server.ts` passes `req`.
- `web/control/views/browser.js`, `views/workflows.js`, `app.js`: their "Too many …" toasts go through `limitToast` (no other change).
- Create `scripts/control-ui-perf.mjs`: Playwright, logs in with `CONTROL_UI_URL`/`CONTROL_UI_PASSWORD_FILE` like the screenshot script, prints first paint, bytes per resource and the biggest eight, three timings for five API routes, and tab-switch times; used before and after Task 3.
- `web/control/sw.js`: v20.

---

### Task 1: Copy and error mapping (copy-writer findings)

- [ ] `ui.js`: `limitToast(what, wait = 'a minute')` and `serverError(err, fallback)`; the allow-list is exact strings the server sends that are already plain ("confirmation required", "not found", "too many session starts", "read-only from the dashboard"); anything else → fallback.
- [ ] `claude.js`: `LIVE_END = { exited: 'the session finished', error: 'something went wrong on the server', closed: 'it was closed', 'login-ended': 'you were signed out', abandoned: 'it was idle too long' }`; `onEnd` passes the raw reason; the banner reads `Live view ended — ${LIVE_END[r] || 'it was closed'}.`; the open-failure line reads "Couldn't open the live view — try again in a moment." unless 429 (unchanged) ; "Live view isn't set up on this server yet — you'll see recent output instead."; Details: "ID", and `KIND_LABEL` ("Runs in the background" / "Runs in a terminal window"); status labels all lowercase ("working").
- [ ] `chat.js`: `typing(text)` requires text (no default); notes: model "Only for this chat." → "Only for this chat. Leave it on Default to use Amos's usual model."; effort → "Only for this chat. Leave it on Default to use Amos's usual effort."; busy toast "Amos is busy — try again in a minute."; import toast always: "Moved your earlier chat here." or "Moved the newest N of M messages here — the older ones are still kept in this browser."
- [ ] `artifacts.js`: "protocol not allowed"; "Artifact list can't be read right now (<reason label>). Check `artifacts.json` on the server."; empty state as written in the Create-artifact change.
- [ ] `agents.js`: "No agents match your filter."
- [ ] All eleven "Too many …" toasts (app, artifacts, browser, claude, workflows) through `limitToast`.
- [ ] Re-run copy-writer on the diff; fix until it reports no critical or major issue.

### Task 2: UX fixes (ux-reviewer P0–P2)

- [ ] P0: `composer.js` exports `autosize(textarea, maxRows)`; the new-session textarea autosizes on input and on the draft handoff, then the caret goes to the end with no forced scroll.
- [ ] P1: `.agent-card:hover, .agent-card:focus-visible { background: var(--surface-2); }` and the same for `.chat-row` if it shares the leak (check `button:hover` precedence).
- [ ] P1: Chat composer lead shows the chat's settings as text (`Sonnet 5 · High`, or `Amos's defaults`), updated by `syncState()`; on phones (≤ 480 px) the pickers stay, the lead text is hidden to save width.
- [ ] P1: `dir="auto"` on `.chat-text`, `.conv-user`, `.conv-assistant`, the composer textarea, and the chat-row preview; Hebrew sample in the fixture drive shows right-aligned bubbles.
- [ ] P2: `pollSoon()` right after a picker send on the Claude tab.
- [ ] Re-run ux-reviewer on the diff; fix until no P0/P1 remains.

### Task 3: Static compression and validation caching

```ts
export function serveStatic(rootDir: string, urlPath: string, res: ServerResponse, req?: { headers: IncomingHttpHeaders }): void
```

- Text types gzip'd when `accept-encoding` includes `gzip`; a small memo keyed by `full:mtimeMs:size` holds `{ raw, gz, etag }` (cap 64 entries); `Vary: Accept-Encoding`; `ETag: "<sha1>"`; `If-None-Match` match → 304 with the same cache headers.
- [ ] Add `scripts/control-ui-perf.mjs` (from this session's scratch script) and record the "before" numbers on the fixture.
- [ ] Tests first: gzip when accepted, identity otherwise, 304 on matching ETag, woff2 never gzip'd, memo refreshed when the file changes.
- [ ] Implement gzip + ETag + memo in `static.ts`.
- [ ] Wire the call site: `server.ts` (~3004) passes `req` as the fourth argument to `staticHandler`; a server test asserts `content-encoding: gzip` for `/app.css` with `Accept-Encoding: gzip` and none without.
- [ ] Record the "after" numbers with the same script (expect app.css 49 KB → ~11 KB) in the notes.

### Task 4: Finger-drag scrolling on phones (task #27)

- On touch devices only (`(hover: none)`), a vertical finger drag on the terminal scrolls the view: `touchstart` records `y`; `touchmove` computes rows from `deltaY / rowHeight` and calls `term.scrollLines(±n)` and `preventDefault()`, so xterm does not turn it into mouse-reporting; a tap (no move) still focuses. Two-finger drag is left to xterm. A drag while the pane is on the alternate screen (Claude's own scrolling UI) sends arrow keys instead? — No: keep it simple; scroll the viewport only; document it.
- [ ] Implement the touch handler in `views/claude.js` (`openLive`): `touchstart`/`touchmove`/`touchend` on the terminal host, active only under `(hover: none)`, one finger, vertical intent (|dy| > |dx|), `preventDefault()` so xterm gets no mouse event, `term.scrollLines(round(dy / rowHeight))`; a tap without movement still focuses.
- [ ] Drive at 390 px with touch on a throwaway session with 200+ lines of output: capture `claude-touch-before.png` and `claude-touch-after.png` (the terminal before and after a 300 px drag, with the viewport row offset printed in the drive log), commit both under `docs/control-ui/artifacts/`; the key bar still works; the transcript is unchanged by the drag.

### Task 5: Verification and deploy

- Per commit: build, vitest (control-ui + scripts), eslint/prettier, screenshot script (claude, chat, artifacts, agents) at 3 viewports, code-reviewer, verification. After the compression commit: restart once and confirm `content-encoding: gzip` and a 304 on the live server with curl.
- Record in `docs/control-ui-notes.md`.

## Out of scope

- The seven tabs unchanged this session (Tasks, Groups, Channels, Logs, Config, Debug, Sessions): reviewed in task #23; not touched here. Browser and Workflows are touched only for the toast helper.
- WebSocket transport for the terminal.
