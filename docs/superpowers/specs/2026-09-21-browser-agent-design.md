# Browser agent — design (scope 3)

The assistant can already act on channels it has credentials for (WhatsApp,
Telegram, Gmail) and inside its own repo. It cannot act on a site that has no
API. This adds one: a logged-in browser on the host that performs **operator-
defined, rule-bounded jobs**, one approved action at a time.

Two jobs are named by the operator and shape the design:

- **Alibaba** — reply to supplier threads in the Message Center (the stage
  before a supplier moves to WhatsApp, which the supplier tracker already
  covers from `store/messages.db`).
- **Instagram** — follow accounts from the existing plan, under the budgets
  already decided.

## Decisions taken with the operator (2026-09-21)

1. **Approve each action by default.** The assistant proposes; the operator
   approves in the dashboard. Autonomy is opt-in per rule, with a daily cap,
   and never the default.
2. **The operator's own accounts only.** No account creation, no scraping of
   anyone else's private data, no engagement with strangers beyond the list
   the operator supplies.
3. **One phase, one engine.** Session store + job runner + rules + approvals
   queue + dashboard tab, with two thin site adapters. Everything site-
   specific lives in an adapter; the engine never hard-codes a site.
4. Same gate discipline as scope 2: plan-review + threat-model before code,
   code-review + verification-gate before commit.

## The platform-policy risk, stated plainly

Instagram's terms prohibit automated interaction; accounts that follow at
machine pace get action-blocked, shadow-limited or disabled, and there is no
official API for following. Alibaba's messenger is less aggressive but its
terms also disallow automated agents. The operator is automating work they
already do by hand on their own accounts, so the risk is theirs to take — the
design's job is to keep it small and visible:

- Budgets come from the operator's own plan (Instagram 25/week rising to
  30/week, TikTok 15→20, per the Social Follow Plan sheet decided 2026-09-18),
  never from a limit the code invents.
- Human pacing between actions, jittered, with a daily cap and a hard stop.
- **Any challenge, checkpoint, captcha, 429 or unexpected page stops the run**
  and marks the session `needs_attention`. The runner never retries a blocked
  action and never solves a challenge.
- Every action is recorded with what it did and who approved it.

## Trust boundary

The browser profile holds live session cookies for the operator's accounts:
credentials in every sense. They live host-side, 0700/0600, never mounted into
containers, never rendered, never logged — the Phase D treatment. A job is a
**closed action type with validated parameters**, never a script or a
selector supplied from the browser: the dashboard can ask for
"follow @handle", never "run this code".

## S — Session (login, once per site)

Playwright's own `storageState` is the unit. The operator produces it on their
own machine — `node scripts/browser-session.mjs help` prints the two-command
recipe (`npx playwright open <site>`, log in, save state) — and uploads the
JSON in the Browser tab. Stored `CONFIG_DIR/browser/<site>/storage-state.json`
0600 in a 0700 dir; validated as Playwright state shape and nothing else;
presence, host list and age shown, contents never. **Forget session** (typed
`<site>`) deletes it. A run that finds the session expired marks it
`signed_out` and stops.

## R — Rules (what the assistant may do)

One JSON file per site, `CONFIG_DIR/browser/<site>/rules.json`, written by the
operator (CLI: `scripts/browser-rules.mjs set`), validated on read like every
other registry in this dashboard: closed enum of job kinds, integer caps, a
target allow-list. Nothing in a rules file is executable.

```
{ "v": 1, "site": "instagram", "enabled": true, "autonomous": false,
  "weekly_cap": 25, "daily_cap": 4, "min_gap_seconds": 45, "jitter_seconds": 30,
  "quiet_hours": [22, 7],
  "allow": { "kinds": ["follow"], "handles": ["@babybrand", "..."] } }
```

`weekly_cap` is the number from the operator's own plan (the sheet is written
in weeks); `daily_cap` is how far it may be spread in one day and defaults to
`ceil(weekly_cap / 7)`. Both bind.

`autonomous: false` (the default) means every action waits for approval.
`true` means follows inside the caps run unattended — a deliberate extension of
the recorded "founders tick manually" decision, off until the operator types the
site name to enable it, never available to `alibaba.*`.

## J — Jobs and the approvals queue

A job is `{ site, kind, params }` from the closed set: `instagram.follow
{ handle }`, `alibaba.reply { thread_id, body }`, `alibaba.list_threads {}`.
The runner: opens the persistent context, does **one** action, screenshots the
result, closes. Proposals land in an approvals queue with the exact action and
a screenshot of the page before acting; approve runs it, reject drops it. The
queue is the operator's audit log: who approved, when, what happened.

Message bodies for `alibaba.reply` are drafted by a session and **always**
approved by the operator before sending, even in autonomous mode — sending
words to a supplier in the operator's name is not a rate-limited action, it is
a statement.

## Dashboard

A **Browser** tab: per-site card (session state and age, rules summary,
enabled/autonomous, today's count against the cap), the approvals queue with
screenshots, and the run log. Typed confirmation for Forget session and for
enabling autonomy. Read-only refuses everything but the view.

## Testing, and what cannot be tested here

Selectors cannot be verified against the live sites from this environment, and
no test may touch a real account. The engine, rules validation, caps, pacing,
queue, stop-on-challenge and the adapters' DOM handling are tested against
**local static HTML fixtures** that mimic each site's shape. The first real
run is operator-supervised, approve-each-action, and is expected to need
selector fixes — the adapters are written so a selector change is one line.

## Non-goals

No captcha solving, no account creation, no proxy rotation, no follow/unfollow
churn, no scraping beyond the pages a job must read, no engagement with
accounts outside the operator's list, and no second browser for anything but
these jobs.
