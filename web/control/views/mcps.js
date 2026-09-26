import { h, clear, badge } from '../dom.js';
import { header } from '../app.js';
import { addButton, catalogue } from '../integrations.js';
import { serverError } from '../ui.js';

function table(headers, rows) {
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
      h('tbody', {}, ...(rows.length ? rows : [h('tr', {}, h('td', { colspan: String(headers.length), class: 'muted' }, 'none'))]))));
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const cat = catalogue(api, { kinds: ['mcp', 'tool', 'backend'], title: 'Add an MCP, tool or backend', readOnly });
  let inv;
  try { inv = await api.get('/api/v1/mcps'); }
  catch (err) {
    clear(root);
    root.append(header('MCPs', { eyebrow: 'Configure', actions: readOnly ? [] : [addButton('Add MCP or tool', cat)] }), cat.el,
      h('div', { class: 'empty' }, serverError(err, 'Could not load the MCP list — try again in a moment.')));
    return;
  }
  clear(root);
  root.append(
    header('MCPs', { eyebrow: 'Configure', actions: readOnly ? [] : [addButton('Add MCP or tool', cat)] }),
    cat.el,
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
