import { describe, expect, it } from 'vitest';
import {
  checkUrl,
  isAllowedUrl,
  parsePreviewHosts,
  URL_MAX,
} from './allowed-url.js';

describe('allowed-url', () => {
  it('accepts claude.ai over https and exact local http hosts only', () => {
    expect(checkUrl('https://claude.ai/artifact/abc')).toMatchObject({
      ok: true,
      hostname: 'claude.ai',
    });
    expect(isAllowedUrl('https://CLAUDE.AI/x')).toBe(true);
    for (const u of [
      'http://localhost:3017/',
      'http://127.0.0.1:8080/p',
      'http://[::1]/',
    ])
      expect(isAllowedUrl(u)).toBe(true);
    expect(checkUrl('http://localhost.evil/')).toMatchObject({
      ok: false,
      blocked: 'host',
    });
    expect(checkUrl('http://claude.ai/')).toMatchObject({
      ok: false,
      blocked: 'host',
    });
    expect(checkUrl('https://evil.example/')).toMatchObject({
      ok: false,
      blocked: 'host',
    });
    expect(checkUrl('https://sub.claude.ai/')).toMatchObject({
      ok: false,
      blocked: 'host',
    });
  });

  it('rejects userinfo, other protocols and secret-looking query keys', () => {
    expect(checkUrl('https://claude.ai@evil.example/')).toMatchObject({
      ok: false,
      blocked: 'userinfo',
    });
    expect(checkUrl('https://u:p@claude.ai/')).toMatchObject({
      ok: false,
      blocked: 'userinfo',
    });
    expect(checkUrl('javascript:alert(1)')).toMatchObject({
      ok: false,
      blocked: 'protocol',
    });
    expect(checkUrl('ftp://claude.ai/')).toMatchObject({
      ok: false,
      blocked: 'protocol',
    });
    for (const q of [
      'token',
      'access_token',
      'api_key',
      'x-api-key',
      'Authorization',
      'PASSWORD',
    ]) {
      expect(checkUrl(`https://claude.ai/p?${q}=abc`)).toMatchObject({
        ok: false,
        blocked: 'secret-query',
      });
    }
    expect(isAllowedUrl('https://claude.ai/p?tokenizer=1&page=2')).toBe(true);
  });

  it('classifies shape failures separately from policy failures', () => {
    expect(checkUrl(42)).toEqual({ ok: false, shape: true });
    expect(checkUrl('')).toEqual({ ok: false, shape: true });
    expect(checkUrl('not a url')).toEqual({ ok: false, shape: true });
    expect(checkUrl('https://claude.ai/' + 'a'.repeat(URL_MAX))).toEqual({
      ok: false,
      shape: true,
    });
  });

  it('honours operator preview hosts as exact, normalised hostnames', () => {
    const hosts = parsePreviewHosts(' Preview.Example.com ,, ,shop.example ');
    expect(hosts).toEqual(['preview.example.com', 'shop.example']);
    expect(isAllowedUrl('https://preview.example.com/x', hosts)).toBe(true);
    expect(isAllowedUrl('https://www.preview.example.com/x', hosts)).toBe(
      false,
    );
    expect(parsePreviewHosts(undefined)).toEqual([]);
    expect(isAllowedUrl('https://shop.example/', [])).toBe(false);
  });
});
