import { h, clear } from '../dom.js';
import { confirmTyped, serverError, toast } from '../ui.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { parseMarkdown, renderBlocks } from '../markdown.js';
import { createComposer } from '../composer.js';

// Chat with Amos, WhatsApp-style: a list of saved chats and the open one.
// Chats live on the server, so every device sees the same ones, and a reply
// that finishes while this page is closed is there when it opens again.
// Every string is drawn as text or through the markdown renderer — never HTML.

const LEGACY_KEY = 'deus_ctl_chat';
const LEGACY_DONE = 'deus_ctl_chat_imported';
const IMPORT_MAX_BYTES = 1000 * 1024; // under the server's 1 MiB body limit
// Values mirror AGENT_MODELS in src/types.ts; the server refuses anything else.
const MODELS = [['', 'Default'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5', 'Sonnet 5'], ['claude-haiku-4-5-20251001', 'Haiku 4.5']];
const EFFORTS = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['max', 'Max']];
const labelOf = (list, v, fallback) => (list.find(([k]) => k === (v || '')) || [null, fallback])[1];

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayKey = (ms) => new Date(ms).toDateString();
function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function shortWhen(ms) {
  return dayKey(ms) === dayKey(Date.now()) ? time(ms) : new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Local history kept by the old Chat page, if any and not imported yet. */
function readLegacy() {
  try {
    if (localStorage.getItem(LEGACY_DONE)) return null;
    const v = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
    const msgs = Array.isArray(v) ? v.filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')) : [];
    return msgs.length ? msgs : null;
  } catch { return null; }
}

/** A list preview without markdown marks. */
const plain = (t) => (t || '').replace(/[*_`#>]+/g, '').replace(/(^|\s)[-+] /g, '$1').replace(/\s+/g, ' ').trim();

const avatar = () => h('span', { class: 'amos-av', 'aria-hidden': 'true' }, 'A');
const typing = (text) => h('div', { class: 'chat-typing' },
  h('span', { class: 'dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
  h('span', {}, text));

function messageNode(m) {
  if (m.role === 'user')
    return h('div', { class: 'chat-user' }, h('div', { class: 'chat-text', dir: 'auto' }, m.text), h('span', { class: 'chat-time' }, time(m.at)));
  const body = h('div', { class: 'chat-body' });
  if (m.activity && m.activity.length) {
    const list = h('ul', { class: 'conv-calls', hidden: true }, ...m.activity.map((a) => h('li', {}, a)));
    const fold = h('button', { type: 'button', class: 'conv-fold', 'aria-expanded': 'false' },
      `Worked through ${m.activity.length} ${m.activity.length === 1 ? 'step' : 'steps'}`, h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
    fold.addEventListener('click', () => { list.hidden = !list.hidden; fold.setAttribute('aria-expanded', String(!list.hidden)); });
    body.append(fold, list);
  }
  if (m.text) body.append(h('div', { class: 'conv-assistant', dir: 'auto' }, ...renderBlocks(parseMarkdown(m.text), h)));
  if (m.error) body.append(h('div', { class: 'chat-error' }, m.error));
  body.append(h('span', { class: 'chat-time' }, time(m.at)));
  return h('div', { class: 'chat-amos' }, avatar(), body);
}

export async function render(root, api, bus, me) {
  clear(root);
  const readOnly = Boolean(me && me.read_only);
  const who = (me && me.assistant) || 'Amos';
  let chats = [];
  let current = null; // the open chat, as the server last sent it
  let commands = [];
  let modelsOk = false;
  let ownTurn = null; // { id, controller } while this page streams a reply

  const side = h('div', { class: 'chat-side' });
  const pane = h('section', { class: 'chat-pane' });
  const layout = h('div', { class: 'chat-layout' }, side, pane);

  api.get('/api/v1/chat/commands').then((r) => { commands = r.commands || []; modelsOk = Boolean(r.models); syncState(); }).catch(() => {});

  // ---- list ----
  async function newChat() {
    try {
      const c = await api.post('/api/v1/chats', {});
      await loadList();
      openChat(c.id);
    } catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
  }
  function drawList() {
    clear(side);
    if (!readOnly) side.append(h('button', { type: 'button', class: 'primary new-chat', onclick: newChat }, icon('plus', { size: 16 }), 'New chat'));
    if (!chats.length) { side.append(h('div', { class: 'empty' }, readOnly ? 'No chats yet.' : 'No chats yet — start one.')); return; }
    let group = '';
    for (const c of chats) {
      const g = dayKey(c.updated) === dayKey(Date.now()) ? 'Today' : 'Earlier';
      if (g !== group) { side.append(h('div', { class: 'session-group', role: 'presentation' }, g)); group = g; }
      side.append(h('button', {
        type: 'button', class: `chat-row${current && current.id === c.id ? ' selected' : ''}${c.running ? ' running' : ''}`,
        onclick: () => openChat(c.id),
      },
      h('span', { class: 'chat-row-top' }, h('span', { class: 'chat-row-title' }, c.title), h('span', { class: 'chat-row-when' }, shortWhen(c.updated))),
      h('span', { class: 'chat-row-sub', dir: 'auto' }, c.running ? h('span', { class: 'spin', 'aria-hidden': 'true' }, '✻') : null, c.running ? `${who} is replying…` : plain(c.preview))));
    }
  }
  async function loadList() {
    try { chats = (await api.get('/api/v1/chats')).chats; drawList(); }
    catch (err) { clear(side); side.append(h('div', { class: 'empty' }, serverError(err, 'Something went wrong — try again.'))); }
  }

  // ---- open chat ----
  let view = null; // { listEl, scroller, composer, statusEl, titleEl, live }
  function closeView() {
    if (view) view.composer.dispose();
    view = null;
  }
  function placeholder() {
    closeView();
    clear(pane);
    pane.append(h('div', { class: 'claude-empty' },
      h('p', { class: 'lead' }, `Chat with ${who}`),
      h('p', { class: 'muted' }, 'Your chats are saved, so they are the same on your phone and computer. Pick one, or start a new chat.')));
  }

  async function openChat(id, opts = {}) {
    let chat;
    try { chat = await api.get(`/api/v1/chats/${id}`); }
    catch (err) { toast(err.status === 404 ? 'That chat is gone' : serverError(err, 'Something went wrong — try again.'), 'error'); current = null; drawList(); placeholder(); return; }
    const sameChat = current && current.id === chat.id && view;
    current = chat;
    drawList();
    if (!sameChat) {
      buildView();
      if (window.matchMedia('(max-width: 899px)').matches) document.body.classList.add('chat-open');
    }
    drawMessages(sameChat && opts.keepScroll);
    syncState();
  }

  function buildView() {
    closeView();
    clear(pane);
    const statusEl = h('small', { class: 'chat-status' });
    const titleEl = h('span', { class: 'session-name' }, current.title);
    const actions = readOnly ? null : h('div', { class: 'claude-actions' },
      h('button', { type: 'button', class: 'small', onclick: rename }, 'Rename'),
      h('button', { type: 'button', class: 'small danger', onclick: remove }, 'Delete'));
    const bar = h('div', { class: 'claude-bar chat-bar' },
      h('button', { type: 'button', class: 'small back', 'aria-label': 'Back to chats', onclick: () => { document.body.classList.remove('chat-open'); current = null; drawList(); placeholder(); } }, '←'),
      avatar(),
      h('div', { class: 'claude-title' }, titleEl, statusEl),
      actions);
    const listEl = h('div', { class: 'conv-list chat-list', role: 'log', 'aria-label': `Chat with ${who}` });
    const scroller = h('div', { class: 'conv-scroll' }, h('div', { class: 'conv-col' }, listEl));
    const composer = createComposer({
      placeholder: readOnly ? 'Read-only mode — chat is off' : `Message ${who} — type / for commands`,
      label: `Message ${who}`,
      commands: () => commands,
      onSubmit: (text) => { send(text); return true; },
      onStop: stopTurn,
      stopLabel: `Stop ${who}`,
      lead: h('span', { class: 'conv-mode chat-settings' }),
      pickers: [
        { id: 'model', initial: 'Model', options: MODELS, onPick: (v) => setting({ model: v || null }), note: `Only for this chat. Leave it on Default to use ${who}'s usual model.` },
        { id: 'effort', initial: 'Effort', options: EFFORTS, onPick: (v) => setting({ effort: v || null }), note: `Only for this chat. Leave it on Default to use ${who}'s usual effort.` },
      ],
    });
    composer.input.setAttribute('dir', 'auto');
    if (readOnly) composer.input.disabled = true;
    pane.append(bar, h('div', { class: 'chat-stage' }, scroller, h('div', { class: 'conv-composer' }, composer.el)));
    view = { listEl, scroller, composer, statusEl, titleEl, live: null };
  }

  function drawMessages(keepScroll) {
    if (!view) return;
    const { listEl, scroller } = view;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    const nodes = [];
    let day = '';
    for (const m of current.messages) {
      if (dayKey(m.at) !== day) { day = dayKey(m.at); nodes.push(h('div', { class: 'chat-day' }, dayLabel(m.at))); }
      nodes.push(messageNode(m));
    }
    if (!current.messages.length) nodes.push(h('div', { class: 'conv-note' }, `Say hello to ${who}. Type / to see what ${who} can do.`));
    if (current.running_turn_id && !ownTurn) nodes.push(h('div', { class: 'chat-amos' }, avatar(), typing(`${who} is replying…`)));
    listEl.replaceChildren(...nodes);
    if (view.live) listEl.append(view.live.el);
    if (!keepScroll || near) scroller.scrollTop = scroller.scrollHeight;
    listEl.dataset.loaded = 'true';
  }

  function syncState() {
    if (!view || !current) return;
    const running = Boolean(current.running_turn_id || ownTurn);
    view.statusEl.textContent = running ? 'replying…' : 'online';
    view.statusEl.className = `chat-status${running ? ' running' : ''}`;
    view.titleEl.textContent = current.title;
    view.composer.setBusy(running);
    const why = running ? `Wait until ${who} finishes` : '';
    const mp = view.composer.picker('model');
    const ep = view.composer.picker('effort');
    mp.hide(!modelsOk);
    mp.set(labelOf(MODELS, current.model, 'Default'));
    ep.set(labelOf(EFFORTS, current.effort, 'Default'));
    mp.disable(running || readOnly, why);
    ep.disable(running || readOnly, why);
    // What this chat runs with, as text — the pickers hold the controls.
    const lead = view.composer.el.querySelector('.chat-settings');
    if (lead) lead.textContent = current.model || current.effort
      ? [current.model ? labelOf(MODELS, current.model, '') : `${who}'s model`, current.effort ? labelOf(EFFORTS, current.effort, '') : `${who}'s effort`].join(' · ')
      : `${who}'s defaults`;
  }

  async function setting(patch) {
    try { current = await api.patch(`/api/v1/chats/${current.id}`, patch); syncState(); }
    catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
  }
  async function rename() {
    const title = window.prompt('Name this chat', current.title);
    if (!title || !title.trim()) return;
    try { current = await api.patch(`/api/v1/chats/${current.id}`, { title }); syncState(); loadList(); }
    catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
  }
  async function remove() {
    const ok = await confirmTyped('delete', `Delete "${current.title}"? Its messages are removed from every device. Type delete to confirm.`);
    if (!ok) return;
    try {
      await api.del(`/api/v1/chats/${current.id}`, { 'X-Confirm': current.id });
      toast('Chat deleted', 'ok');
      current = null;
      document.body.classList.remove('chat-open');
      placeholder();
      loadList();
    } catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
  }

  // ---- a turn ----
  async function send(text) {
    if (ownTurn || !current) return;
    const chatId = current.id;
    current.messages.push({ role: 'user', text, at: Date.now() });
    const body = h('div', {});
    const status = typing(`${who} is replying…`);
    const live = { el: h('div', { class: 'chat-amos live' }, avatar(), h('div', { class: 'chat-body' }, status, body)), text: '' };
    view.live = live;
    ownTurn = { id: null, controller: new AbortController() };
    drawMessages(false);
    syncState();
    let frame = null;
    const paint = () => {
      frame = null;
      body.replaceChildren(h('div', { class: 'conv-assistant' }, ...renderBlocks(parseMarkdown(live.text), h)));
      const s = view && view.scroller;
      if (s && s.scrollHeight - s.scrollTop - s.clientHeight < 160) s.scrollTop = s.scrollHeight;
    };
    try {
      await api.stream('/api/v1/chat/turns', { chat_id: chatId, message: text }, (type, data) => {
        if (type === 'turn_started') ownTurn.id = data.id;
        else if (type === 'output_text') { live.text += data.text; if (!frame) frame = requestAnimationFrame(paint); }
        else if (type === 'activity') status.lastChild.textContent = data.text;
        else if (type === 'tool_call') status.lastChild.textContent = `Using ${data.name}…`;
      }, ownTurn.controller.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast(err.status === 429 ? `${who} is busy — try again in a minute.` : serverError(err, 'Something went wrong — try again.'), 'error');
        if (view) view.composer.restore(text);
      }
    } finally {
      ownTurn = null;
      if (view) view.live = null;
      // The server saved both sides; show exactly what it kept.
      if (current && current.id === chatId) await openChat(chatId, { keepScroll: true });
      loadList();
    }
  }
  async function stopTurn() {
    const id = (ownTurn && ownTurn.id) || (current && current.running_turn_id);
    if (!id) return;
    try { await api.del(`/api/v1/chat/turns/${encodeURIComponent(id)}`); }
    catch (err) { if (err.status !== 404) toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
  }

  // ---- the old browser-only chat, moved over once ----
  async function importLegacy() {
    const local = readLegacy();
    if (!local || readOnly) return;
    const localTotal = local.length;
    const msgs = [];
    let bytes = 0;
    for (let i = local.length - 1; i >= 0; i--) {
      const m = { role: local[i].role, text: local[i].content, at: Date.now() - (local.length - i) * 1000 };
      bytes += new Blob([m.text]).size + 64;
      if (bytes > IMPORT_MAX_BYTES) break;
      msgs.unshift(m);
    }
    let r = null;
    try { r = await api.post('/api/v1/chats', { title: 'Earlier chat', messages: msgs }); } catch { r = null; }
    if (!r || !r.id) return; // nothing saved: kept in this browser, tried again next time
    const imported = r.imported || 0;
    try {
      localStorage.setItem(LEGACY_DONE, r.id);
      if (imported === localTotal) localStorage.removeItem(LEGACY_KEY);
    } catch { /* storage unavailable: nothing to clear */ }
    toast(imported < localTotal
      ? `Moved the newest ${imported} of ${localTotal} messages here — the older ones are still kept in this browser.`
      : 'Moved your earlier chat here.');
  }

  root.append(h('div', { class: 'chat-page' }, header('Chat', { eyebrow: 'Operate' }), layout));
  await importLegacy();
  await loadList();
  placeholder();

  const onChat = (e) => {
    loadList();
    if (current && e.detail && e.detail.id === current.id) {
      if (e.detail.action === 'deleted') { toast('This chat was deleted on another device'); current = null; document.body.classList.remove('chat-open'); placeholder(); return; }
      if (!ownTurn) openChat(current.id, { keepScroll: true });
    }
  };
  const onRefresh = () => { loadList(); if (current && !ownTurn) openChat(current.id, { keepScroll: true }); };
  bus.addEventListener('chat', onChat);
  bus.addEventListener('refresh', onRefresh);
  bus.addEventListener('view-unmount', () => {
    bus.removeEventListener('chat', onChat);
    bus.removeEventListener('refresh', onRefresh);
    document.body.classList.remove('chat-open');
    closeView();
  }, { once: true });
}
