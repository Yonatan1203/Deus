import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';

// The Claude tab: your sessions, and each one live — the same `claude attach`
// your terminal uses, so typing here is typing there, and Claude Code's own
// input shows slash commands and shortcuts exactly as it does in the terminal.
// Every string from the session list is rendered as text, never markup; the
// terminal itself renders on a canvas.

const ago = (ms) => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} d ago`;
};
function stateOf(s) {
  if (s.state === 'blocked') return ['needs you', 'warn'];
  if (s.status === 'busy') return ['working', 'ok'];
  if (s.state === 'done') return ['done', ''];
  return ['idle', 'idle'];
}

// ---- xterm, loaded on first use from same-origin vendor files -------------
let xtermReady = null;
function loadXterm() {
  if (xtermReady) return xtermReady;
  const script = (src) => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(el);
  });
  const css = document.createElement('link');
  css.rel = 'stylesheet'; css.href = '/vendor/xterm/xterm.css';
  document.head.append(css);
  xtermReady = script('/vendor/xterm/xterm.js')
    .then(() => Promise.all([script('/vendor/xterm/addon-fit.js'), script('/vendor/xterm/addon-webgl.js')]))
    .catch((err) => { xtermReady = null; throw err; });
  return xtermReady;
}

const enc = new TextEncoder();
const toB64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (b64) => { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Keys a phone keyboard cannot send. Bytes are exactly what a terminal sends.
const KEYBAR = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['⇧Tab', '\x1b[Z'], ['↑', '\x1b[A'], ['↓', '\x1b[B'],
  ['←', '\x1b[D'], ['→', '\x1b[C'], ['Ctrl+C', '\x03'], ['/', '/'],
];

/**
 * One live view: opens it on the server, streams its screen into xterm and
 * sends keystrokes back. Returns `close()`.
 */
async function openLive(api, host, session, onEnd) {
  await loadXterm();
  // Size the view from the host box before anything is created, so a refused
  // open (too many views, session gone) leaves no terminal behind to dispose.
  const probe = { cols: Math.max(20, Math.floor((host.clientWidth - 20) / 8)), rows: Math.max(5, Math.floor((host.clientHeight - 20) / 16)) };
  const opened = await api.post('/api/v1/claude/live', { id: session.id, cols: Math.min(400, probe.cols), rows: Math.min(200, probe.rows) });
  const term = new window.Terminal({
    // Claude Code draws symbols (⏵, ✻, ●) the dashboard's font lacks; the
    // fallbacks cover them on Windows, macOS and Linux.
    fontFamily: '"Geist Mono", ui-monospace, "Cascadia Mono", Consolas, SFMono-Regular, Menlo, "DejaVu Sans Mono", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", monospace',
    fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
    allowProposedApi: false,
    theme: { background: cssVar('--surface') || '#131316', foreground: cssVar('--text') || '#ededef', cursor: cssVar('--text') || '#ededef', selectionBackground: '#3a3a44' },
    // Only real web links, opened without handing this page to the target.
    linkHandler: { activate: (_e, text) => {
      try { const u = new URL(text); if (u.protocol === 'https:' || u.protocol === 'http:') window.open(u.href, '_blank', 'noopener,noreferrer'); } catch { /* not a link */ }
    } },
  });
  // tmux already answers the program's terminal queries. If xterm answered
  // too, output the model controls could make this page type into Claude.
  const swallow = () => true;
  term.parser.registerCsiHandler({ final: 'n' }, swallow);
  term.parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow);
  term.parser.registerCsiHandler({ final: 'c' }, swallow);
  term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow);
  term.parser.registerCsiHandler({ prefix: '=', final: 'c' }, swallow);
  term.parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow);
  term.parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow);
  term.parser.registerCsiHandler({ final: 't' }, swallow);
  term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow);
  for (const n of [4, 10, 11, 12]) term.parser.registerOscHandler(n, (d) => d.includes('?'));

  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  try { term.loadAddon(new window.WebglAddon.WebglAddon()); } catch { /* DOM renderer fallback */ }
  fit.fit();

  let closed = false;
  let vid = null;
  let es = null;
  let outBuf = [];
  let outTimer = null;

  const ended = (why) => { if (!closed) { closed = true; cleanup(); onEnd(why); } };
  vid = opened.vid;
  // The real fitted size, now that the terminal exists.
  api.post(`/api/v1/claude/live/${vid}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {});

  const connect = async () => {
    if (closed) return;
    let ticket;
    try { ({ ticket } = await api.post('/api/v1/events/ticket')); } catch { ended('signed out'); return; }
    es = new EventSource(`/api/v1/claude/live/${vid}/stream?ticket=${encodeURIComponent(ticket)}`);
    es.addEventListener('o', (e) => term.write(fromB64(e.data)));
    es.addEventListener('x', (e) => { es.close(); ended(e.data === 'exited' ? 'the session view ended' : `closed (${e.data})`); });
    // Tickets are single-use, so a dropped stream reconnects with a new one.
    es.onerror = () => { if (closed) return; es.close(); setTimeout(connect, 1000); };
  };
  await connect();

  const flush = async () => {
    outTimer = null;
    if (!outBuf.length || closed) return;
    const total = outBuf.reduce((n, a) => n + a.length, 0);
    const all = new Uint8Array(total);
    let off = 0; for (const a of outBuf) { all.set(a, off); off += a.length; }
    outBuf = [];
    for (let i = 0; i < all.length; i += 12 * 1024) {
      try { await api.post(`/api/v1/claude/live/${vid}/input`, { data: toB64(all.subarray(i, i + 12 * 1024)) }); }
      catch (err) { if (err.status === 404 || err.status === 403) { ended('this view is no longer open'); return; } toast(err.message, 'error'); return; }
    }
  };
  const sendBytes = (u8) => { outBuf.push(u8); if (!outTimer) outTimer = setTimeout(flush, 12); };
  term.onData((d) => sendBytes(enc.encode(d)));
  term.onBinary((d) => { const u8 = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) u8[i] = d.charCodeAt(i) & 0xff; sendBytes(u8); });

  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    if (closed) return;
    fit.fit();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!closed) api.post(`/api/v1/claude/live/${vid}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {}); }, 150);
  });
  ro.observe(host);

  function cleanup() {
    ro.disconnect();
    clearTimeout(resizeTimer);
    if (es) es.close();
    term.dispose();
  }
  term.focus();
  return {
    send: (s) => { sendBytes(enc.encode(s)); term.focus(); },
    close() {
      if (closed) return;
      closed = true;
      cleanup();
      api.del(`/api/v1/claude/live/${vid}`).catch(() => {});
    },
  };
}

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const list = h('div', { class: 'claude-sessions', role: 'list' });
  const pane = h('section', { class: 'claude-pane' });
  const wrap = h('div', { class: 'claude-layout' }, list, pane);
  let sessions = [];
  let liveAvailable = false;
  let current = null; // { id, view }
  let refreshTimer = null;

  // ---- new session ----
  const form = h('form', { class: 'card new-session', hidden: true });
  const nameInput = h('input', { type: 'text', placeholder: 'e.g. Posts Automation', 'aria-label': 'Session name', maxlength: '60', required: true });
  const promptInput = h('textarea', { rows: '3', placeholder: 'What should it do first?', 'aria-label': 'First message', required: true });
  const startBtn = h('button', { type: 'submit', class: 'primary' }, 'Start');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name || !prompt) return;
    startBtn.disabled = true;
    try {
      // The form itself is the explicit action; runs in auto mode, like the terminal.
      const r = await api.post('/api/v1/claude/sessions', { name, prompt }, { 'X-Confirm': 'start' });
      nameInput.value = ''; promptInput.value = ''; form.hidden = true;
      toast(`Started "${name}"`, 'ok');
      await load();
      const s = sessions.find((x) => x.id === r.id);
      if (s) select(s);
    } catch (err) { toast(err.status === 429 ? 'Too many starts — wait a few minutes' : err.message, 'error'); }
    finally { startBtn.disabled = false; }
  });
  form.append(
    h('div', { class: 'form-grid' },
      h('label', {}, 'Name', nameInput),
      h('label', { class: 'wide' }, 'First message', promptInput)),
    h('p', { class: 'hint' }, 'Starts in auto mode in the Deus repo, the same as a terminal session.'),
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', onclick: () => { form.hidden = true; } }, 'Cancel'), startBtn));
  const newBtn = readOnly ? null : h('button', { type: 'button', class: 'small primary', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) nameInput.focus(); } }, icon('plus', { size: 14 }), 'New session');

  // ---- list ----
  async function setPinned(s, pinned) {
    try {
      await api.put(`/api/v1/claude/sessions/${s.id}/pin`, { pinned });
      s.pinned = pinned;
      draw();
    } catch (err) { toast(err.status === 429 ? 'Too many changes — wait a minute' : err.message, 'error'); }
  }
  function pinButton(s, withLabel) {
    return h('button', {
      type: 'button', class: `small pin-btn${s.pinned ? ' on' : ''}`,
      'aria-pressed': s.pinned ? 'true' : 'false',
      'aria-label': `${s.pinned ? 'Unpin' : 'Pin'} ${s.name}`, title: s.pinned ? 'Unpin' : 'Pin to the top',
      onclick: (e) => { e.stopPropagation(); setPinned(s, !s.pinned); },
    }, icon('pin', { size: 14 }), withLabel ? (s.pinned ? 'Unpin' : 'Pin') : null);
  }
  function row(s) {
    const [label, kind] = stateOf(s);
    // Two sibling buttons, never one inside the other.
    return h('div', { role: 'listitem', class: `session-item${current && current.id === s.id ? ' selected' : ''}${s.pinned ? ' pinned' : ''}`, 'data-id': s.id },
      h('button', { type: 'button', class: 'session-row', onclick: () => select(s) },
        h('span', { class: `dot ${kind}`, 'aria-hidden': 'true' }),
        h('span', { class: 'session-main' },
          h('span', { class: 'session-name' }, s.name),
          h('span', { class: 'session-sub' }, [label, ago(s.last_active || s.started_at)].filter(Boolean).join(' · ')))),
      readOnly ? null : pinButton(s, false));
  }
  function draw() {
    clear(list);
    if (sessions.length === 0) { list.append(h('div', { class: 'empty' }, 'No sessions yet. Start one with New session.')); return; }
    const order = { 'needs you': 0, working: 1, idle: 2, done: 3 };
    const sorted = [...sessions].sort((a, b) => (order[stateOf(a)[0]] - order[stateOf(b)[0]]) || ((b.last_active || 0) - (a.last_active || 0)));
    const pinned = sorted.filter((s) => s.pinned);
    const rest = sorted.filter((s) => !s.pinned);
    if (pinned.length) list.append(h('div', { class: 'session-group', role: 'presentation' }, 'Pinned'), ...pinned.map(row));
    if (pinned.length && rest.length) list.append(h('div', { class: 'session-group', role: 'presentation' }, 'All sessions'));
    list.append(...rest.map(row));
    if (current && current.pinSlot) {
      const open = sessions.find((x) => x.id === current.id);
      if (open && !readOnly) { clear(current.pinSlot); current.pinSlot.append(pinButton(open, true)); }
    }
    // Keep the open session's header in step with the list.
    const open = current && sessions.find((x) => x.id === current.id);
    if (open && current.statusEl) {
      const [l, k] = stateOf(open);
      current.statusEl.textContent = l;
      current.statusEl.className = `status ${k}`;
    }
  }

  // ---- pane ----
  function placeholder() {
    clear(pane);
    pane.append(h('div', { class: 'claude-empty' },
      h('p', { class: 'lead' }, 'Pick a session to open it here, live.'),
      h('p', { class: 'muted' }, readOnly
        ? 'Live view is off in read-only mode.'
        : liveAvailable
          ? 'It is the same session as your terminal: what you type here appears there, and slash commands work as usual.'
          : 'Live view needs tmux on the server; only recent output is available.')));
  }
  function closeCurrent() {
    if (current && current.view) current.view.close();
    current = null;
    document.body.classList.remove('claude-full');
  }
  async function select(s) {
    closeCurrent();
    current = { id: s.id, view: null };
    draw();
    clear(pane);
    const [label, kind] = stateOf(s);
    const statusEl = h('span', { class: `status ${kind}` }, label);
    current.statusEl = statusEl;
    const pinSlot = h('span', { class: 'pin-slot' }, readOnly ? null : pinButton(s, true));
    current.pinSlot = pinSlot;
    const details = h('dl', { class: 'claude-details', hidden: true },
      h('dt', {}, 'Id'), h('dd', { class: 'mono' }, s.id),
      h('dt', {}, 'Started'), h('dd', {}, s.started_at ? fmtTime(s.started_at) : '—'),
      h('dt', {}, 'Folder'), h('dd', { class: 'mono' }, s.cwd_rel || '.'),
      h('dt', {}, 'Kind'), h('dd', {}, s.kind));
    const bar = h('div', { class: 'claude-bar' },
      h('button', { type: 'button', class: 'small back', 'aria-label': 'Back to sessions', onclick: () => { closeCurrent(); draw(); placeholder(); } }, '←'),
      h('div', { class: 'claude-title' }, h('span', { class: 'session-name' }, s.name), statusEl),
      h('div', { class: 'claude-actions' },
        pinSlot,
        h('button', { type: 'button', class: 'small', onclick: () => { details.hidden = !details.hidden; } }, 'Details'),
        readOnly || s.kind !== 'background' ? null : h('button', { type: 'button', class: 'small danger', onclick: async () => {
          const ok = await confirmTyped(s.id, `Stop "${s.name}"? Its conversation is kept; you can resume it later.`);
          if (!ok) return;
          try { await api.post(`/api/v1/claude/sessions/${s.id}/stop`, undefined, { 'X-Confirm': s.id }); toast('Stopped', 'ok'); closeCurrent(); await load(); placeholder(); }
          catch (err) { toast(err.message, 'error'); }
        } }, 'Stop')));
    pane.append(bar, details);

    if (s.kind !== 'background') {
      pane.append(h('div', { class: 'claude-empty' }, h('p', {}, 'This session runs in a terminal window, so it can only be used there.')));
      return;
    }
    if (readOnly || !liveAvailable) {
      pane.append(recentOutput(s));
      return;
    }
    const host = h('div', { class: 'term-host' });
    const keybar = h('div', { class: 'keybar', role: 'toolbar', 'aria-label': 'Terminal keys' },
      ...KEYBAR.map(([label, bytes]) => h('button', { type: 'button', class: 'small', onclick: () => current && current.view && current.view.send(bytes) }, label)));
    pane.append(host, keybar);
    if (window.matchMedia('(max-width: 767px)').matches) document.body.classList.add('claude-full');
    const mine = current;
    try {
      const view = await openLive(api, host, s, (why) => {
        if (current !== mine) return;
        current.view = null;
        pane.append(h('div', { class: 'claude-ended' }, h('span', {}, `Live view ended: ${why}.`),
          h('button', { type: 'button', class: 'small', onclick: () => select(s) }, 'Reopen')));
      });
      if (current !== mine) { view.close(); return; }
      mine.view = view;
    } catch (err) {
      host.replaceWith(h('div', { class: 'claude-empty' }, h('p', { class: 'error' }, err.status === 429 ? 'Too many live views open — close one first.' : `Could not open the live view: ${err.message}`), recentOutput(s)));
    }
  }
  function recentOutput(s) {
    const out = h('pre', { class: 'console', hidden: true });
    return h('div', { class: 'claude-recent' },
      h('button', { type: 'button', class: 'small', onclick: async () => {
        try { const r = await api.get(`/api/v1/claude/sessions/${s.id}/logs`); clear(out); out.append(r.lines.join('\n')); out.hidden = false; }
        catch (err) { toast(err.message, 'error'); }
      } }, 'Show recent output'), out);
  }

  async function load() {
    try {
      const r = await api.get('/api/v1/claude/sessions');
      if (r.unavailable) { clear(list); list.append(h('div', { class: 'empty' }, `Session list unavailable: ${r.error || 'claude CLI not found'}`)); return; }
      sessions = r.sessions;
      liveAvailable = Boolean(r.live);
      draw();
      if (!current) placeholder();
    } catch (err) { clear(list); list.append(h('div', { class: 'empty' }, err.status === 429 ? 'Too many refreshes — wait a minute.' : err.message)); }
  }

  clear(root);
  root.append(header('Claude', { eyebrow: 'Operate', actions: newBtn ? [newBtn] : [] }), form, wrap);
  await load();
  bus.addEventListener('csession', (e) => {
    if (e.detail && e.detail.sessions) { sessions = e.detail.sessions.map((s) => { const o = sessions.find((x) => x.id === s.id) || {}; return { ...s, last_active: o.last_active, pinned: Boolean(o.pinned) }; }); draw(); }
    else load();
  });
  bus.addEventListener('refresh', () => load());
  refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 45_000);
  bus.addEventListener('view-unmount', () => { clearInterval(refreshTimer); closeCurrent(); }, { once: true });
}
