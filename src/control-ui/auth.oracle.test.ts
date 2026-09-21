// @oracle — authored from the spec, independent of the implementation. A
// failing case means fix the code, not this file.
//
// Sources: docs/superpowers/specs/2026-09-20-control-ui-design.md ("Auth")
// and the Interfaces (Produces) list for Task 1 in
// docs/superpowers/plans/2026-09-20-control-ui-phase1.md. Authored blind to
// src/control-ui/auth.ts (does not exist at authoring time) and blind to the
// Step 4 code sketch in that plan.
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IncomingMessage } from 'http';
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  SESSION_IDLE_MS,
  SESSION_ABSOLUTE_MS,
  TICKET_TTL_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  BACKOFF_WINDOW_MS,
  generatePassword,
  hashPassword,
  verifyPassword,
  writeCredentialFile,
  loadCredentialFile,
  createCredentialSource,
  createSessionStore,
  createBackoff,
  normalizeAddr,
  parseCookies,
  isTls,
  sessionCookie,
  clearSessionCookie,
} from './auth.js';

import { IS_WINDOWS } from '../platform.js';

describe('@oracle control-ui auth', () => {
  // ---- constants ---------------------------------------------------------
  it('// @oracle: exact constant values from the Interfaces list', () => {
    expect(SESSION_COOKIE).toBe('deus_ctl');
    expect(SESSION_HEADER).toBe('x-deus-session');
    expect(SESSION_IDLE_MS).toBe(43_200_000);
    expect(SESSION_ABSOLUTE_MS).toBe(604_800_000);
    expect(TICKET_TTL_MS).toBe(60_000);
    expect(BACKOFF_BASE_MS).toBe(1000);
    expect(BACKOFF_MAX_MS).toBe(300_000);
    expect(BACKOFF_WINDOW_MS).toBe(900_000);
  });

  // ---- generatePassword ---------------------------------------------------
  it('// @oracle: generatePassword returns a non-trivial base64url string', () => {
    const p1 = generatePassword();
    const p2 = generatePassword();
    expect(typeof p1).toBe('string');
    expect(p1.length).toBeGreaterThan(16);
    expect(p1).not.toBe(p2);
    expect(p1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // ---- hashPassword / verifyPassword --------------------------------------
  it('// @oracle: verifyPassword resolves true for the right password, false for a 1-char change', async () => {
    const rec = hashPassword('correct horse battery staple');
    await expect(
      verifyPassword('correct horse battery staple', rec),
    ).resolves.toBe(true);
    await expect(
      verifyPassword('correct horse battery staplf', rec),
    ).resolves.toBe(false);
  });

  it('// @oracle: hashPassword: different salt/hash each call, fixed scrypt params, hex encoding', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(a.N).toBe(16384);
    expect(a.r).toBe(8);
    expect(a.p).toBe(1);
    expect(a.salt).toMatch(/^[0-9a-f]{32}$/); // 16 bytes hex
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex
  });

  // ---- writeCredentialFile / loadCredentialFile ---------------------------
  describe('credential file round-trip', () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-oracle-'));
      file = path.join(dir, 'cred.json');
    });

    it('// @oracle: writeCredentialFile then loadCredentialFile round-trips, mode 0600 on POSIX', () => {
      writeCredentialFile(file, 'my-password');
      const loaded = loadCredentialFile(file);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.cred.scrypt).toMatchObject({ N: 16384, r: 8, p: 1 });
        expect(typeof loaded.cred.scrypt.salt).toBe('string');
        expect(typeof loaded.cred.scrypt.hash).toBe('string');
        expect(typeof loaded.cred.created_at).toBe('string');
      }
      if (!IS_WINDOWS) {
        const mode = fs.statSync(file).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it('// @oracle: loadCredentialFile ok:false for missing file, non-JSON, and JSON missing scrypt', () => {
      const missing = loadCredentialFile(path.join(dir, 'nope.json'));
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(typeof missing.reason).toBe('string');

      const badJson = path.join(dir, 'bad.json');
      fs.writeFileSync(badJson, 'not json at all {{{', { mode: 0o600 });
      const badResult = loadCredentialFile(badJson);
      expect(badResult.ok).toBe(false);

      const noScrypt = path.join(dir, 'noscrypt.json');
      fs.writeFileSync(
        noScrypt,
        JSON.stringify({ created_at: new Date().toISOString() }),
        { mode: 0o600 },
      );
      const noScryptResult = loadCredentialFile(noScrypt);
      expect(noScryptResult.ok).toBe(false);
    });
  });

  // ---- createCredentialSource (live rotation) -----------------------------
  it('// @oracle: credential source reports rotated:true exactly once after a real rotation, ok:false after deletion', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-oracle-'));
    const file = path.join(dir, 'cred.json');

    writeCredentialFile(file, 'password-one');
    const source = createCredentialSource(file);

    const first = source.current();
    expect(first.ok).toBe(true);
    expect(first.rotated).toBe(false);

    // Unchanged file: still not rotated.
    const second = source.current();
    expect(second.ok).toBe(true);
    expect(second.rotated).toBe(false);
    if (first.ok && second.ok) {
      expect(second.cred.scrypt.hash).toBe(first.cred.scrypt.hash);
    }

    // Rotate: new password, and force the mtime stamp forward so a
    // same-second write is still detected as changed.
    writeCredentialFile(file, 'password-two');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);

    const third = source.current();
    expect(third.ok).toBe(true);
    expect(third.rotated).toBe(true);
    if (first.ok && third.ok) {
      expect(third.cred.scrypt.hash).not.toBe(first.cred.scrypt.hash);
    }

    // Immediately after: not rotated again (rotated is a one-shot edge, not a
    // "did the file change since v1" flag).
    const fourth = source.current();
    expect(fourth.ok).toBe(true);
    expect(fourth.rotated).toBe(false);

    // Deleted file: ok:false.
    fs.rmSync(file);
    const fifth = source.current();
    expect(fifth.ok).toBe(false);
  });

  // ---- session store -------------------------------------------------------
  describe('session store', () => {
    let t: number;
    const now = () => t;

    beforeEach(() => {
      t = 1_000_000_000; // arbitrary fixed epoch ms
    });

    it('// @oracle: validate is null for unknown id, wrong secret, wrong-length secret, and undefined args', () => {
      const store = createSessionStore(now);
      const { id, secret } = store.create('agent/1.0');

      expect(store.validate('not-a-real-id', secret)).toBeNull();
      expect(store.validate(id, 'wrong-secret-value')).toBeNull();
      expect(store.validate(id, secret.slice(0, secret.length - 1))).toBeNull();
      expect(store.validate(undefined, secret)).toBeNull();
      expect(store.validate(id, undefined)).toBeNull();
      expect(store.validate(undefined, undefined)).toBeNull();
    });

    it('// @oracle: create then validate returns a well-formed SessionInfo; destroy/clear invalidate it', () => {
      const store = createSessionStore(now);
      const { id, secret } = store.create('agent/1.0');

      const info = store.validate(id, secret);
      expect(info).not.toBeNull();
      if (info) {
        expect(info.id).toBe(id);
        expect(info.shortId).toMatch(/^[0-9a-f]{12}$/);
        expect(info.createdAt).toBe(t);
        expect(info.userAgent).toBe('agent/1.0');
      }

      store.destroy(id);
      expect(store.validate(id, secret)).toBeNull();

      const { id: id2, secret: secret2 } = store.create('agent/2.0');
      expect(store.validate(id2, secret2)).not.toBeNull();
      store.clear();
      expect(store.validate(id2, secret2)).toBeNull();
      expect(store.size()).toBe(0);
    });

    it('// @oracle: session expires after SESSION_IDLE_MS since the last successful validate', () => {
      const store = createSessionStore(now);
      const { id, secret } = store.create('agent/1.0');

      t += SESSION_IDLE_MS - 1000;
      expect(store.validate(id, secret)).not.toBeNull(); // still alive, refreshes idle clock

      t += SESSION_IDLE_MS - 1000; // would be stale from creation, fresh from last validate
      expect(store.validate(id, secret)).not.toBeNull();

      t += SESSION_IDLE_MS + 1000; // now stale since the last successful validate
      expect(store.validate(id, secret)).toBeNull();
    });

    it('// @oracle: session expires at SESSION_ABSOLUTE_MS even with hourly successful validates', () => {
      const store = createSessionStore(now);
      const { id, secret } = store.create('agent/1.0');
      const hourMs = 60 * 60_000;

      let elapsed = 0;
      while (elapsed + hourMs < SESSION_ABSOLUTE_MS) {
        t += hourMs;
        elapsed += hourMs;
        expect(store.validate(id, secret)).not.toBeNull();
      }

      // Push past the absolute ceiling from creation.
      t += SESSION_ABSOLUTE_MS - elapsed + 1000;
      expect(store.validate(id, secret)).toBeNull();
    });

    it('// @oracle: a wrong-secret or undefined-secret validate must NOT refresh the idle timer', () => {
      const store = createSessionStore(now);
      const { id, secret } = store.create('agent/1.0');

      t += 11 * 60 * 60_000; // 11h since creation — within idle window
      expect(store.validate(id, 'totally-wrong-secret')).toBeNull();
      expect(store.validate(id, undefined)).toBeNull();

      t += 2 * 60 * 60_000; // 13h since creation, i.e. since the LAST SUCCESSFUL validate
      // Idle window is 12h; the failed calls above must not have refreshed it.
      expect(store.validate(id, secret)).toBeNull();
    });

    // ---- tickets -----------------------------------------------------------
    it('// @oracle: issueTicket is null for an unknown id', () => {
      const store = createSessionStore(now);
      expect(store.issueTicket('unknown-session-id')).toBeNull();
    });

    it('// @oracle: redeemTicket is single-use, id-bound, and time-limited', () => {
      const store = createSessionStore(now);
      const { id } = store.create('agent/1.0');
      const { id: otherId } = store.create('agent/2.0');

      const ticket = store.issueTicket(id);
      expect(typeof ticket).toBe('string');
      expect(ticket).not.toBeNull();

      // Wrong id: rejected without consuming the ticket.
      expect(store.redeemTicket(ticket ?? undefined, otherId)).toBeNull();

      // Correct id: succeeds exactly once.
      const redeemed = store.redeemTicket(ticket ?? undefined, id);
      expect(redeemed).not.toBeNull();
      expect(redeemed?.id).toBe(id);

      // Reuse: rejected.
      expect(store.redeemTicket(ticket ?? undefined, id)).toBeNull();

      // Fresh ticket expires after TICKET_TTL_MS.
      const ticket2 = store.issueTicket(id);
      t += TICKET_TTL_MS + 1;
      expect(store.redeemTicket(ticket2 ?? undefined, id)).toBeNull();
    });
  });

  // ---- backoff --------------------------------------------------------------
  describe('backoff', () => {
    let t: number;
    const now = () => t;

    beforeEach(() => {
      t = 1_000_000_000;
    });

    it('// @oracle: retryAfterMs curve — 0 baseline, base/2x/4x/8x growth, cap, recovery, forgetting, and reset', () => {
      const backoff = createBackoff(now);
      const key = '127.0.0.1';

      expect(backoff.retryAfterMs(key)).toBe(0);

      backoff.recordFailure(key);
      expect(backoff.retryAfterMs(key)).toBe(BACKOFF_BASE_MS);

      backoff.recordFailure(key);
      expect(backoff.retryAfterMs(key)).toBe(BACKOFF_BASE_MS * 2);

      backoff.recordFailure(key);
      expect(backoff.retryAfterMs(key)).toBe(BACKOFF_BASE_MS * 4);

      backoff.recordFailure(key);
      expect(backoff.retryAfterMs(key)).toBe(BACKOFF_BASE_MS * 8);

      // Many more failures: caps at BACKOFF_MAX_MS, never exceeds it.
      for (let i = 0; i < 20; i++) backoff.recordFailure(key);
      expect(backoff.retryAfterMs(key)).toBe(BACKOFF_MAX_MS);

      // Advance past the outstanding delay: back to 0.
      t += BACKOFF_MAX_MS + 1;
      expect(backoff.retryAfterMs(key)).toBe(0);

      // Forgetting: a single old failure outside the window contributes nothing.
      backoff.reset();
      backoff.recordFailure(key);
      t += BACKOFF_WINDOW_MS + 1;
      expect(backoff.retryAfterMs(key)).toBe(0);

      // recordSuccess clears an in-progress backoff immediately.
      backoff.recordFailure(key);
      expect(backoff.retryAfterMs(key)).toBeGreaterThan(0);
      backoff.recordSuccess(key);
      expect(backoff.retryAfterMs(key)).toBe(0);

      // reset() clears every key.
      backoff.recordFailure(key);
      backoff.recordFailure('another-key');
      backoff.reset();
      expect(backoff.retryAfterMs(key)).toBe(0);
      expect(backoff.retryAfterMs('another-key')).toBe(0);
    });
  });

  // ---- normalizeAddr ---------------------------------------------------------
  it('// @oracle: normalizeAddr collapses loopback v4-in-v6 forms, passes through real addrs, defaults undefined', () => {
    expect(normalizeAddr('::1')).toBe('127.0.0.1');
    expect(normalizeAddr('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeAddr('10.0.0.5')).toBe('10.0.0.5');
    expect(normalizeAddr(undefined)).toBe('unknown');
  });

  // ---- cookies ---------------------------------------------------------------
  it('// @oracle: sessionCookie sets deus_ctl, HttpOnly, SameSite=Strict, Path=/, Max-Age, Secure only when TLS', () => {
    const id = 'abc123session';

    const insecure = sessionCookie(id, false);
    expect(insecure).toContain(`deus_ctl=${id}`);
    expect(insecure).toMatch(/HttpOnly/i);
    expect(insecure).toMatch(/SameSite=Strict/i);
    expect(insecure).toMatch(/Path=\//i);
    expect(insecure).toMatch(/Max-Age=\d+/i);
    expect(insecure).not.toMatch(/;\s*Secure/i);

    const secure = sessionCookie(id, true);
    expect(secure).toMatch(/;\s*Secure/i);
    expect(secure).toContain(`deus_ctl=${id}`);
  });

  it('// @oracle: clearSessionCookie has Max-Age=0 and honors the secure flag', () => {
    const cleared = clearSessionCookie(false);
    expect(cleared).toContain(SESSION_COOKIE);
    expect(cleared).toMatch(/Max-Age=0\b/i);
    expect(cleared).not.toMatch(/;\s*Secure/i);

    const clearedSecure = clearSessionCookie(true);
    expect(clearedSecure).toMatch(/Max-Age=0\b/i);
    expect(clearedSecure).toMatch(/;\s*Secure/i);
  });

  it('// @oracle: parseCookies handles multiple pairs, a missing header, and "=" inside values', () => {
    expect(parseCookies('a=1; b=2')).toMatchObject({ a: '1', b: '2' });
    expect(parseCookies(undefined)).toEqual({});
    const withEquals = parseCookies('token=abc=def==; other=1');
    expect(withEquals.token).toBe('abc=def==');
    expect(withEquals.other).toBe('1');
  });

  // ---- isTls ------------------------------------------------------------------
  it('// @oracle: isTls trusts only req.socket.encrypted, never the X-Forwarded-Proto header', () => {
    const tlsReq = {
      socket: { encrypted: true },
      headers: {},
    } as unknown as IncomingMessage;
    expect(isTls(tlsReq)).toBe(true);

    const spoofedReq = {
      socket: { encrypted: false },
      headers: { 'x-forwarded-proto': 'https' },
    } as unknown as IncomingMessage;
    expect(isTls(spoofedReq)).toBe(false);

    const plainReq = {
      socket: {},
      headers: {},
    } as unknown as IncomingMessage;
    expect(isTls(plainReq)).toBe(false);
  });
});
