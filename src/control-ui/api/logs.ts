import type { LogEntry, LogRing } from '../../log-ring.js';
import { isOwnContainer } from '../../container-runtime.js';
import type { DockerRunner } from './docker.js';

export const LOG_LINES_MAX = 1000;
const LEVELS: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// Backstop over already-structurally-redacted host lines and over raw
// container output: quoted/unquoted key:value, known token prefixes, URL
// userinfo. Best-effort by nature — read-only mode withholds container logs.
const SECRET_KEYS =
  'api[_-]?key|token|secret|password|passwd|credential|authorization';
const QUOTED_KV = new RegExp(`"(${SECRET_KEYS})"\\s*:\\s*"[^"]*"`, 'gi');
const BARE_KV = new RegExp(
  `\\b(${SECRET_KEYS})(\\s*[=:]\\s*)(?:Bearer\\s+)?\\S+`,
  'gi',
);
const TOKEN_PREFIX =
  /\b(ghp_|gho_|ghs_|glpat-|xox[baprs]-|AIza|sk-|eyJ[A-Za-z0-9_-]{10,})\S+/g;
const URL_USERINFO = /(https?:\/\/)[^/\s@]*:[^/\s@]*@/g;

export function redactSecrets(s: string): string {
  return s
    .replace(QUOTED_KV, '"$1":"[redacted]"')
    .replace(BARE_KV, '$1$2[redacted]')
    .replace(TOKEN_PREFIX, '[redacted]')
    .replace(URL_USERINFO, '$1[redacted]@');
}

export function clampLines(v: unknown, fallback = 200): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, LOG_LINES_MAX);
}

export type HostLogView =
  { seq: number; time: number; level: number; msg: string } | LogEntry;

export function queryLogs(
  ring: LogRing,
  q: { level?: string; q?: string; lines?: unknown; readOnly?: boolean },
): HostLogView[] {
  const min = LEVELS[(q.level ?? 'info').toLowerCase()] ?? 30;
  const needle = (q.q ?? '').trim().toLowerCase();
  const lines = clampLines(q.lines);
  const out: HostLogView[] = [];
  const all = ring.entries();
  for (let i = all.length - 1; i >= 0 && out.length < lines; i--) {
    const e = all[i];
    if (e.level < min) continue;
    if (needle && !e.line.toLowerCase().includes(needle)) continue;
    out.push(
      q.readOnly
        ? { seq: e.seq, time: e.time, level: e.level, msg: e.msg }
        : { ...e, msg: redactSecrets(e.msg), line: redactSecrets(e.line) },
    );
  }
  return out.reverse();
}

export async function containerLogs(
  docker: DockerRunner,
  name: string,
  lines: unknown,
  instanceId: string,
): Promise<{ lines: string[] } | { status: 404 } | { error: string }> {
  if (!isOwnContainer(name, instanceId)) return { status: 404 };
  const n = clampLines(lines);
  const r = await docker.run(['logs', '--tail', String(n), name], {
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!r.ok) return { error: r.error };
  const text = `${r.stdout}${r.stdout && r.stderr ? '\n' : ''}${r.stderr}`;
  return {
    lines: text
      .split('\n')
      .filter((l) => l.length > 0)
      .slice(-n)
      .map(redactSecrets),
  };
}
