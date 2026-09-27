/**
 * Oracle tests for Public Ingress Isolation — webhookQueryRestrictions() and
 * assertWebhookInit() in allowed-tools.ts.
 * Authored from the spec BEFORE implementation exists (oracle-author warden).
 * These tests are RED against the current tree (the two exports do not exist
 * yet) and must go GREEN once the implementer adds, to allowed-tools.ts:
 *
 *   - webhookQueryRestrictions(profile: 'full' | 'webhook', allowedTools: string[])
 *       => Partial<query options>, spread LAST into the SDK query() options.
 *     - 'full'    -> {} (no change to full-profile behavior)
 *     - 'webhook' -> {
 *         tools: allowedTools,               // exactly the passed manifest
 *         disallowedTools: [...],            // covers Bash/Write/Edit/MultiEdit/
 *                                             //   NotebookEdit/WebFetch/Task/KillShell
 *                                             //   not already absent via `tools`
 *         mcpServers: {},                     // no MCP server registered
 *         permissionMode: 'dontAsk',
 *         allowDangerouslySkipPermissions: not true,
 *         settingSources: [],
 *         strictMcpConfig: true,
 *         hooks: { ... no UserPromptSubmit key ... },
 *       }
 *
 *   - assertWebhookInit(init: { tools: string[]; mcp_servers: unknown[]; plugins?: unknown[] }, manifest: string[])
 *       - returns normally (void) when init.tools ⊆ manifest and mcp_servers/plugins
 *         are empty
 *       - THROWS when init.tools has a name outside manifest, or any mcp__*
 *         tool name, or mcp_servers/plugins is non-empty
 *
 * Every test is tagged @oracle so the oracle-integrity gate can protect it.
 *
 * TEST-SEAM REQUIREMENTS imposed on the implementer:
 *   - Both functions must be named exports of allowed-tools.ts.
 *   - webhookQueryRestrictions must be a pure function (no reliance on env,
 *     no side effects) so it can be called directly with synthetic inputs.
 *   - assertWebhookInit must throw a real Error (any subclass) on violation —
 *     the oracle checks `toThrow()`, not a specific message or return value.
 */

import { describe, it, expect } from 'vitest';
import {
  webhookQueryRestrictions,
  assertWebhookInit,
  buildAllowedTools,
} from './allowed-tools.js';

const DANGEROUS_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'Task',
  'KillShell',
];

// The real webhook manifest, per spec, built with the documented inputs.
const WEBHOOK_MANIFEST = buildAllowedTools({
  profile: 'webhook',
  teamsNeeded: false,
  hasGcalMcp: false,
  hasLinearMcp: false,
  curatedTools: [],
});

describe('oracle: webhookQueryRestrictions — full profile is a no-op', () => {
  it("profile 'full' returns an empty object", () => {
    // @oracle: full profile must not alter query options at all
    const restrictions = webhookQueryRestrictions('full', WEBHOOK_MANIFEST);
    expect(restrictions).toEqual({});
  });
});

describe('oracle: webhookQueryRestrictions — webhook profile tool surface', () => {
  it('tools equals exactly the passed manifest', () => {
    // @oracle: 1a — no other built-in tool is reachable beyond the manifest
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    expect(restrictions.tools).toEqual(WEBHOOK_MANIFEST);
  });

  it('none of the dangerous tools are in tools', () => {
    // @oracle: 1b — Bash/Write/Edit/MultiEdit/NotebookEdit/WebFetch/Task/KillShell absent from tools
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    for (const t of DANGEROUS_TOOLS) {
      expect(restrictions.tools).not.toContain(t);
    }
  });

  it('every dangerous tool absent from the manifest is explicitly disallowed', () => {
    // @oracle: 1b — belt-and-suspenders: SDK-level disallow list, not just omission
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    for (const t of DANGEROUS_TOOLS) {
      if (!WEBHOOK_MANIFEST.includes(t)) {
        expect(restrictions.disallowedTools).toContain(t);
      }
    }
  });
});

describe('oracle: webhookQueryRestrictions — webhook profile MCP isolation', () => {
  it('mcpServers is an empty object', () => {
    // @oracle: 1c — no MCP server registered for webhook runs
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    expect(restrictions.mcpServers).toEqual({});
  });

  it('mcpServers does not contain deus, gcal, or linear keys', () => {
    // @oracle: 1c — explicit check for the three known server keys, in case
    // an implementer tries a "present but empty-config" shortcut
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    const keys = Object.keys(restrictions.mcpServers ?? {});
    expect(keys).not.toContain('deus');
    expect(keys).not.toContain('gcal');
    expect(keys).not.toContain('linear');
  });
});

describe('oracle: webhookQueryRestrictions — webhook profile permission posture', () => {
  it("permissionMode is 'dontAsk'", () => {
    // @oracle: 1d — webhook runs never prompt (no human on the other end)
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    expect(restrictions.permissionMode).toBe('dontAsk');
  });

  it('allowDangerouslySkipPermissions is not true', () => {
    // @oracle: 1d — reduced privilege must not be paired with a blanket bypass
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    expect(restrictions.allowDangerouslySkipPermissions).not.toBe(true);
  });
});

describe('oracle: webhookQueryRestrictions — webhook profile config isolation', () => {
  it('settingSources is an empty array', () => {
    // @oracle: 1e — no filesystem settings (project/user/local) are loaded
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    expect(restrictions.settingSources).toEqual([]);
  });

  it('strictMcpConfig is true', () => {
    // @oracle: 1e — no MCP config merging from ambient/project sources
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    expect(restrictions.strictMcpConfig).toBe(true);
  });

  it('hooks contains no UserPromptSubmit entry', () => {
    // @oracle: 1f — no memory-retrieval hook fires for webhook-originated prompts
    const restrictions: any = webhookQueryRestrictions(
      'webhook',
      WEBHOOK_MANIFEST,
    );
    const hooks = restrictions.hooks ?? {};
    expect(
      Object.prototype.hasOwnProperty.call(hooks, 'UserPromptSubmit'),
    ).toBe(false);
  });
});

describe('oracle: assertWebhookInit — accepts a compliant init', () => {
  it('does not throw when init.tools is within the manifest and mcp_servers/plugins are empty', () => {
    // @oracle: 2 — compliant init (subset of manifest, no MCP, no plugins) passes
    expect(() =>
      assertWebhookInit(
        { tools: WEBHOOK_MANIFEST.slice(0, 2), mcp_servers: [], plugins: [] },
        WEBHOOK_MANIFEST,
      ),
    ).not.toThrow();
  });

  it('does not throw when init.tools exactly equals the manifest and plugins is omitted', () => {
    // @oracle: 2 — plugins is optional per the contract; omission must not be treated as a violation
    expect(() =>
      assertWebhookInit(
        { tools: [...WEBHOOK_MANIFEST], mcp_servers: [] },
        WEBHOOK_MANIFEST,
      ),
    ).not.toThrow();
  });
});

describe('oracle: assertWebhookInit — rejects a non-compliant init', () => {
  it('throws when init.tools contains a name outside the manifest (Bash)', () => {
    // @oracle: 2 — a leaked dangerous tool must be caught, not silently accepted
    expect(() =>
      assertWebhookInit(
        { tools: [...WEBHOOK_MANIFEST, 'Bash'], mcp_servers: [] },
        WEBHOOK_MANIFEST,
      ),
    ).toThrow();
  });

  it('throws when init.tools contains any mcp__* tool name', () => {
    // @oracle: 2 — a leaked MCP-backed tool must be caught even if not literally "Bash"
    expect(() =>
      assertWebhookInit(
        {
          tools: [...WEBHOOK_MANIFEST, 'mcp__deus__anything'],
          mcp_servers: [],
        },
        WEBHOOK_MANIFEST,
      ),
    ).toThrow();
  });

  it('throws when mcp_servers is non-empty', () => {
    // @oracle: 2 — any registered MCP server at init time is a violation regardless of tools
    expect(() =>
      assertWebhookInit(
        {
          tools: WEBHOOK_MANIFEST.slice(0, 1),
          mcp_servers: [{ name: 'deus' }],
        },
        WEBHOOK_MANIFEST,
      ),
    ).toThrow();
  });

  it('throws when plugins is non-empty', () => {
    // @oracle: 2 — a loaded plugin at init time is a violation regardless of tools
    expect(() =>
      assertWebhookInit(
        {
          tools: WEBHOOK_MANIFEST.slice(0, 1),
          mcp_servers: [],
          plugins: [{ name: 'some-plugin' }],
        },
        WEBHOOK_MANIFEST,
      ),
    ).toThrow();
  });
});
