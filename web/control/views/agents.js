import { h, clear, badge } from '../dom.js';
import { header } from '../app.js';

const PREVIEW = 220;

function card(a) {
  const desc = a.description || '';
  const p = h('p', {}, desc.length > PREVIEW ? desc.slice(0, PREVIEW) + '…' : desc);
  if (desc.length > PREVIEW) {
    const more = h('button', { class: 'linkish', type: 'button', onclick: () => { p.textContent = desc; more.remove(); } }, 'more');
    p.append(' ', more);
  }
  return h('article', { class: 'card', 'data-name': a.name },
    h('div', { class: 'title' }, h('span', {}, a.name), a.model ? badge(a.model, 'info') : null),
    p,
    h('div', { class: 'chips' },
      a.explores_code ? h('span', { class: 'chip' }, 'explores code') : null,
      ...(a.tools || []).map((t) => h('span', { class: 'chip' }, t)),
      a.version ? h('span', { class: 'chip' }, `v${a.version}`) : null));
}

export async function render(root, api) {
  const list = await api.get('/api/v1/agents');
  clear(root);
  const grid = h('div', { class: 'grid' });
  const draw = (q) => {
    clear(grid);
    const needle = q.trim().toLowerCase();
    const shown = list.filter((a) => !needle || a.name.includes(needle) || (a.description || '').toLowerCase().includes(needle));
    if (shown.length === 0) grid.append(h('div', { class: 'empty' }, 'No agents match.'));
    else grid.append(...shown.map(card));
  };
  const search = h('input', { type: 'search', placeholder: 'Filter agents…', 'aria-label': 'Filter agents', oninput: (e) => draw(e.target.value) });
  root.append(header('Agents', { eyebrow: 'Configure', count: list.length }), h('div', { class: 'toolbar' }, search), grid);
  draw('');
}
