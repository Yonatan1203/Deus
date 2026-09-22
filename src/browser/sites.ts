// The closed table of sites the assistant may act on, and the only place a
// navigable URL is ever built. Sites are code, not configuration: each one
// needs an adapter, and letting a site be declared in a data file would make
// "where may the browser go" an operator-editable question. Phase E1 ships
// the table and the URL builder; Phase E2 is what enforces `requestHosts` on
// a live context.

export const JOB_KINDS = [
  'instagram.follow',
  'alibaba.reply',
  'alibaba.list_threads',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export interface Site {
  id: string;
  baseUrl: string;
  /** Hosts the runner's context may reach at all (E2 installs the filter). */
  requestHosts: string[];
  /** Domains an uploaded session's cookies must belong to (E2). */
  cookieDomains: string[];
  kinds: JobKind[];
}

export const SITES: Site[] = [
  {
    id: 'instagram',
    baseUrl: 'https://www.instagram.com',
    requestHosts: [
      'www.instagram.com',
      'instagram.com',
      'i.instagram.com',
      'static.cdninstagram.com',
      'scontent.cdninstagram.com',
    ],
    cookieDomains: ['.instagram.com', 'instagram.com', 'www.instagram.com'],
    kinds: ['instagram.follow'],
  },
  {
    id: 'alibaba',
    baseUrl: 'https://message.alibaba.com',
    requestHosts: [
      'message.alibaba.com',
      'www.alibaba.com',
      'alibaba.com',
      'i.alicdn.com',
      'gw.alicdn.com',
    ],
    cookieDomains: ['.alibaba.com', 'alibaba.com', 'message.alibaba.com'],
    kinds: ['alibaba.reply', 'alibaba.list_threads'],
  },
];

export function getSite(id: unknown): Site | null {
  if (typeof id !== 'string') return null;
  return SITES.find((s) => s.id === id) ?? null;
}

export const siteOfKind = (kind: JobKind): string => kind.split('.')[0];

/**
 * One normalisation, used by both the allow-list membership test and the URL
 * builder. Checking one form and navigating another is how the two quietly
 * diverge, so neither has its own copy.
 */
export function normaliseHandle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const h = raw.trim().replace(/^@/, '').toLowerCase();
  return h.length > 0 && h.length <= 30 ? h : null;
}

export function normaliseThreadId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 && t.length <= 64 ? t : null;
}

export type UrlParams = { handle?: unknown; thread_id?: unknown };

/**
 * Every URL the engine will ever navigate to. Built from the closed table plus
 * validated params — never from anything a job, an adapter or a page supplies —
 * with each segment encoded on its own so a parameter cannot add one. Dot-only
 * segments are refused outright: the handle grammar admits dots, and a path
 * builder is where `.`/`..` belong.
 */
export function urlFor(kind: unknown, params: UrlParams = {}): string | null {
  const k = typeof kind === 'string' ? kind : '';
  if (!(JOB_KINDS as readonly string[]).includes(k)) return null;
  const site = getSite(siteOfKind(k as JobKind));
  if (!site) return null;
  const join = (...segments: string[]): string | null => {
    for (const seg of segments) {
      if (seg.length === 0 || seg === '.' || seg === '..') return null;
    }
    return `${site.baseUrl}/${segments.map(encodeURIComponent).join('/')}/`;
  };
  if (k === 'instagram.follow') {
    const handle = normaliseHandle(params.handle);
    return handle === null ? null : join(handle);
  }
  if (k === 'alibaba.reply') {
    const thread = normaliseThreadId(params.thread_id);
    return thread === null ? null : join('thread', thread);
  }
  return `${site.baseUrl}/`; // alibaba.list_threads: the inbox itself
}
