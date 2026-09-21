# Control UI — scope 2 design: Claude sessions, Workflows, Artifacts, Gmail connect

**Scope:** four additions to the existing control UI (`docs/superpowers/specs/2026-09-20-control-ui-design.md` stays the base: auth, render boundary, CSP, read-only mode, audit, no-shell rule). This spec adds four tabs and the conventions behind them. Order of delivery: C → W → A → D.

## Decisions taken with the operator (2026-09-21)

- Browser-started Claude Code sessions run with `--permission-mode bypassPermissions` — the operator wants them to behave exactly like a terminal session. This is remote code execution on the host by design; the only exposure is the SSH tunnel + dashboard login, so the spec treats the dashboard session as the operator's shell.
- Working directory for browser-started sessions is fixed to this instance's repo root (`PROJECT_ROOT`); no other project roots.
- Phases are delivered one at a time (C alone first), each with its own plan-review + threat-model before code and code-review + verification-gate before commit.

## New trust boundary: dashboard → Claude Code (host agent)

Everything in the base spec stops at the Deus process. Phase C crosses into Claude Code through **its own job CLI**, never through its files or pids:

- **Read:** `claude agents --json --all --cwd <PROJECT_ROOT>` (the same list the terminal Agents view shows, limited to sessions started under this instance's repo: interactive + background, with `id`, `sessionId`, `name`, `kind`, `state: working|blocked|done`, `status`, `pid`, `startedAt`); `claude logs <id>` for recent terminal output; the session transcript `~/.claude/projects/<dir>/<sessionId>.jsonl` (found by session id, confined under the projects dir) for the conversation (user/assistant text, tool names only). Never `~/.claude/sessions/*.key`, never credentials, never `history.jsonl`, never sessions outside `PROJECT_ROOT`.
- **Execute:** only the `claude` binary (resolved once at boot, absolute path cached) with fixed argv shapes — `agents --json --all --cwd <root>`, `logs <id>`, `stop <id>`, and `--bg --name=<name> --permission-mode=bypassPermissions [--resume=<sessionId>] -- <prompt>` (the prompt is the positional argument; `-p/--print` is the one-shot mode and is not used) — cwd `PROJECT_ROOT`, explicit env allowlist, 15 s timeout for the read/stop calls. Ids match `/^[0-9a-f]{8}$/` (job, the only form a request may carry) or a well-formed UUID `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` (session, resolved from the list, never from a request); names `/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u` (no leading `-`, so no user string can be parsed as an option); prompt ≤ 8 KB and passed as one argv element after `--`. No shell, ever.
- **Message a session:** `--bg --resume <sessionId>` continues the conversation as a background job under the same id when the daemon allows it, or starts a copy and says so — the route reports which (from the CLI's own stdout). Attaching to an interactive terminal session is out of scope.
- **Withheld in read-only:** start/message/stop (403), transcripts and `claude logs` (403 — operator prompts and tool-echoed file contents, same line as container logs); the list with `waiting_on` stays (metadata about what the operator owes the session).
- **Blast radius:** the list is every session under this repo, including the autonomous pipeline's worktree sessions; stop/message reach them and message injects a prompt into a `bypassPermissions` session the dashboard did not start — the operator's explicit decision, traceable only through the audit line. A failed list never authorizes anything: id-resolving routes answer 503, and the list route reports `{ unavailable: true, error }` rather than an empty array.
- **CLI output is untrusted input:** rows are kept only when `realpath(cwd)` is under `PROJECT_ROOT` (the `--cwd` flag is an optimization, not the control); printed ids are parsed structurally (exactly one distinct 8-hex value — the job id is also the session UUID's first group, so it may legitimately appear twice) and continue-vs-copy is decided by id equality, never by prose; stop/message re-check `kind`/`resumable` in the route.

## C — Claude sessions tab

Routes (all session-auth; mutations need `X-Confirm`):

| Route | Behaviour |
|---|---|
| `GET /api/v1/claude/sessions` | the daemon list, projected: `{ id, session_id, name, kind, state, status, waiting_on?, cwd_rel, started_at, resumable }` (`waiting_on` = the transcript's last assistant text when blocked); `claudeReadLimiter` 30/min per session shared with transcript/logs (one `HostCli` semaphore) |
| `GET /api/v1/claude/sessions/:id/transcript?limit=200` | user/assistant text and `{ tool, summary }` rows from the jsonl (tail-bounded), newest last; 404 for ids not in the list; 403 in read-only |
| `GET /api/v1/claude/sessions/:id/logs` | `claude logs <id>` output, redacted; 403 in read-only |
| `POST /api/v1/claude/sessions` `{ name, prompt }` | `X-Confirm: start`; spawns `claude --bg …`; 3/10 min globally and at most 3 dashboard-started sessions working at once; audited with name + prompt hash + the printed id |
| `POST /api/v1/claude/sessions/:id/message` `{ prompt }` | `X-Confirm: <id>`; `claude --bg --resume <sessionId> …`; 10/10 min; audited by hash; answers `{ continued: true \| copied: true, id }` |
| `POST /api/v1/claude/sessions/:id/stop` | `X-Confirm: <id>`; `claude stop <id>`; audited |
| SSE `csession` | 3 s poll-and-diff over the daemon list while a client is attached |

UI: list rows (name, state dot: working / waiting for you / done, the question it is waiting on, cwd relative to the repo, age), row → transcript panel with a reply composer and a "recent output" toggle; header action **New session** (name + prompt, typed `start`). Interactive sessions show "open in your terminal" and no controls.

## W — Workflows tab

A workflow is any multi-step order (create posts, product images, site images, …). Progress is **reported, not inferred**: one CLI, `scripts/workflow.mjs`, writes JSON records under `CONFIG_DIR/control-ui/workflows/<id>.json` (outside the repo, never mounted into containers):

```
{ id, name, kind: posts|product_images|site_images|other, status: running|waiting|done|failed,
  percent: 0-100, step, steps_total?, message?, session_id?, preview_url?, outputs: [{label,url}],
  started_at, updated_at, finished_at? }
```

CLI: `workflow.mjs start --name … --kind … [--session <id>]` → prints id; `progress <id> --percent 40 --step "3/7 hero shots"`; `finish <id> --preview <url> [--output label=url]`; `fail <id> --message …`. Records are validated (ids `/^wf-[0-9a-f]{12}$/`, urls `https://` only, strings capped); the dashboard never executes anything from them. A standing instruction in `CLAUDE.md`/`AGENTS.md` tells sessions to report through it for any order that takes more than a minute, and `marketing/pipeline/catalog_images.py` / `build_preview.py` gain a `--workflow <id>` flag in a follow-up so the pipeline reports natively. The tab: cards with a progress bar, step text, linked session state (via C), and the preview link when finished; SSE `workflow` events from a file watcher; a **Clear finished** action (typed `clear`) archives records older than 30 days.

## A — Live artifacts tab

Registry `CONFIG_DIR/control-ui/artifacts.json`: `[{ id, title, url, kind: app|report|preview, description, added_at, added_by }]`, seeded with the known ones (Supplier Line, the posts preview, the product-image preview). Populated by `scripts/artifact-registry.mjs add --title … --url … --kind …` (a standing instruction: after publishing an artifact app, **ask the operator** whether to add it to the dashboard, then run the CLI), by W's `finish --preview`, and by an **Add** form in the tab. Remove needs a typed title. Links open in a new tab with `rel="noopener noreferrer"`; the dashboard never fetches artifact content. Only `https://claude.ai/…` URLs are accepted (allow-list, not a denylist).

## D — Connect Gmail to the assistant

For Deus's own `packages/mcp-gmail` (not the claude.ai connector). One-time: the operator pastes the Google OAuth *desktop* client JSON into the Channels tab (stored `~/.gmail-mcp/gcp-oauth.keys.json` 0600; contents never rendered; presence shown as a chip). **Connect**: the server builds the consent URL with a 32-byte `state` nonce (single use, 10 min), `access_type=offline`, `prompt=consent`, redirect `http://localhost:3017/api/v1/integrations/gmail/callback`; the operator's browser reaches that redirect through the SSH tunnel; the server exchanges the code server-side and writes `~/.gmail-mcp/credentials.json` 0600; status shows connected/not, the token file's age, and the account email (fetched once via the userinfo scope). **Disconnect** (typed `gmail`) revokes the token and deletes the files. The Deus container reads the files as it does today (`GMAIL_CREDENTIALS_DIR`). Read-only refuses all of it.

## Non-goals

An in-browser terminal; the daemon's messaging socket; sessions for other repos/instances; editing `~/.claude` config; inferring workflow progress from transcripts.

## Testing

Each phase: unit tests on pure functions with injected fs/spawn; integration through `server.test.ts` with fakes; a fixture for screenshots (synthetic `~/.claude` tree, fake `claude` binary that records argv); mutation checks on the argv shape and the id/name regexes; verification-gate drives the real host read-only (list must show this very session).
