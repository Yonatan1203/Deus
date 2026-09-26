import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';
import { createInputQueue } from '../input-queue.js';
import { renderConversation } from '../conversation.js';
import { createComposer } from '../composer.js';

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

/** Claude's own "working" mark, turning; still under reduced motion. */
const spinner = () => h('span', { class: 'spin', 'aria-hidden': 'true' }, '✻');
function setStatus(el, label, kind) {
  const running = label === 'working';
  el.className = `status ${kind}${running ? ' running' : ''}`;
  el.replaceChildren(...(running ? [spinner(), 'Working'] : [label]));
}
const MODE_KEY = 'claude.mode';
const isShown = (el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.offsetParent !== null);
function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'terminal' ? 'terminal' : 'conversation'; } catch { return 'conversation'; }
}
function saveMode(m) {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* private window: not remembered */ }
}
const MODELS = [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const MODE_LABEL = { auto: 'Auto mode', plan: 'Plan mode', acceptEdits: 'Accept edits', default: 'Asks before edits', bypassPermissions: 'Bypass permissions', dontAsk: "Don't ask" };

/** "claude-opus-5-5" → "Opus 5.5"; a date suffix is dropped. */
function modelLabel(id) {
  if (!id) return 'Model';
  const [name = '', ...ver] = id.replace(/^claude-/, '').split('-').filter((p) => !/^\d{8}$/.test(p));
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${ver.join('.')}`.trim();
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

  // Keystroke sending (order, pacing, retries) lives in input-queue.js, where
  // it is tested without a browser.
  const queue = createInputQueue({
    post: (chunk) => api.post(`/api/v1/claude/live/${vid}/input`, { data: toB64(chunk) }),
    onEnded: () => ended('this view is no longer open'),
    onWarn: (msg) => toast(msg, 'error'),
  });
  const sendBytes = (u8) => queue.push(u8);
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
    queue.dispose();
    ro.disconnect();
    clearTimeout(resizeTimer);
    if (es) es.close();
    term.dispose();
  }
  if (isShown(host)) term.focus();
  return {
    vid,
    send: (s, { focus = true } = {}) => { sendBytes(enc.encode(s)); if (focus) term.focus(); },
    focus: () => term.focus(),
    /** Text in Claude Code's own input line (the bottom `❯` line), or '' when empty. */
    inputLine() {
      const b = term.buffer.active;
      for (let y = b.length - 1, n = 0; y >= 0 && n < 30; y--, n++) {
        const m = /^\s*\u276f\s?(.*)$/.exec(b.getLine(y)?.translateToString(true) ?? '');
        if (m) return m[1].trim();
      }
      return '';
    },
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
  const runningText = h('span', {});
  const summary = h('div', { class: 'running-summary', role: 'status', hidden: true }, spinner(), runningText);
  const side = h('div', { class: 'claude-side' }, summary, list);
  const wrap = h('div', { class: 'claude-layout' }, side, pane);
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
    const running = label === 'working';
    return h('div', { role: 'listitem', class: `session-item${current && current.id === s.id ? ' selected' : ''}${s.pinned ? ' pinned' : ''}${running ? ' running' : ''}`, 'data-id': s.id },
      h('button', { type: 'button', class: 'session-row', onclick: () => select(s) },
        h('span', { class: `dot ${kind}${running ? ' running' : ''}`, 'aria-hidden': 'true' }),
        h('span', { class: 'session-main' },
          h('span', { class: 'session-name' }, s.name),
          h('span', { class: 'session-sub' },
            running ? spinner() : null,
            [running ? 'Working' : label, ago(s.last_active || s.started_at)].filter(Boolean).join(' · ')))),
      readOnly ? null : pinButton(s, false));
  }
  function draw() {
    clear(list);
    if (sessions.length === 0) { list.append(h('div', { class: 'empty' }, 'No sessions yet. Start one with New session.')); return; }
    const order = { 'needs you': 0, working: 1, idle: 2, done: 3 };
    const sorted = [...sessions].sort((a, b) => (order[stateOf(a)[0]] - order[stateOf(b)[0]]) || ((b.last_active || 0) - (a.last_active || 0)));
    // One live region kept across redraws, so screen readers hear changes only.
    const busy = sessions.filter((s) => stateOf(s)[0] === 'working').length;
    const text = busy ? `${busy} ${busy === 1 ? 'session' : 'sessions'} running` : '';
    if (runningText.textContent !== text) runningText.textContent = text;
    summary.hidden = !busy;
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
      setStatus(current.statusEl, l, k);
      if (current.conv) current.conv.setSession(open);
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
    if (current && current.conv) current.conv.dispose();
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
    const statusEl = h('span', {});
    setStatus(statusEl, label, kind);
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
    const mine = current;
    const conv = conversationView(s, mine, () => setMode('terminal'));
    mine.conv = conv;
    const stage = h('div', { class: 'claude-stage' }, h('div', { class: 'term-pane' }, host, keybar), conv.el);
    // Both views stay laid out; the hidden one is only invisible, so the
    // terminal keeps its real size (and its session its width) either way.
    let mode = readMode();
    const segBtn = (m, label) => h('button', { type: 'button', 'data-mode': m, onclick: () => setMode(m) }, label);
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, segBtn('conversation', 'Conversation'), segBtn('terminal', 'Terminal'));
    function setMode(m) {
      mode = m;
      saveMode(m);
      stage.dataset.mode = m;
      for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
      if (m === 'terminal') { if (mine.view) mine.view.focus(); }
      else conv.shown();
    }
    bar.insertBefore(seg, bar.querySelector('.claude-actions'));
    pane.append(stage);
    setMode(mode);
    if (window.matchMedia('(max-width: 767px)').matches) document.body.classList.add('claude-full');
    try {
      const view = await openLive(api, host, s, (why) => {
        if (current !== mine) return;
        current.view = null;
        pane.append(h('div', { class: 'claude-ended' }, h('span', {}, `Live view ended: ${why}.`),
          h('button', { type: 'button', class: 'small', onclick: () => select(s) }, 'Reopen')));
      });
      if (current !== mine) { view.close(); return; }
      mine.view = view;
      if (mode === 'terminal') view.focus(); else conv.shown();
    } catch (err) {
      stage.replaceWith(h('div', { class: 'claude-empty' }, h('p', { class: 'error' }, err.status === 429 ? 'Too many live views open — close one first.' : `Could not open the live view: ${err.message}`), recentOutput(s)));
    }
  }

  // ---- conversation view ----
  // Draws the open session like the Claude app, from its own transcript, and
  // types into the same live view as the terminal: nothing here has a way in
  // to the session of its own.
  let commands = null;
  function loadCommands() {
    if (commands) return;
    commands = [];
    api.get('/api/v1/claude/commands').then((r) => { commands = r.commands || []; }).catch(() => { commands = null; });
  }
  function conversationView(s, mine, openTerminal) {
    loadCommands();
    const listEl = h('div', { class: 'conv-list', role: 'log', 'aria-label': 'Conversation' },
      h('div', { class: 'conv-note' }, 'Loading the conversation…'));
    const truncNote = h('div', { class: 'conv-note', hidden: true }, 'Earlier messages are in the Terminal view.');
    const scroller = h('div', { class: 'conv-scroll' }, h('div', { class: 'conv-col' }, truncNote, listEl));

    const banner = h('div', { class: 'conv-banner', hidden: true },
      h('span', {}, 'Claude is waiting for you in the terminal.'),
      h('button', { type: 'button', class: 'small', onclick: openTerminal }, 'Open terminal'));
    const modeEl = h('span', { class: 'conv-mode' });
    // Claude Code saves either choice as the default for new sessions, exactly
    // as /model and /effort do in the terminal; the menus say so.
    const DEFAULT_NOTE = 'Also becomes the default for new sessions.';
    const composer = createComposer({
      placeholder: 'Message Claude — type / for commands',
      label: 'Message Claude',
      commands: () => commands,
      // Before anything is typed, your own commands and the built-ins lead.
      rank: { personal: 0, 'built-in': 1, project: 2 },
      onSubmit: (text) => { if (!sendText(text)) return false; pollSoon(); return true; },
      onStop: () => stop(),
      stopLabel: 'Stop Claude',
      lead: modeEl,
      pickers: [
        { id: 'model', initial: 'Model', options: MODELS, onPick: (v) => sendLine(`/model ${v}`), note: DEFAULT_NOTE },
        { id: 'effort', initial: 'Effort', options: EFFORTS, onPick: (v) => sendLine(`/effort ${v}`), note: DEFAULT_NOTE },
      ],
    });
    const el = h('div', { class: 'conv' }, scroller, h('div', { class: 'conv-composer' }, banner, composer.el));

    const view = () => mine.view;
    function sendText(t) {
      if (!t) return false;
      if (!view()) { toast('The live view is not open', 'error'); return false; }
      // Text goes in as a paste, so a fast burst is never read as keystrokes
      // that submit early; Enter follows on its own.
      view().send(`\x1b[200~${t}\x1b[201~`, { focus: false });
      setTimeout(() => { if (view()) view().send('\r', { focus: false }); }, 80);
      return true;
    }
    function sendLine(text) { if (sendText(text)) pollSoon(); }
    // Esc interrupts, as in the terminal. Claude then puts an unanswered
    // message back in its own input, where the next message would be appended
    // to it; like the Claude app, it comes back to this box instead. Clearing
    // takes Esc twice, which on an empty input would open Claude's rewind
    // menu, so it is sent only when the input line shows text.
    let lastItems = [];
    const later = (ms) => new Promise((r) => setTimeout(r, ms));
    async function stop() {
      if (!view()) return;
      const last = lastItems[lastItems.length - 1];
      const unanswered = last && last.k === 'user' ? last.text : '';
      view().send('\x1b', { focus: false });
      await later(800);
      const v = view();
      const restored = v ? v.inputLine() : '';
      if (v && restored) {
        v.send('\x1b', { focus: false });
        await later(200);
        v.send('\x1b', { focus: false });
        composer.restore(unanswered && unanswered.startsWith(restored.slice(0, 40)) ? unanswered : restored);
      }
      pollSoon();
    }
    // Polling, only while this view shows and the page is visible.
    let version = '';
    let first = true;
    let disposed = false;
    const expanded = new Set();
    const visible = () => !document.hidden && isShown(el);
    async function poll() {
      if (disposed || !view() || !visible()) return;
      try {
        const r = await api.get(`/api/v1/claude/live/${view().vid}/conversation?v=${encodeURIComponent(version)}`);
        if (disposed || r.unchanged) return;
        version = r.version;
        lastItems = r.items;
        const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
        if (r.items.length) renderConversation(listEl, r.items, h, { openTerminal, expanded });
        else listEl.replaceChildren(h('div', { class: 'conv-note' }, 'No messages yet. Write the first one below.'));
        truncNote.hidden = !r.truncated;
        composer.picker('model').set(modelLabel(r.model));
        const eff = EFFORTS.find(([v]) => v === r.effort);
        composer.picker('effort').set(eff ? eff[1] : 'Effort');
        modeEl.textContent = MODE_LABEL[r.mode] || '';
        if (first || near) scroller.scrollTop = scroller.scrollHeight;
        first = false;
        listEl.dataset.loaded = 'true';
      } catch (err) {
        if (err.status === 404) {
          listEl.replaceChildren(h('div', { class: 'conv-note' }, 'No conversation found for this session yet.'));
          listEl.dataset.loaded = 'true';
        }
      }
    }
    let soon = null;
    const pollSoon = () => { clearTimeout(soon); soon = setTimeout(poll, 400); };
    const timer = setInterval(poll, 1500);
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVisible);

    function setSession(row) {
      const [label] = stateOf(row);
      const busy = label === 'working';
      banner.hidden = label !== 'needs you';
      composer.setBusy(busy);
      const why = busy ? 'Wait until Claude finishes' : '';
      composer.picker('model').disable(busy, why);
      composer.picker('effort').disable(busy, why);
    }
    setSession(s);
    return {
      el,
      setSession,
      shown() { poll(); if (!window.matchMedia('(hover: none)').matches) composer.focus(); },
      dispose() {
        disposed = true;
        clearInterval(timer);
        clearTimeout(soon);
        document.removeEventListener('visibilitychange', onVisible);
        composer.dispose();
      },
    };
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
  // A draft handed over by another tab (Agents → Add agent): used once.
  let draft = null;
  try {
    draft = JSON.parse(sessionStorage.getItem('claude.draft') || 'null');
    sessionStorage.removeItem('claude.draft');
  } catch { draft = null; }
  if (!readOnly && draft && typeof draft.name === 'string' && typeof draft.prompt === 'string'
    && draft.name.length <= 60 && draft.prompt.length <= 8192) {
    nameInput.value = draft.name;
    promptInput.value = draft.prompt;
    form.hidden = false;
    promptInput.focus();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
    promptInput.scrollTop = promptInput.scrollHeight;
  }
  await load();
  bus.addEventListener('csession', (e) => {
    if (e.detail && e.detail.sessions) { sessions = e.detail.sessions.map((s) => { const o = sessions.find((x) => x.id === s.id) || {}; return { ...s, last_active: o.last_active, pinned: Boolean(o.pinned) }; }); draw(); }
    else load();
  });
  bus.addEventListener('refresh', () => load());
  refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 45_000);
  bus.addEventListener('view-unmount', () => { clearInterval(refreshTimer); closeCurrent(); }, { once: true });
}
