# Claude tab v2 — live sessions, exactly like the terminal

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Tasks:** #19 (live remote control), #18 (simpler list), #25 (auto mode).
**Operator's words:** "I want it to be like remote control function in claude.
The conversation will be the same meaning writing in the gui is writing in the
terminal … Deus short-cuts are there and marked when typed." "Make sure the
sessions in the dashboard will run the same as in terminal meaning auto mode."
"The Claude tab is the most important … work good, easy to use and looks good."

## Facts established before this plan (all driven first-hand, 2026-09-25)

1. Claude Code's own Remote Control is a private relay for claude.ai, the
   mobile app and Desktop only; no third-party client API, no embedding
   (code.claude.com/docs/en/remote-control). Not buildable on.
2. The operator's sessions are background sessions owned by the Claude daemon
   (`claude daemon run`), started with `--permission-mode auto`.
   `claude agents --json` lists them; `claude attach <id>` opens one in any
   terminal, and per its help "the session keeps running either way".
3. Two attaches to the same session at once work and stay in lockstep. Driven
   with a throwaway session in two tmux panes: identical screens, a half-typed
   draft in pane A appeared live in pane B, the reply rendered in both. The
   test session was stopped and removed. So the dashboard attaching is the same
   as the operator's terminal attaching. No migration is needed; the earlier
   "move to shared terminal" step is dropped.
4. tmux 3.4 is installed. xterm.js 5.5.0 renders correctly under the
   dashboard's existing CSP (`style-src 'self'`) with the WebGL renderer
   (colours, bold, 256-colour verified in a screenshot). xterm core attempts four
   inline `<style>` injections that the CSP blocks, with no visible effect. CSP
   stays as it is; if implementation shows any of those four matters, add its
   exact sha256 for the pinned vendored version, never `'unsafe-inline'`.

## Design

**Server — a live view is `claude attach <id>` inside a private tmux.**
- Open: `tmux -f /dev/null -L deus-dash new-session -d -s v-<rand> -x <cols>
  -y <rows> <claudeBin> attach <id>` — argv array via execFile, with `claude`,
  `attach`, `<id>` as separate items (tmux joins a single string through
  `sh -c`); `-f /dev/null` so the operator's `~/.tmux.conf` (hooks,
  run-shell, set-clipboard, plugins) is never loaded; cwd = repo root; same env
  builder as today's Claude calls; `<id>` must match `CLAUDE_JOB_ID_RE` AND be
  in `claude agents --json` output for this repo. Strictly AFTER `-C attach`
  succeeds (never before — the new session has no client until then):
  `set-option -t v-<rand> destroy-unattached on`, so a node crash removes the
  view immediately. Then the server
  connects in tmux control mode (`tmux -L deus-dash -C attach -t v-<rand>`) as a
  child process with plain pipes. No native module.
- Output: control-mode `%output` lines are decoded (tmux octal escapes; other
  bytes pass raw — both forms appear in captured tmux 3.4 output) and sent on a
  **dedicated per-view stream, not the shared event hub** (the hub broadcasts
  to every login and keeps a shared replay ring): `GET
  /api/v1/claude/live/:vid/stream?ticket=` redeems a single-use ticket and
  checks the view's owner is the ticket's login. No replay ring: on (re)connect
  the current screen is painted with `capture-pane -p -e -J`. Per-view
  backpressure: output is coalesced every ~30 ms; if a view's buffer overflows
  it is dropped and repainted from `capture-pane`. A slow view never stalls or
  disconnects the dashboard's main event stream.
- Input: `POST /api/v1/claude/live/:vid/input` carries raw bytes as base64,
  ≤ 16 KB per request, forwarded with `send-keys -t … -H <hex…>` over the
  control-mode stdin, so escape sequences, Shift+Tab, Ctrl+C and arrows arrive
  exactly as a terminal sends them. **Only server-built values ever reach the
  control-mode stdin**: keys as lowercase hex pairs, targets from the view
  registry, cols/rows `Number.isInteger` and bounded 20..400 × 5..200 before
  `refresh-client -C WxH` is built. Large inputs are split into chunks and go
  through one bounded, serialised stdin queue per view. Limits: 16 KB per
  request, ~50 input requests/s per view, a per-login rate limit on opens
  (like `claudeStartLimiter`).
- Lifetime: a view belongs to one dashboard login session. **One teardown
  function** (kill-session + end the stream) runs on: browser close, stream
  gone 60 s, logout, session destroy, revoke-all / `sessions.clear()`,
  credential rotation, idle or absolute expiry, and server shutdown. A 20 s
  sweep re-checks every owning login without extending its idle timer and
  calls `credentialState()` so rotation does not wait for the next request. On
  server start any leftover `deus-dash` sessions are killed. Killing a view never stops the Claude session (fact 2). Max 4 live
  views per login, 8 total.
- The private socket keeps these apart from anything the operator runs in
  their own tmux.

**Stream budget.** The per-view stream is its own `ServerResponse` held by
the view registry, not an `EventHub` client, so live views never count against
the hub's `maxClients` (8) or touch its replay ring. `events.ts` is unchanged.

**Patterns.** *Registry* (`Map<viewId, View>`): O(1) lookup on every
input/resize/stream call and O(n≤8) sweeps by owning login; a `View` owns its
tmux process, its stream, its stdin queue and its teardown. *Adapter*: the
control-mode parser turns tmux's line protocol into `{kind:'output', bytes}` /
`{kind:'exit'}` / ignored, so nothing else knows tmux's wire format.
*Single teardown path*: every end condition calls `view.close(reason)`, which
is idempotent.

**Input chunking.** `send-keys -H` takes one argv per byte, so input is split
into chunks of at most 512 bytes (≈ 1.5 KB of command line each) and written
one command per chunk through the queue. A 16 KB paste is 32 commands.

**Platform.** tmux is Unix-only. `resolveTmuxBin()` (in `claude-live.ts`, using
`src/platform.ts` like `resolveClaudeBin`) returns null on Windows or when
`tmux -V` fails; then the open route answers 503 and the tab shows "live view
needs tmux on the server" with the existing Recent output fallback.

**Starting sessions (#25).** "New session" runs `claude --bg
--permission-mode auto --name <name> [prompt]` (was
`--permission-mode=bypassPermissions`), then opens it live.

**No extra friction (operator decision, recorded in #19).** The dashboard is
reachable only through an SSH tunnel plus its own login, so anyone using it
already has a shell. Typing into a live view needs no typed confirmation. Stop
keeps its typed confirmation. **Read-only mode gets no live view** (the list
only, with a note), matching the existing rule that read-only never gets the
host log follow; open/input/resize/stream all answer 403 there.

**Hardening (threat review, 2026-09-25).**
- xterm.js: terminal query answers that tmux already gives are suppressed via
  `term.parser.registerCsiHandler` for `n` (DSR), `c` (DA), `$p`, and
  DCS/OSC query handlers returning true, so model-controlled output cannot
  make the browser type answers into Claude. No addon-clipboard (no OSC 52
  writes; verify for 5.5.0). `linkHandler` allows only http/https, opened
  `noopener,noreferrer`. `onTitleChange` is not wired. CSP unchanged.
- Host header checked on every request against `localhost|127.0.0.1` with
  the bind port (3017) AND `deps.publicPort` (the tunnel's local port may
  differ); a route test uses a publicPort different from the bind port.
- Input and resize routes stay header-authenticated (`x-deus-session`), never
  ticket- or cookie-only; only the stream uses a ticket.
- Audit log: view open/close and input byte counts per login short id, never
  content.
- `sw.js` skips all `/api/` routes including the live ones.
- `startArgv` keeps the existing `--name=` and `--` forms; only the
  permission mode changes. This supersedes the Phase C typed-id confirm on
"message" (the message route is removed with this change) — recorded as a
superseding note in `docs/superpowers/plans/2026-09-21-control-ui-phaseC.md`.

**Browser (web/control/views/claude.js, rewritten).**
- Desktop: left column is the session list, one row each: name, working/idle
  dot + word, "last active" relative time (#18). "New session" on top. Right:
  the live terminal filling the rest of the screen, with a slim header (name,
  "Open in Claude app" when the session has Remote Control on, Stop). A
  "Details" disclosure holds id, started, cwd.
- States in the list: working, idle, and **needs you** (the existing
  `blocked` / `waiting_on` state, kept — it is the one the operator most needs
  to see).
- Mobile: list full-screen; tapping a session opens the terminal full-screen
  with a back arrow and a key bar (Esc, Tab, Shift+Tab, ↑, ↓, Ctrl+C, `/`),
  because phone keyboards cannot send those.
- Slash commands and Deus shortcuts: the view is the terminal, so Claude
  Code's own input autocompletes and marks them exactly as in the terminal.
- xterm.js 5.5.0 + addon-fit + addon-webgl (canvas fallback), pinned exactly as
  devDependencies, copied into `web/control/vendor/xterm/` by a build step and
  served same-origin.
- Style A buttons; terminal theme uses the dashboard's tokens.

**Removed:** the transcript panel, the "message this session" composer and
route, and the copy-on-busy fallback. `/logs` "Recent output" stays as a
fallback when tmux is unavailable.

**Rollback.** One `git revert` of the implementation commit restores the
previous tab, routes and tests; no data or config migrates.

## Files

- `src/control-ui/api/claude-live.ts` (new): view registry, tmux lifecycle,
  control-mode parser (`%output`, `%exit`, `%begin/%end`), input encoder,
  limits.
- `src/control-ui/api/claude-sessions.ts`: `startArgv` uses `auto`.
- `src/control-ui/server.ts`: `POST /api/v1/claude/live` (open → `vid`),
  `DELETE …/live/:vid`, `POST …/live/:vid/input`, `POST …/live/:vid/resize`;
  per-view stream endpoint; teardown hooks; message route removed.
- `web/control/views/claude.js` (rewrite), `web/control/app.css`,
  `web/control/index.html`, `web/control/sw.js`, `scripts/vendor-xterm.mjs`
  (wired into `npm run build`), `package.json`, `web/control/app.js` (a
  body class while a live view is full-screen on mobile, so the shell hides
  its header/tab bar), `scripts/control-ui-screenshot.mjs` (the claude step
  waits on the new list/terminal, not the removed transcript), and a
  superseding note in `docs/superpowers/plans/2026-09-21-control-ui-phaseC.md`.
- Removed with their routes: the `server.test.ts` cases for `/message` and
  `/transcript`.
- Tests: `claude-live.test.ts` (parser against real captured tmux 3.4 output,
  encoder, limits, lifecycle with a fake tmux), server route tests (auth,
  read-only refusal, a view id from another login → 404, size caps, teardown
  on logout/rotation), one real-tmux integration test that attaches a view to
  a throwaway `sh`, types, and reads it back.

## Verification (predicted outcomes, frozen now)

| Check | Prediction |
|---|---|
| Unit + route tests | pass; foreign view id → 404; read-only input → 403 |
| Real tmux integration | bytes typed via the input route appear in `capture-pane` |
| Live parity, driven | a throwaway `claude --bg` session opened in the dashboard fixture AND in a tmux pane: a draft typed in the dashboard appears in the pane before Enter; the reply renders in both; session then stopped and removed |
| Slash command | typing `/` in the dashboard view shows Claude Code's own command menu |
| Auto mode | a dashboard-started session's status line reads "auto mode on" |
| Teardown | closing the view, logout, revoke-all, expiry and rotation each leave no `deus-dash` tmux session; the Claude session is still listed as running; a killed node process leaves no view behind (destroy-unattached) |
| Stream isolation | a view's stream opened with another login's ticket → 403; terminal output never appears on the main event stream |
| Query-answer loop | output containing DSR/DA queries produces no input POST from the browser |
| Injection | cols `"80\nkill-server"` → 400, nothing written to tmux stdin |
| CSP | no new directive; screenshot shows correct colours |
| Visual | before/after at 390/1280/1920; 0 px sideways overflow at 390 on all tabs |
| Suite | `npx vitest run` green; `tsc`, `eslint` clean |

| Two logins | login B's streams never receive login A's view output; B cannot open A's stream (403) |
| Big paste | a 16 KB paste through the input route arrives intact in a real tmux pane (byte count + hash of `capture-pane` of a `cat > file` target) |
| No tmux | with tmux unresolvable, open → 503 and the tab shows the fallback |

## Steps

- [ ] 1. Commit this plan + the phaseC superseding note.
- [ ] 2. `claude-live.ts`: parser + encoder + tests against the captured tmux 3.4 fixture (red then green).
- [ ] 3. View registry, lifecycle, teardown, limits, `resolveTmuxBin`; fake-tmux tests.
- [ ] 4. Real-tmux integration tests (type + read back; 16 KB paste; destroy-unattached on kill).
- [ ] 5. Server routes + per-view stream + Host check + audit + read-only 403s; remove message/transcript routes and their tests; route tests incl. two-login isolation and injection.
- [ ] 6. `startArgv` → auto mode (#25) + test.
- [ ] 7. Vendor xterm (devDeps pinned, build step, sw.js shell + cache bump + `/api/` skip).
- [ ] 8. Rewrite `claude.js` + CSS + app.js hook; xterm hardening (query handlers, linkHandler, no clipboard/title).
- [ ] 9. Screenshot script update; before/after captures; overflow probe.
- [ ] 10. Live parity drive with a throwaway `claude --bg` session (dashboard + tmux pane), slash menu, auto-mode line; remove the session.
- [ ] 11. Full suite, tsc, eslint; code-reviewer + verification-gate; commit; merge; restart; verify on 3017.

## Risks

- tmux control-mode format drift: parser tested against captured real output;
  unknown notifications ignored, not fatal.
- A viewer that never closes: 60 s SSE-gone teardown + per-login caps.
- Keystrokes to the wrong view: view ids random 128-bit, bound to the owning
  login, checked on every call.
