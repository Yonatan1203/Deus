// Search and sort for the Artifacts tab. DOM-free so it can be tested.

const WORDS_MAX = 10;
const WORD_MAX = 60;

/** The words of a query: trimmed, lowercased, at most 10 of at most 60 characters. */
export function queryWords(query) {
  return String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, WORDS_MAX)
    .map((w) => w.slice(0, WORD_MAX));
}

const haystack = (a) => [a.title, a.description, a.session && a.session.name, a.kind, a.hostname]
  .map((v) => (typeof v === 'string' ? v : ''))
  .join('\n')
  .toLowerCase();

/** Entries in which every query word occurs (title, description, session, kind, host). */
export function matchArtifacts(list, query) {
  const words = queryWords(query);
  if (!words.length) return list;
  return list.filter((a) => {
    const text = haystack(a);
    return words.every((w) => text.includes(w));
  });
}

export const SORTS = { newest: 'Newest', oldest: 'Oldest', title: 'Title A–Z', session: 'Session' };

const time = (a) => {
  const t = Date.parse(a.added_at || '');
  return Number.isNaN(t) ? 0 : t;
};
const sessionName = (a) => (a.session && typeof a.session.name === 'string' ? a.session.name : '');

/** A sorted copy; the input is never mutated. Unknown modes fall back to newest. */
export function sortArtifacts(list, mode) {
  const byNewest = (a, b) => time(b) - time(a);
  const cmp = {
    newest: byNewest,
    oldest: (a, b) => time(a) - time(b),
    title: (a, b) => String(a.title || '').localeCompare(String(b.title || ''), undefined, { sensitivity: 'base' }) || byNewest(a, b),
    session: (a, b) => {
      const sa = sessionName(a), sb = sessionName(b);
      if (!sa !== !sb) return sa ? -1 : 1; // entries without a session last
      return sa.localeCompare(sb, undefined, { sensitivity: 'base' }) || byNewest(a, b);
    },
  }[mode] || byNewest;
  return list.map((a, i) => [a, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(([a]) => a);
}
