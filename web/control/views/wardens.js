import { h, clear } from '../dom.js';
import { banner, confirmTyped, toast } from '../ui.js';

function updateBanner(list) {
  const off = list.filter((w) => !w.enabled).length;
  banner(off ? `${off} warden${off === 1 ? '' : 's'} disabled — review gates are weakened.` : '');
}

function row(w, api, readOnly, onChange) {
  const sw = h('button', {
    class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(w.enabled), 'aria-label': `${w.name} enabled`,
    hidden: readOnly,
    onclick: async () => {
      const next = !w.enabled;
      const headers = {};
      if (!next) {
        const ok = await confirmTyped(w.name, `Disable ${w.name}? Its gate stops running until re-enabled.`);
        if (!ok) return;
        headers['X-Confirm'] = w.name;
      }
      sw.disabled = true;
      try {
        const updated = await api.patch(`/api/v1/wardens/${encodeURIComponent(w.name)}`, { enabled: next }, headers);
        onChange(updated);
        toast(`${w.name} ${updated.enabled ? 'enabled' : 'disabled'}`, 'ok');
      } catch (err) {
        toast(err.status === 403 ? 'Read-only mode' : err.message, 'error');
      } finally {
        sw.disabled = false;
      }
    },
  });
  const el = h('div', { class: 'row', 'data-name': w.name },
    h('div', {},
      h('div', { class: 'name' }, w.name),
      h('div', { class: 'meta' },
        h('span', {}, w.rules_file ? `rules: ${w.rules_file}` : 'no rules file'),
        h('div', { class: 'chips' },
          ...w.tools.map((t) => h('span', { class: 'chip' }, t)),
          ...(w.backends || []).map((b) => h('span', { class: 'chip' }, `backend: ${b}`)),
          w.auto_threshold != null ? h('span', { class: 'chip' }, `auto: ${w.auto_threshold}`) : null))),
    sw);
  return el;
}

export async function render(root, api, bus, me) {
  let list = await api.get('/api/v1/wardens');
  clear(root);
  const holder = h('div', {});
  const readOnly = Boolean(me && me.read_only);
  const draw = () => {
    clear(holder);
    if (list.length === 0) holder.append(h('div', { class: 'empty' }, 'No wardens configured.'));
    else holder.append(...list.map((w) => row(w, api, readOnly, apply)));
    updateBanner(list);
  };
  const apply = (updated) => {
    list = list.map((w) => (w.name === updated.name ? updated : w));
    draw();
  };
  root.append(h('h1', {}, `Wardens (${list.length})`), holder);
  draw();
  bus.addEventListener('warden', (e) => apply(e.detail));
  bus.addEventListener('refresh', async () => { list = await api.get('/api/v1/wardens'); draw(); });
}
