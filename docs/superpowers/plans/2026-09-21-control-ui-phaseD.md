# Control UI Phase D — Connect Gmail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect a Gmail account to the assistant's own `packages/mcp-gmail` channel from the dashboard — paste the Google OAuth client once, click Connect, consent in Google, done — with disconnect and status, and without the assistant restarting.

**Architecture:** a new `src/control-ui/api/gmail-auth.ts` owns the credential directory (`GMAIL_CREDENTIALS_DIR`, default `~/.gmail-mcp`, 0700): key-file intake (validated, rewritten as a fresh literal, 0600), the OAuth *authorization code* flow with a server-held single-use `state` bound to the dashboard session, the server-side code exchange through `google-auth-library` (already a root dependency), token + account files (0600), status, and revoke/disconnect. `server.ts` adds five routes under `/api/v1/integrations/gmail/…`; the callback is the one route with `auth: 'none'` (Google redirects a top-level navigation, which cannot carry the `X-Deus-Session` header) and is gated by the state nonce plus the session cookie the nonce was bound to. `index.ts` gains `startChannel`/`stopChannel` so a successful connect starts the Gmail channel in the running process, exactly as boot would. The Channels tab's Gmail card grows a "Gmail account" panel.

**Tech Stack:** Node `fs` (confined, 0600), `google-auth-library` `OAuth2Client` (`generateAuthUrl`, `getToken`, `revokeToken`), global `fetch` for the Gmail profile call, vitest with injected exchange/profile/revoke functions, vanilla ES modules with `h()`.

**Spec:** `docs/superpowers/specs/2026-09-21-control-ui-scope2-design.md` § D.

**Review gates:** plan-reviewer and threat-modeler rounds run on this document before any code (round 1 of each: REVISE, folded below; rounds continue until both SHIP); `oracle-author` writes the discriminating red test for the state → exchange → callback contract before Task 1's implementation; code-reviewer and verification-gate run before the commit, as in every prior phase.

## Global Constraints

- **Credentials never render.** The key file's `client_secret`, every token, the authorization `code` and the raw pasted JSON never appear in a response, an SSE frame, a log line or an error message. The **host log ring is a boundary this phase feeds** (it is served to the dashboard at `/api/v1/logs`, its export and the `log` SSE), so: (i) exchange/revoke/profile errors are caught and logged as `{ code, status }` only — never the error object (a `GaxiosError` carries `config.data` = `client_secret=…&code=…`); a test throws a synthetic error shaped that way with the fixture secret in `config.data` and asserts no logger call carries it; (ii) `redactSecrets` in `api/logs.ts` is extended so the key alternation matches key *segments* (`client_secret`, `refresh_token`, `access_token`) rather than whole words, a **separate** OAuth-shaped pattern `[?&]code=[^&\s]+` joins the chain (bare `code` must not enter `SECRET_KEYS`, which also drives Claude-transcript rendering and would redact "status code: 500"), and `TOKEN_PREFIX` gains `ya29.` and `1//`; (iii) the server's top-level 500 handler (`server.ts:1957-1961`) is hardened for everyone, not only this phase: it logs `path` without its query string and a **safe error shape** `{ name, code, status, message: redactSecrets(message) }` — never the raw error object, whose `config.data` or `response` could carry a secret — and the whole callback handler is additionally wrapped so every step (state check, exchange, schema check, profile, email validation, writes, `startChannel`) returns a controlled `CallbackResult`; a test makes an injected step throw a synthetic error carrying the fixture secret in `config.data` and asserts the 500/502 path logs none of it. Status exposes booleans, ages and the account email only. Audit lines carry the email's domain, never the address, and never a token.
- **Files, all 0600 in a 0700 dir** (`GMAIL_CREDENTIALS_DIR` or `~/.gmail-mcp`, created by the server): `gcp-oauth.keys.json` — written only as the fresh literal `{ installed: { client_id, client_secret, redirect_uris: [<callback>] } }` after the paste is parsed (≤ 16 KB body, must be an object with `installed` or `web` holding string `client_id` ending in `.apps.googleusercontent.com` and a non-empty string `client_secret`; anything else → 400 `invalid client json`, nothing written); `credentials.json` — `{ access_token, refresh_token, token_type, expiry_date, scope }` as a fresh literal from the exchange result (the MCP server later merges refreshed tokens into it, unchanged behaviour); `account.json` — `{ email, connected_at }`. Reads go through `readRecordFile(file, 64 KB)` (`O_NOFOLLOW`, fstat bound, one parse); the dir is `lstat`-checked and a symlinked dir or file refuses everything with 503.
- **Redirect URI is the loopback the tunnel maps:** `http://localhost:<CONTROL_UI_PORT>/api/v1/integrations/gmail/callback`, built from the configured port (`deps.publicPort`, passed from `index.ts` as `CONTROL_UI_PORT`), never from the request's `Host`. Google's Desktop client type accepts any loopback port/path, so no console change is needed beyond creating the client. The operator's `ssh -L 3017:127.0.0.1:3017` (documented in Phase 5) already makes `localhost:3017` on their machine reach the server.
- **Consent URL** (`OAuth2Client.generateAuthUrl`): `access_type: 'offline'`, `prompt: 'consent'` (so a refresh token is always issued), `scope: ['https://www.googleapis.com/auth/gmail.modify']` (read, send, labels — what the MCP server's tools use; the profile email comes from `users/me/profile`, covered by the same scope), `state` = 32 random bytes hex. Pending states live in memory only: `Map<state, { sid, flowCookie, verifier, createdAt }>`, **one per session** (a new connect evicts that session's earlier state, since one flow cookie can only carry one value) and ≤ 5 across sessions (oldest evicted), 10-minute expiry, deleted on first use — success or failure — **and deleted when the owning session ends**: `/auth/logout`, `/auth/sessions/revoke-all` and credential rotation drop every pending state whose `sid` matches (or all of them), so a just-revoked browser cannot finish a flow. The `state` value and the PKCE verifier are never logged: `control_ui_gmail_connect` records only that a state was issued.
- **Callback** (`GET …/callback?state&code|error`, `auth: 'none'`, GET so the router's read-only gate does not apply — the route checks `deps.readOnly` itself and answers 403): (1) `state` must be present in the map and unexpired, and its stored `flowCookie` must equal the request's flow cookie — `sid` is recorded for the audit line only, nothing resolves a session from a cookie here; **not the session cookie** because it is `SameSite=Strict` (`auth.ts:366`) and browsers do not send it on Google's cross-site top-level redirect, so the second factor is a dedicated **flow cookie** `deus_ctl_oauth=<32 random bytes hex>; HttpOnly; SameSite=Lax; Path=/api/v1/integrations/gmail/callback; Max-Age=600` set by `POST …/connect` (with `Secure` under the same condition as `sessionCookie`) and stored beside `{ sid, createdAt }`; the callback requires `state` ∧ flow-cookie match, clears the flow cookie in its response whatever the outcome (`Max-Age=0` with the **same** `Path`, `SameSite` and `Secure` attributes it was set with, as `clearSessionCookie` does), `sid` stays in the record for the audit line, and the main cookie stays Strict; missing/mismatched → 403 page; (2) `error` from Google → 400 page naming the error code only; (3) `code` must be a string ≤ 512; (4) the exchange runs server-side through an injectable `exchange(code, verifier)` whose default wraps `OAuth2Client.getToken({ code, codeVerifier })` and returns **`result.tokens`** (the library resolves `{ tokens, res }`, not the credentials themselves); the consent URL carries a **PKCE S256 challenge** from `generateCodeVerifierAsync` and the verifier lives in the pending-state record, so a code observed on the loopback is useless without it; a result without `refresh_token` → 502 page "no refresh token — remove the app at myaccount.google.com/permissions and try again"; (5) the token object is schema-checked (`access_token`, `refresh_token` non-empty strings; `expiry_date` integer; `scope` string; `token_type` string) before it becomes `credentials.json` (written with `mode: 0o600` **and** an explicit `chmodSync`, as `writeCredentialFile` does), the profile fetched through an injectable `profile(accessToken)` (default: `fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile')`) and its `emailAddress` validated (string, ≤ 320, exactly one `@`, no whitespace or control characters) before `account.json` is written or ever re-served; (6) both files are written through open/write/`fsyncSync`/close (the factory re-reads them from disk at call time, so a partial file would start a child that fails) and only then `deps.startChannel?.('gmail')` starts the channel in-process (idempotent: no-op if a live `gmail` channel exists; on a `connect()` failure the entry is removed from `channels` again so a retry is possible); (7) the response is a minimal HTML page (`text/html`, the same `SECURITY_HEADERS`, no inline script or style, a link back to `/#/channels`) — one static template with a text slot filled through escaping of a **closed set of messages**, never of Google-supplied strings. 6/min per session on every mutating route; the callback is single-use per state, capped at 5 pending states, and rate-limited **per remote address** (10/min) counting only hits that fail state validation — every request shares the loopback address behind the tunnel, so a valid callback must never be denied by a local flood; the limiter exists to cap log-ring writes, not to gate the operator.
- **Connect** (`POST …/connect`): 428 without `X-Confirm: gmail`? No — connecting is not destructive; it needs keys present (409 `client keys missing`), read-only 403, limiter 6/min; returns `{ url }` for the browser to open. **Disconnect** (`POST …/disconnect`, `X-Confirm: gmail`), in this order because the MCP child is a concurrent writer of `credentials.json` (its `tokens` listener re-creates the file): (1) `await deps.stopChannel?.('gmail')` — the adapter's `disconnect()` closes the MCP transport, which kills the child **without awaiting its exit**, so a refresh callback in flight can still write the file afterwards; (2) revoke the refresh token through an injectable `revoke(token)` (default `OAuth2Client.revokeToken`); (3) delete `credentials.json` and `account.json`, then **re-check for up to 2 s (every 200 ms, with awaited timers — never a synchronous spin, this process also runs every channel)** and delete anything that reappeared; if a file is still present after the last pass the response carries `deleted: false` and `control_ui_gmail_delete_failed` is audited — Disconnect never reports a clean state it did not verify; (4) the route relays the module's `{ revoked, deleted }` as **200 `{ revoked, deleted }`** and audits from the same object — a revoke failure is never hidden: the response says so, the card renders "token could not be revoked — remove access at myaccount.google.com/permissions", and `control_ui_gmail_revoke_failed` is audited. The MCP server's merge-back write (`packages/mcp-gmail/src/gmail.ts:98`) gains `{ mode: 0o600 }` **and** a `chmodSync(…, 0o600)` (mode applies only on creation, as `auth.ts:79` notes) so a refreshed token file never lands at the umask default. **Forget keys** (`DELETE …/keys`, `X-Confirm: gmail`): refuses 409 while connected, else deletes `gcp-oauth.keys.json`. **Status** (`GET …`): `{ keys: boolean, connected: boolean, email?: string, connected_at?: string, token_age_ms?: number, channel_live: boolean, redirect_uri }` — `token_age_ms` from the token file's mtime. All audited: `control_ui_gmail_keys`, `control_ui_gmail_connect` (state issued), `control_ui_gmail_connected` (domain), `control_ui_gmail_disconnect`, `control_ui_gmail_keys_forgotten`.
- **Channel lifecycle in-process:** `index.ts` passes `startChannel(name)` — runs the registered factory with the same `channelOpts` boot uses, pushes into `channels`, awaits `connect()`, logs the same lines; a `connect()` failure is logged and returned as `{ ok: false }` (never thrown into the request); `stopChannel(name)` — `disconnect()` and remove from `channels`. Both only for names in the registry; the control UI only ever passes `'gmail'`. Boot behaviour is unchanged.
- **Container boundary unchanged:** the credential dir is read by the host-side MCP channel process only (`src/channels/mcp-gmail.ts`), never mounted into containers; this phase adds no mount.
- **Read-only** refuses every mutation (403) and the callback; status still shows.
- Public-repo generic: tests and the capture use a fake client id `fixture.apps.googleusercontent.com` and a fake exchange; no real Google call runs in tests or the capture.
- Visual language: existing `.card`/`.chips`/`.pairing` conventions on the Channels tab.

## Design

- `src/control-ui/api/gmail-auth.ts` — `gmailDir(env)`; `readKeys(dir)` → `{ client_id, client_secret } | null | 'invalid'`; `saveKeys(dir, rawBody, redirectUri)` → `'ok' | 'invalid'`; `status(dir, channelLive)`; `createGmailAuth({ dir, redirectUri, now, random?, exchange?, profile?, revoke? })` returning `{ issueState(sid) → { state, url, flowCookie } | { error }, consume(state, flowCookie, params) → Promise<CallbackResult>, disconnect() → Promise<{ revoked: boolean; deleted: boolean }>, forgetKeys() → 'ok' | 'connected' | 'missing' }`; `CallbackResult = { ok: true, email } | { ok: false, status: 400 | 403 | 502 | 503, message: <closed enum> }`; `callbackPage(result, assistantName)` → HTML string.
- `src/control-ui/server.ts` — deps `gmailCredentialsDir?`, `publicPort?`, `startChannel?`, `stopChannel?`; `gmailLimiter` 6/min; routes: `GET /api/v1/integrations/gmail`, `POST …/keys` (`maxBody: 16 KB`), `POST …/connect`, `GET …/callback` (`auth: 'none'`), `POST …/disconnect`, `DELETE …/keys`.
- `src/index.ts` — `startChannel`/`stopChannel` closures over `channels` + `channelOpts` + the registry; `gmailCredentialsDir` from `GMAIL_CREDENTIALS_DIR`; `publicPort: CONTROL_UI_PORT`.
- View: `web/control/views/channels.js` — today every adapter shares one generic card and only WhatsApp has a panel (`c.pairing`); the `gmail` card is extended the same way when the status route reports it, with: keys chip (`client keys saved` / `no client keys`), a **Paste client JSON** textarea + Save (hidden once keys exist; a "Forget keys" typed `gmail` action when not connected), **Connect Gmail** button → fetches `{ url }` and opens it in a new tab (`window.open(url, '_blank', 'noopener')`; the URL is server-built), status line `connected as … · token refreshed 3h ago · channel live`, **Disconnect** (typed `gmail`). The card refreshes on `refresh`/`queue` events and after the operator returns from the callback page. Text nodes only.
- Callback page: one template in `web/control/oauth-done.html` served by the route with `{{message}}` replaced by an escaped string from the closed message set; it links to `/#/channels`. Google's `error` code is mapped to a closed message (`access denied` for `access_denied`, `consent failed` otherwise).

## API surface verified

| Symbol | Where | Use |
|---|---|---|
| `OAuth2Client` (`generateAuthUrl`, `getToken` → `{ tokens, res }`, `revokeToken`, `generateCodeVerifierAsync`) | `google-auth-library` — manifest `^11.0.2` (`package.json:48`); the worktree was at 10.9.0 until `npm install` ran after plan-review round 1 and now holds **11.0.2** (the resulting `package-lock.json` normalisation lands with this phase's commit); `GetTokenResponse.tokens: Credentials`, `GetTokenOptions.codeVerifier`, `generateCodeVerifierAsync` and `revokeToken` verified against the installed `oauth2client.d.ts` | consent URL, PKCE, exchange, revoke |
| `readRecordFile(file, maxBytes)` | `src/control-ui/api/workflows.ts` | confined reads of the three files |
| `registerChannel`, `getChannelFactory`, `channelOpts`, `channels` | `src/channels/registry.ts`, `src/index.ts:441-460` | in-process start/stop |
| `src/channels/mcp-gmail.ts` | factory returns `null` without both files | why connect must write both before `startChannel` |
| router `auth: 'none'`, `maxBody`, `mutation` | `src/control-ui/router.ts:48-54`, `server.ts:1893-1905` | callback auth mode, paste size |
| `SECURITY_HEADERS` | `src/control-ui/static.ts:20` | callback page headers |
| `sessionCookie()` (`SameSite=Strict`, `auth.ts:362-372`), `writeCredentialFile` chmod pattern (`auth.ts:80-82`) | `src/control-ui/auth.ts` | why a flow cookie; the 0600 write pattern |
| `redactSecrets`, `SECRET_KEYS`, `TOKEN_PREFIX` | `src/control-ui/api/logs.ts:19-34` | extended for this phase's credential shapes |
| `listChannels` / Channels card | `src/control-ui/api/channels.ts`, `web/control/views/channels.js` | card extension |

## Verification strategy (frozen)

| Surface | Predicted |
|---|---|
| Module | `saveKeys` with a Desktop client JSON → 0600 file holding only `installed.{client_id, client_secret, redirect_uris}`; with `web` shape → same; with a missing secret / non-Google id / 20 KB body / an array → `invalid` and no file; `issueState` → 64-hex state, URL on `accounts.google.com` containing `access_type=offline`, `prompt=consent`, the `gmail.modify` scope, the redirect and the state, never the secret; 6th pending state evicts the oldest; `consume` with unknown state → 403, expired (11 min) → 403, wrong or missing flow cookie → 403, reused → 403, the URL carries `code_challenge` + `code_challenge_method=S256` and the exchange receives the matching verifier, `error=access_denied` → 400 `access denied`, exchange without `refresh_token` → 502 and no file, success → `credentials.json` 0600 with exactly the five fields, `account.json` with the email, state deleted; a token object missing `access_token` or with a non-integer `expiry_date` → 502 and no file; a profile with `emailAddress: 'x y@z'` or 400 chars → 502 and no `account.json`; a synthetic exchange error whose `config.data` holds the fixture secret → 502 and no logger call contains the secret; `disconnect` (module scope: the channel stop is the route's job, see the API row) calls `revoke` with the refresh token, deletes both files, deletes a file re-created 300 ms later (fake clock + a test writer), reports `revoked: false` when revoke throws and `deleted: false` when a writer keeps re-creating the file past 2 s; a second `issueState` for the same session evicts the first (the first state → 403); the `state` and verifier appear in no logger call; `forgetKeys` → `connected` while connected, deletes otherwise; a symlinked dir → every call 503 |
| API | status 401 unauthenticated; `{ keys: false, connected: false, channel_live: false, redirect_uri }` on a fresh dir; POST keys 400 for junk, 201 for a fixture client, audit line without the secret; connect 409 without keys, 200 `{ url }` with them, 429 on the 7th mutation; callback without the flow cookie → 403 page, with a flow cookie from another connect → 403, the connect response's `Set-Cookie` carries `Secure` only when the session cookie does, the callback response clears the flow cookie with the same attributes, 11 bad-state hits from one address in a minute → the 11th is 429 while a valid callback from the same address still succeeds, happy path → 200 HTML with the `Content-Security-Policy` header and the `/#/channels` link, `credentials.json` written, `startChannel('gmail')` called once, second visit of the same state → 403; status now `connected: true, email, channel_live: true`; disconnect 428 without confirm, 200 `{ revoked: true, deleted: true }` with, `stopChannel` awaited before `revoke`, files gone; with a failing `revoke` → 200 `{ revoked: false }` and a `control_ui_gmail_revoke_failed` audit line; forget keys 409 while connected; read-only → 403 on keys/connect/disconnect/forget and on the callback, status still 200; no response body or log call ever contains the fixture `client_secret`, `refresh_token`, `access_token` or authorization `code` strings (asserted over every captured response and every logger call); `redactSecrets('client_secret=abc&code=def')` and `redactSecrets('ya29.xyz')` carry none of the values; a route that throws a synthetic error with the fixture secret in `config.data` on `/api/v1/integrations/gmail/callback?state=s&code=c` → the top-level 500 log line has `path` without the query and no `config`, `response` or secret in it |
| index.ts | `startChannel('gmail')` with both files present runs the factory and `connect()`, pushes into `channels`; with files missing → `{ ok: false, reason: 'not configured' }`; a `connect()` that throws → `{ ok: false }` and `channels` does not keep the entry; `stopChannel` awaits `disconnect()` and removes it (unit test with a stub registry entry) |
| Visual | `phaseD-channels-{mobile,desktop}.png`: Gmail card with keys saved, connected as `fixture@example.invalid`, channel live; a second capture state before connect showing the paste box |

---

### Task 1: module

**Files:** create `src/control-ui/api/gmail-auth.ts` (+test), `web/control/oauth-done.html`.

- [ ] Step 0: `npm install` in the worktree (already run once; idempotent — keep the lockfile diff it produced); dispatch `oracle-author` for the state/PKCE/flow-cookie/exchange/callback contract (its test lands as `gmail-auth.oracle.test.ts`, untouched by the implementer).
- [ ] Step 1: failing tests per the Module row (injected `exchange`/`profile`/`revoke`/`random`/`now`).
- [ ] Step 2: implement; `npx vitest run src/control-ui/api/gmail-auth.test.ts`; tsc; eslint.

### Task 2: routes + flow cookie + channel lifecycle

**Files:** modify `src/control-ui/api/logs.ts` (redaction), `src/control-ui/server.ts` (routes, flow cookie, 500-handler path without query), `src/control-ui/server.test.ts` (describe "gmail"), `src/index.ts` (`startChannel`/`stopChannel`, deps), `src/config.ts` if `CONTROL_UI_PORT` needs exporting for `index.ts` (it is already exported).

- [ ] Step 1: integration tests per the API row and a unit test for the lifecycle closures.
- [ ] Step 2: implement; full control-ui suite; tsc; eslint; prettier.

### Task 3: view + capture + docs

**Files:** modify `web/control/views/channels.js`, `app.css`, `scripts/control-ui-screenshot.mjs` (`channels` step also drives the Gmail panel when the fixture reports keys), fixture launcher (fake `exchange`/`profile`/`revoke` through `gmailAuthOverrides` in `ControlServerOptions` — **construction-only**: reachable from a caller's options literal, never from env or config, never set by `index.ts`), `docs/control-ui-notes.md` Phase D record, `docs/control-ui-progress.md`, `docs/CONTROL-UI.md`/operator notes: how to create the Desktop OAuth client and what to paste.

- [ ] Step 1: view; capture; overflow probe; record; gates; commit `feat(control-ui): connect Gmail from the dashboard (Phase D)`.

## Threat-model round 1 — controls folded in

| Finding | Folded as |
|---|---|
| Blocking 1: session cookie is `SameSite=Strict`, never reaches the callback | dedicated Lax, path-scoped, 10-min flow cookie set at connect; state ∧ flow cookie; `peek` dropped |
| Blocking 2: host log ring boundary unnamed; `redactSecrets` misses this phase's shapes | boundary named; errors logged as code/status only + synthetic-error test; `SECRET_KEYS` segment-aware + `ya29.`/`1//`; 500 handler strips the query |
| Blocking 3: disconnect race with the MCP writer; silent revoke failure | stop channel first, revoke, delete, re-stat; 0600 + chmod on write and on the MCP merge-back; `{ revoked: false }` surfaced and audited |
| Blocking 4: profile response unvalidated | email validated before write or re-serve; token object schema-checked |
| PKCE, per-IP callback limiter, dead channel entry on failure | folded |

Answers: (1) inferred, not browser-tested — hence the flow cookie rather than a Lax downgrade; (2) `stopChannel` awaits the adapter's `disconnect()`, which ends the child, and the delete is re-checked afterwards; (3) `prompt=consent` mints a new grant per connect — the operator docs say to review `myaccount.google.com/permissions` after a failed revoke, and Disconnect always tries the revoke first; (4) accepted: the client secret now lives on the box, consistent with the SSH-only posture.

## Plan-review round 1 — folded in

| Finding | Folded as |
|---|---|
| Blocking: Strict cookie breaks the callback | same flow-cookie control as the threat round |
| Blocking: `getToken` resolves `{ tokens, res }`; installed library is 10.9.0 vs `^11.0.2` | default `exchange` returns `result.tokens`; Task 1 Step 0 runs `npm install` and re-checks field names |
| Blocking: no threat-model step named | "Review gates" line in the header; rounds cited |
| Warning: no independent oracle for a credential-rotation change | `oracle-author` in Task 1 Step 0 |
| Info: `startChannel` catches where boot throws | named under Deviations |
| Info: the Gmail card does not exist yet | Design now says the generic card is extended |

## Threat-model round 2 — controls folded in

| Finding | Folded as |
|---|---|
| Blocking 1: `peek` still in the Design | removed from Design and the API table; nothing resolves a session from the cookie alone |
| Blocking 2: `disconnect()` does not await the child's exit | stated accurately; bounded 2 s re-check with `deleted: false` + audit when a writer wins |
| merge-back mode is a no-op on an existing file | `chmodSync` added |
| flow cookie `Secure` and lifetime | same `Secure` condition as the session cookie; cleared by the callback |
| per-address limiter denies the operator behind the tunnel | counts failed-state hits only |
| ≤ 5 states vs one flow cookie | one pending state per session, 5 across sessions |
| state/verifier logging | never logged; stated |
| Q1 factory re-reads at call time | fsync before `startChannel` |
| Q2 audit content | only the fact a state was issued |

## Plan-review round 2 — folded in

| Finding | Folded as |
|---|---|
| Blocking: `peek` still in Design | already removed in the threat round 2 fold; Task 2 title and self-review scrubbed |
| Warning: "10.9.0 installed" stale; lockfile diff | API table corrected; the lockfile normalisation is intentional and ships with the phase |
| Warning: top-level catch logs the raw error | safe error shape + redacted message for every route; callback fully wrapped; synthetic-throw test at the router boundary |
| Info: `auth.ts:364` → `:366` | corrected |

Answers: (1) every callback step returns a `CallbackResult` inside one outer try/catch, and the router's own catch is hardened regardless; (2) the lockfile diff is intentional groundwork.

## Threat-model round 3 — SHIP; recommendations folded in

| Finding | Folded as |
|---|---|
| pending states outlive a revoked session | dropped on logout / revoke-all / credential rotation |
| 2 s re-check could be a sync spin | awaited timers stated |
| bare `code` in `SECRET_KEYS` would hit transcripts | separate `[?&]code=` pattern in the chain |
| flow-cookie clear needs matching attributes | stated |
| `gmailAuthOverrides` must stay construction-only | stated |
| Q1 opening clause of the callback check | rewritten: flow cookie match, `sid` audit-only |

## Plan-review round 3 — folded in

| Finding | Folded as |
|---|---|
| Module row asserted route-level behaviour (channel stop, cookie `Secure`) | moved to the API row; the module's `disconnect` covers revoke + delete + re-check only |

## Plan-review round 4 — folded in

| Finding | Folded as |
|---|---|
| `disconnect()` declared void but must report `revoked`/`deleted` | returns `{ revoked, deleted }`; the route relays and audits from it |
| `saveKeys` return unstated | `'ok' \| 'invalid'` |

## Deviations from the spec

- The spec's "fetched once via the userinfo scope" is replaced by the Gmail profile endpoint under the `gmail.modify` scope already required, so no extra scope or consent line is requested.
- Connect starts the channel in the running process (`startChannel`) instead of leaving the operator to restart the assistant — the spec did not say how the container "reads the files as it does today" would begin without a restart; boot behaviour is unchanged.
- Forget-keys is a separate typed action from Disconnect, so revoking the account does not force re-pasting the client JSON.
- Disconnect answers 200 `{ revoked }` rather than a bare 204, so a failed revocation is visible.
- `startChannel` returns `{ ok: false }` on a `connect()` failure where boot throws and aborts startup — a request must never take the process down.
- `packages/mcp-gmail` gets a one-line change (token merge-back written 0600) — outside the control UI, but it is the other writer of the same file.

## Self-review

Spec coverage: paste keys (chip, never rendered) ✓, Connect with state/offline/consent/redirect ✓, server-side exchange + 0600 token file ✓, status with age + email ✓, Disconnect revoke + delete ✓, container reads unchanged ✓, read-only refuses ✓. Placeholders: none. Type consistency: `createGmailAuth`, `issueState`, `consume`, `disconnect`, `forgetKeys` (Task 1, module scope), `startChannel`, `stopChannel` and the flow cookie (Task 2, route scope) used identically across Tasks 1–3.
