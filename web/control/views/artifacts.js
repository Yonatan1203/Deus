import { h, clear, badge } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, limitToast, serverError, toast } from '../ui.js';

// The operator's curated list of live artifact apps, reports and previews.
// Titles and descriptions are text nodes; an href is built only from a URL
// the server already cleared (`url` a string). `url: null` + `blocked` is a
// policy-withheld link; a missing `url` means read-only.
const KIND = { app: 'Apps', report: 'Reports', preview: 'Previews' };
const BLOCKED = { userinfo: 'link withheld · credentials in URL', host: 'link withheld · host not allowed', protocol: 'link withheld · protocol not allowed', 'secret-query': 'link withheld · secret in query' };
const STATE = { working: ['working', 'ok'], blocked: ['needs you', 'warn'], done: ['finished', ''], gone: ['session gone', ''] };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const REASON = { unreadable: 'file unreadable', 'too-large': 'file too large', 'not-json': 'not JSON', 'bad-schema': 'bad schema' };

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const holder = h('div', { class: 'art-sections' });
  const form = h('div', { class: 'card new-artifact', hidden: true });
  let data = { artifacts: [], rev: 0 };

  const titleInput = h('input', { type: 'text', placeholder: 'Title', 'aria-label': 'Title', maxlength: '100' });
  const urlInput = h('input', { type: 'url', placeholder: 'https://claude.ai/artifact/…', 'aria-label': 'URL', maxlength: '2048' });
  const kindSel = h('select', { 'aria-label': 'Kind' }, ...Object.keys(KIND).map((k) => h('option', { value: k }, k)));
  const descInput = h('textarea', { rows: '2', placeholder: 'What is it? (optional)', 'aria-label': 'Description', maxlength: '300' });
  const addBtn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    addBtn.disabled = true;
    try {
      await api.post('/api/v1/artifacts', { title: titleInput.value.trim(), url: urlInput.value.trim(), kind: kindSel.value, description: descInput.value.trim() });
      toast('Added', 'ok');
      titleInput.value = ''; urlInput.value = ''; descInput.value = ''; form.hidden = true;
      await load();
    } catch (err) {
      if (err.status === 429) limitToast('changes');
      else toast(err.data && err.data.blocked ? `Not allowed: ${BLOCKED[err.data.blocked] || 'link withheld'}` : serverError(err, 'Something went wrong — try again.'), 'error');
    } finally { addBtn.disabled = false; }
  } }, 'Add');
  form.append(
    h('div', { class: 'form-grid' },
      h('label', {}, 'Title', titleInput), h('label', {}, 'Kind', kindSel),
      h('label', { class: 'wide' }, 'URL', urlInput, h('span', { class: 'hint' }, 'claude.ai links, or a host the operator allowed on the server')),
      h('label', { class: 'wide' }, 'Description', descInput)),
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => { form.hidden = true; } }, 'Cancel'), addBtn));
  const addAction = readOnly ? null : h('button', { type: 'button', class: 'small', onclick: () => { createForm.hidden = true; form.hidden = !form.hidden; if (!form.hidden) titleInput.focus(); } }, 'Add a link');

  // Create: a Claude session builds and publishes it, then registers the link.
  const createForm = h('div', { class: 'card new-artifact', hidden: true });
  const cTitle = h('input', { type: 'text', placeholder: 'e.g. Posts preview', 'aria-label': 'Title', maxlength: '60' });
  const cKind = h('select', { 'aria-label': 'Kind' }, ...Object.keys(KIND).map((k) => h('option', { value: k }, k)));
  const cDesc = h('textarea', { rows: '6', placeholder: 'What should it show, and for whom? The more specific, the better.', 'aria-label': 'What should it be?', maxlength: '2000' });
  const counter = h('span', { class: 'hint counter' }, '0 / 2000');
  cDesc.addEventListener('input', () => { counter.textContent = `${cDesc.value.length} / 2000`; });
  const createBtn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    const title = cTitle.value.trim();
    const description = cDesc.value.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u.test(title)) { toast('Title: letters, digits, spaces, . _ - only, up to 60 characters', 'error'); cTitle.focus(); return; }
    if (description.length < 10) { toast('Say a little more about what it should be', 'error'); cDesc.focus(); return; }
    createBtn.disabled = true;
    try {
      const r = await api.post('/api/v1/artifacts/create', { title, kind: cKind.value, description }, { 'X-Confirm': 'create' });
      toast(`Creating "${title}" — a session is on it`, 'ok');
      cTitle.value = ''; cDesc.value = ''; counter.textContent = '0 / 2000'; createForm.hidden = true;
      await load();
      if (r && r.id) history.replaceState(null, '', '#/artifacts');
    } catch (err) {
      if (err.status === 429) limitToast('starts', 'a few minutes');
      else toast(err.status === 409 && err.data && err.data.id ? 'That title is already being created — see the Creating list.' : serverError(err, 'Something went wrong — try again.'), 'error');
    } finally { createBtn.disabled = false; }
  } }, 'Create');
  createForm.append(
    h('div', { class: 'form-grid' },
      h('label', {}, 'Title', cTitle), h('label', {}, 'Kind', cKind),
      h('label', { class: 'wide' }, 'What should it be?', cDesc, counter)),
    h('p', { class: 'hint' }, 'A Claude session builds and publishes it, then it appears here. You can watch or help it on the Claude tab.'),
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => { createForm.hidden = true; } }, 'Cancel'), createBtn));
  const createAction = readOnly ? null : h('button', { type: 'button', class: 'small primary', onclick: () => { form.hidden = true; createForm.hidden = !createForm.hidden; if (!createForm.hidden) cTitle.focus(); } }, icon('plus', { size: 14 }), 'Create artifact');

  function titleNode(a) {
    if (typeof a.url === 'string') {
      return h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', class: 'art-link' }, icon('external', { size: 14 }), h('span', {}, a.title), h('span', { class: 'muted' }, ` · ${a.hostname}`));
    }
    if (a.url === null) return h('span', { class: 'art-link withheld' }, h('span', {}, a.title), h('span', { class: 'muted' }, ` · ${BLOCKED[a.blocked] || 'link withheld'}`));
    return h('span', { class: 'art-link' }, h('span', {}, a.title), h('span', { class: 'muted' }, ` · ${a.hostname}`));
  }
  function card(a) {
    const remove = readOnly ? null : h('button', { type: 'button', class: 'small ghost', onclick: async () => {
      const ok = await confirmTyped(a.id, `Remove "${a.title}" from the dashboard? The link is kept in the registry's removed log.`);
      if (!ok) return;
      try { await api.del(`/api/v1/artifacts/${a.id}`, { 'X-Confirm': a.id }); toast('Removed', 'ok'); await load(); }
      catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
    } }, 'Remove');
    return h('div', { class: 'card art-card', 'data-id': a.id },
      h('div', { class: 'title' }, titleNode(a)),
      a.description ? h('p', {}, a.description) : null,
      h('div', { class: 'wf-foot muted' }, h('span', {}, `added ${fmtTime(a.added_at)} · ${a.added_by}`),
        a.local ? h('a', { href: `#/claude?artifact=${encodeURIComponent(a.id)}`, class: 'small linkish' }, 'Open beside Claude') : null, remove));
  }
  function creatingCard(c) {
    const [label, kind] = STATE[c.state] || STATE.gone;
    const running = c.state === 'working';
    return h('div', { class: `card art-card creating${running ? ' running' : ''}` },
      h('div', { class: 'title' }, h('span', { class: 'art-link' }, running ? h('span', { class: 'spin', 'aria-hidden': 'true' }, '✻') : h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' }), h('span', {}, c.title)), badge(c.kind, '')),
      h('p', {}, c.state === 'done'
        ? 'Finished without registering a link — open the session to see why.'
        : c.state === 'blocked' ? 'The session needs an answer from you.' : `Being built · started ${ago(c.started_at)}`),
      h('div', { class: 'wf-foot muted' }, h('span', {}, `${label} · ${c.kind}`), h('a', { href: `#/claude/${encodeURIComponent(c.id)}`, class: 'small linkish' }, 'Open session')));
  }
  function draw() {
    clear(holder);
    const creating = data.creating || [];
    if (creating.length) holder.append(h('section', { class: 'art-section' }, h('h2', {}, 'Creating', badge(String(creating.length), '')), h('div', { class: 'wf-grid' }, ...creating.map(creatingCard))));
    if (data.invalid) {
      holder.append(h('div', { class: 'empty' }, `The artifact list can't be read right now (${REASON[data.reason] || 'unreadable'}). Check artifacts.json on the server.`));
      return;
    }
    if (data.artifacts.length === 0) {
      if (creating.length) return;
      holder.append(h('div', { class: 'empty' }, readOnly ? 'No artifacts registered.' : 'Nothing here yet. Create one, add a link, or say yes when Claude asks to add one it published.'));
      return;
    }
    for (const kind of Object.keys(KIND)) {
      const rows = data.artifacts.filter((a) => a.kind === kind);
      if (rows.length === 0) continue;
      holder.append(h('section', { class: 'art-section' }, h('h2', {}, KIND[kind], badge(String(rows.length), '')), h('div', { class: 'wf-grid' }, ...rows.map(card))));
    }
  }
  async function load() {
    try { data = await api.get('/api/v1/artifacts'); draw(); }
    catch (err) { clear(holder); holder.append(h('div', { class: 'empty' }, err.status === 503 ? 'The artifact list is unavailable on the server.' : err.status === 429 ? 'Too many refreshes — wait a minute.' : serverError(err, 'Something went wrong — try again.'))); }
  }

  clear(root);
  root.append(header('Artifacts', { eyebrow: 'Operate', actions: [addAction, createAction].filter(Boolean) }), createForm, form, holder);
  await load();
  bus.addEventListener('artifact', (e) => { if (e.detail && e.detail.artifacts) { data = e.detail; draw(); } });
  bus.addEventListener('csession', () => { if (data.creating && data.creating.length) load(); });
  bus.addEventListener('refresh', load);
}
