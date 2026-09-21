# Control UI — progress (resume from here if interrupted)

Branch: `control-ui` (worktree `.claude/worktrees/control-ui`).
Notes and assumptions: `docs/control-ui-notes.md`.

| Phase | Status | Notes |
|-------|--------|-------|
| 0 Recon | done 2026-09-20 | notes written |
| Design spec | done 2026-09-20 | `docs/superpowers/specs/2026-09-20-control-ui-design.md` |
| 1 Server + Agents/Wardens/MCPs | done 2026-09-20 | verification record + screenshots in notes / `docs/control-ui/artifacts/`; throwaway credential deleted |
| 2 Chat + Sessions + Groups | done 2026-09-20 | web-turn extraction (Odysseus tests untouched), chat/sessions/groups routes + views; record + screenshots in notes |
| 3 Tasks + Channels + Memory | done 2026-09-20 | tasks CRUD/run/logs with limiter+floor+caps, channels + confirmed WhatsApp QR, confined memory browse/edit; record + screenshots in notes |
| Visual redesign (v2) | done 2026-09-20 | "Console" direction: neutral surfaces, self-hosted Geist, SVG icons, rail groups + 4-tab bar with More sheet, chat as document; record + `v2-*` screenshots in notes |
| 4 Containers + Logs + System + Config + Debug | done 2026-09-21 | instance-scoped containers + confirmed stop/rebuild, info+ log ring with structural redaction, system tiles, allow-listed `.env` editor with shadowed temp dir + external backups, debug health/counts/trace; record + `phase4-*` screenshots in notes |
| 5 Deploy + verify | done 2026-09-21 | merged into the instance checkout, `CONTROL_UI_ENABLED=1` + `CONTROL_UI_PORT=3017` added to the service unit (backup kept outside the checkout), credential generated once, restart verified: bound to 127.0.0.1:3017 only, every API route 401 unauthenticated, other listeners unchanged; instance facts live in the operator's local notes, not here |

## Scope 2 (spec `2026-09-21-control-ui-scope2-design.md`)

| Phase | Status | Notes |
|-------|--------|-------|
| C Claude sessions | done 2026-09-21 | list/transcript/start/message/stop through the Claude Code job CLI; bypassPermissions by operator decision; record + `phaseC-*` screenshots in notes |
| W Workflows | done 2026-09-21 | `scripts/workflow.mjs` registry under `CONFIG_DIR`, confined read path, shared URL allow-list, watcher-driven `workflow` SSE with data-path read-only projection, typed archive; record + `phaseW-*` screenshots in notes |
| A Live artifacts | done 2026-09-21 | `scripts/artifact-registry.mjs` + one locked, budgeted registry file, add/remove routes with the read-time URL allow-list as the control, ask-to-register convention, Workflows tie-in; record + `phaseA-*` screenshots in notes |
| D Connect Gmail to the assistant | done 2026-09-21 | paste the Desktop client once, PKCE code flow through the tunnel loopback with a session-bound state + path-scoped flow cookie, server-side exchange, 0600 files, in-process channel start, typed disconnect with revocation; record + `phaseD-*` screenshots in notes |
