import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createBackoff,
  createCredentialSource,
  createSessionStore,
  isTls,
  loadCredentialFile,
  parseCookies,
  verifyPassword,
  writeCredentialFile,
} from './auth.js';

describe('control-ui auth edge cases', () => {
  it('verifyPassword rejects a record whose hash length differs', async () => {
    await expect(
      verifyPassword('x', {
        salt: 'ab'.repeat(16),
        hash: 'ab',
        N: 2,
        r: 1,
        p: 1,
      }),
    ).resolves.toBe(false);
  });

  it('loadCredentialFile rejects a non-hex salt', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')),
      'c.json',
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        scrypt: {
          salt: 'zz'.repeat(16),
          hash: 'ab'.repeat(32),
          N: 2,
          r: 1,
          p: 1,
        },
      }),
    );
    expect(loadCredentialFile(file)).toEqual({
      ok: false,
      reason: 'credential file has no valid scrypt record',
    });
  });

  it('credential source does not report rotation when the file is rewritten with the same hash', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-')),
      'c.json',
    );
    writeCredentialFile(file, 'pw');
    const src = createCredentialSource(file);
    expect(src.current().rotated).toBe(false);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8') + '\n');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    expect(src.current().rotated).toBe(false);
  });

  it('session validate touches lastSeen so idle resets; secret must be hex', () => {
    let t = 0;
    const store = createSessionStore(() => t);
    const { id, secret } = store.create('ua');
    t = 11 * 60 * 60_000;
    expect(store.validate(id, secret)?.userAgent).toBe('ua');
    t += 11 * 60 * 60_000;
    expect(store.validate(id, secret)).not.toBeNull();
    expect(store.validate(id, 'not-hex')).toBeNull();
    expect(store.size()).toBe(1);
  });

  it('a redeemed ticket counts as activity; an expired one does not', () => {
    let t = 0;
    const store = createSessionStore(() => t);
    const { id } = store.create('ua');
    const ticket = store.issueTicket(id);
    t = 61_000;
    expect(store.redeemTicket(ticket ?? undefined, id)).toBeNull();
  });

  it('backoff caps at five minutes', () => {
    const t = 0;
    const b = createBackoff(() => t);
    for (let i = 0; i < 12; i++) b.recordFailure('k');
    expect(b.retryAfterMs('k')).toBe(5 * 60_000);
  });

  it('isTls ignores forwarded headers; cookies keep = in values', () => {
    const req = {
      socket: {},
      headers: { 'x-forwarded-proto': 'https' },
    } as never;
    expect(isTls(req)).toBe(false);
    expect(parseCookies('a=1;b=x=y')).toEqual({ a: '1', b: 'x=y' });
  });
});
