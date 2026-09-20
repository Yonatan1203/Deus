import { h, clear, badge } from '../dom.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';

const HINTS = {
  cron: 'cron expression, e.g. 0 9 * * 1-5 (host timezone)',
  interval: 'milliseconds, at least 60000 (1 minute)',
  once: 'ISO timestamp, e.g. 2030-01-01T09:00:00Z',
};

function schedule(t) {
  if (t.schedule_type === 'interval') return `every ${Math.round(Number(t.schedule_value) / 60000)} min`;
  if (t.schedule_type === 'once') return `once at ${fmtTime(t.schedule_value)}`;
  return `cron ${t.schedule_value}`;
}

function resultBadge(t) {
  if (!t.last_run) return badge('never ran', '');
  const r = (t.last_result || '').toLowerCase();
  return badge(r.startsWith('error') ? 'last run failed' : 'last run ok', r.startsWith('error') ? 'bad' : 'ok');
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const holder = h('div', {});
  const formHolder = h('div', {});
  clear(root);
  root.append(h('h1', {}, 'Scheduled tasks'), formHolder, holder);

  let groups = [];
  try { groups = await api.get('/api/v1/groups'); } catch { groups = []; }
  const byFolder = new Map();
  for (const g of groups) byFolder.set(g.folder, [...(byFolder.get(g.folder) || []), g]);

  function newTaskForm() {
    const folderSel = h('select', { 'aria-label': 'Group' }, ...[...byFolder.keys()].map((f) => h('option', { value: f }, f)));
    const destSel = h('select', { 'aria-label': 'Destination chat' });
    const fillDest = () => { clear(destSel); for (const g of byFolder.get(folderSel.value) || []) destSel.append(h('option', { value: g.jid }, `${g.name} (${g.jid})`)); };
    folderSel.addEventListener('change', fillDest);
    fillDest();
    const prompt = h('textarea', { rows: '3', placeholder: 'What should the assistant do?' });
    const type = h('select', { 'aria-label': 'Schedule type' }, ...Object.keys(HINTS).map((k) => h('option', { value: k }, k)));
    const value = h('input', { type: 'text', placeholder: HINTS.cron, 'aria-label': 'Schedule value' });
    type.addEventListener('change', () => { value.placeholder = HINTS[type.value]; });
    const context = h('select', { 'aria-label': 'Context mode' }, h('option', { value: 'isolated' }, 'isolated session'), h('option', { value: 'group' }, 'group session'));
    const backend = h('select', { 'aria-label': 'Backend' }, h('option', { value: '' }, 'default backend'), h('option', { value: 'claude' }, 'claude'), h('option', { value: 'openai' }, 'openai'), h('option', { value: 'llama-cpp' }, 'llama-cpp'));
    const submit = h('button', { type: 'button', class: 'primary', onclick: async () => {
      try {
        await api.post('/api/v1/tasks', { group_folder: folderSel.value, chat_jid: destSel.value, prompt: prompt.value, schedule_type: type.value, schedule_value: value.value.trim(), context_mode: context.value, agent_backend: backend.value || undefined });
        toast('Task created', 'ok');
        prompt.value = ''; value.value = '';
        await draw();
      } catch (err) { toast(err.status === 403 ? 'Read-only mode' : err.message, 'error'); }
    } }, 'Create task');
    return h('details', { class: 'card new-task' },
      h('summary', {}, 'New task'),
      h('div', { class: 'form-grid' },
        h('label', {}, 'Group', folderSel), h('label', {}, 'Send output to', destSel),
        h('label', { class: 'wide' }, 'Prompt', prompt),
        h('label', {}, 'Schedule', type), h('label', {}, 'Value', value),
        h('label', {}, 'Context', context), h('label', {}, 'Backend', backend)),
      h('div', { class: 'editor-actions' }, submit));
  }

  function row(t) {
    const runsHolder = h('div', { class: 'runs', hidden: true });
    const actions = readOnly ? [] : [
      t.status === 'active' ? h('button', { type: 'button', class: 'small', onclick: () => act(() => api.post(`/api/v1/tasks/${encodeURIComponent(t.id)}/run`), 'Queued to run within a minute') }, 'Run now') : null,
      h('button', { type: 'button', class: 'small', onclick: () => act(() => api.patch(`/api/v1/tasks/${encodeURIComponent(t.id)}`, { status: t.status === 'paused' ? 'active' : 'paused' }), t.status === 'paused' ? 'Resumed' : 'Paused') }, t.status === 'paused' ? 'Resume' : 'Pause'),
      h('button', { type: 'button', class: 'small danger', onclick: async () => {
        const ok = await confirmTyped(t.id, `Delete task ${t.id}? Its run history goes with it.`);
        if (ok) act(() => api.del(`/api/v1/tasks/${encodeURIComponent(t.id)}`, { 'X-Confirm': t.id }), 'Deleted');
      } }, 'Delete'),
    ];
    const runsBtn = h('button', { type: 'button', class: 'small ghost', onclick: async () => {
      runsHolder.hidden = !runsHolder.hidden;
      if (runsHolder.hidden) return;
      clear(runsHolder);
      const runs = await api.get(`/api/v1/tasks/${encodeURIComponent(t.id)}/runs?limit=20`);
      if (runs.length === 0) { runsHolder.append(h('p', { class: 'muted' }, 'No runs yet.')); return; }
      runsHolder.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['When', 'Duration', 'Status', 'Output'].map((x) => h('th', {}, x)))),
        h('tbody', {}, ...runs.map((r) => h('tr', {}, h('td', {}, fmtTime(r.run_at)), h('td', {}, `${r.duration_ms} ms`), h('td', {}, badge(r.status, r.status === 'success' ? 'ok' : 'bad')), h('td', {}, h('pre', { class: 'run-output' }, r.error || r.result || ''))))))));
    } }, 'Runs');
    return h('div', { class: 'row task', 'data-id': t.id },
      h('div', {},
        h('div', { class: 'name' }, t.prompt.length > 120 ? t.prompt.slice(0, 120) + '…' : t.prompt),
        h('div', { class: 'meta' },
          h('span', {}, `${t.group_folder} → ${t.chat_jid} · ${schedule(t)}${t.agent_backend ? ` · ${t.agent_backend}` : ''}`),
          h('div', { class: 'chips' }, badge(t.status, t.status === 'active' ? 'ok' : t.status === 'paused' ? 'warn' : ''), resultBadge(t), h('span', { class: 'chip' }, `next ${fmtTime(t.next_run)}`), h('span', { class: 'chip' }, `id ${t.id}`)),
          runsHolder)),
      h('div', { class: 'actions-col' }, runsBtn, ...actions));
  }

  async function act(fn, okMsg) {
    try { await fn(); toast(okMsg, 'ok'); await draw(); }
    catch (err) { toast(err.status === 403 ? 'Read-only mode' : err.message, 'error'); }
  }

  async function draw() {
    const tasks = await api.get('/api/v1/tasks');
    clear(holder);
    if (tasks.length === 0) holder.append(h('div', { class: 'empty' }, 'No scheduled tasks.'));
    else holder.append(...tasks.map(row));
  }
  clear(formHolder);
  if (!readOnly && byFolder.size) formHolder.append(newTaskForm());
  await draw();
  for (const ev of ['task', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
}
