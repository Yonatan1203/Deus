import { h, clear, badge } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, toast } from '../ui.js';

function row(c, api, readOnly, refresh) {
  const stop = readOnly ? null : h('button', { type: 'button', class: 'small danger', onclick: async () => {
    const ok = await confirmTyped(c.name, `Stop ${c.name}? The agent turn running in it is cut short.`);
    if (!ok) return;
    try {
      await api.post(`/api/v1/containers/${encodeURIComponent(c.name)}/stop`, undefined, { 'X-Confirm': c.name });
      toast('Stop requested', 'ok');
      await refresh();
    } catch (err) { toast(err.status === 404 ? 'Not one of this instance’s containers' : err.message, 'error'); }
  } }, icon('stop', { size: 14 }), 'Stop');
  return h('div', { class: 'row', 'data-name': c.name },
    h('div', {},
      h('div', { class: 'name mono' }, c.name),
      h('div', { class: 'meta' },
        h('span', {}, `${c.image} · ${c.status || c.state}`),
        h('div', { class: 'chips' },
          badge(c.state, c.state === 'running' ? 'ok' : ''),
          c.group_folder ? h('span', { class: 'chip' }, `group ${c.group_folder}`) : null,
          c.is_task_container ? badge(c.running_task_id ? `task ${c.running_task_id}` : 'task', 'info') : null))),
    stop);
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const holder = h('div', {});
  const consoleBox = h('pre', { class: 'console', hidden: true });
  const buildState = h('div', { class: 'build-state muted', hidden: true });
  const rebuild = readOnly ? null : h('button', { type: 'button', class: 'small', onclick: async () => {
    const ok = await confirmTyped('rebuild', 'Rebuild the agent image? Every future agent turn runs on the result.', ['Runs container/build.sh on the host', 'One build at a time; output streams below']);
    if (!ok) return;
    try {
      const r = await api.post('/api/v1/containers/rebuild', undefined, { 'X-Confirm': 'rebuild' });
      clear(consoleBox);
      consoleBox.hidden = false;
      toast(`Build started (${r.image_ref}${r.head ? ` @ ${r.head.slice(0, 7)}${r.dirty ? '+dirty' : ''}` : ''})`, 'ok');
      showBuild(await api.get('/api/v1/containers/build'));
    } catch (err) { toast(err.status === 409 ? 'A build is already running' : err.status === 501 ? 'Rebuild needs a POSIX host' : err.message, 'error'); }
  } }, icon('refresh', { size: 14 }), 'Rebuild image');

  function showBuild(st) {
    buildState.hidden = false;
    buildState.textContent = st.running ? 'Build running…' : st.code === null ? 'No build yet' : `Last build exited ${st.code}`;
    if (st.lines.length) { consoleBox.hidden = false; clear(consoleBox); consoleBox.append(st.lines.join('\n')); }
  }

  async function draw() {
    const r = await api.get('/api/v1/containers');
    clear(holder);
    if (r.probe_error) { holder.append(h('div', { class: 'empty' }, `Container runtime unreachable: ${r.probe_error}`)); return; }
    if (r.containers.length === 0) { holder.append(h('div', { class: 'empty' }, 'No containers for this instance.')); return; }
    holder.append(h('div', { class: 'list' }, ...r.containers.map((c) => row(c, api, readOnly, draw))));
  }

  clear(root);
  root.append(header('Containers', { eyebrow: 'System', actions: rebuild ? [rebuild] : [] }), holder, buildState, consoleBox);
  await draw();
  try { showBuild(await api.get('/api/v1/containers/build')); } catch { /* status is optional */ }
  bus.addEventListener('build', (e) => {
    const d = e.detail;
    if (d.line !== undefined) { consoleBox.hidden = false; consoleBox.append(`${d.line}\n`); consoleBox.scrollTop = consoleBox.scrollHeight; }
    if (d.done) { buildState.textContent = `Build exited ${d.code}`; toast(d.code === 0 ? 'Image rebuilt' : `Build failed (${d.code})`, d.code === 0 ? 'ok' : 'error'); }
  });
  for (const ev of ['queue', 'container', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
}
