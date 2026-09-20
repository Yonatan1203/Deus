import { h, clear, badge } from '../dom.js';
import { confirmTyped, toast } from '../ui.js';

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const grid = h('div', { class: 'grid' });
  clear(root);
  root.append(h('h1', {}, 'Channels'), grid);

  async function draw() {
    const channels = await api.get('/api/v1/channels');
    clear(grid);
    for (const c of channels) {
      const card = h('article', { class: 'card' },
        h('div', { class: 'title' }, h('span', {}, c.name), badge(c.connected ? 'connected' : 'not connected', c.connected ? 'ok' : '')),
        h('p', {}, c.package),
        h('div', { class: 'chips' },
          c.configured === null ? badge('config unknown', '') : badge(c.configured ? 'configured' : 'not configured', c.configured ? 'ok' : 'warn'),
          ...c.groups.map((g) => h('span', { class: 'chip' }, g))));
      if (c.pairing) {
        const p = c.pairing;
        const panel = h('div', { class: 'pairing' });
        card.append(h('div', { class: 'chips' },
          badge(p.needs_pairing ? 'needs pairing' : 'paired', p.needs_pairing ? 'warn' : 'ok'),
          p.qr_available ? badge('QR available', 'info') : null,
          p.pairing_code_available ? badge('pairing code available', 'info') : null));
        if (p.needs_pairing && p.qr_available && !readOnly) {
          card.append(h('button', { type: 'button', onclick: async () => {
            const ok = await confirmTyped('whatsapp', "This links a phone as the assistant's WhatsApp. Unlink later from WhatsApp → Linked devices.");
            if (!ok) return;
            try {
              const r = await api.post('/api/v1/channels/whatsapp/qr', undefined, { 'X-Confirm': 'whatsapp' });
              clear(panel);
              panel.append(r.ascii ? h('pre', { class: 'qr' }, r.ascii) : h('code', {}, r.qr), h('p', { class: 'muted' }, 'Scan from WhatsApp → Linked devices → Link a device. Unlink from the same screen to revoke.'));
            } catch (err) { toast(err.status === 409 ? 'Already paired' : err.message, 'error'); }
          } }, 'Show pairing QR'), panel);
        }
      }
      grid.append(card);
    }
  }
  await draw();
  for (const ev of ['queue', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
}
