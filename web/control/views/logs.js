import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { toast } from '../ui.js';

const LEVELS = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
const KIND = { 40: 'warn', 50: 'bad', 60: 'bad' };

function line(e) {
  const t = new Date(e.time);
  const time = Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
  const extra = e.fields ? Object.entries(e.fields).filter(([k]) => k !== 'event').map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ') : '';
  return h('div', { class: 'logline' },
    h('span', { class: `dot ${KIND[e.level] || ''}`.trim(), 'aria-hidden': 'true' }),
    h('span', { class: 'time' }, time),
    h('span', { class: 'lvl' }, LEVELS[e.level] || String(e.level)),
    h('span', { class: 'lmsg' }, e.fields && e.fields.event ? `${e.fields.event} ` : '', e.msg),
    extra ? h('span', { class: 'lfields' }, extra) : null);
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const source = h('select', { 'aria-label': 'Source' }, h('option', { value: 'host' }, 'host process'));
  const level = h('select', { 'aria-label': 'Minimum level' }, ...['info', 'warn', 'error'].map((l) => h('option', { value: l }, l)));
  const q = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter' });
  const lines = h('select', { 'aria-label': 'Lines' }, ...[100, 200, 500, 1000].map((n) => h('option', { value: String(n), selected: n === 200 }, `${n} lines`)));
  const follow = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'true', 'aria-label': 'Follow live', hidden: readOnly, onclick: () => { follow.setAttribute('aria-checked', follow.getAttribute('aria-checked') === 'true' ? 'false' : 'true'); } });
  const out = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
  const exportBtn = readOnly ? null : h('button', { type: 'button', class: 'small', onclick: async () => {
    try {
      const res = await fetch(`/api/v1/logs/export?level=${encodeURIComponent(level.value)}&q=${encodeURIComponent(q.value)}`, { headers: { 'X-Deus-Session': api.token() }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: 'deus-control-logs.txt' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) { toast(err.message, 'error'); }
  } }, icon('logs', { size: 14 }), 'Export');

  async function draw() {
    clear(out);
    try {
      const params = new URLSearchParams({ source: source.value, level: level.value, q: q.value, lines: lines.value });
      const r = await api.get(`/api/v1/logs?${params}`);
      const items = r.entries ? r.entries.map(line) : r.lines.map((l) => h('div', { class: 'logline' }, h('span', { class: 'lmsg' }, l)));
      if (items.length === 0) out.append(h('div', { class: 'empty' }, 'Nothing matches.'));
      else out.append(...items);
      out.scrollTop = out.scrollHeight;
    } catch (err) { out.append(h('div', { class: 'empty' }, err.status === 403 ? 'Container logs are withheld in read-only mode.' : err.message)); }
  }
  async function loadSources() {
    try {
      const r = await api.get('/api/v1/containers');
      for (const c of r.containers || []) source.append(h('option', { value: `container:${c.name}` }, c.name));
    } catch { /* host only */ }
  }

  clear(root);
  root.append(
    header('Logs', { eyebrow: 'System', actions: exportBtn ? [exportBtn] : [] }),
    h('div', { class: 'toolbar' }, source, level, q, lines, readOnly ? null : h('label', { class: 'inline' }, 'Follow', follow)),
    out);
  if (!readOnly) await loadSources();
  await draw();
  for (const el of [source, level, lines]) el.addEventListener('change', draw);
  let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(draw, 250); });
  bus.addEventListener('log', (e) => {
    if (readOnly || source.value !== 'host' || follow.getAttribute('aria-checked') !== 'true') return;
    const min = { info: 30, warn: 40, error: 50 }[level.value] || 30;
    const needle = q.value.trim().toLowerCase();
    for (const entry of e.detail.entries) {
      if (entry.level < min) continue;
      if (needle && !entry.line.toLowerCase().includes(needle)) continue;
      out.append(line(entry));
    }
    if (e.detail.dropped) out.append(h('div', { class: 'logline muted' }, `… ${e.detail.dropped} lines dropped`));
    while (out.children.length > 1200) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  });
}
