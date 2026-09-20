import { h, clear, badge } from '../dom.js';
import { confirmTyped, toast } from '../ui.js';

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const grid = h('div', { class: 'grid' });
  const editor = h('div', { class: 'editor', hidden: true });
  clear(root);
  root.append(h('h1', {}, 'Groups'), grid, editor);

  async function openEditor(g) {
    clear(editor);
    editor.hidden = false;
    let doc;
    try { doc = await api.get(`/api/v1/groups/${encodeURIComponent(g.folder)}/claude-md`); }
    catch (err) { if (err.status !== 404) { toast(err.message, 'error'); return; } doc = { content: '', bytes: 0 }; }
    const area = h('textarea', { class: 'editor-area', spellcheck: 'false', readonly: readOnly });
    area.value = doc.content;
    const count = h('span', { class: 'muted' }, `${new TextEncoder().encode(area.value).length} bytes`);
    area.addEventListener('input', () => { count.textContent = `${new TextEncoder().encode(area.value).length} bytes`; });
    const save = readOnly ? null : h('button', { type: 'button', class: 'primary', onclick: async () => {
      const ok = await confirmTyped(g.folder, `Overwrite CLAUDE.md for ${g.name}? The next agent turn runs under it.`);
      if (!ok) return;
      try {
        const r = await api.put(`/api/v1/groups/${encodeURIComponent(g.folder)}/claude-md`, { content: area.value }, { 'X-Confirm': g.folder });
        toast(r.backup ? `Saved (backup ${r.backup})` : 'Saved', 'ok');
      } catch (err) { toast(err.status === 403 ? 'Read-only mode' : err.message, 'error'); }
    } }, 'Save');
    editor.append(
      h('div', { class: 'editor-head' }, h('h2', {}, `${g.folder}/CLAUDE.md`), count, h('button', { type: 'button', class: 'ghost', onclick: () => { editor.hidden = true; } }, 'Close')),
      area,
      save ? h('div', { class: 'editor-actions' }, save) : h('p', { class: 'muted' }, 'Read-only mode'));
    editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function draw() {
    const groups = await api.get('/api/v1/groups');
    clear(grid);
    if (groups.length === 0) { grid.append(h('div', { class: 'empty' }, 'No registered groups.')); return; }
    for (const g of groups) {
      const c = g.container;
      grid.append(h('article', { class: 'card' },
        h('div', { class: 'title' }, h('span', {}, g.name), g.is_control_group ? badge('control group', 'info') : null),
        h('p', {}, `folder ${g.folder} · trigger ${g.trigger || '—'}${g.backend ? ` · ${g.backend}` : ''}`),
        h('div', { class: 'chips' },
          c && c.active ? badge(`container ${c.containerName || ''}`.trim(), 'ok') : badge('no container', ''),
          g.folder_exists ? badge(g.claude_md_bytes ? `CLAUDE.md ${g.claude_md_bytes} B` : 'CLAUDE.md missing', g.claude_md_bytes ? 'ok' : 'warn') : badge('folder missing', 'bad'),
          g.requires_trigger ? null : badge('no trigger needed', '')),
        h('div', {}, h('button', { type: 'button', onclick: () => openEditor(g) }, readOnly ? 'View CLAUDE.md' : 'Open CLAUDE.md'))));
    }
  }
  await draw();
  for (const ev of ['group', 'queue', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
}
