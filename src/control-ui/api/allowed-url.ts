import { SECRET_KEYS } from './logs.js';

// The one place a server-supplied string is cleared to become an `href` in
// the control UI (workflow previews and outputs; the artifacts registry
// imports this too). `h()` sets attributes verbatim, so this is the control.
export type UrlBlock = 'userinfo' | 'host' | 'protocol' | 'secret-query';
export type UrlCheck =
  | { ok: true; url: string; hostname: string }
  | { ok: false; shape: true }
  | { ok: false; shape: false; blocked: UrlBlock };

export const URL_MAX = 2048;
export const DEFAULT_HOSTS = ['claude.ai'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// `SECRET_KEYS` is an unanchored alternation meant for prose; here it is
// anchored to key segments so `api_key`, `access_token` and `x-token` all
// reject while `tokenizer` does not. Over-rejection fails closed.
const SECRET_QUERY_KEY = new RegExp(
  `^(?:[^_-]*[_-])?(?:${SECRET_KEYS})(?:[_-][^_-]*)?$`,
  'i',
);

/** `CONTROL_UI_PREVIEW_HOSTS`: comma-separated exact hostnames. */
export function parsePreviewHosts(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0 && h.length <= 253);
}

export function checkUrl(raw: unknown, extraHosts: string[] = []): UrlCheck {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX)
    return { ok: false, shape: true };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, shape: true };
  }
  if (url.username !== '' || url.password !== '')
    return { ok: false, shape: false, blocked: 'userinfo' };
  const host = url.hostname.toLowerCase();
  if (url.protocol === 'https:') {
    if (!DEFAULT_HOSTS.includes(host) && !extraHosts.includes(host))
      return { ok: false, shape: false, blocked: 'host' };
  } else if (url.protocol === 'http:') {
    if (!LOCAL_HOSTS.has(host))
      return { ok: false, shape: false, blocked: 'host' };
  } else {
    return { ok: false, shape: false, blocked: 'protocol' };
  }
  for (const key of url.searchParams.keys()) {
    if (SECRET_QUERY_KEY.test(key))
      return { ok: false, shape: false, blocked: 'secret-query' };
  }
  return { ok: true, url: raw, hostname: host };
}

export function isAllowedUrl(raw: unknown, extraHosts: string[] = []): boolean {
  return checkUrl(raw, extraHosts).ok;
}
