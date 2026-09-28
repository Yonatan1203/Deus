import { describe, expect, it } from 'vitest';
import {
  classifyTailnet,
  isTailnetAddress,
  parseTailnetLogins,
} from './tailnet.js';

const HOST = 'dash.tail0000.ts.net:8443';
const cfg = { tailnetHost: HOST, tailnetLogins: ['a@x.com', 'b@y.com'] };
const req = (over: {
  host?: string;
  peer?: string;
  headers?: Record<string, string | string[] | undefined>;
}) => ({
  host: over.host ?? HOST,
  peer: over.peer ?? '127.0.0.1',
  headers: {
    'tailscale-user-login': 'a@x.com',
    'x-forwarded-for': '100.64.0.7',
    ...over.headers,
  },
});

describe('parseTailnetLogins', () => {
  it('splits, trims, lowercases and drops empties', () => {
    expect(parseTailnetLogins(' A@x.com , ,b@y.com ')).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });
  it('empty or blank input is an empty list', () => {
    expect(parseTailnetLogins('')).toEqual([]);
    expect(parseTailnetLogins(' , ')).toEqual([]);
    expect(parseTailnetLogins(undefined)).toEqual([]);
  });
});

describe('isTailnetAddress', () => {
  it.each([
    ['100.64.0.7', true],
    ['100.127.255.255', true],
    ['100.63.0.1', false],
    ['100.128.0.1', false],
    ['1.2.3.4', false],
    ['fd7a:115c:a1e0::1', true],
    ['fd7a:115c:a1e1::1', false],
    ['garbage', false],
    ['', false],
  ])('%s → %s', (v, want) => expect(isTailnetAddress(v)).toBe(want));
});

describe('classifyTailnet', () => {
  it('feature off (no host or empty list) → none', () => {
    expect(classifyTailnet(req({}), {})).toEqual({ kind: 'none' });
    expect(
      classifyTailnet(req({}), { tailnetHost: HOST, tailnetLogins: [] }),
    ).toEqual({ kind: 'none' });
  });
  it('another Host → none (the localhost path decides)', () => {
    expect(classifyTailnet(req({ host: 'localhost:3017' }), cfg)).toEqual({
      kind: 'none',
    });
  });
  it('right host, listed login, one tailnet address, from loopback → ok', () => {
    expect(classifyTailnet(req({}), cfg)).toEqual({
      kind: 'ok',
      ip: '100.64.0.7',
      login: 'a@x.com',
    });
    expect(classifyTailnet(req({ peer: '::1' }), cfg).kind).toBe('ok');
    expect(
      classifyTailnet(
        req({ headers: { 'tailscale-user-login': 'B@Y.com' } }),
        cfg,
      ),
    ).toMatchObject({ kind: 'ok', login: 'b@y.com' });
  });
  it('Host matched case-insensitively; hyphenated names work', () => {
    expect(classifyTailnet(req({ host: HOST.toUpperCase() }), cfg).kind).toBe(
      'ok',
    );
    const h = 'my-dash.tail0000.ts.net:8443';
    expect(
      classifyTailnet(req({ host: h }), { ...cfg, tailnetHost: h }).kind,
    ).toBe('ok');
  });
  it('not from loopback → refused', () => {
    expect(classifyTailnet(req({ peer: '10.0.0.5' }), cfg)).toEqual({
      kind: 'refused',
      reason: 'not-loopback',
    });
  });
  it('login missing, unlisted, or a look-alike → refused', () => {
    expect(
      classifyTailnet(
        req({ headers: { 'tailscale-user-login': undefined } }),
        cfg,
      ),
    ).toEqual({ kind: 'refused', reason: 'login-missing' });
    expect(
      classifyTailnet(
        req({ headers: { 'tailscale-user-login': 'c@z.com' } }),
        cfg,
      ),
    ).toEqual({ kind: 'refused', reason: 'login-mismatch' });
    expect(
      classifyTailnet(
        req({ headers: { 'tailscale-user-login': 'a@x.com.evil' } }),
        cfg,
      ),
    ).toEqual({ kind: 'refused', reason: 'login-mismatch' });
  });
  it.each(['1.2.3.4', '100.64.0.7, 100.64.0.8', '', 'garbage'])(
    'X-Forwarded-For %j → refused',
    (xff) => {
      expect(
        classifyTailnet(req({ headers: { 'x-forwarded-for': xff } }), cfg),
      ).toEqual({ kind: 'refused', reason: 'xff-invalid' });
    },
  );
  it('a Funnel request → refused', () => {
    expect(
      classifyTailnet(
        req({ headers: { 'tailscale-funnel-request': '?1' } }),
        cfg,
      ),
    ).toEqual({ kind: 'refused', reason: 'funnel' });
  });
});
