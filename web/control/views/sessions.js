import { h, clear, badge } from '../dom.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';
import { header } from '../app.js';

function state(row) {
  if (row.active_container) return badge(`container: ${row.active_container.name}`, 'ok');
  if (row.orphaned_at) return badge(`orphaned: ${row.orphan_reason || '?'}`, 'warn');
  return badge('idle', '');
}

function cost(m) {
  if (!m) return 'n/a';
  const parts = [];
  if (typeof m.cost_usd === 'number') parts.push(`$${m.cost_usd.toFixed(3)}`);
  if (typeof m.tokens === 'number') parts.push(`${m.tokens} tok`);
  return parts.join(' · ') || 'n/a';
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const holder = h('div', {});
  clear(root);
  root.append(header('Sessions', { eyebrow: 'Operate' }), holder);

  async function draw() {
    const data = await api.get('/api/v1/sessions');
    clear(holder);
    if (data.rows.length === 0) { holder.append(h('div', { class: 'empty' }, 'No sessions recorded.')); return; }
    const seen = new Set();
    holder.append(h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Group', 'Backend', 'Ref', 'Last used', 'State', 'Usage', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, ...data.rows.map((row) => {
        const containers = data.containers[row.group_folder] || [];
        const canKill = !readOnly && !seen.has(row.group_folder) && (containers.length > 0 || !row.orphaned_at);
        seen.add(row.group_folder);
        const kill = canKill ? h('button', { type: 'button', class: 'danger small', onclick: async () => {
          const details = containers.length
            ? containers.map((c) => `${c.name} — ${c.isTaskContainer ? 'scheduled task' : 'chat'}${c.runningTaskId ? ` (${c.runningTaskId})` : ''}`)
            : ['no running container — session rows will be orphaned'];
          const ok = await confirmTyped(row.group_folder, `Kill sessions for ${row.group_folder}? This stops:`, details);
          if (!ok) return;
          try {
            const r = await api.post(`/api/v1/sessions/${encodeURIComponent(row.group_folder)}/kill`, undefined, { 'X-Confirm': row.group_folder });
            toast(`Stopped ${r.stopped.length} container(s)${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`, r.errors.length ? 'error' : 'ok');
            await draw();
          } catch (err) { toast(err.status === 403 ? 'Read-only mode' : err.message, 'error'); }
        } }, 'Kill') : null;
        return h('tr', {},
          h('td', {}, row.group_folder),
          h('td', {}, row.backend),
          h('td', {}, h('code', {}, row.session_ref)),
          h('td', {}, fmtTime(row.last_used_at)),
          h('td', {}, state(row)),
          h('td', {}, cost(row.metadata)),
          h('td', {}, kill));
      })))));
  }
  await draw();
  for (const ev of ['session', 'queue', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
}
