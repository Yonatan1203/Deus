import { h, clear } from '../dom.js';
import { header } from '../app.js';
import { banner, confirmTyped, toast } from '../ui.js';

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const holder = h('div', {});
  async function draw() {
    const cfg = await api.get('/api/v1/config');
    clear(holder);
    if (!cfg.env_file_exists) holder.append(h('p', { class: 'muted' }, 'No .env file — showing editable keys from the process environment.'));
    holder.append(h('div', { class: 'table-wrap' }, h('table', { class: 'kv' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value'), h('th', {}, 'Source'), h('th', {}, ''))),
      h('tbody', {}, ...cfg.keys.map((k) => {
        const valueCell = h('td', {}, h('code', {}, k.value));
        const actionCell = h('td', {});
        if (k.editable && !readOnly) {
          const edit = h('button', { type: 'button', class: 'small ghost', onclick: () => {
            const input = h('input', { type: 'text', value: k.value, 'aria-label': `New value for ${k.key}` });
            const save = h('button', { type: 'button', class: 'small primary', onclick: async () => {
              const ok = await confirmTyped(k.key, `Change ${k.key} in .env? A backup is kept; the assistant must be restarted to apply it.`);
              if (!ok) return;
              try {
                const r = await api.patch('/api/v1/config', { key: k.key, value: input.value }, { 'X-Confirm': k.key });
                toast(`Saved (backup ${r.backup}) — restart required`, 'ok');
                banner('Configuration changed on disk; restart the assistant to apply it.');
                await draw();
              } catch (err) { toast(err.status === 403 ? 'Read-only mode' : err.message, 'error'); }
            } }, 'Save');
            const cancel = h('button', { type: 'button', class: 'small ghost', onclick: () => draw() }, 'Cancel');
            clear(valueCell); valueCell.append(input);
            clear(actionCell); actionCell.append(h('div', { class: 'actions-col' }, save, cancel));
          } }, 'Edit');
          actionCell.append(edit);
        }
        return h('tr', {}, h('td', {}, h('code', {}, k.key)), valueCell, h('td', {}, h('span', { class: 'chip' }, k.source)), actionCell);
      })))),
      h('p', { class: 'muted' }, `${cfg.secret_keys_omitted} secret-looking key${cfg.secret_keys_omitted === 1 ? '' : 's'} not shown. Values save to .env; restart to apply.`));
  }
  clear(root);
  root.append(header('Config', { eyebrow: 'System' }), holder);
  await draw();
}
