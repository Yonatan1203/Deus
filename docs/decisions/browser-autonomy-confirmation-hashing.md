# ADR: Binding the browser autonomy grant to the rules it was confirmed over

**Status:** Accepted
**Date:** 2026-09-22
**Scope:** `src/control-ui/api/browser-store.ts` (`scopeHash`, `validateRules`, `writeRules`), `PUT /api/v1/browser/sites/:site/rules`, `scripts/browser-rules.mjs`

## Context

Browser jobs let the assistant act on sites that have no API. Most actions wait
for the operator to approve them by typing the job id. One narrow path does not:
with `autonomous: true`, Instagram follows inside the caps run without a
per-action tick.

That flag lives in a JSON file under `CONFIG_DIR/browser/rules/`, writable by any
host session running at the same uid as the control server. A flag alone would
therefore be no control at all: a session could write itself `autonomous: true`
with its own allow-list and caps, and the poller would approve its own
proposals. Requiring a confirmation timestamp closes only half of it — one
confirmation at the operator's own caps, and any later writer could widen those
caps to the maximum and swap in a different target list while carrying the
confirmation forward untouched.

## Decision

`autonomous: true` is honoured only when the record carries both
`autonomy_confirmed_at` and `autonomy_scope_sha256`, where the hash covers **the
whole validated record except those two fields**, not an enumerated subset.
`validateRules` recomputes it on every read and reads `autonomous: false` on any
mismatch. `PUT /api/v1/browser/sites/:site/rules`, behind a typed site name, is
the only writer of either field; `writeRules` deletes both from any input it is
given, and `scripts/browser-rules.mjs` rebuilds the record without them.

Hashing the whole record rather than a list of fields is the load-bearing part.
An enumerated subset has to be extended by hand every time the record grows, and
the failure mode of forgetting is silent widening. Whole-record coverage means
every field Phase E2 adds is covered on the day it is added.

The invariant this buys, stated exactly: **the rules in force are byte-identical
to the rules the operator confirmed.** Anything else reads as not autonomous.

## Consequences

Editing caps or the allow-list outside the dashboard costs one re-confirmation
inside it. That is the intended price, not a papercut.

**Named residual.** The invariant is weaker than "a pause consumes the
confirmation", and an earlier draft of the plan claimed the stronger property.
It is unreachable here. Pausing a site by hand-editing `enabled: false` breaks
the hash and autonomy goes inert, but editing it back restores the scope bytes
exactly, so the hash matches again — whether or not `enabled` is inside the
hashed scope. A monotonic counter or nonce outside that scope would not help,
because it is equally hand-writable by the same actor. Against every writer in
the system the stronger property does hold, since all of them destroy the
confirmation; only a raw file edit that preserves both fields can round-trip a
pause, and that actor can write any record they like in the first place.

This is deliberate and bounded: the mechanism defends against content-driven
mistakes, which is the realistic failure, not against a compromised same-uid
session, which nothing at one uid can defend against. The residual is recorded
in `docs/KNOWN_LIMITATIONS.md`.

## Reversibility

Reversible. The hash is recomputed on read and stored in the record itself, so
changing the canonical form or the covered scope costs one re-confirmation per
site and no migration. Removing the binding entirely would reopen the widening
path described above and should not be done without replacing it.
