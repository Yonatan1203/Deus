import { describe, it, expect } from 'vitest';
import {
  DEFAULT_APIFY_ACTORS,
  actorNameToApifyToolName,
  apifyAllowedTools,
  buildApifyMcpServerConfig,
} from './apify-mcp.js';

const DEFAULT_ACTORS = DEFAULT_APIFY_ACTORS.split(',');

describe('actorNameToApifyToolName', () => {
  it('maps the three default actors to the names the server registers', () => {
    // Mirrors @apify/actors-mcp-server@0.15.1 actorNameToToolName: '/' → '--'.
    expect(actorNameToApifyToolName('apify/instagram-scraper')).toBe(
      'apify--instagram-scraper',
    );
    expect(actorNameToApifyToolName('clockworks/tiktok-scraper')).toBe(
      'clockworks--tiktok-scraper',
    );
    expect(actorNameToApifyToolName('apify/facebook-ads-scraper')).toBe(
      'apify--facebook-ads-scraper',
    );
  });

  it('replaces dots in the username with -dot-', () => {
    expect(actorNameToApifyToolName('some.org/scraper')).toBe(
      'some-dot-org--scraper',
    );
  });

  it('truncates over-64-char names and appends a 4-hex sha256 fragment', () => {
    // Worked example pinned against the package's algorithm: the mapped name is
    // 77 chars, so it truncates to 64-4-1=59 chars + '-' + first 4 hex chars of
    // sha256 of the ORIGINAL full name (slash form, not the mapped form).
    const name = actorNameToApifyToolName(
      'very-long-organization-name/extremely-long-actor-name-that-exceeds-the-limit',
    );
    expect(name).toBe(
      'very-long-organization-name--extremely-long-actor-name-that-a011',
    );
    expect(name.length).toBe(64);
  });
});

describe('apifyAllowedTools', () => {
  it('returns exactly one entry per actor plus the two result helpers', () => {
    expect(apifyAllowedTools(DEFAULT_ACTORS)).toEqual([
      'mcp__apify__apify--instagram-scraper',
      'mcp__apify__clockworks--tiktok-scraper',
      'mcp__apify__apify--facebook-ads-scraper',
      'mcp__apify__get-dataset-items',
      'mcp__apify__get-actor-run',
    ]);
  });

  it('never emits a wildcard or the excluded auto-injected tools', () => {
    const tools = apifyAllowedTools(DEFAULT_ACTORS);
    expect(tools).not.toContain('mcp__apify__*');
    expect(tools.some((t) => t.includes('*'))).toBe(false);
    // Auto-injected by the server but deliberately not allowlisted: each takes
    // an arbitrary id, and the result flow never needs them.
    expect(tools).not.toContain('mcp__apify__abort-actor-run');
    expect(tools).not.toContain('mcp__apify__get-key-value-store-record');
  });

  it('derives entries from the given actor list (override consistency)', () => {
    expect(apifyAllowedTools(['someone/custom-scraper'])).toEqual([
      'mcp__apify__someone--custom-scraper',
      'mcp__apify__get-dataset-items',
      'mcp__apify__get-actor-run',
    ]);
  });
});

describe('buildApifyMcpServerConfig', () => {
  const cfg = buildApifyMcpServerConfig(DEFAULT_ACTORS, 'apify_api_test');

  it('runs the globally-installed stdio server by absolute path, not npx', () => {
    expect(cfg.command).toBe('node');
    expect(cfg.args[0]).toBe(
      '/usr/local/lib/node_modules/@apify/actors-mcp-server/dist/stdio.js',
    );
    expect(cfg.args).toEqual(
      expect.arrayContaining(['--tools', DEFAULT_APIFY_ACTORS]),
    );
  });

  it('disables telemetry via the equals-form flag AND the env var', () => {
    // instrument.js's Sentry bootstrap scans raw argv BEFORE yargs parses, and
    // matches only the single-token equals form or the env var — the
    // two-token form ['--telemetry-enabled', 'false'] silently leaves Sentry
    // enabled. Pin the exact forms that actually work.
    expect(cfg.args).toContain('--telemetry-enabled=false');
    expect(cfg.args).not.toContain('--telemetry-enabled');
    expect(cfg.args).not.toContain('false');
    expect(cfg.env.TELEMETRY_ENABLED).toBe('false');
  });

  it('passes the token through env only', () => {
    expect(cfg.env.APIFY_TOKEN).toBe('apify_api_test');
    expect(cfg.args.join(' ')).not.toContain('apify_api_test');
  });
});
