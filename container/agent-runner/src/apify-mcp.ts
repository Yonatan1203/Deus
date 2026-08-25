// Apify Actors MCP configuration for the CLAUDE-backend container run.
//
// Extracted from index.ts for the same reason as allowed-tools.ts: index.ts
// runs `bootstrap(main, ...)` at module load, so importing helpers from it
// would execute the agent during tests. Pure functions only — no side effects.
//
// This module is the single source of truth for everything Apify-shaped: the
// default actor set, the actor-id → MCP-tool-name mapping, the explicit tool
// allowlist, and the stdio server config. Deriving the allowlist and the
// server config from the same actor list here is what guarantees a
// DEUS_APIFY_ACTORS override can never desynchronize them.

import { createHash } from 'node:crypto';

// Default scraper set. Overridable per-run via DEUS_APIFY_ACTORS without a
// container rebuild (parsed in index.ts, charset-validated host-side in
// container-runner.ts).
export const DEFAULT_APIFY_ACTORS =
  'apify/instagram-scraper,clockworks/tiktok-scraper,apify/facebook-ads-scraper';

// Mirrors @apify/actors-mcp-server@0.15.1 dist/mcp/const.js:4-5. The naming
// port below must be re-verified against the package source on any version
// bump — the pinned version lives in container/Dockerfile and the add-apify
// skill's launcher line.
const MAX_TOOL_NAME_LENGTH = 64;
const TOOL_NAME_HASH_LENGTH = 4;

// Result-retrieval helpers the server auto-injects whenever any actor tool is
// loaded (dist/utils/tools_loader.js). Actor tools do NOT inline dataset
// items — the model follows the run response's nextStep to get-dataset-items,
// and runs outlasting the 45s waitSecs cap need get-actor-run polling. The
// other two auto-injected tools (abort-actor-run, get-key-value-store-record)
// are deliberately NOT allowlisted: the result flow never needs them, and each
// takes an arbitrary id. API-layer containment for the two we do allow is the
// scoped token (run-only + own-run storages) — see the add-apify skill.
const APIFY_HELPER_TOOLS = ['get-dataset-items', 'get-actor-run'];

/**
 * Exact port of @apify/actors-mcp-server@0.15.1's actorNameToToolName
 * (dist/tools/actor_tool_naming.js): `username/actor-name` becomes
 * `username--actor-name`, dots in the username become `-dot-`, and names over
 * MAX_TOOL_NAME_LENGTH are truncated and suffixed with a sha256 fragment for
 * uniqueness. The port must stay byte-identical to the package's output or
 * the allowlist silently denies the real tool (fails safe, but fails).
 */
export function actorNameToApifyToolName(actorFullName: string): string {
  const slashIndex = actorFullName.indexOf('/');
  const username = slashIndex !== -1 ? actorFullName.slice(0, slashIndex) : '';
  const actorName =
    slashIndex !== -1 ? actorFullName.slice(slashIndex + 1) : actorFullName;
  const safeUsername = username.replace(/\./g, '-dot-');
  const fullName =
    slashIndex !== -1 ? `${safeUsername}--${actorName}` : actorName;
  if (fullName.length <= MAX_TOOL_NAME_LENGTH) {
    return fullName;
  }
  const hash = createHash('sha256')
    .update(actorFullName)
    .digest('hex')
    .slice(0, TOOL_NAME_HASH_LENGTH);
  return `${fullName.slice(0, MAX_TOOL_NAME_LENGTH - TOOL_NAME_HASH_LENGTH - 1)}-${hash}`;
}

/**
 * The explicit allowedTools entries for an Apify-enabled run: one named entry
 * per configured actor plus the two result-retrieval helpers. Never a
 * wildcard — the server's manifest is wider than its --tools flag suggests
 * (auto-injected storage/run tools), and a wildcard would re-grant whatever a
 * future server version adds.
 */
export function apifyAllowedTools(actors: string[]): string[] {
  return [
    ...actors.map((a) => `mcp__apify__${actorNameToApifyToolName(a)}`),
    ...APIFY_HELPER_TOOLS.map((t) => `mcp__apify__${t}`),
  ];
}

/**
 * The stdio MCP server entry for the Apify Actors server. Absolute path from
 * the global install (container/Dockerfile), never npx — a dispatch must not
 * reach the network to resolve its own binary.
 *
 * Telemetry is disabled via BOTH mechanisms the package checks: the
 * TELEMETRY_ENABLED env var is what dist/instrument.js:17-19 honors for its
 * pre-yargs Sentry bootstrap (the space-separated flag form never reaches
 * that raw argv scan), and the equals-form flag keeps the yargs-parsed event
 * tracking off even if a future version drops the env check.
 */
export function buildApifyMcpServerConfig(
  actors: string[],
  token: string,
): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: 'node',
    args: [
      '/usr/local/lib/node_modules/@apify/actors-mcp-server/dist/stdio.js',
      '--tools',
      actors.join(','),
      '--telemetry-enabled=false',
    ],
    env: {
      APIFY_TOKEN: token,
      TELEMETRY_ENABLED: 'false',
    },
  };
}
