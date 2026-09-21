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
      if (c.name === 'gmail') card.append(await gmailPanel());
      grid.append(card);
    }
  }

  // The assistant's own Gmail channel: paste the Google Desktop client once,
  // Connect in Google, Disconnect revokes. Only booleans, ages and the account
  // email ever reach this panel; the server keeps every secret.
  async function gmailPanel() {
    const panel = h('div', { class: 'pairing gmail-panel' });
    let st;
    try { st = await api.get('/api/v1/integrations/gmail'); }
    catch (err) { panel.append(h('p', { class: 'muted' }, err.message)); return panel; }
    const chips = h('div', { class: 'chips' },
      badge(st.keys ? 'client keys saved' : st.keys_invalid ? 'client keys invalid' : 'no client keys', st.keys ? 'ok' : 'warn'),
      badge(st.connected ? 'account connected' : 'not connected', st.connected ? 'ok' : ''),
      st.connected ? badge(st.channel_live ? 'channel live' : 'channel not running', st.channel_live ? 'ok' : 'warn') : null);
    panel.append(chips);
    if (st.connected) {
      const age = st.token_age_ms != null ? `token refreshed ${Math.max(1, Math.round(st.token_age_ms / 3_600_000))}h ago` : null;
      panel.append(h('p', {}, `Connected as ${st.email || 'unknown account'}${age ? ` · ${age}` : ''}`));
      if (!readOnly) {
        panel.append(h('button', { type: 'button', class: 'small danger', onclick: async () => {
          const ok = await confirmTyped('gmail', 'Disconnect this Gmail account? The token is revoked at Google and the assistant stops reading the mailbox.');
          if (!ok) return;
          try {
            const r = await api.post('/api/v1/integrations/gmail/disconnect', undefined, { 'X-Confirm': 'gmail' });
            toast(r.revoked ? 'Disconnected' : 'Disconnected, but the token could not be revoked — remove access at myaccount.google.com/permissions', r.revoked ? 'ok' : 'error');
            if (!r.deleted) toast('A token file reappeared; disconnect again in a moment', 'error');
            await draw();
          } catch (err) { toast(err.message, 'error'); }
        } }, 'Disconnect'));
      }
      return panel;
    }
    if (readOnly) { panel.append(h('p', { class: 'muted' }, 'Read-only mode: connect from a read-write session.')); return panel; }
    if (!st.keys) {
      const box = h('textarea', { rows: '4', placeholder: 'Paste the OAuth client JSON downloaded from Google Cloud (Desktop app type)', 'aria-label': 'OAuth client JSON' });
      const save = h('button', { type: 'button', class: 'small primary', onclick: async () => {
        save.disabled = true;
        try {
          await api.post('/api/v1/integrations/gmail/keys', { json: box.value });
          box.value = '';
          toast('Client keys saved', 'ok');
          await draw();
        } catch (err) { toast(err.status === 400 ? 'That is not a Google OAuth client JSON' : err.message, 'error'); }
        finally { save.disabled = false; }
      } }, 'Save keys');
      panel.append(
        h('p', { class: 'muted' }, 'One-time: create an OAuth client of type Desktop app in Google Cloud with the Gmail API enabled, download its JSON and paste it here. The secret is stored on the server only.'),
        box, h('div', { class: 'editor-actions' }, save));
      return panel;
    }
    panel.append(
      h('p', { class: 'muted' }, `Google will send you back to ${st.redirect_uri} — keep the SSH tunnel open while you consent.`),
      h('div', { class: 'editor-actions' },
        h('button', { type: 'button', class: 'small ghost', onclick: async () => {
          const ok = await confirmTyped('gmail', 'Forget the saved client keys? You will need to paste the JSON again to connect.');
          if (!ok) return;
          try { await api.del('/api/v1/integrations/gmail/keys', { 'X-Confirm': 'gmail' }); toast('Client keys forgotten', 'ok'); await draw(); }
          catch (err) { toast(err.status === 409 ? 'Disconnect first' : err.message, 'error'); }
        } }, 'Forget keys'),
        h('button', { type: 'button', class: 'small primary', onclick: async () => {
          try {
            const r = await api.post('/api/v1/integrations/gmail/connect');
            window.open(r.url, '_blank', 'noopener'); // server-built consent URL
            toast('Finish in the Google tab, then come back here', 'info');
          } catch (err) { toast(err.status === 409 ? 'Save the client keys first' : err.message, 'error'); }
        } }, icon('external', { size: 14 }), 'Connect Gmail')));
    return panel;
  }
  await draw();
  for (const ev of ['queue', 'refresh']) bus.addEventListener(ev, () => { draw().catch(() => {}); });
  const onVisible = () => { if (!document.hidden) draw().catch(() => {}); }; // back from the Google tab
  document.addEventListener('visibilitychange', onVisible);
  bus.addEventListener('view-unmount', () => document.removeEventListener('visibilitychange', onVisible), { once: true });
}
