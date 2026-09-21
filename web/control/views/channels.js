import { h, clear, badge } from '../dom.js';
import { confirmTyped, toast } from '../ui.js';
import { icon } from '../icons.js';
import { header } from '../app.js';

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const grid = h('div', { class: 'grid' });
  // A served QR survives redraws: queue/refresh events rebuild the grid while
  // the user is still scanning.
  const served = new Map();
  clear(root);
  root.append(header('Channels', { eyebrow: 'Configure' }), grid);

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
        const showQr = (r) => {
          clear(panel);
          panel.append(r.ascii ? h('pre', { class: 'qr' }, r.ascii) : h('code', {}, r.qr), h('p', { class: 'muted' }, 'Scan from WhatsApp → Linked devices → Link a device. Unlink from the same screen to revoke.'));
        };
        if (served.has(c.name)) showQr(served.get(c.name));
        card.append(h('div', { class: 'chips' },
          badge(p.needs_pairing ? 'needs pairing' : 'paired', p.needs_pairing ? 'warn' : 'ok'),
          p.qr_available ? badge('QR available', 'info') : null,
          p.pairing_code_available ? badge('pairing code available', 'info') : null));
        if (!p.needs_pairing) served.delete(c.name);
        if (p.needs_pairing && p.qr_available && !readOnly) {
          card.append(h('button', { type: 'button', onclick: async () => {
            const ok = await confirmTyped('whatsapp', "This links a phone as the assistant's WhatsApp. Unlink later from WhatsApp → Linked devices.");
            if (!ok) return;
            try {
              const r = await api.post('/api/v1/channels/whatsapp/qr', undefined, { 'X-Confirm': 'whatsapp' });
              served.set(c.name, r);
              await draw(); // rebuild from state: a redraw may have replaced this card mid-request
            } catch (err) { toast(err.status === 409 ? 'Already paired' : err.message, 'error'); }
          } }, icon('qr', { size: 16 }), 'Show pairing QR'), panel);
        }
      }
      grid.append(card);
    }
  }
  await draw();
  for (const ev of ['queue', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
}
