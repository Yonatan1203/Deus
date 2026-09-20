import { h, clear, badge } from '../dom.js';

function table(headers, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
      h('tbody', {}, ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: String(headers.length), class: 'muted' }, 'none'))]))));
}

export async function render(root, api) {
  const inv = await api.get('/api/v1/mcps');
  clear(root);
  root.append(
    h('h1', {}, 'MCPs'),
    h('h2', {}, 'Container MCP servers'),
    table(['Name', 'Source', 'Status'], inv.container.map((c) => h('tr', {},
      h('td', {}, c.name),
      h('td', {}, c.source),
      h('td', {}, badge(c.available ? 'available' : 'unavailable', c.available ? 'ok' : 'bad'), ' ', c.conditional ? badge('conditional', 'info') : badge('always', 'info'))))),
    h('h2', {}, 'Skill MCPs'),
    table(['Skill', 'Directory', 'Tests'], inv.skills.map((s) => h('tr', {},
      h('td', {}, s.name),
      h('td', {}, h('code', {}, s.dir)),
      h('td', {}, badge(s.has_test ? 'has test' : 'no test', s.has_test ? 'ok' : 'warn'))))),
    h('h2', {}, 'Channel packages'),
    table(['Package', 'Built', 'Configured'], inv.channels.map((c) => h('tr', {},
      h('td', {}, c.package),
      h('td', {}, badge(c.built ? 'built' : 'not built', c.built ? 'ok' : 'warn')),
      h('td', {}, c.configured === null ? badge('unknown', '') : badge(c.configured ? 'configured' : 'missing', c.configured ? 'ok' : 'bad'))))));
}
