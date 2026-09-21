// Independent oracle for Phase D ("Connect Gmail"). Authored from the plan
// at docs/superpowers/specs/2026-09-21-control-ui-scope2-design.md § D and
// the "Global Constraints" / Design bullets of
// 2026-09-21-control-ui-phaseD.md — BEFORE any implementation of
// `./gmail-auth.js` exists. Blind to the implementation by construction
// (oracle-author rule `independence`, .claude/wardens/oracle-rules.md).
//
// Expected RED: `./gmail-auth.js` does not exist yet, so every test in this
// file fails at import time (module resolution error), which is the correct
// "red" state per `oracle-rules.md` `red-green-able`. Once Task 1 implements
// the module, these tests must go green without modification.
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../../platform.js';
// Authored blind, before the module existed (the red state was the import failing).
import { createGmailAuth, saveKeys } from './gmail-auth.js';

const T0 = Date.parse('2026-09-21T12:00:00.000Z');
const MINUTE = 60 * 1000;

const REDIRECT_URI = 'http://localhost:3017/api/v1/integrations/gmail/callback';

// Fixture-only credentials -- never real. Distinctive strings so a
// substring leak is unambiguous (rule 8 below).
const FIXTURE_SECRET = 'FIXTURE-SECRET-xyz';
const FIXTURE_ACCESS_TOKEN = 'FIXTURE-ACCESS-TOKEN-abc123';
const FIXTURE_REFRESH_TOKEN = 'FIXTURE-REFRESH-TOKEN-xyz789';
const FIXTURE_EMAIL = 'fixture@example.invalid';
const CLIENT_JSON = {
  installed: {
    client_id: 'fixture.apps.googleusercontent.com',
    client_secret: FIXTURE_SECRET,
    redirect_uris: [] as string[],
  },
};
const SECRET_STRINGS = [
  FIXTURE_SECRET,
  FIXTURE_ACCESS_TOKEN,
  FIXTURE_REFRESH_TOKEN,
];

function s256(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/** Records (code, verifier) it was called with and resolves a full token set. */
function makeExchange(
  result:
    | Record<string, unknown>
    | (() => Record<string, unknown>)
    | (() => never) = () => ({
    access_token: FIXTURE_ACCESS_TOKEN,
    refresh_token: FIXTURE_REFRESH_TOKEN,
    token_type: 'Bearer',
    expiry_date: T0 + 3600_000,
    scope: 'https://www.googleapis.com/auth/gmail.modify',
  }),
) {
  const calls: Array<{ code: string; verifier: string }> = [];
  const fn = async (code: string, verifier: string) => {
    calls.push({ code, verifier });
    return typeof result === 'function' ? result() : result;
  };
  return Object.assign(fn, { calls });
}

/** Records the access token it was called with and resolves a profile. */
function makeProfile(
  result: Record<string, unknown> | (() => Record<string, unknown>) = {
    emailAddress: FIXTURE_EMAIL,
  },
) {
  const calls: string[] = [];
  const fn = async (accessToken: string) => {
    calls.push(accessToken);
    return typeof result === 'function' ? result() : result;
  };
  return Object.assign(fn, { calls });
}

function makeRevoke(behavior: 'ok' | 'throw' = 'ok') {
  const calls: string[] = [];
  const fn = async (token: string) => {
    calls.push(token);
    if (behavior === 'throw') throw new Error('revoke failed');
  };
  return Object.assign(fn, { calls });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-auth-oracle-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes the fixture client JSON into `dir` via the module's own intake. */
function plantKeys() {
  const result = saveKeys(dir, JSON.stringify(CLIENT_JSON), REDIRECT_URI);
  expect(result).toBe('ok');
}

/** A clock the test controls, passed as the injected `now`. */
function makeClock(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const credFile = () => path.join(dir, 'credentials.json');
const acctFile = () => path.join(dir, 'account.json');
const keysFile = () => path.join(dir, 'gcp-oauth.keys.json');

describe('issueState', () => {
  it('// @oracle: Global Constraints "Consent URL" -- returns a 64-hex state and a URL carrying offline/consent/scope/PKCE/redirect/state, never the secret', () => {
    plantKeys();
    const clock = makeClock();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
    });

    const issued = auth.issueState('sid-1');
    expect('error' in issued).toBe(false);
    if ('error' in issued) return;

    expect(issued.state).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof issued.flowCookie).toBe('string');
    expect(issued.flowCookie.length).toBeGreaterThan(0);
    expect(issued.flowCookie).not.toBe(issued.state);

    const url = new URL(issued.url);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/gmail.modify',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe(issued.state);

    expect(issued.url).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(issued)).not.toContain(FIXTURE_SECRET);
  });
});

describe('consume -- rejections', () => {
  it('// @oracle: Global Constraints "Callback" (1) -- unknown state is refused with 403', async () => {
    plantKeys();
    const clock = makeClock();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
    });

    const result = await auth.consume('0'.repeat(64), 'any-cookie', {
      code: 'unused',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('// @oracle: Global Constraints "Consent URL" pending-state 10-minute expiry -- an 11-minute-old state is refused with 403', async () => {
    plantKeys();
    const clock = makeClock();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');
    clock.advance(11 * MINUTE);

    const result = await auth.consume(issued.state, issued.flowCookie, {
      code: 'unused',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('// @oracle: Global Constraints "Callback" (1) -- a mismatched flow cookie is refused with 403', async () => {
    plantKeys();
    const clock = makeClock();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');

    const result = await auth.consume(
      issued.state,
      'not-the-real-flow-cookie',
      {
        code: 'unused',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('// @oracle: Global Constraints "Callback" (1) -- a state is single-use: a second consume of the same state is refused with 403', async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');

    const first = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    expect(first.ok).toBe(true);

    const second = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-2',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(403);
  });

  it('// @oracle: Global Constraints "Callback" (2) -- error=access_denied from Google is refused with 400', async () => {
    plantKeys();
    const clock = makeClock();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');

    const result = await auth.consume(issued.state, issued.flowCookie, {
      error: 'access_denied',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });
});

describe('consume -- happy path and PKCE', () => {
  it('// @oracle: Global Constraints "Callback" (4)-(5) + Design "createGmailAuth" -- exchanges the code, validates PKCE S256, writes credentials.json (0600, exactly 5 fields) and account.json with the email', async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');
    const challenge = new URL(issued.url).searchParams.get('code_challenge');
    expect(challenge).toBeTruthy();

    const result = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.email).toBe(FIXTURE_EMAIL);

    // The exchange received the code from the callback and the PKCE
    // verifier whose S256 hash matches the challenge advertised in the URL.
    expect(exchange.calls).toHaveLength(1);
    expect(exchange.calls[0].code).toBe('AUTH-CODE-1');
    expect(s256(exchange.calls[0].verifier)).toBe(challenge);

    // The profile call received the access token from the exchange result.
    expect(profile.calls).toEqual([FIXTURE_ACCESS_TOKEN]);

    const creds = JSON.parse(fs.readFileSync(credFile(), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(creds).sort()).toEqual([
      'access_token',
      'expiry_date',
      'refresh_token',
      'scope',
      'token_type',
    ]);
    expect(creds).toEqual({
      access_token: FIXTURE_ACCESS_TOKEN,
      refresh_token: FIXTURE_REFRESH_TOKEN,
      token_type: 'Bearer',
      expiry_date: T0 + 3600_000,
      scope: 'https://www.googleapis.com/auth/gmail.modify',
    });
    if (!IS_WINDOWS) expect(fs.statSync(credFile()).mode & 0o777).toBe(0o600);

    const acct = JSON.parse(fs.readFileSync(acctFile(), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(acct.email).toBe(FIXTURE_EMAIL);
  });
});

describe('consume -- exchange/profile validation', () => {
  it('// @oracle: Global Constraints "Callback" (4) -- an exchange result without refresh_token is refused with 502 and writes no credentials.json', async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange(() => ({
      access_token: FIXTURE_ACCESS_TOKEN,
      token_type: 'Bearer',
      expiry_date: T0 + 3600_000,
      scope: 'https://www.googleapis.com/auth/gmail.modify',
    }));
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');

    const result = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(fs.existsSync(credFile())).toBe(false);
  });

  it('// @oracle: Global Constraints "Callback" (5) -- an invalid profile email is refused with 502 and writes no account.json', async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile({ emailAddress: 'x y@z' });
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
    });

    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');

    const result = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(502);
    expect(fs.existsSync(acctFile())).toBe(false);
  });
});

describe('disconnect', () => {
  async function connectOnce(revoke: ReturnType<typeof makeRevoke>) {
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
      revoke,
    });
    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');
    const result = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    if (!result.ok) throw new Error('setup failed: consume did not succeed');
    return auth;
  }

  it('// @oracle: Global Constraints "Disconnect" (1)-(4) -- revokes the refresh token and deletes both files', async () => {
    plantKeys();
    const revoke = makeRevoke('ok');
    const auth = await connectOnce(revoke);

    const result = await auth.disconnect();
    expect(result).toEqual({ revoked: true, deleted: true });
    expect(revoke.calls).toEqual([FIXTURE_REFRESH_TOKEN]);
    expect(fs.existsSync(credFile())).toBe(false);
    expect(fs.existsSync(acctFile())).toBe(false);
  });

  it('// @oracle: Global Constraints "Disconnect" -- a throwing revoke still deletes both files but reports revoked:false', async () => {
    plantKeys();
    const revoke = makeRevoke('throw');
    const auth = await connectOnce(revoke);

    const result = await auth.disconnect();
    expect(result.revoked).toBe(false);
    expect(result.deleted).toBe(true);
    expect(fs.existsSync(credFile())).toBe(false);
    expect(fs.existsSync(acctFile())).toBe(false);
  });
});

describe('forgetKeys', () => {
  it("// @oracle: Design 'forgetKeys' -- reports 'connected' and keeps the key file while a token exists", async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
    });
    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');
    const connected = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    if (!connected.ok) throw new Error('setup failed: consume did not succeed');

    expect(auth.forgetKeys()).toBe('connected');
    expect(fs.existsSync(keysFile())).toBe(true);
  });

  it("// @oracle: Design 'forgetKeys' -- reports 'ok' and deletes the key file once disconnected", async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile();
    const revoke = makeRevoke('ok');
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
      revoke,
    });
    const issued = auth.issueState('sid-1');
    if ('error' in issued) throw new Error('setup failed: issueState errored');
    const connected = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    if (!connected.ok) throw new Error('setup failed: consume did not succeed');
    await auth.disconnect();

    expect(auth.forgetKeys()).toBe('ok');
    expect(fs.existsSync(keysFile())).toBe(false);
  });

  it("// @oracle: Design 'forgetKeys' -- reports 'missing' when no client keys were ever saved", () => {
    const clock = makeClock();
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
    });
    expect(auth.forgetKeys()).toBe('missing');
  });
});

describe('secret containment', () => {
  it('// @oracle: Global Constraints "Credentials never render" -- no return value or thrown message from any call ever carries the fixture secret, refresh token, or access token', async () => {
    plantKeys();
    const clock = makeClock();
    const exchange = makeExchange();
    const profile = makeProfile();
    const revoke = makeRevoke('ok');
    const auth = createGmailAuth({
      dir,
      redirectUri: REDIRECT_URI,
      now: clock.now,
      exchange,
      profile,
      revoke,
    });

    const captured: unknown[] = [];

    const issued = auth.issueState('sid-1');
    captured.push(issued);
    if ('error' in issued) throw new Error('setup failed: issueState errored');

    const connected = await auth.consume(issued.state, issued.flowCookie, {
      code: 'AUTH-CODE-1',
    });
    captured.push(connected);

    captured.push(await auth.disconnect());
    captured.push(auth.forgetKeys());

    // A synthetic Gaxios-shaped error (client_secret/code in `config.data`,
    // as a real google-auth-library error carries them) thrown by the
    // exchange step of a fresh flow must not leak through the CallbackResult.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-auth-oracle-'));
    try {
      const result2 = saveKeys(dir2, JSON.stringify(CLIENT_JSON), REDIRECT_URI);
      expect(result2).toBe('ok');
      const clock2 = makeClock();
      const throwingExchange = makeExchange(() => {
        const err = new Error(
          'Request failed with status code 400',
        ) as Error & {
          config?: { data?: string };
        };
        err.config = {
          data: `client_secret=${FIXTURE_SECRET}&code=AUTH-CODE-1&refresh_token=${FIXTURE_REFRESH_TOKEN}`,
        };
        throw err;
      });
      const auth2 = createGmailAuth({
        dir: dir2,
        redirectUri: REDIRECT_URI,
        now: clock2.now,
        exchange: throwingExchange,
      });
      const issued2 = auth2.issueState('sid-2');
      if ('error' in issued2)
        throw new Error('setup failed: issueState errored');
      const failed = await auth2.consume(issued2.state, issued2.flowCookie, {
        code: 'AUTH-CODE-1',
      });
      captured.push(failed);
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect([400, 403, 502, 503]).toContain(failed.status);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }

    const blob = JSON.stringify(captured);
    for (const secret of SECRET_STRINGS) {
      expect(blob).not.toContain(secret);
    }
  });
});
