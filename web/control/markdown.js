// A small markdown reader for Claude's replies. It never produces HTML: the
// parser returns plain blocks and the renderer builds them with `h()`, so
// anything a transcript contains can only ever become text. Links survive
// only as http(s); anything else stays text.

const FENCE_RE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RE = /^\s*\|.*\|\s*$/;

// `\#` shows as `#`, as markdown intends.
const unescape = (t) => t.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1');

/** Inline spans: text, strong, em (both with `children`), code, link. */
export function parseInline(s) {
  const out = [];
  const push = (type, text, extra) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (type === 'text' && last && last.type === 'text') last.text += text;
    else out.push({ type, text, ...extra });
  };
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let at = 0;
  for (let m; (m = re.exec(s)); ) {
    push('text', unescape(s.slice(at, m.index)));
    if (m[1]) push('code', m[2].trim() || m[2]);
    else if (m[3] || m[4]) push('strong', m[3] || m[4], { children: parseInline(m[3] || m[4]) });
    else if (m[5]) push('em', m[5], { children: parseInline(m[5]) });
    else if (m[6]) {
      if (/^https?:\/\//i.test(m[7])) push('link', m[6], { href: m[7] });
      else push('text', m[0]);
    } else if (m[8]) push('link', m[8], { href: m[8] });
    at = m.index + m[0].length;
  }
  push('text', unescape(s.slice(at)));
  return out;
}

/** Blocks: p, h, ul, ol, code, quote, hr. A table becomes code, so it keeps its columns. */
export function parseMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', inline: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flush();
      const body = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[j])) body.push(lines[j++]);
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      i = j; // an unclosed fence runs to the end, as one code block
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (TABLE_RE.test(line)) {
      // A real table has a separator row (|---|---|) under its header; a
      // stray run of pipe rows is a paragraph like any other text.
      const rows = [];
      let j = i;
      while (j < lines.length && TABLE_RE.test(lines[j])) rows.push(lines[j++].trim());
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (rows.length >= 2 && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(rows[1])) {
        flush();
        blocks.push({ type: 'table', head: cells(rows[0]).map(parseInline), rows: rows.slice(2).map((r) => cells(r).map(parseInline)) });
        i = j - 1;
        continue;
      }
    }
    if (HR_RE.test(line)) { flush(); blocks.push({ type: 'hr' }); continue; }
    const hd = HEADING_RE.exec(line);
    if (hd) { flush(); blocks.push({ type: 'h', level: Math.min(3, hd[1].length), inline: parseInline(hd[2].trim()) }); continue; }
    let listed = false;
    for (const [type, re] of [['ul', UL_RE], ['ol', OL_RE]]) {
      if (!re.test(line)) continue;
      listed = true;
      flush();
      const items = [];
      const indentOf = (l) => l.length - l.trimStart().length;
      const base = indentOf(line);
      while (i < lines.length && re.test(lines[i]) && indentOf(lines[i]) <= base) {
        let item = re.exec(lines[i])[1];
        const sub = { type: null, items: [] };
        // Indented lines under an item: a deeper list item (one level of
        // nesting is kept) or a continuation of the item's text.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
          const next = lines[i + 1];
          const deeper = indentOf(next) > base;
          const subRe = UL_RE.test(next) ? UL_RE : OL_RE.test(next) ? OL_RE : null;
          if (deeper && subRe) { sub.type = sub.type || (subRe === UL_RE ? 'ul' : 'ol'); sub.items.push(parseInline(subRe.exec(next)[1])); i++; continue; }
          if (subRe) break;
          item += ` ${next.trim()}`; i++;
        }
        items.push(sub.type ? { inline: parseInline(item), sub } : parseInline(item));
        i++;
      }
      i--;
      blocks.push({ type, items });
      break;
    }
    if (listed) continue;
    if (QUOTE_RE.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) q.push(QUOTE_RE.exec(lines[i++])[1]);
      i--;
      blocks.push({ type: 'quote', inline: parseInline(q.join(' ')) });
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

// A link to a page the dashboard holds a copy of gets an "Open beside" button
// right after it — only when both handlers are given (the Claude tab's
// conversation); everywhere else links render exactly as before.
function renderInline(spans, h, handlers = {}) {
  const canOpen = typeof handlers.localArtifact === 'function' && typeof handlers.openArtifact === 'function';
  return spans.flatMap((s) => {
    if (s.type === 'strong') return [h('strong', {}, ...renderInline(s.children || [{ type: 'text', text: s.text }], h, handlers))];
    if (s.type === 'em') return [h('em', {}, ...renderInline(s.children || [{ type: 'text', text: s.text }], h, handlers))];
    if (s.type === 'code') return [h('code', {}, s.text)];
    if (s.type === 'link') {
      const a = h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, s.text);
      const entry = canOpen ? handlers.localArtifact(s.href) : null;
      if (!entry) return [a];
      return [a, h('button', { type: 'button', 'aria-label': 'Open beside', title: 'Open beside', class: 'md-open-beside icon-btn', onclick: () => handlers.openArtifact(entry) }, (handlers.icon ? handlers.icon('beside') : 'Open beside'))];
    }
    return [s.text];
  });
}

/**
 * Builds the blocks with `h()` only. Every block carries `dir="auto"` so a
 * Hebrew paragraph after an English one reads its own way. With
 * `handlers.copy`, a code block gets a Copy button.
 */
export function renderBlocks(blocks, h, handlers = {}) {
  const li = (it) => (Array.isArray(it)
    ? h('li', { dir: 'auto' }, ...renderInline(it, h, handlers))
    : h('li', { dir: 'auto' }, ...renderInline(it.inline, h, handlers), h(it.sub.type, {}, ...it.sub.items.map((s) => h('li', { dir: 'auto' }, ...renderInline(s, h, handlers))))));
  return blocks.map((b) => {
    switch (b.type) {
      case 'h': return h(`h${b.level + 2}`, { class: 'md-h', dir: 'auto' }, ...renderInline(b.inline, h, handlers));
      case 'ul':
      case 'ol': return h(b.type, { dir: 'auto' }, ...b.items.map(li));
      case 'code': return h('div', { class: 'md-codewrap' },
        handlers.copy ? h('button', { type: 'button', 'aria-label': 'Copy the code', title: 'Copy the code', class: 'small ghost md-copy icon-btn', onclick: () => handlers.copy(b.text) }, (handlers.icon ? handlers.icon('copy') : 'Copy the code')) : null,
        h('pre', { class: 'md-code', dir: 'ltr' }, h('code', {}, b.text)));
      case 'table': return h('table', { class: 'md-table', dir: 'auto' },
        h('thead', {}, h('tr', {}, ...b.head.map((c) => h('th', { dir: 'auto' }, ...renderInline(c, h, handlers))))),
        h('tbody', {}, ...b.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', { dir: 'auto' }, ...renderInline(c, h, handlers)))))));
      case 'quote': return h('blockquote', { dir: 'auto' }, ...renderInline(b.inline, h, handlers));
      case 'hr': return h('hr', {});
      default: return h('p', { dir: 'auto' }, ...renderInline(b.inline, h, handlers));
    }
  });
}
