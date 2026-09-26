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
      flush();
      const rows = [];
      while (i < lines.length && TABLE_RE.test(lines[i])) rows.push(lines[i++].trim());
      i--;
      blocks.push({ type: 'code', lang: 'table', text: rows.join('\n') });
      continue;
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
      while (i < lines.length && re.test(lines[i])) {
        let item = re.exec(lines[i])[1];
        // Indented continuation lines belong to the item above.
        while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !UL_RE.test(lines[i + 1]) && !OL_RE.test(lines[i + 1])) item += ` ${lines[++i].trim()}`;
        items.push(parseInline(item));
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

function renderInline(spans, h) {
  return spans.map((s) => {
    if (s.type === 'strong') return h('strong', {}, ...renderInline(s.children || [{ type: 'text', text: s.text }], h));
    if (s.type === 'em') return h('em', {}, ...renderInline(s.children || [{ type: 'text', text: s.text }], h));
    if (s.type === 'code') return h('code', {}, s.text);
    if (s.type === 'link') return h('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, s.text);
    return s.text;
  });
}

/** Builds the blocks with `h()` only. */
export function renderBlocks(blocks, h) {
  return blocks.map((b) => {
    switch (b.type) {
      case 'h': return h(`h${b.level + 2}`, { class: 'md-h' }, ...renderInline(b.inline, h));
      case 'ul':
      case 'ol': return h(b.type, {}, ...b.items.map((it) => h('li', {}, ...renderInline(it, h))));
      case 'code': return h('pre', { class: 'md-code' }, h('code', {}, b.text));
      case 'quote': return h('blockquote', {}, ...renderInline(b.inline, h));
      case 'hr': return h('hr', {});
      default: return h('p', {}, ...renderInline(b.inline, h));
    }
  });
}
