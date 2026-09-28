import { h, clear, badge } from '../dom.js';
import { header } from '../app.js';
import { icon } from '../icons.js';
import { serverError, toast } from '../ui.js';
import { parseMarkdown, renderBlocks } from '../markdown.js';

// Agents: the Claude Code subagents in this repo's .claude/agents. Each card
// opens its full file — description, settings and instructions — as text
// (the markdown renderer never produces HTML). Add agent starts a Claude
// session with a prepared prompt: only a Claude session can write these files.

const PREVIEW = 180;
const DRAFT_KEY = 'claude.draft';
const TEMPLATE = [
  'Create a new Claude Code subagent for this repo as a file in .claude/agents/.',
  'Follow the format of the agents already there: frontmatter with name, description (when to use it, with one or two examples), tools and model; then clear instructions.',
  'Pick a short kebab-case name. Before writing, tell me the name and a one-paragraph summary and wait for my OK.',
  '',
  'What the agent should do:',
  '',
].join('\n');

/** A description for reading: examples and YAML block markers (`>`, `|`) removed. */
const cleanDesc = (d) => (d || '').replace(/<example>[\s\S]*?<\/example>/g, '').replace(/^[>|][-+]?\s*/, '').replace(/\s+/g, ' ').trim();

/** The agent named in the address (`#/agents/<name>`), if any. */
const nameInHash = () => decodeURIComponent(location.hash.replace(/^#\/?/, '').split('/')[1] || '');
const setHash = (name) => history.replaceState(null, '', name ? `#/agents/${encodeURIComponent(name)}` : '#/agents');

function card(a, onOpen) {
  const desc = cleanDesc(a.description);
  return h('button', { type: 'button', class: 'card agent-card', 'data-name': a.name, onclick: () => onOpen(a.name) },
    h('div', { class: 'title' }, h('span', {}, a.name), a.model ? badge(a.model, 'info') : null),
    h('p', {}, desc.length > PREVIEW ? `${desc.slice(0, PREVIEW)}…` : desc),
    h('div', { class: 'chips' },
      a.explores_code ? h('span', { class: 'chip' }, 'explores code') : null,
      ...(a.tools || []).slice(0, 6).map((t) => h('span', { class: 'chip' }, t)),
      (a.tools || []).length > 6 ? h('span', { class: 'chip' }, `+${a.tools.length - 6}`) : null));
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const list = await api.get('/api/v1/agents');
  clear(root);
  const grid = h('div', { class: 'grid' });
  const panel = h('aside', { class: 'agent-panel', hidden: true, 'aria-label': 'Agent details' });
  const layout = h('div', { class: 'agents-layout' }, grid, panel);
  let openName = '';

  const draw = (q) => {
    clear(grid);
    const needle = q.trim().toLowerCase();
    const shown = list.filter((a) => !needle || a.name.includes(needle)
      || (a.description || '').toLowerCase().includes(needle)
      || (a.tools || []).some((t) => t.toLowerCase().includes(needle)));
    if (shown.length === 0) grid.append(h('div', { class: 'empty' }, 'No agents match your filter.'));
    else grid.append(...shown.map((a) => card(a, open)));
    for (const el of grid.querySelectorAll('.agent-card')) el.classList.toggle('selected', el.dataset.name === openName);
  };

  function close() {
    openName = '';
    panel.hidden = true;
    clear(panel);
    layout.classList.remove('open');
    document.body.classList.remove('agent-open');
    setHash('');
    for (const el of grid.querySelectorAll('.agent-card')) el.classList.remove('selected');
  }

  async function open(name) {
    let a;
    try { a = await api.get(`/api/v1/agents/${encodeURIComponent(name)}`); }
    catch (err) { toast(err.status === 404 ? 'That agent is gone' : serverError(err, 'Something went wrong — try again.'), 'error'); close(); return; }
    openName = a.name;
    setHash(a.name);
    const desc = cleanDesc(a.description);
    clear(panel);
    panel.append(...[
      h('div', { class: 'agent-panel-head' },
        h('button', { type: 'button', class: 'small back', 'aria-label': 'Back to agents', onclick: close }, '←'),
        h('h2', {}, a.name),
        h('button', { type: 'button', class: 'small', onclick: close }, 'Close')),
      h('div', { class: 'chips' },
        a.model ? badge(a.model, 'info') : null,
        a.version ? h('span', { class: 'chip' }, `v${a.version}`) : null,
        a.explores_code ? h('span', { class: 'chip' }, 'explores code') : null),
      desc ? h('p', { class: 'agent-desc' }, desc) : null,
      (a.tools || []).length ? h('div', { class: 'agent-tools' }, h('span', { class: 'muted' }, 'Tools'), h('div', { class: 'chips' }, ...a.tools.map((t) => h('span', { class: 'chip' }, t)))) : null,
      h('hr', {}),
      h('div', { class: 'conv-assistant agent-body' }, ...renderBlocks(parseMarkdown(a.body || ''), h)),
      a.truncated ? h('p', { class: 'muted' }, 'The file is longer than 128 KB; the rest is not shown.') : null,
      h('p', { class: 'muted agent-file' }, 'File: ', h('code', {}, `.claude/agents/${a.file}`)),
    ].filter(Boolean));
    panel.hidden = false;
    panel.scrollTop = 0;
    layout.classList.add('open');
    if (window.matchMedia('(max-width: 899px)').matches) document.body.classList.add('agent-open');
    for (const el of grid.querySelectorAll('.agent-card')) el.classList.toggle('selected', el.dataset.name === a.name);
  }

  const addBtn = readOnly ? null : h('button', { type: 'button', class: 'small primary', onclick: () => {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: 'New agent', prompt: TEMPLATE })); } catch { /* storage off: the form opens empty */ }
    location.hash = '#/claude';
  } }, icon('plus', { size: 14 }), 'Add agent');

  const search = h('input', { type: 'search', placeholder: 'Filter agents by name, text or tool…', 'aria-label': 'Filter agents', oninput: (e) => draw(e.target.value) });
  root.append(header('Agents', { eyebrow: 'Advanced', count: list.length, actions: addBtn ? [addBtn] : [] }), h('div', { class: 'toolbar' }, search), layout);
  draw('');

  const onKey = (e) => { if (e.key === 'Escape' && openName && !document.querySelector('dialog[open]')) close(); };
  document.addEventListener('keydown', onKey);
  bus.addEventListener('view-unmount', () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('agent-open'); }, { once: true });

  const wanted = nameInHash();
  if (wanted) open(wanted);
}
