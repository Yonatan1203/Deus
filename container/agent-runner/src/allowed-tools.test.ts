import { describe, it, expect } from 'vitest';
import {
  buildAllowedTools,
  computeTeamsNeeded,
  SWARM_SIGNALS,
} from './allowed-tools.js';

describe('buildAllowedTools', () => {
  const base = { hasGcalMcp: false, hasLinearMcp: false };

  it('always includes SendMessage — it pairs with the always-present Task tool (LIA-307)', () => {
    expect(buildAllowedTools({ ...base, teamsNeeded: false })).toContain(
      'SendMessage',
    );
    expect(buildAllowedTools({ ...base, teamsNeeded: true })).toContain(
      'SendMessage',
    );
  });

  it('always includes the Task tools regardless of teamsNeeded', () => {
    for (const teamsNeeded of [false, true]) {
      const tools = buildAllowedTools({ ...base, teamsNeeded });
      expect(tools).toEqual(
        expect.arrayContaining(['Task', 'TaskOutput', 'TaskStop']),
      );
    }
  });

  it('gates TeamCreate/TeamDelete behind teamsNeeded', () => {
    const off = buildAllowedTools({ ...base, teamsNeeded: false });
    expect(off).not.toContain('TeamCreate');
    expect(off).not.toContain('TeamDelete');

    const on = buildAllowedTools({ ...base, teamsNeeded: true });
    expect(on).toContain('TeamCreate');
    expect(on).toContain('TeamDelete');
  });

  it('gates the gcal/linear MCP wildcards by their flags', () => {
    const none = buildAllowedTools({ ...base, teamsNeeded: false });
    expect(none).not.toContain('mcp__gcal__*');
    expect(none).not.toContain('mcp__linear__*');

    const both = buildAllowedTools({
      teamsNeeded: false,
      hasGcalMcp: true,
      hasLinearMcp: true,
    });
    expect(both).toContain('mcp__gcal__*');
    expect(both).toContain('mcp__linear__*');
  });

  const APIFY_ACTORS = [
    'apify/instagram-scraper',
    'clockworks/tiktok-scraper',
    'apify/facebook-ads-scraper',
  ];
  const APIFY_EXPECTED = [
    'mcp__apify__apify--instagram-scraper',
    'mcp__apify__clockworks--tiktok-scraper',
    'mcp__apify__apify--facebook-ads-scraper',
    'mcp__apify__get-dataset-items',
    'mcp__apify__get-actor-run',
  ];

  it('offers the explicit apify tool entries when hasApifyMcp is set', () => {
    const tools = buildAllowedTools({
      ...base,
      teamsNeeded: false,
      hasApifyMcp: true,
      apifyActors: APIFY_ACTORS,
    });
    expect(tools).toEqual(expect.arrayContaining(APIFY_EXPECTED));
    // Never a wildcard, and never the excluded auto-injected tools — the
    // server manifest is wider than --tools suggests (arbitrary-id storage
    // and run tools), so membership must be exact.
    expect(tools).not.toContain('mcp__apify__*');
    expect(tools).not.toContain('mcp__apify__abort-actor-run');
    expect(tools).not.toContain('mcp__apify__get-key-value-store-record');
  });

  it('offers no apify entries when the flag is off, absent, or actors are missing', () => {
    // Omitted flag must behave as "no APIFY_TOKEN on the host" — a default-on
    // Apify manifest would offer scraper tools to every container.
    const noApify = (tools: string[]) =>
      expect(tools.filter((t) => t.startsWith('mcp__apify__'))).toEqual([]);
    noApify(buildAllowedTools({ ...base, teamsNeeded: false }));
    noApify(
      buildAllowedTools({ ...base, teamsNeeded: false, hasApifyMcp: false }),
    );
    // Flag set but no actor list: nothing to derive entries from — stay closed.
    noApify(
      buildAllowedTools({ ...base, teamsNeeded: false, hasApifyMcp: true }),
    );
  });

  it('never offers apify tools under the webhook profile (LIA-315 R2)', () => {
    // publicIngress containers get no APIFY_TOKEN injected, but the manifest
    // must not offer any apify entry even if the flag were somehow set.
    const webhook = buildAllowedTools({
      ...base,
      teamsNeeded: false,
      hasApifyMcp: true,
      apifyActors: APIFY_ACTORS,
      profile: 'webhook',
    });
    expect(webhook.filter((t) => t.startsWith('mcp__apify__'))).toEqual([]);
  });

  it('always includes the core + deus MCP tools', () => {
    const tools = buildAllowedTools({ ...base, teamsNeeded: false });
    expect(tools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        'mcp__deus__*',
      ]),
    );
  });
});

describe('computeTeamsNeeded', () => {
  it('is true when an external project is mounted, even with a plain prompt', () => {
    expect(computeTeamsNeeded('what time is it?', true)).toBe(true);
  });

  it('is true when the prompt contains any swarm signal (case-insensitive)', () => {
    for (const kw of SWARM_SIGNALS) {
      expect(computeTeamsNeeded(`please ${kw.toUpperCase()} this`, false)).toBe(
        true,
      );
    }
  });

  it('is false for a plain query with no project and no swarm signal', () => {
    expect(computeTeamsNeeded('remind me to buy milk', false)).toBe(false);
  });
});
