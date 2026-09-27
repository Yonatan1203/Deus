// Tool-allowlist construction for the CLAUDE-backend container run.
//
// Extracted from index.ts so the gating logic is unit-testable: index.ts runs
// `bootstrap(main, ...)` at module load, so importing helpers from it would
// execute the agent during tests. Pure functions only — no side effects — which
// also matches the existing helper-module pattern (doom-loop-detector.ts,
// context-registry.ts).

// Keywords that signal the prompt requires multi-agent *team* orchestration.
// When none are present and no external project is mounted, the team tools
// (TeamCreate, TeamDelete) are excluded from allowedTools to save ~200 tokens
// per call on personal-assistant queries.
//
// NOTE: SendMessage is deliberately NOT gated here. It pairs with the Task tool
// (always allowed) — the Task tool's own description advertises SendMessage as
// the way to continue a previously-spawned subagent (SDK sdk-tools.d.ts:297,
// "addressable via SendMessage({to: name})"). Gating it while Task stays
// unconditional made plain queries that spawned a Task subagent hit
// "SendMessage tool isn't available" (LIA-307).
export const SWARM_SIGNALS = [
  'parallel agent',
  'subagent',
  'agent team',
  'agent swarm',
  'orchestrate',
  'in parallel',
  'multiple agents',
  'spawn agent',
];

/**
 * Whether multi-agent *team* tools (TeamCreate/TeamDelete) should be offered.
 * True when an external project is mounted (engineering context) or the prompt
 * explicitly signals multi-agent intent via a SWARM_SIGNALS keyword.
 */
export function computeTeamsNeeded(
  prompt: string,
  hasProject: boolean,
): boolean {
  return (
    hasProject || SWARM_SIGNALS.some((kw) => prompt.toLowerCase().includes(kw))
  );
}

// LIA-315 Phase 2: minimal base toolset for webhook-originated (publicIngress)
// runs — read-only + orchestration-free. NO Bash/Write/Edit/Task/mcp__deus__* (R1).
const WEBHOOK_BASE = [
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'TodoWrite',
  'ToolSearch',
];

// LIA-315 Phase 2: tools that MAY be offered to a reduced-privilege webhook run
// (the webhook profile includes only `curatedTools ∩ SAFE_CURATED`). Hardcoded —
// never env-configurable — so a malformed/injected DEUS_CURATED_TOOLS can never
// widen the manifest. Curated names not in this set are silently dropped.
//
// EXACT tool names only (no globs): the host tool-proxy authorizes a scoped token
// by exact match (isToolAllowedForToken → Set.has(rawName)), so a glob like
// `mcp__linear__*` could never match a real call. Host-brokered MCP curated tools
// are deferred to Phase 4, when the manifest-glob ↔ proxy-exact namespace split is
// reconciled. Entry criteria: read-only, no in-container shell/file-write, no
// raw-secret access.
//
// SYNC-REQUIRED: this set is mirrored host-side in src/container-runner.ts
// (SAFE_CURATED) because the host and the container build as isolated packages and
// cannot share a module (cf. LIA-223 host↔container hand-duplicated contracts). The
// host pre-filters DEUS_CURATED_TOOLS + the scoped token; this is defense-in-depth.
export const SAFE_CURATED = new Set<string>([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
]);

export interface AllowedToolsOpts {
  /** Result of computeTeamsNeeded — gates TeamCreate/TeamDelete only. */
  teamsNeeded: boolean;
  /** Google Calendar MCP server is available for this run. */
  hasGcalMcp: boolean;
  /** Linear MCP server is available for this run. */
  hasLinearMcp: boolean;
  /**
   * LIA-315 Phase 2: execution profile. 'webhook' returns the reduced-privilege
   * manifest (WEBHOOK_BASE + curatedTools ∩ SAFE_CURATED). 'full' or undefined
   * returns the standard manifest (byte-identical to pre-Phase-2 behavior).
   */
  profile?: 'full' | 'webhook';
  /** LIA-315 Phase 2: curated tool names a webhook run requested (filtered by SAFE_CURATED). */
  curatedTools?: string[];
}

/**
 * Build the allowedTools manifest for a CLAUDE-backend run.
 *
 * SendMessage is unconditional (pairs with the always-present Task tool).
 * Only TeamCreate/TeamDelete are gated behind `teamsNeeded`.
 *
 * LIA-315 Phase 2: `profile: 'webhook'` returns a reduced-privilege manifest;
 * any other value (incl. undefined) returns the standard full manifest.
 */
export function buildAllowedTools(opts: AllowedToolsOpts): string[] {
  const { teamsNeeded, hasGcalMcp, hasLinearMcp, profile, curatedTools } = opts;
  if (profile === 'webhook') {
    // Reduced-privilege: minimal base + only the curated tools on the SAFE_CURATED
    // allowlist. Unsafe/unknown curated names drop silently (no info leak).
    return [
      ...WEBHOOK_BASE,
      ...(curatedTools ?? []).filter((t) => SAFE_CURATED.has(t)),
    ];
  }
  return [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'SendMessage',
    ...(teamsNeeded ? ['TeamCreate', 'TeamDelete'] : []),
    'TodoWrite',
    'ToolSearch',
    'Skill',
    'NotebookEdit',
    'mcp__deus__*',
    ...(hasGcalMcp ? ['mcp__gcal__*'] : []),
    ...(hasLinearMcp ? ['mcp__linear__*'] : []),
  ];
}

// Removed from the model's context for webhook runs even if another option
// would have offered them (defence in depth under `tools`).
const WEBHOOK_DENY = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Task',
  'KillShell',
];

/**
 * SDK query options that make the webhook (publicIngress) profile real.
 * `allowedTools` alone only pre-approves tools; under bypassPermissions every
 * other tool stays callable. For webhook runs: `tools` limits the built-ins,
 * no MCP servers, `dontAsk` denies anything not pre-approved, and no settings
 * files are loaded. Spread LAST into the query options. Full profile → `{}`.
 */
export function webhookQueryRestrictions(
  profile: 'full' | 'webhook',
  allowedTools: string[],
): {
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: Record<string, never>;
  permissionMode?: 'dontAsk';
  allowDangerouslySkipPermissions?: false;
  settingSources?: [];
  strictMcpConfig?: true;
} {
  if (profile !== 'webhook') return {};
  return {
    tools: [...allowedTools],
    disallowedTools: WEBHOOK_DENY.filter((t) => !allowedTools.includes(t)),
    mcpServers: {},
    permissionMode: 'dontAsk',
    allowDangerouslySkipPermissions: false,
    settingSources: [],
    strictMcpConfig: true,
  };
}

/**
 * Session slash commands run a separate query without the webhook
 * restrictions, so a webhook run must never take that path.
 */
export function refuseSessionCommand(
  profile: 'full' | 'webhook',
  isSessionCommand: boolean,
): boolean {
  return profile === 'webhook' && isSessionCommand;
}

/**
 * Fail-closed check on the SDK's init message for a webhook run: the tools
 * actually offered must be within the manifest, with no MCP servers or
 * plugins. Throws with the offending names only.
 */
export function assertWebhookInit(
  init: { tools: string[]; mcp_servers: unknown[]; plugins?: unknown[] },
  manifest: string[],
): void {
  const extra = init.tools.filter(
    (t) => t.startsWith('mcp__') || !manifest.includes(t),
  );
  const problems: string[] = [];
  if (extra.length > 0) problems.push(`tools: ${extra.join(', ')}`);
  if (init.mcp_servers.length > 0)
    problems.push(`mcp_servers: ${init.mcp_servers.length}`);
  if ((init.plugins ?? []).length > 0)
    problems.push(`plugins: ${(init.plugins ?? []).length}`);
  if (problems.length > 0) {
    throw new Error(`webhook run refused: ${problems.join('; ')}`);
  }
}
