import { h, clear } from '../dom.js';
import { toast } from '../ui.js';
import { icon } from '../icons.js';
import { header } from '../app.js';

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const list = h('div', { class: 'memory-list' });
  const viewer = h('div', { class: 'memory-viewer' }, h('div', { class: 'empty' }, 'Pick a file.'));
  const filter = h('input', { type: 'search', placeholder: 'Filter files…', 'aria-label': 'Filter files' });
  clear(root);
  root.append(header('Memory', { eyebrow: 'Configure' }), h('div', { class: 'memory' }, h('div', { class: 'memory-side' }, filter, list), viewer));

  let entries = [];
  function drawList() {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    const shown = entries.filter((e) => !q || `${e.root}:${e.path}`.toLowerCase().includes(q));
    if (shown.length === 0) { list.append(h('div', { class: 'empty' }, 'No files.')); return; }
    for (const e of shown) {
      const item = h('button', { type: 'button', class: 'memory-item', onclick: () => { for (const b of list.children) b.removeAttribute('aria-current'); item.setAttribute('aria-current', 'true'); open(e); } },
        icon(e.writable ? 'file' : 'lock', { size: 16 }), h('span', { class: 'path' }, `${e.root}/${e.path}`), h('span', { class: 'chip' }, `${e.bytes} B`));
      list.append(item);
    }
  }

  async function open(e) {
    clear(viewer);
    let doc;
    try { doc = await api.get(`/api/v1/memory/file?root=${encodeURIComponent(e.root)}&path=${encodeURIComponent(e.path)}`); }
    catch (err) { toast(err.message, 'error'); return; }
    const pre = h('pre', { class: 'memory-content' }, doc.content);
    const head = h('div', { class: 'editor-head' }, h('h2', {}, `${e.root}/${e.path}`), h('span', { class: 'muted' }, `${doc.bytes} B`));
    viewer.append(head, pre);
    if (readOnly || !e.writable) {
      const isGroupsClaude = e.root === 'groups' && e.path.endsWith('/CLAUDE.md');
      viewer.append(h('p', { class: 'muted' }, readOnly ? 'Read-only mode' : isGroupsClaude ? 'Edit this file from the Groups tab.' : 'Read-only from the dashboard.'));
      return;
    }
    const edit = h('button', { type: 'button', onclick: () => {
      const area = h('textarea', { class: 'editor-area', spellcheck: 'false' });
      area.value = doc.content;
      const save = h('button', { type: 'button', class: 'primary', onclick: async () => {
        if (!window.confirm(`Save ${e.path}? A backup is kept.`)) return;
        try {
          const r = await api.put('/api/v1/memory/file', { root: e.root, path: e.path, content: area.value }, { 'X-Confirm-Edit': '1' });
          toast(r.index_not_updated ? `Saved (backup ${r.backup}) — semantic index not updated` : `Saved (backup ${r.backup})`, 'ok');
          await open(e);
        } catch (err) { toast(err.message, 'error'); }
      } }, 'Save');
      pre.replaceWith(area);
      edit.replaceWith(h('div', { class: 'editor-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => open(e) }, 'Cancel'), save));
    } }, 'Edit');
    viewer.append(h('div', { class: 'editor-actions' }, edit));
  }

  async function load() {
    entries = await api.get('/api/v1/memory/tree');
    drawList();
  }
  filter.addEventListener('input', drawList);
  await load();
  for (const ev of ['memory', 'refresh']) bus.addEventListener(ev, () => { load().catch(() => {}); });
}
