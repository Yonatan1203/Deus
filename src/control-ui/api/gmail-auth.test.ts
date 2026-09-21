import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IS_WINDOWS } from '../../platform.js';
import {
  ACCOUNT_FILE,
  callbackPage,
  createGmailAuth,
  KEYS_FILE,
  readKeys,
  saveKeys,
  status,
  TOKENS_FILE,
  type CallbackResult,
} from './gmail-auth.js';

const REDIRECT = 'http://localhost:3017/api/v1/integrations/gmail/callback';
const SECRET = 'FIXTURE-SECRET-xyz';
const CLIENT = JSON.stringify({
  installed: {
    client_id: 'fixture.apps.googleusercontent.com',
    client_secret: SECRET,
    redirect_uris: [],
  },
});
const TOKENS = {
  access_token: 'ya29.FIXTURE-ACCESS',
  refresh_token: '1//FIXTURE-REFRESH',
  token_type: 'Bearer',
  expiry_date: 1790000000000,
  scope: 'https://www.googleapis.com/auth/gmail.modify',
};
let dir: string;
let clock: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-'));
  clock = Date.parse('2026-09-21T12:00:00.000Z');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
const read = (f: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Record<
    string,
    unknown
  >;
const mode = (f: string) => fs.statSync(path.join(dir, f)).mode & 0o777;

function auth(over: Partial<Parameters<typeof createGmailAuth>[0]> = {}) {
  const calls: {
    exchange: [string, string][];
    profile: string[];
    revoke: string[];
  } = { exchange: [], profile: [], revoke: [] };
  const a = createGmailAuth({
    dir,
    redirectUri: REDIRECT,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    exchange: async (code, verifier) => {
      calls.exchange.push([code, verifier]);
      return { ...TOKENS };
    },
    profile: async (token) => {
      calls.profile.push(token);
      return { emailAddress: 'fixture@example.invalid', messagesTotal: 1 };
    },
    revoke: async (token) => {
      calls.revoke.push(token);
    },
    ...over,
  });
  return { a, calls };
}
const issued = (a: ReturnType<typeof createGmailAuth>, sid = 'sid-1') => {
  const r = a.issueState(sid);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('saveKeys / readKeys', () => {
  it('rewrites a Desktop or web client as a fresh 0600 literal and rejects junk', () => {
    expect(saveKeys(dir, CLIENT, REDIRECT)).toBe('ok');
    if (!IS_WINDOWS) expect(mode(KEYS_FILE)).toBe(0o600);
    expect(read(KEYS_FILE)).toEqual({
      installed: {
        client_id: 'fixture.apps.googleusercontent.com',
        client_secret: SECRET,
        redirect_uris: [REDIRECT],
      },
    });
    expect(readKeys(dir)).toEqual({
      client_id: 'fixture.apps.googleusercontent.com',
      client_secret: SECRET,
    });
    const web = JSON.stringify({
      web: {
        client_id: 'w.apps.googleusercontent.com',
        client_secret: 's',
        project_id: 'p',
        extra: { deep: 1 },
      },
    });
    expect(saveKeys(dir, web, REDIRECT)).toBe('ok');
    expect(Object.keys(read(KEYS_FILE).installed as object)).toEqual([
      'client_id',
      'client_secret',
      'redirect_uris',
    ]);
    fs.unlinkSync(path.join(dir, KEYS_FILE));
    for (const bad of [
      '[]',
      'not json',
      JSON.stringify({
        installed: { client_id: 'x.apps.googleusercontent.com' },
      }),
      JSON.stringify({
        installed: { client_id: 'evil.example', client_secret: 's' },
      }),
      JSON.stringify({
        installed: {
          client_id: 'x.apps.googleusercontent.com',
          client_secret: '',
        },
      }),
      'x'.repeat(20 * 1024),
      42,
    ]) {
      expect(saveKeys(dir, bad, REDIRECT), String(bad).slice(0, 30)).toBe(
        'invalid',
      );
      expect(fs.existsSync(path.join(dir, KEYS_FILE))).toBe(false);
    }
    expect(readKeys(dir)).toBeNull();
    fs.writeFileSync(
      path.join(dir, KEYS_FILE),
      '{"installed":{"client_id":42}}',
    );
    expect(readKeys(dir)).toBe('invalid');
    const link = path.join(dir, 'link');
    fs.symlinkSync(path.join(dir, 'nope'), link);
    expect(saveKeys(link, CLIENT, REDIRECT)).toBe('unavailable');
  });
});

describe('issueState', () => {
  it('builds the consent URL with offline access, consent, the scope, PKCE and the state — never the secret', () => {
    saveKeys(dir, CLIENT, REDIRECT);
    const { a } = auth();
    const r = issued(a);
    expect(r.state).toMatch(/^[0-9a-f]{64}$/);
    expect(r.flowCookie).toMatch(/^[0-9a-f]{64}$/);
    const u = new URL(r.url);
    expect(u.origin + u.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('scope')).toBe(
      'https://www.googleapis.com/auth/gmail.modify',
    );
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('state')).toBe(r.state);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('client_id')).toBe(
      'fixture.apps.googleusercontent.com',
    );
    expect(r.url).not.toContain(SECRET);
    expect(
      createGmailAuth({
        dir: path.join(dir, 'missing'),
        redirectUri: REDIRECT,
      }).issueState('s'),
    ).toEqual({ error: 'credential dir unavailable' });
    fs.unlinkSync(path.join(dir, KEYS_FILE));
    expect(a.issueState('s')).toEqual({ error: 'client keys missing' });
    fs.writeFileSync(path.join(dir, KEYS_FILE), '{}');
    expect(a.issueState('s')).toEqual({ error: 'client keys invalid' });
  });

  it('keeps one pending state per session, five overall, and drops them on logout', () => {
    saveKeys(dir, CLIENT, REDIRECT);
    const { a } = auth();
    const first = issued(a, 'A');
    const second = issued(a, 'A');
    expect(a.pendingCount()).toBe(1);
    expect(second.state).not.toBe(first.state);
    for (const sid of ['B', 'C', 'D', 'E', 'F']) issued(a, sid);
    expect(a.pendingCount()).toBe(5);
    a.dropSession('B');
    expect(a.pendingCount()).toBe(4);
    a.dropAll();
    expect(a.pendingCount()).toBe(0);
  });
});

describe('consume', () => {
  it('refuses unknown, expired, mismatched and reused states, and Google errors', async () => {
    saveKeys(dir, CLIENT, REDIRECT);
    const { a, calls } = auth();
    expect(await a.consume('nope', 'x', { code: 'c' })).toMatchObject({
      ok: false,
      status: 403,
      message: 'state unknown or expired',
    });
    const exp = issued(a);
    clock += 11 * 60_000;
    expect(
      await a.consume(exp.state, exp.flowCookie, { code: 'c' }),
    ).toMatchObject({ status: 403, message: 'state unknown or expired' });
    const mis = issued(a);
    expect(await a.consume(mis.state, 'wrong', { code: 'c' })).toMatchObject({
      status: 403,
      message: 'flow cookie mismatch',
    });
    expect(
      await a.consume(mis.state, mis.flowCookie, { code: 'c' }),
    ).toMatchObject({ status: 403 }); // single use
    const den = issued(a);
    expect(
      await a.consume(den.state, den.flowCookie, { error: 'access_denied' }),
    ).toMatchObject({ status: 400, message: 'access denied' });
    const other = issued(a);
    expect(
      await a.consume(other.state, other.flowCookie, { error: 'server_error' }),
    ).toMatchObject({ status: 400, message: 'consent failed' });
    const bad = issued(a);
    expect(
      await a.consume(bad.state, bad.flowCookie, { code: 'x'.repeat(600) }),
    ).toMatchObject({ status: 400, message: 'invalid code' });
    expect(calls.exchange).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, TOKENS_FILE))).toBe(false);
  });

  it('exchanges with the PKCE verifier, writes both files 0600 and reports the email', async () => {
    saveKeys(dir, CLIENT, REDIRECT);
    const { a, calls } = auth();
    const r = issued(a);
    const challenge = new URL(r.url).searchParams.get('code_challenge');
    const res = await a.consume(r.state, r.flowCookie, {
      code: '4/fixture-code',
    });
    expect(res).toEqual({
      ok: true,
      email: 'fixture@example.invalid',
      message: 'connected',
    });
    expect(calls.exchange).toEqual([['4/fixture-code', calls.exchange[0][1]]]);
    const verifier = calls.exchange[0][1];
    expect(
      crypto.createHash('sha256').update(verifier).digest('base64url'),
    ).toBe(challenge);
    expect(calls.profile).toEqual([TOKENS.access_token]);
    if (!IS_WINDOWS) {
      expect(mode(TOKENS_FILE)).toBe(0o600);
      expect(mode(ACCOUNT_FILE)).toBe(0o600);
    }
    expect(read(TOKENS_FILE)).toEqual(TOKENS);
    expect(read(ACCOUNT_FILE)).toEqual({
      email: 'fixture@example.invalid',
      connected_at: '2026-09-21T12:00:00.000Z',
    });
    expect(a.pendingCount()).toBe(0);
    const s = status(dir, {
      channelLive: true,
      redirectUri: REDIRECT,
      now: () => Date.now() + 3_600_000,
    });
    expect(s).toMatchObject({
      keys: true,
      connected: true,
      email: 'fixture@example.invalid',
      channel_live: true,
      redirect_uri: REDIRECT,
    });
    expect(s.token_age_ms).toBeGreaterThan(0);
    expect(JSON.stringify(s)).not.toContain('FIXTURE-REFRESH');
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it('rejects token responses without a refresh token or with a bad shape, and invalid profiles', async () => {
    saveKeys(dir, CLIENT, REDIRECT);
    const cases: [Partial<typeof TOKENS> | Record<string, unknown>, string][] =
      [
        [{ ...TOKENS, refresh_token: undefined }, 'no refresh token'],
        [{ ...TOKENS, expiry_date: '12' }, 'token response invalid'],
        [{ ...TOKENS, access_token: '' }, 'token response invalid'],
      ];
    for (const [tokens, message] of cases) {
      const { a } = auth({ exchange: async () => tokens });
      const r = issued(a);
      expect(
        await a.consume(r.state, r.flowCookie, { code: 'c' }),
      ).toMatchObject({ ok: false, status: 502, message });
      expect(fs.existsSync(path.join(dir, TOKENS_FILE)), message).toBe(false);
    }
    for (const prof of [
      { emailAddress: 'x y@z' },
      { emailAddress: 'a'.repeat(400) + '@z' },
      { emailAddress: 42 },
      'nope',
    ]) {
      const { a } = auth({ profile: async () => prof });
      const r = issued(a);
      expect(
        await a.consume(r.state, r.flowCookie, { code: 'c' }),
      ).toMatchObject({ status: 502, message: 'profile invalid' });
      expect(fs.existsSync(path.join(dir, ACCOUNT_FILE))).toBe(false);
      expect(fs.existsSync(path.join(dir, TOKENS_FILE))).toBe(false);
    }
    // A throwing exchange carrying the secret in its config never surfaces it.
    const gaxios = Object.assign(
      new Error('Request failed with status code 400'),
      {
        code: '400',
        response: { status: 400, data: { error: 'invalid_grant' } },
        config: { data: `client_secret=${SECRET}&code=c` },
      },
    );
    const { a } = auth({
      exchange: async () => {
        throw gaxios;
      },
    });
    const r = issued(a);
    const res = await a.consume(r.state, r.flowCookie, { code: 'c' });
    expect(res).toEqual({
      ok: false,
      status: 502,
      message: 'exchange failed',
      detail: { code: '400', status: 400 },
    });
    expect(JSON.stringify(res)).not.toContain(SECRET);
  });
});

describe('disconnect / forgetKeys', () => {
  it('revokes, deletes, re-checks, and reports revoke or delete failures honestly', async () => {
    saveKeys(dir, CLIENT, REDIRECT);
    const { a, calls } = auth();
    const r = issued(a);
    await a.consume(r.state, r.flowCookie, { code: 'c' });
    expect(a.forgetKeys()).toBe('connected');
    expect(await a.disconnect()).toEqual({ revoked: true, deleted: true });
    expect(calls.revoke).toEqual([TOKENS.refresh_token]);
    expect(fs.existsSync(path.join(dir, TOKENS_FILE))).toBe(false);
    expect(fs.existsSync(path.join(dir, ACCOUNT_FILE))).toBe(false);
    expect(a.forgetKeys()).toBe('ok');
    expect(fs.existsSync(path.join(dir, KEYS_FILE))).toBe(false);
    expect(a.forgetKeys()).toBe('missing');
    // A concurrent writer re-creates the file once: caught by the re-check.
    saveKeys(dir, CLIENT, REDIRECT);
    let writes = 0;
    const { a: b } = auth({
      revoke: async () => {
        throw new Error('revoke failed');
      },
      sleep: async (ms) => {
        clock += ms;
        if (writes++ === 1)
          fs.writeFileSync(path.join(dir, TOKENS_FILE), JSON.stringify(TOKENS));
      },
    });
    const r2 = issued(b);
    await b.consume(r2.state, r2.flowCookie, { code: 'c' });
    expect(await b.disconnect()).toEqual({ revoked: false, deleted: true });
    expect(fs.existsSync(path.join(dir, TOKENS_FILE))).toBe(false);
    // A writer that never stops wins: reported, not hidden.
    const { a: c } = auth({
      sleep: async (ms) => {
        clock += ms;
        fs.writeFileSync(path.join(dir, TOKENS_FILE), JSON.stringify(TOKENS));
      },
    });
    const r3 = issued(c);
    await c.consume(r3.state, r3.flowCookie, { code: 'c' });
    expect(await c.disconnect()).toEqual({ revoked: true, deleted: false });
  });
});

describe('callbackPage', () => {
  it('fills the template with escaped closed-set text only', () => {
    const tpl = '<title>{{title}}</title><h1>{{message}}</h1>';
    const ok: CallbackResult = {
      ok: true,
      email: 'a<b@x.y',
      message: 'connected',
    };
    expect(callbackPage(tpl, ok, 'Deus & co')).toBe(
      '<title>Deus &amp; co Control</title><h1>Gmail connected as a&lt;b@x.y.</h1>',
    );
    const bad: CallbackResult = {
      ok: false,
      status: 403,
      message: 'flow cookie mismatch',
    };
    expect(callbackPage(tpl, bad, 'D')).toContain(
      'Gmail was not connected: flow cookie mismatch.',
    );
  });
});
