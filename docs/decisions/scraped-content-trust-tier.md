---
name: Scraped social content is a distinct, attacker-authored trust tier
description: >
  Records the trust model for the Apify scraper integration: scraped
  Instagram/TikTok/Facebook content is attacker-authored input landing in a
  container that holds Bash, WebFetch, Write and APIFY_TOKEN, and no existing
  scanner covers tool results. Documents the accepted residual risk, the
  containment layers that do exist (explicit tool allowlist, scoped token,
  publicIngress exclusion, redaction, telemetry off), and the named follow-ups.
type: decision
tags: [apify, scrapers, prompt-injection, trust-boundary, mcp, security]
date: 2026-08-25
---

# Scraped social content is a distinct trust tier

**Date:** 2026-08-25
**Scope:** The Apify Actors MCP integration (Instagram / TikTok / Facebook Ads
scrapers) on both surfaces — container agents and host-side Claude Code.
Documents the trust model and the deliberate residual-risk acceptance for
prompt injection via scraped content; specifies no new scanning mechanism.
**Status:** Accepted with this integration's security-fix pass (the branch
resolving the 2026-08-23 dual-warden REVISE).

## Context

Apify actor tools return scraped social content — captions, bios, comments, ad
copy — into the agent's context. Unlike Linear (where planting a payload
requires account access), **no access is needed here**: a public post plus a
hashtag scrape delivers arbitrary attacker-authored text into a container that
also holds `Bash`, `WebFetch`, `Write`, and `APIFY_TOKEN` in env.

The repo's `injection-scanner.ts` is pre-ingestion only (inbound user
prompts), off by default, and logOnly — it never runs on tool results. No
existing mechanism tags or scans MCP tool output.

## Decision

1. **Scraped content is treated as untrusted, attacker-authored input** — the
   same tier as inbound webhook text, NOT the same tier as user prompts. The
   add-apify skill and group-level usage guidance say so explicitly; agents
   consuming scrape results must treat embedded instructions as data.
2. **Containment is capability-reduction, not content-scanning**, in layers:
   - Explicit per-tool allowlist (`apify-mcp.ts`) — no wildcard; the
     arbitrary-id `abort-actor-run` / `get-key-value-store-record` are never
     granted.
   - Scoped token (run-only + own-run storages), so the two granted helper
     tools are inert beyond this integration's own runs at the API layer.
   - No token in `publicIngress` containers; token redacted from container
     failure logs.
   - Third-party telemetry disabled: the package's Sentry bootstrap
     initializes at import against a hardcoded third-party DSN unless
     disabled, and its pre-yargs argv scan matches only
     `--telemetry-enabled=false` (equals form), `--no-telemetry-enabled`, or
     `TELEMETRY_ENABLED=false` — so both the env var and the equals-form flag
     are set at both invocation sites (verified against
     `@apify/actors-mcp-server@0.15.1` `dist/instrument.js:17-24`;
     re-verify on any version bump, along with the tool-naming port in
     `apify-mcp.ts`).
3. **Mechanical mitigation of tool-result injection is deferred, named, and
   tracked** — not silently dropped. Extending the injection scanner (or
   boundary-tagging) to MCP tool results is a real gap shared by every MCP
   integration in the repo, not Apify-specific, and belongs to its own scoped
   change.

## Residual risk accepted

A scraped caption can still attempt to steer the consuming agent. The blast
radius is bounded by the container's own tool grants and the scoped token —
an injected instruction cannot widen the tool manifest, reach other Apify
account data, or exfiltrate the token via failure logs. This residual risk is
accepted until the tool-result scanning follow-up lands.

## Follow-ups (named, out of this branch's scope)

- Tool-result injection scanning / boundary-tagging for MCP outputs
  (repo-wide, all MCP integrations).
- Retrofit `add-linear`'s launcher from whole-file `set -a; . .env` sourcing
  to the two-key extraction pattern introduced by `add-apify` (same
  over-broad env-export shape, user scope).
