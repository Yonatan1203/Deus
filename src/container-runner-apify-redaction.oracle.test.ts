/**
 * Oracle tests for the APIFY_TOKEN credential-containment fix.
 * Authored from the spec BEFORE the fix exists (oracle-author warden) —
 * blind to any in-progress implementation of the fix itself.
 *
 * Contract under test (from spec):
 *   1. REDACTION: redactContainerArgs() must redact the value of
 *      APIFY_TOKEN from its returned log string — a raw token value must
 *      never appear in the rendered output; it must render as
 *      `APIFY_TOKEN=[REDACTED]`.
 *      As of authoring, redactContainerArgs (src/container-runner.ts) only
 *      handles DEUS_PROXY_TOKEN and LINEAR_API_KEY — this suite is RED
 *      against that code and must go GREEN once APIFY_TOKEN redaction is
 *      added.
 *   2. PUBLIC-INGRESS ABSENCE: buildContainerArgs() must never emit
 *      APIFY_TOKEN in any arg element for a publicIngress (webhook) group,
 *      even when process.env.APIFY_TOKEN is set. This already holds in the
 *      current implementation (the APIFY_TOKEN injection lives inside the
 *      `if (!isPublicIngress)` branch) — this test pins it against
 *      regression and is expected GREEN today.
 *      (Non-publicIngress containers DO get APIFY_TOKEN injected — that is
 *      intended, out of scope here, and not asserted by this file.)
 *
 * Every test is tagged @oracle so the oracle-integrity gate can protect it.
 *
 * TEST-SEAM REQUIREMENT imposed on the implementer:
 *   - redactContainerArgs MUST be exported from src/container-runner.ts.
 *     It is currently module-internal (`function redactContainerArgs`).
 *     Add:
 *       export function redactContainerArgs(...) { ... }
 *     This mirrors the precedent already set for buildContainerArgs (see
 *     container-runner-phase2.oracle.test.ts) — an export added purely as a
 *     test seam, no other restructuring. Until exported, the import below
 *     resolves to `undefined` and the redaction describe block fails at
 *     call time (TypeError: redactContainerArgs is not a function), which
 *     is itself a valid RED signal for "the fix (including its test seam)
 *     has not landed yet."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { RegisteredGroup } from './types.js';

// ---------------------------------------------------------------------------
// Module mocks (same pattern as container-runner-phase2.oracle.test.ts)
// ---------------------------------------------------------------------------

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'deus-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  CONFIG_DIR: '/tmp/deus-test-config',
  CONTEXT_AUTO_COMPACT_PCT: 75,
  CONTEXT_WARN_PCT: 70,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/deus-test-data',
  DEUS_CONTEXT_FILE_MAX_CHARS: '',
  DEUS_OPENAI_MODEL: '',
  GROUPS_DIR: '/tmp/deus-test-groups',
  HOME_DIR: '/tmp/deus-test-home',
  IDLE_TIMEOUT: 1800000,
  LLAMA_CPP_AGENT_MODEL: '',
  LLAMA_CPP_MODEL: '',
  LLAMA_CPP_PORT: '8765',
  TIMEZONE: 'America/Los_Angeles',
  TOOL_PROXY_PORT: 3003,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((hostPath: string, containerPath: string) => [
    '-v',
    `${hostPath}:${containerPath}:ro`,
  ]),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/deus-test-groups/${folder}`,
  ),
  resolveGroupIpcPath: vi.fn(
    (folder: string) => `/tmp/deus-test-groups/${folder}/ipc`,
  ),
}));

// group-tokens.js is deliberately NOT mocked — buildContainerArgs needs the
// real getOrCreateScopedToken/getOrCreateGroupToken behavior, same rationale
// as container-runner-phase2.oracle.test.ts.

vi.mock('./db.js', () => ({
  getProjectById: vi.fn(() => undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the flat -e KEY=VALUE args array into a map, same as the phase2 oracle. */
function parseEnvArgs(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-e' && i + 1 < args.length) {
      const pair = args[i + 1];
      const eqIdx = pair.indexOf('=');
      if (eqIdx !== -1) {
        env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
      }
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Oracle (1): redactContainerArgs must redact APIFY_TOKEN
// ---------------------------------------------------------------------------

describe('oracle (1): redactContainerArgs redacts APIFY_TOKEN', () => {
  it('redacts a realistic apify_api_ token value, never leaking it raw', async () => {
    // @oracle: spec item 1 — raw APIFY_TOKEN value must never appear in the log string
    const mod = (await import('./container-runner.js')) as unknown as {
      redactContainerArgs?: (args: string[]) => string;
    };
    expect(
      typeof mod.redactContainerArgs,
      'redactContainerArgs must be exported from src/container-runner.ts as a test seam',
    ).toBe('function');

    const rawToken = 'apify_api_XXXX';
    const args = [
      'run',
      '-i',
      '--rm',
      '--name',
      'test-container',
      '-e',
      `APIFY_TOKEN=${rawToken}`,
      '-e',
      'DEUS_APIFY_ACTORS=apify/instagram-scraper',
    ];

    const rendered = mod.redactContainerArgs!(args);

    // The discriminating assertions: raw value gone, placeholder present.
    expect(rendered).not.toContain(rawToken);
    expect(rendered).toContain('APIFY_TOKEN=[REDACTED]');
  });

  it('redacts APIFY_TOKEN even when it is the only credential present (no DEUS_PROXY_TOKEN/LINEAR_API_KEY)', async () => {
    // @oracle: spec item 1 — redaction is unconditional on APIFY_TOKEN's own presence,
    // not accidentally dependent on the other two credential patterns also matching
    const mod = (await import('./container-runner.js')) as unknown as {
      redactContainerArgs?: (args: string[]) => string;
    };
    expect(typeof mod.redactContainerArgs).toBe('function');

    const rawToken = 'apify_api_someverysecrettoken12345';
    const args = ['-e', `APIFY_TOKEN=${rawToken}`];

    const rendered = mod.redactContainerArgs!(args);

    expect(rendered).not.toContain(rawToken);
    expect(rendered).toMatch(/APIFY_TOKEN=\[REDACTED\]/);
  });
});

// ---------------------------------------------------------------------------
// Oracle (2): publicIngress containers never receive APIFY_TOKEN
// ---------------------------------------------------------------------------

describe('oracle (2): publicIngress group never gets APIFY_TOKEN', () => {
  const savedApifyToken = process.env.APIFY_TOKEN;

  beforeEach(async () => {
    process.env.APIFY_TOKEN = 'apify_api_shouldNeverLeakIntoWebhook';
    const { _clearTokens } = await import('./group-tokens.js');
    _clearTokens();
  });

  afterEach(async () => {
    if (savedApifyToken === undefined) {
      delete process.env.APIFY_TOKEN;
    } else {
      process.env.APIFY_TOKEN = savedApifyToken;
    }
    const { _clearTokens } = await import('./group-tokens.js');
    _clearTokens();
  });

  it('publicIngress group args contain no APIFY_TOKEN entry, even though process.env.APIFY_TOKEN is set', async () => {
    // @oracle: spec item 2 — regression guard for R2 credential containment on Apify token
    const { buildContainerArgs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 'Webhook Group',
      folder: 'webhook-group-apify',
      trigger: '@Webhook',
      added_at: new Date().toISOString(),
      containerConfig: {
        publicIngress: true,
      },
    };

    const args = buildContainerArgs(
      [],
      'webhook-container-apify',
      'claude',
      'iid-apify-1',
      group,
    );
    const env = parseEnvArgs(args);

    // No APIFY_TOKEN key in the parsed env map...
    expect(env).not.toHaveProperty('APIFY_TOKEN');
    // ...and belt-and-suspenders: no element of the raw args array contains
    // the substring "APIFY_TOKEN" at all (catches any format variation,
    // e.g. a differently-cased or differently-delimited injection).
    expect(args.some((a) => a.includes('APIFY_TOKEN'))).toBe(false);
    // The actual secret value must not appear anywhere in the args either.
    expect(args.join(' ')).not.toContain(
      'apify_api_shouldNeverLeakIntoWebhook',
    );
  });

  it('a non-publicIngress group DOES get APIFY_TOKEN (control case, confirms the test env var actually flows)', async () => {
    // @oracle: control for spec item 2 — proves the negative assertion above is meaningful
    // (not vacuously true because process.env.APIFY_TOKEN never reaches buildContainerArgs)
    const { buildContainerArgs } = await import('./container-runner.js');
    const group: RegisteredGroup = {
      name: 'Normal Group',
      folder: 'normal-group-apify',
      trigger: '@Deus',
      added_at: new Date().toISOString(),
    };

    const args = buildContainerArgs(
      [],
      'normal-container-apify',
      'claude',
      'iid-apify-2',
      group,
    );
    const env = parseEnvArgs(args);

    expect(env['APIFY_TOKEN']).toBe('apify_api_shouldNeverLeakIntoWebhook');
  });
});
