import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { serverError, toast } from './ui.js';

// The catalogue of integrations this repo can add (its own /add-* skills),
// shown on the Channels and MCPs tabs. "Set up" starts a Claude session that
// runs the skill and walks the operator through it on the Claude tab. Key
// names may be shown; key values never come near this page.

const KIND_LABEL = { channel: 'channel', mcp: 'MCP', tool: 'tool', backend: 'backend', other: 'other' };
const mark = (title) => title.replace(/[^A-Za-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '+';

function row(it, { readOnly, onSetup }) {
  const chips = [];
  if (!readOnly) {
    if (it.configured === true) chips.push(h('span', { class: 'chip ok' }, 'configured'));
    else for (const k of it.needs) chips.push(h('span', { class: 'chip warn' }, `needs ${k}`));
  }
  const btn = readOnly ? null : h('button', { type: 'button', class: `small${it.configured ? '' : ' primary'}`, onclick: () => onSetup(it, btn) }, it.configured ? 'Set up again' : 'Set up');
  return h('div', { class: 'integ-row', 'data-name': it.name },
    h('span', { class: 'integ-mark', 'aria-hidden': 'true' }, mark(it.title)),
    h('div', { class: 'integ-main' },
      h('div', { class: 'integ-title' }, h('b', {}, it.title), h('span', { class: 'chip' }, KIND_LABEL[it.kind] || it.kind)),
      h('div', { class: 'integ-desc' }, it.description, chips.length ? ' ' : null, ...chips)),
    btn);
}

/**
 * The catalogue panel for one family of integrations.
 * `kinds`: which kinds to show. Returns the element (hidden until `show()`).
 */
export function catalogue(api, { kinds, title, readOnly }) {
  const list = h('div', { class: 'integ-list' });
  const filter = h('input', { type: 'search', placeholder: 'Filter…', 'aria-label': 'Filter integrations' });
  const panel = h('section', { class: 'integ-panel', hidden: true, 'aria-label': title },
    h('div', { class: 'integ-head' }, h('b', {}, title), filter),
    h('p', { class: 'hint' }, readOnly
      ? 'Setting up needs a full login.'
      : 'Set up starts a Claude session that installs it and walks you through the steps on the Claude tab. Any token is added to the server\'s .env by you; it never goes through this page.'),
    list);
  let items = [];
  let loaded = false;

  async function onSetup(it, btn) {
    btn.disabled = true;
    try {
      const r = await api.post(`/api/v1/integrations/${encodeURIComponent(it.name)}/setup`, {}, { 'X-Confirm': 'setup' });
      toast(`Setting up ${it.title} — follow along on the Claude tab.`, 'ok');
      location.hash = `#/claude/${encodeURIComponent(r.id)}`;
    } catch (err) {
      if (err.status === 409 && err.data && err.data.id) {
        const other = items.find((x) => x.name === err.data.name);
        toast(other && other.name !== it.name ? `Another setup is running (${other.title}) — finish it first.` : `${it.title} is already being set up — it's on the Claude tab.`);
        location.hash = `#/claude/${encodeURIComponent(err.data.id)}`;
      } else if (err.status === 409) toast(serverError(err, 'This one cannot be set up from here.'), 'error');
      else if (err.status === 429) toast('Too many starts — wait a few minutes.', 'error'); // the shared session-start limiter
      else toast(serverError(err, 'Something went wrong — try again.'), 'error');
    } finally { btn.disabled = false; }
  }
  function draw() {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const order = (k) => kinds.indexOf(k);
    const shown = items
      .filter((it) => kinds.includes(it.kind) && (!q || it.title.toLowerCase().includes(q) || it.description.toLowerCase().includes(q)))
      .sort((a, b) => order(a.kind) - order(b.kind) || a.title.localeCompare(b.title));
    if (!shown.length) list.append(h('div', { class: 'empty' }, loaded ? 'Nothing matches.' : 'Loading…'));
    else list.append(...shown.map((it) => row(it, { readOnly, onSetup })));
  }
  filter.addEventListener('input', draw);
  return {
    el: panel,
    async show() {
      panel.hidden = false;
      filter.focus();
      if (loaded) return;
      draw();
      try { items = (await api.get('/api/v1/integrations')).integrations || []; loaded = true; draw(); }
      catch (err) { clear(list); list.append(h('div', { class: 'empty' }, serverError(err, 'Could not load the catalogue.'))); }
    },
    hide() { panel.hidden = true; },
    toggle() { return panel.hidden ? this.show() : this.hide(); },
  };
}

/** The header action that opens a catalogue. */
export const addButton = (label, cat) => h('button', { type: 'button', class: 'small primary', onclick: () => cat.toggle() }, icon('plus', { size: 14 }), label);
