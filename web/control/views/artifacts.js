import { h, clear, badge } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';

// The operator's curated list of live artifact apps, reports and previews.
// Titles and descriptions are text nodes; an href is built only from a URL
// the server already cleared (`url` a string). `url: null` + `blocked` is a
// policy-withheld link; a missing `url` means read-only.
const KIND = { app: 'Apps', report: 'Reports', preview: 'Previews' };
const BLOCKED = { userinfo: 'link withheld · credentials in URL', host: 'link withheld · host not allowed', protocol: 'link withheld · scheme not allowed', 'secret-query': 'link withheld · secret in query' };
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
      toast(err.data && err.data.blocked ? `Not allowed: ${BLOCKED[err.data.blocked] || err.data.blocked}` : err.status === 429 ? 'Too many changes — wait a minute' : err.message, 'error');
    } finally { addBtn.disabled = false; }
  } }, 'Add');
  form.append(
    h('div', { class: 'form-grid' },
      h('label', {}, 'Title', titleInput), h('label', {}, 'Kind', kindSel),
      h('label', { class: 'wide' }, 'URL', urlInput, h('span', { class: 'hint' }, 'claude.ai links, or a host the operator allowed on the server')),
      h('label', { class: 'wide' }, 'Description', descInput)),
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => { form.hidden = true; } }, 'Cancel'), addBtn));
  const addAction = readOnly ? null : h('button', { type: 'button', class: 'small primary', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) titleInput.focus(); } }, icon('plus', { size: 14 }), 'Add artifact');

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
      catch (err) { toast(err.message, 'error'); }
    } }, 'Remove');
    return h('div', { class: 'card art-card', 'data-id': a.id },
      h('div', { class: 'title' }, titleNode(a)),
      a.description ? h('p', {}, a.description) : null,
      h('div', { class: 'wf-foot muted' }, h('span', {}, `added ${fmtTime(a.added_at)} · ${a.added_by}`), remove));
  }
  function draw() {
    clear(holder);
    if (data.invalid) {
      holder.append(h('div', { class: 'empty' }, `Registry unreadable: ${REASON[data.reason] || data.reason}. Fix or move artifacts.json on the host.`));
      return;
    }
    if (data.artifacts.length === 0) {
      holder.append(h('div', { class: 'empty' }, readOnly ? 'No artifacts registered.' : 'Nothing registered yet. Add a link here, or say yes when a session asks to register one it published.'));
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
    catch (err) { clear(holder); holder.append(h('div', { class: 'empty' }, err.status === 503 ? 'Artifact registry unavailable on the server.' : err.status === 429 ? 'Too many refreshes — wait a minute.' : err.message)); }
  }

  clear(root);
  root.append(header('Artifacts', { eyebrow: 'Operate', actions: addAction ? [addAction] : [] }), form, holder);
  await load();
  bus.addEventListener('artifact', (e) => { if (e.detail && e.detail.artifacts) { data = e.detail; draw(); } });
  bus.addEventListener('refresh', load);
}
