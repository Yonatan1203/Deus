import { h, clear, badge } from '../dom.js';
import { header } from '../app.js';

const fmtBytes = (n) => {
  if (typeof n !== 'number') return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtDur = (s) => {
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m`;
};
const tile = (label, value, sub) => h('div', { class: 'tile' }, h('span', { class: 'eyebrow' }, label), h('div', { class: 'value' }, value), sub ? h('div', { class: 'muted' }, sub) : null);

export async function render(root, api, bus) {
  const holder = h('div', {});
  function draw(s) {
    clear(holder);
    const disk = s.disk;
    const diskTile = 'used_pct' in disk
      ? h('div', { class: 'tile' }, h('span', { class: 'eyebrow' }, 'Disk (repo)'), h('div', { class: 'value' }, `${disk.used_pct}%`, s.alert === 'disk' ? badge('alert', 'bad') : null),
          h('progress', { class: `bar ${disk.used_pct >= 85 ? 'bad' : ''}`.trim(), value: String(disk.used_pct), max: '100', 'aria-label': 'Disk used' }),
          h('div', { class: 'muted' }, `${fmtBytes(disk.free)} free of ${fmtBytes(disk.total)}`))
      : tile('Disk', '—', disk.error);
    holder.append(
      h('div', { class: 'tiles' },
        tile('Uptime', fmtDur(s.pid_uptime_s), `host ${fmtDur(s.os_uptime_s)}`),
        tile('Load', s.load.map((x) => x.toFixed(2)).join(' · '), '1 · 5 · 15 min'),
        tile('Memory', fmtBytes(s.mem.rss), `${fmtBytes(s.mem.free)} free of ${fmtBytes(s.mem.total)}`),
        diskTile,
        tile('Runtime', s.docker.version ? `docker ${s.docker.version}` : 'unreachable', s.docker.error || ''),
        tile('Versions', `v${s.version}`, `node ${s.node} · ${s.platform}/${s.arch}`)),
      s.docker.df && s.docker.df.length ? h('h2', {}, 'Runtime disk usage') : null,
      s.docker.df && s.docker.df.length ? h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ...['Type', 'Total', 'Active', 'Size', 'Reclaimable'].map((t) => h('th', {}, t)))),
        h('tbody', {}, ...s.docker.df.map((r) => h('tr', {}, h('td', {}, r.type), h('td', {}, r.total), h('td', {}, r.active), h('td', {}, r.size), h('td', {}, r.reclaimable)))))) : null);
  }
  clear(root);
  root.append(header('System', { eyebrow: 'System' }), holder);
  draw(await api.get('/api/v1/system'));
  bus.addEventListener('system', (e) => draw(e.detail));
  bus.addEventListener('refresh', async () => { try { draw(await api.get('/api/v1/system')); } catch { /* keep last */ } });
}
