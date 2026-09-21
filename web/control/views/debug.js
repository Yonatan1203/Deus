import { h, clear, badge } from '../dom.js';
import { header } from '../app.js';
import { fmtTime, toast } from '../ui.js';

const tile = (label, value) => h('div', { class: 'tile' }, h('span', { class: 'eyebrow' }, label), h('div', { class: 'value' }, String(value)));

export async function render(root, api, bus) {
  const health = h('div', { class: 'health list' });
  const counts = h('div', { class: 'tiles' });
  const events = h('div', {});
  const traceOut = h('div', {});
  const traceInput = h('input', { type: 'text', placeholder: 'message id', 'aria-label': 'Message id' });
  const traceBtn = h('button', { type: 'button', class: 'small primary', onclick: async () => {
    clear(traceOut);
    try {
      const r = await api.get(`/api/v1/debug/trace?message_id=${encodeURIComponent(traceInput.value.trim())}`);
      if (r.messages.length === 0) { traceOut.append(h('div', { class: 'empty' }, 'No message with that id.')); return; }
      traceOut.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['Chat', 'When', 'From me', 'Bot', 'Length'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...r.messages.map((m) => h('tr', {}, h('td', {}, h('code', {}, m.chat_jid)), h('td', {}, fmtTime(m.timestamp)), h('td', {}, m.is_from_me ? 'yes' : 'no'), h('td', {}, m.is_bot_message ? 'yes' : 'no'), h('td', {}, String(m.content_length))))))));
      if (r.queue) traceOut.append(h('p', { class: 'muted' }, `Queue: ${r.queue.active ? 'active' : 'idle'}${r.queue.containerName ? ` · ${r.queue.containerName}` : ''}${r.queue.pendingTaskCount ? ` · ${r.queue.pendingTaskCount} pending` : ''}`));
      if (r.session) traceOut.append(h('p', { class: 'muted' }, `Session: ${r.session.backend || '—'} · last used ${fmtTime(r.session.last_used_at)}${r.session.orphaned_at ? ' · orphaned' : ''}`));
    } catch (err) { toast(err.status === 400 ? 'Invalid message id' : err.message, 'error'); }
  } }, 'Trace');

  async function draw() {
    const [hl, ct, ev] = await Promise.all([api.get('/api/v1/debug/health'), api.get('/api/v1/debug/counts'), api.get('/api/v1/debug/events')]);
    clear(health);
    const item = (name, ok, detail) => h('div', { class: 'row' }, h('div', {}, h('div', { class: 'name' }, name), detail ? h('div', { class: 'meta' }, h('span', {}, detail)) : null), badge(ok ? 'ok' : 'down', ok ? 'ok' : 'bad'));
    health.append(
      item('Container runtime', hl.docker.ok, hl.docker.version ? `docker ${hl.docker.version}` : hl.docker.error),
      item('Database', hl.db.ok),
      ...hl.channels.map((c) => item(`Channel ${c.name}`, c.connected)),
      item('Event stream', true, `${hl.sse_clients} client${hl.sse_clients === 1 ? '' : 's'}`),
      item('Image build', true, hl.build_running ? 'running' : 'idle'));
    clear(counts);
    counts.append(tile('Groups', ct.groups), tile('Tasks', `${ct.tasks.active} active · ${ct.tasks.paused} paused`), tile('Sessions', ct.sessions), tile('Containers', ct.containers_active), tile('Messages', ct.messages), tile('SSE clients', ct.sse_clients));
    clear(events);
    if (ev.events.length === 0) events.append(h('div', { class: 'empty' }, 'No events yet.'));
    else events.append(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Id'), h('th', {}, 'Type'), h('th', {}, 'At'))),
      h('tbody', {}, ...ev.events.slice().reverse().map((e) => h('tr', {}, h('td', {}, h('code', {}, String(e.id))), h('td', {}, e.type), h('td', {}, fmtTime(new Date(e.at).toISOString()))))))));
  }
  clear(root);
  root.append(header('Debug', { eyebrow: 'System' }), h('h2', {}, 'Health'), health, h('h2', {}, 'Counts'), counts, h('h2', {}, 'Recent events'), events, h('h2', {}, 'Trace a message'), h('div', { class: 'toolbar' }, traceInput, traceBtn), traceOut);
  await draw();
  bus.addEventListener('refresh', () => { draw().catch(() => {}); });
}
