import net from 'net';

// Requests that reach the dashboard through `tailscale serve` on this host.
// tailscaled terminates TLS, keeps the inbound Host, replaces X-Forwarded-For
// with the peer's tailnet address and sets Tailscale-User-Login from its own
// identity lookup (dropping any copy the client sent). The dashboard still
// listens on 127.0.0.1 only; this decides whether such a request is answered.
// Password, session, CSRF and Origin checks apply unchanged — Tailscale is the
// transport, not the authentication.

export interface TailnetConfig {
  tailnetHost?: string;
  tailnetLogins?: string[];
}

export type TailnetClass =
  | { kind: 'none' }
  | { kind: 'ok'; ip: string; login: string }
  | {
      kind: 'refused';
      reason:
        | 'not-loopback'
        | 'login-missing'
        | 'login-mismatch'
        | 'xff-invalid'
        | 'funnel';
    };

/** `CONTROL_UI_TAILNET_LOGINS`: comma-separated; trimmed, lowercased, empties dropped. */
export function parseTailnetLogins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** One address inside Tailscale's ranges: 100.64.0.0/10 or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(v: string): boolean {
  const kind = net.isIP(v);
  if (kind === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  if (kind === 6) return v.toLowerCase().startsWith('fd7a:115c:a1e0:');
  return false;
}

const one = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? (v.length === 1 ? v[0] : undefined) : v;

/**
 * `none`: not addressed to the tailnet name (or the feature is off) — the
 * normal localhost path decides. `refused`: addressed to it, but not provably
 * from `tailscale serve` for a listed login. `ok`: answer it.
 */
export function classifyTailnet(
  req: {
    host: string | undefined;
    peer: string | undefined;
    headers: Record<string, string | string[] | undefined>;
  },
  cfg: TailnetConfig,
): TailnetClass {
  const want = cfg.tailnetHost?.trim().toLowerCase();
  const logins = cfg.tailnetLogins ?? [];
  if (!want || logins.length === 0) return { kind: 'none' };
  if ((req.host ?? '').trim().toLowerCase() !== want) return { kind: 'none' };
  if (!req.peer || !LOOPBACK.has(req.peer))
    return { kind: 'refused', reason: 'not-loopback' };
  if (req.headers['tailscale-funnel-request'] !== undefined)
    return { kind: 'refused', reason: 'funnel' };
  const login = one(req.headers['tailscale-user-login'])?.trim().toLowerCase();
  if (!login) return { kind: 'refused', reason: 'login-missing' };
  if (!logins.includes(login))
    return { kind: 'refused', reason: 'login-mismatch' };
  const xff = one(req.headers['x-forwarded-for'])?.trim() ?? '';
  if (xff.includes(',') || !isTailnetAddress(xff))
    return { kind: 'refused', reason: 'xff-invalid' };
  return { kind: 'ok', ip: xff, login };
}
