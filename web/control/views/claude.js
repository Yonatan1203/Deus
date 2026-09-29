import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { header, hashQuery } from '../app.js';
import { createArtifactPane } from '../artifact-pane.js';
import { confirmTyped, fmtTime, limitToast, serverError, toast } from '../ui.js';
import { createInputQueue } from '../input-queue.js';
import { parseAskScreen, parseIdlePrompt, parseLiveReply, parseMenuScreen, parseRunningTool, parseWorking } from '../ask-screen.js';
import { createMissCounter } from '../ask-fallback.js';
import { BACK_MAX, arrowKeys, backKeys, nextKeys, pickKeys, submitKeys, textKeys } from '../ask-keys.js';
import { fallbackNotice, menuCard, renderConversation } from '../conversation.js';
import { parseMarkdown, renderBlocks } from '../markdown.js';
import { autosizeTextarea, createComposer } from '../composer.js';

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
  el.replaceChildren(...(running ? [spinner(), 'working'] : [label]));
}
// Why a live view ended, as a sentence; the server sends a short code.
const LIVE_END = { exited: 'the session finished', error: 'something went wrong on the server', closed: 'it was closed', 'login-ended': 'you were signed out', abandoned: 'it was idle too long', 'signed-out': 'you were signed out', 'view-gone': 'it was opened somewhere else' };
const KIND_LABEL = { background: 'Runs in the background', interactive: 'Runs in a terminal window' };
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
// The label a switch or the settings default gave: a printed name ("Opus 5.5")
// is already cased, a bare alias ("opus") is capitalised, a literal id is
// formatted like one from a reply.
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const givenLabel = (label) => (/^claude-/.test(label) ? modelLabel(label) : cap(label));
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
    fontFamily: '"Cascadia Mono NF", "Geist Mono", ui-monospace, "Cascadia Mono", Consolas, SFMono-Regular, Menlo, "DejaVu Sans Mono", "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", monospace',
    fontSize: 14, lineHeight: 1.15, cursorBlink: true, scrollback: 5000,
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
    try { ({ ticket } = await api.post('/api/v1/events/ticket')); } catch { ended('signed-out'); return; }
    es = new EventSource(`/api/v1/claude/live/${vid}/stream?ticket=${encodeURIComponent(ticket)}`);
    es.addEventListener('o', (e) => term.write(fromB64(e.data)));
    es.addEventListener('x', (e) => { es.close(); ended(e.data); });
    // Tickets are single-use, so a dropped stream reconnects with a new one.
    es.onerror = () => { if (closed) return; es.close(); setTimeout(connect, 1000); };
  };
  await connect();

  // Keystroke sending (order, pacing, retries) lives in input-queue.js, where
  // it is tested without a browser.
  const queue = createInputQueue({
    post: (chunk) => api.post(`/api/v1/claude/live/${vid}/input`, { data: toB64(chunk) }),
    onEnded: () => ended('view-gone'),
    onWarn: (msg) => toast(msg, 'error'),
  });
  const sendBytes = (u8) => queue.push(u8);
  term.onData((d) => sendBytes(enc.encode(d)));
  term.onBinary((d) => { const u8 = new Uint8Array(d.length); for (let i = 0; i < d.length; i++) u8[i] = d.charCodeAt(i) & 0xff; sendBytes(u8); });

  // On a phone, a one-finger vertical drag scrolls. Claude Code draws on the
  // alternate screen with mouse reporting on and scrolls its own view from
  // wheel reports, so the drag becomes wheel events for xterm to report — the
  // same thing a mouse wheel does. On the normal screen the drag scrolls
  // xterm's own history instead.
  const touch = { y: null, x: null, carry: 0, moved: false };
  const rowHeight = () => host.clientHeight / Math.max(1, term.rows);
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) { touch.y = null; return; }
    touch.y = e.touches[0].clientY; touch.x = e.touches[0].clientX; touch.carry = 0; touch.moved = false;
  };
  const onTouchMove = (e) => {
    if (touch.y === null || e.touches.length !== 1) return;
    const dy = touch.y - e.touches[0].clientY;
    const dx = touch.x - e.touches[0].clientX;
    // With touch-action: none on the host, the browser never scrolls the page
    // or the viewport itself; the only question is whether this drag is ours.
    if (!touch.moved && Math.abs(dy) < 6 && Math.abs(dx) < 6) return; // a tap
    if (!touch.moved && Math.abs(dx) > Math.abs(dy)) { touch.y = null; return; } // sideways: not ours
    touch.moved = true;
    e.preventDefault();
    e.stopPropagation(); // xterm's own handler must not see it
    const rows = (dy + touch.carry) / rowHeight();
    const whole = Math.trunc(rows);
    touch.carry = (rows - whole) * rowHeight();
    if (whole === 0) return;
    if (term.buffer.active.type === 'alternate') {
      const screen = host.querySelector('.xterm-screen') || host;
      for (let i = 0; i < Math.abs(whole); i++)
        screen.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(whole) * rowHeight(), deltaMode: 0, clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, bubbles: true, cancelable: true }));
    } else {
      term.scrollLines(whole);
    }
    touch.y = e.touches[0].clientY; touch.x = e.touches[0].clientX;
  };
  const onTouchEnd = () => { touch.y = null; };
  const touchScroll = window.matchMedia('(hover: none)').matches;
  if (touchScroll) {
    // Capture phase: xterm's listeners sit deeper and would run first.
    host.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    host.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
    host.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    host.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
  }

  let resizeTimer = null;
  const ro = new ResizeObserver(() => {
    if (closed) return;
    fit.fit();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!closed) api.post(`/api/v1/claude/live/${vid}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {}); }, 150);
  });
  ro.observe(host);

  function cleanup() {
    if (touchScroll) {
      host.removeEventListener('touchstart', onTouchStart, { capture: true });
      host.removeEventListener('touchmove', onTouchMove, { capture: true });
      host.removeEventListener('touchend', onTouchEnd, { capture: true });
      host.removeEventListener('touchcancel', onTouchEnd, { capture: true });
    }
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
    /** The last rows of the screen, top to bottom, trailing blanks dropped. */
    screenLines(max = 60) {
      const b = term.buffer.active;
      const out = [];
      for (let y = Math.max(0, b.length - max); y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
      while (out.length && !out[out.length - 1].trim()) out.pop();
      return out;
    },
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

const SESS_KEY = 'deus-control.claude-sessions-hidden';

export async function render(root, api, bus, me) {
  // Ends this view's listeners on the next navigation — registered before the first
  // await, so leaving while it loads cannot leak them (listeners added later with an
  // already-aborted signal are never added).
  const ac = new AbortController();
  bus.addEventListener('view-unmount', () => ac.abort(), { once: true });
  const readOnly = Boolean(me && me.read_only);
  const list = h('div', { class: 'claude-sessions', role: 'list' });
  const pane = h('section', { class: 'claude-pane' });
  const runningText = h('span', {});
  const summary = h('div', { class: 'running-summary', role: 'status', hidden: true }, spinner(), runningText);
  const side = h('div', { class: 'claude-side' }, summary, list);
  const wrap = h('div', { class: 'claude-layout' }, side, pane);
  // A page a session published, beside the conversation (artifact-pane.js).
  // Only artifacts the registry holds a local copy of can open here; the
  // list is read once per visit and again when the registry changes.
  const artPane = createArtifactPane(api);
  let artifactsByUrl = new Map();
  async function loadArtifacts() {
    try {
      const r = await api.get('/api/v1/artifacts');
      artifactsByUrl = new Map((r.artifacts || []).filter((a) => a.local && typeof a.url === 'string').map((a) => [a.url, a]));
    } catch { /* the cards just offer no "Open beside" */ }
    pagesRefresh();
  }
  const localArtifact = (url) => artifactsByUrl.get(url) || null;
  // The pane's width at ≥ 1100 px: a drag handle on its left edge, 30–75 % of
  // the layout, remembered in this browser only (a convenience, not state).
  const W_KEY = 'deus-control.artifact-width';
  const W_MIN = 30, W_MAX = 75;
  // Unless the operator dragged a width: more room for the page on very wide screens.
  const W_DEFAULT = window.matchMedia('(min-width: 2400px)').matches ? 55 : 45;
  const clampW = (v) => Math.min(W_MAX, Math.max(W_MIN, v));
  function setWidth(pct) { wrap.style.setProperty('--art-w', `${clampW(pct)}%`); }
  try { const saved = Number(localStorage.getItem(W_KEY)); setWidth(saved > 0 ? saved : W_DEFAULT); } catch { setWidth(W_DEFAULT); }
  const handle = h('div', { class: 'ap-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the page pane', tabindex: '0' });
  artPane.el.prepend(handle);
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const box = wrap.getBoundingClientRect();
    let pct = null;
    const move = (ev) => { pct = clampW(((box.right - ev.clientX) / box.width) * 100); setWidth(pct); };
    const up = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up);
      if (pct !== null) try { localStorage.setItem(W_KEY, String(Math.round(pct))); } catch { /* not remembered */ }
    };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const now = parseFloat(wrap.style.getPropertyValue('--art-w')) || W_DEFAULT;
    const pct = clampW(now + (e.key === 'ArrowLeft' ? 5 : -5));
    setWidth(pct);
    try { localStorage.setItem(W_KEY, String(pct)); } catch { /* not remembered */ }
  });
  function openArtifact(a, updated) {
    if (!a || !a.local) return;
    if (!artPane.el.isConnected) wrap.append(artPane.el); // attached first, so open() can focus it
    wrap.classList.add('with-artifact');
    artPane.open(a, {
      updated,
      onClose: () => { wrap.classList.remove('with-artifact', 'artifact-expanded'); },
      onExpand: (v) => { wrap.classList.toggle('artifact-expanded', v); },
    });
  }
  // The open session's pages: its own captured entries plus any page its
  // conversation published that the registry holds a copy of (Pages menu).
  let convUrls = new Set();
  let pagesRefresh = () => {};
  let pagesOutside = () => {}; // one document listener for the view, pointed at the open session's menu
  const onPagesOutside = (e) => pagesOutside(e.target);
  document.addEventListener('pointerdown', onPagesOutside, { signal: ac.signal });
  let sessions = [];
  let liveAvailable = false;
  let current = null; // { id, view }
  let refreshTimer = null;

  // ---- new session ----
  const form = h('form', { class: 'card new-session', hidden: true });
  const nameInput = h('input', { type: 'text', placeholder: 'e.g. Posts Automation', 'aria-label': 'Session name', maxlength: '60', required: true });
  const promptInput = h('textarea', { rows: '3', placeholder: 'What should it do first?', 'aria-label': 'First message', required: true });
  promptInput.addEventListener('input', () => autosizeTextarea(promptInput, 12));
  const startBtn = h('button', { type: 'submit', class: 'primary' }, 'Start');
  // The server's name rule (CLAUDE_NAME_RE in api/claude-sessions.ts; a test keeps
  // the two equal), checked as you type so a refusal never comes as a surprise.
  const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u;
  const nameHint = h('p', { class: 'field-hint error', role: 'status', hidden: true });
  const checkName = () => {
    const v = nameInput.value.trim();
    let why = '';
    if (v && !NAME_RE.test(v)) {
      const bad = [...new Set([...v].filter((c) => !/[\p{L}\p{N} ._-]/u.test(c)))].join(' ');
      why = bad
        ? `${bad} can't be used in a session name${bad.includes('&') ? ' — try "and"' : ''}. Use letters, numbers, spaces and . _ -`
        : 'Start the name with a letter or a number.';
    }
    nameHint.textContent = why;
    nameHint.hidden = !why;
    startBtn.disabled = Boolean(why);
    return !why;
  };
  nameInput.addEventListener('input', checkName);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name || !prompt || !checkName()) return;
    startBtn.disabled = true;
    try {
      // The form itself is the explicit action; runs in auto mode, like the terminal.
      const r = await api.post('/api/v1/claude/sessions', { name, prompt }, { 'X-Confirm': 'start' });
      nameInput.value = ''; promptInput.value = ''; form.hidden = true;
      toast(`Started "${name}"`, 'ok');
      await load();
      const s = sessions.find((x) => x.id === r.id);
      if (s) select(s);
    } catch (err) { if (err.status === 429) limitToast('starts', 'a few minutes'); else toast(serverError(err, "Couldn't start the session — try again in a minute."), 'error'); }
    finally { checkName(); }
  });
  form.append(
    h('div', { class: 'form-grid' },
      h('label', {}, 'Name', nameInput, nameHint),
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
    } catch (err) { if (err.status === 429) limitToast('changes'); else toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
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
            [label, ago(s.last_active || s.started_at)].filter(Boolean).join(' · ')))),
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
          : "Live view isn't set up on this server yet — you'll see recent output instead.")));
  }
  function closeCurrent() {
    if (current && current.conv) current.conv.dispose();
    if (current && current.view) current.view.close();
    current = null;
    pagesRefresh = () => {}; pagesOutside = () => {};
    document.body.classList.remove('claude-full');
    wrap.classList.remove('sessions-hidden'); // nothing open: the list is always there to pick from
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
      h('dt', {}, 'ID'), h('dd', { class: 'mono' }, s.id),
      h('dt', {}, 'Started'), h('dd', {}, s.started_at ? fmtTime(s.started_at) : '—'),
      h('dt', {}, 'Folder'), h('dd', { class: 'mono' }, s.cwd_rel || '.'),
      h('dt', {}, 'Kind'), h('dd', {}, KIND_LABEL[s.kind] || s.kind));
    // "Pages": this session's pages that can open beside the conversation.
    convUrls = new Set();
    const pagesBtn = h('button', { type: 'button', class: 'small', hidden: true, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'Pages');
    const pagesMenu = h('div', { class: 'pages-menu', role: 'menu', hidden: true });
    const pagesWrap = h('div', { class: 'pages-wrap' }, pagesBtn, pagesMenu);
    const sessionPages = () => [...artifactsByUrl.values()]
      .filter((a) => (a.session && a.session.id === s.id) || convUrls.has(a.url))
      .sort((a, b) => String(b.added_at || '').localeCompare(String(a.added_at || '')));
    const closeMenu = () => { pagesMenu.hidden = true; pagesBtn.setAttribute('aria-expanded', 'false'); };
    pagesRefresh = () => {
      const list = sessionPages();
      pagesBtn.hidden = list.length === 0;
      pagesBtn.textContent = list.length > 1 ? `Pages (${list.length})` : 'Page';
      pagesMenu.replaceChildren(...list.map((a) => h('button', { type: 'button', class: 'pages-item', role: 'menuitem', onclick: () => { closeMenu(); openArtifact(a); } },
        h('span', { class: 'pages-title', dir: 'auto' }, a.title), h('span', { class: 'muted small' }, a.added_at ? fmtTime(a.added_at) : ''))));
      if (!list.length) closeMenu();
    };
    pagesBtn.addEventListener('click', () => {
      const list = sessionPages();
      if (list.length === 1) { openArtifact(list[0]); return; } // one page: open it, no menu
      const open = pagesMenu.hidden;
      pagesMenu.hidden = !open; pagesBtn.setAttribute('aria-expanded', String(open));
      if (open) { const first = pagesMenu.querySelector('button'); if (first) first.focus(); }
    });
    pagesMenu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); pagesBtn.focus(); } });
    pagesOutside = (t) => { if (!pagesWrap.contains(t)) closeMenu(); };
    pagesRefresh();
    // Hide sessions (≥ 900 px): the open session takes the list's width; remembered in this browser.
    const sessionsBtn = h('button', { type: 'button', class: 'small sessions-toggle' });
    const showSessions = (hidden) => {
      wrap.classList.toggle('sessions-hidden', hidden);
      sessionsBtn.textContent = hidden ? 'Show sessions' : 'Hide sessions';
    };
    sessionsBtn.addEventListener('click', () => {
      const hidden = !wrap.classList.contains('sessions-hidden');
      showSessions(hidden);
      try { localStorage.setItem(SESS_KEY, hidden ? '1' : '0'); } catch { /* remembered for this page only */ }
    });
    const bar = h('div', { class: 'claude-bar' },
      h('button', { type: 'button', class: 'small back', 'aria-label': 'Back to sessions', onclick: () => { closeCurrent(); draw(); placeholder(); } }, '←'),
      h('div', { class: 'claude-title' }, h('span', { class: 'session-name' }, s.name), statusEl),
      h('div', { class: 'claude-actions' },
        sessionsBtn,
        pagesWrap,
        pinSlot,
        h('button', { type: 'button', class: 'small', onclick: () => { details.hidden = !details.hidden; } }, 'Details'),
        readOnly || s.kind !== 'background' ? null : h('button', { type: 'button', class: 'small danger', onclick: async () => {
          const ok = await confirmTyped(s.id, `Stop "${s.name}"? Its conversation is kept; you can resume it later.`);
          if (!ok) return;
          try { await api.post(`/api/v1/claude/sessions/${s.id}/stop`, undefined, { 'X-Confirm': s.id }); toast('Stopped', 'ok'); closeCurrent(); await load(); placeholder(); }
          catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
        } }, 'Stop')));
    pane.append(bar, details);
    let hideList = false;
    try { hideList = localStorage.getItem(SESS_KEY) === '1'; } catch { /* shown */ }
    showSessions(hideList);

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
        pane.append(h('div', { class: 'claude-ended' }, h('span', {}, `Live view ended — ${LIVE_END[why] || 'it was closed'}.`),
          h('button', { type: 'button', class: 'small', onclick: () => select(s) }, 'Reopen')));
      });
      if (current !== mine) { view.close(); return; }
      mine.view = view;
      if (mode === 'terminal') view.focus(); else conv.shown();
    } catch (err) {
      stage.replaceWith(h('div', { class: 'claude-empty' }, h('p', { class: 'error' }, err.status === 429 ? 'Too many live views open — close one first.' : "Couldn't open the live view — try again in a moment."), recentOutput(s)));
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
    // The open question, built from the terminal screen (see readScreen).
    const askEl = h('div', { class: 'conv-ask live', hidden: true, 'aria-live': 'polite' });
    // Claude's own working line ("✻ Thinking… 14s"), read from the screen
    // on every poll tick and updated in place; hidden when idle or asking.
    const thinkVerb = h('span', { class: 'think-verb' });
    const thinkMeta = h('span', { class: 'think-meta' });
    const thinkEl = h('div', { class: 'conv-thinking', hidden: true, role: 'status', 'aria-live': 'polite' }, spinner(), thinkVerb, thinkMeta);
    function updateThinking(w) {
      if (!w) { thinkEl.hidden = true; return; }
      const verb = `${w.verb}…`;
      const meta = `${w.seconds}s${w.tokens ? ` · ${w.tokens} tokens` : ''}${w.tool ? ` · Running ${w.tool}` : ''}`;
      if (thinkVerb.textContent !== verb) thinkVerb.textContent = verb;
      if (thinkMeta.textContent !== meta) thinkMeta.textContent = meta;
      thinkEl.hidden = false;
    }
    // Claude Code's own task list for this session (the ✻/■/□ tree the
    // terminal draws), read from its task store by the conversation route.
    // A collapsed panel stays collapsed for this session (sessionStorage).
    const TASKS_KEY = `claude.tasks.${s.id}`;
    const TASKS_MAX_ROWS = 10;
    const TASK_GLYPH = { in_progress: '■', pending: '□', completed: '✔' };
    const tasksRows = h('div', { class: 'tasks-rows' });
    const tasksCount = h('span', { class: 'tasks-count' });
    const tasksToggle = h('button', { type: 'button', class: 'tasks-head', 'aria-expanded': 'true' }, h('span', { class: 'tasks-title' }, 'Tasks'), tasksCount, h('span', { class: 'tasks-chev', 'aria-hidden': 'true' }, '▾'));
    const tasksEl = h('div', { class: 'conv-tasks', hidden: true, role: 'region', 'aria-label': 'Tasks' }, tasksToggle, tasksRows);
    let tasksVersion = null;
    const readCollapsed = () => { try { return sessionStorage.getItem(TASKS_KEY) === 'collapsed'; } catch { return false; } };
    function setCollapsed(c) {
      tasksEl.classList.toggle('collapsed', c);
      tasksToggle.setAttribute('aria-expanded', String(!c));
      try { if (c) sessionStorage.setItem(TASKS_KEY, 'collapsed'); else sessionStorage.removeItem(TASKS_KEY); } catch { /* not remembered */ }
    }
    tasksToggle.addEventListener('click', () => setCollapsed(!tasksEl.classList.contains('collapsed')));
    setCollapsed(readCollapsed());
    function drawTasks(tasks) {
      const key = tasks.map((t) => `${t.id}\u0000${t.status}\u0000${t.subject}\u0000${t.activeForm || ''}`).join('\u0001');
      if (key === tasksVersion) return;
      tasksVersion = key;
      if (!tasks.length) { tasksEl.hidden = true; tasksRows.replaceChildren(); return; }
      const done = tasks.filter((t) => t.status === 'completed').length;
      tasksCount.textContent = ` · ${done} of ${tasks.length} done`;
      const shown = tasks.slice(0, TASKS_MAX_ROWS);
      // replaceChildren() would render a null as the text "null": filter first.
      tasksRows.replaceChildren(...[
        ...shown.map((t) => h('div', { class: `task-row ${t.status}`, dir: 'auto' },
          h('span', { class: 'task-glyph', 'aria-hidden': 'true' }, TASK_GLYPH[t.status] || '□'),
          t.status === 'in_progress' ? spinner() : null,
          h('span', { class: 'task-text' }, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject))),
        tasks.length > shown.length
          ? h('button', { type: 'button', class: 'small linkish task-more', onclick: openTerminal }, `+${tasks.length - shown.length} more`)
          : null,
      ].filter(Boolean));
      tasksEl.hidden = false;
    }
    // The reply as it is written, read from the terminal screen while Claude
    // works; replaced by the transcript's item when the reply lands.
    const liveEl = h('div', { class: 'conv-assistant live', dir: 'auto', 'aria-live': 'off', hidden: true });
    let liveText = null;
    let lastAssistantText = '';
    const renderState = {};
    function updateLive(r) {
      if (!r) { if (!liveEl.hidden) { liveEl.hidden = true; liveEl.replaceChildren(); } liveText = null; return; }
      if (r.text === liveText) return;
      liveText = r.text;
      const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      const blocks = renderBlocks(parseMarkdown(r.text), h);
      // the "…" cue (the start scrolled off the screen) sits on the first line, inside the first block
      if (r.partial && blocks[0]) blocks[0].prepend(h('span', { class: 'muted' }, '… '));
      liveEl.replaceChildren(...blocks);
      liveEl.hidden = false;
      if (near) scroller.scrollTop = scroller.scrollHeight;
    }
    const scroller = h('div', { class: 'conv-scroll' }, h('div', { class: 'conv-col' }, truncNote, listEl, liveEl, tasksEl, thinkEl, askEl));

    // Two browsers on one session (the raw terminal has the same race): the
    // other one's recent typing is said, not hidden. Set on every poll.
    const othersEl = h('div', { class: 'conv-others', role: 'status', hidden: true }, 'Someone else is answering this session from another browser.');
    // A page this session published lands beside the conversation by itself
    // when the dashboard started the session and the screen is wide enough
    // for two panes; otherwise a notice offers "Open beside". Never on the
    // first render of a reopened session — only on a change while watching.
    // Pages not yet opened queue up (a second publish never replaces the first
    // unseen): the notice names the newest and counts the rest; "Open beside"
    // opens the newest and leaves the others on the notice; Dismiss clears all.
    const cpTitle = h('span', { class: 'cp-title', dir: 'auto' });
    const cpMore = h('span', { class: 'muted' });
    const cpBtn = h('button', { type: 'button', class: 'small primary' }, 'Open beside');
    const publishedEl = h('div', { class: 'conv-published', role: 'status', hidden: true }, 'Claude published ', cpTitle, cpMore, cpBtn,
      h('button', { type: 'button', class: 'small ghost', onclick: () => { published.length = 0; publishedEl.hidden = true; } }, 'Dismiss'));
    const published = []; // newest last
    function drawPublished() {
      if (!published.length) { publishedEl.hidden = true; return; }
      const art = published[published.length - 1];
      cpTitle.textContent = art.title;
      cpMore.textContent = published.length > 1 ? ` and ${published.length - 1} more` : '';
      cpBtn.onclick = () => { published.pop(); drawPublished(); openArtifact(art); };
      publishedEl.hidden = false;
    }
    const knownArtifacts = new Set();
    async function onArtifacts(list) {
      convUrls = new Set((list || []).map((a) => a.url));
      pagesRefresh();
      const fresh = (list || []).filter((a) => a.local && a.id);
      if (first) { fresh.forEach((a) => knownArtifacts.add(a.id)); return; }
      const arrived = fresh.filter((a) => !knownArtifacts.has(a.id));
      if (!arrived.length) return;
      arrived.forEach((a) => knownArtifacts.add(a.id));
      await loadArtifacts(); // once for the batch
      if (disposed) return;
      for (const a of arrived) {
        const art = artifactsByUrl.get(a.url);
        if (!art) continue;
        // A newer version of the page already open beside (same session, same
        // title): the pane follows it instead of offering it again.
        const open = artPane.entry;
        if (open && open.id !== art.id && open.session && art.session && open.session.id === art.session.id && open.title === art.title) {
          openArtifact(art, 'Updated — the session published a new version.');
          continue;
        }
        if (a.started_here && window.innerWidth >= 1100) { openArtifact(art); continue; }
        published.push(art);
      }
      drawPublished();
    }
    // A poll that fails for any reason but "no conversation" is said, not
    // swallowed; the next successful poll clears it.
    const refreshEl = h('div', { class: 'conv-banner conv-refresh', role: 'status', hidden: true }, "Couldn't refresh the conversation — retrying.");
    // New content while scrolled up: a pill, not a jump.
    const newerBtn = h('button', { type: 'button', class: 'small primary conv-newer', hidden: true, onclick: () => { scroller.scrollTop = scroller.scrollHeight; newerBtn.hidden = true; } }, 'New messages ↓');
    const copy = (t) => navigator.clipboard.writeText(t).then(() => toast('Copied', 'ok'), () => toast("Couldn't copy — select the text instead.", 'error'));
    // No "waiting for you in the terminal": the cards answer what the
    // terminal shows. Only when the session is blocked and two interval ticks
    // saw a screen no parser knows does this say so (ask-fallback.js).
    const banner = fallbackNotice(h, { openTerminal });
    banner.hidden = true;
    const missCounter = createMissCounter(2);
    const modeEl = h('span', { class: 'conv-mode' });
    // Claude Code saves either choice as the default for new sessions, exactly
    // as /model and /effort do in the terminal; the menus say so.
    const DEFAULT_NOTE = 'Also becomes the default for new sessions.';
    const composer = createComposer({
      placeholder: 'Message Claude — type / for commands',
      label: 'Message Claude',
      draftKey: `claude.draft.${s.id}`,
      commands: () => commands,
      // Before anything is typed, your own commands and the built-ins lead.
      rank: { personal: 0, 'built-in': 1, project: 2 },
      onSubmit: (text) => { if (!sendText(text)) return false; pollSoon(); return true; },
      onStop: () => stop(),
      stopLabel: 'Stop Claude',
      lead: modeEl,
      pickers: [
        { id: 'model', initial: 'Model', options: MODELS, onPick: (v) => switchModel(v), note: DEFAULT_NOTE },
        { id: 'effort', initial: 'Effort', options: EFFORTS, onPick: (v) => sendLine(`/effort ${v}`), note: DEFAULT_NOTE },
      ],
    });
    const el = h('div', { class: 'conv' }, scroller, h('div', { class: 'conv-composer' }, newerBtn, refreshEl, othersEl, publishedEl, banner, composer.el));
    scroller.addEventListener('scroll', () => { if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120) newerBtn.hidden = true; }, { passive: true });

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
    // A pick is a command: ask for the new state at once, not on the next tick.
    function sendLine(text) { if (sendText(text)) { pollSoon(); setTimeout(poll, 1200); } }
    // Claude Code (2.1.283) asks "Switch model?" before switching mid-session
    // — the pick already is the answer, so the prompt is confirmed when it
    // shows: its first option is "Yes, switch to <model>".
    async function switchModel(v) {
      if (!sendText(`/model ${v}`)) return;
      pollSoon();
      for (let i = 0; i < 12; i++) {
        await later(300);
        const view = mine.view;
        if (!view) return;
        if (view.screenLines(20).some((l) => /^\s*❯\s*1\.\s+Yes, switch to/.test(l))) { view.send('1', { focus: false }); break; }
      }
      pollSoon(); setTimeout(poll, 1200);
    }
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
    // The open question lives on the terminal screen, not in the transcript
    // (Claude Code records the call only once it is answered), so every poll
    // tick reads the screen first and draws the live card from it. A click
    // sends its keys at once — each key its own send, spaced so the screen
    // redraws between them — and the card is read back from the screen.
    let askState = null;     // the last parsed screen, so an unchanged card is not redrawn
    let askText = null;      // { value } while "Other…" is open; survives redraws
    let askSending = false;
    let lockedByAsk = false;
    async function sendKeys(keys) {
      if (disposed || askSending || !view()) return;
      askSending = true; askEl.dataset.sending = 'true';
      try { for (const k of keys) { if (!view()) break; view().send(k, { focus: false }); await later(150); } }
      finally { askSending = false; delete askEl.dataset.sending; }
      await later(250);
      readScreen();
    }
    function readScreen(fromTick = false) {
      if (disposed || askSending) return;
      const v = view();
      const lines = v ? v.screenLines() : [];
      const st = v ? parseAskScreen(lines) || parseMenuScreen(lines) : null;
      // A blocked session at its normal input box asked in plain words: the
      // composer answers it, so that screen counts as understood.
      banner.hidden = !missCounter.tick({ fromTick, blocked: stateOf(row)[0] === 'needs you', matched: !!st || (v ? parseIdlePrompt(lines) : false) });
      // Before the memo below: the working line changes every tick.
      const working = v && !st && stateOf(row)[0] === 'working' ? parseWorking(lines) : null;
      if (working) { const t = parseRunningTool(lines); if (t) working.tool = t.label; }
      updateThinking(working);
      // The reply under way; hidden once the transcript carries the same text.
      const live = working ? parseLiveReply(lines) : null;
      updateLive(live && !(lastAssistantText && lastAssistantText.includes(live.text.slice(0, 60))) ? live : null);
      const key = JSON.stringify(st);
      if (key === askState) return;
      askState = key;
      if (!st) {
        askText = null; askEl.hidden = true; askEl.replaceChildren();
        if (lockedByAsk) { composer.unlock(); lockedByAsk = false; }
        setSession(row);
        return;
      }
      if (st.kind === 'menu') drawMenu(st); else drawAsk(st);
      askEl.hidden = false;
      if (!lockedByAsk) { composer.lock(st.kind === 'menu' ? 'Answer the prompt above first' : 'Answer the question above first'); lockedByAsk = true; }
      setSession(row);
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 200) scroller.scrollTop = scroller.scrollHeight;
    }
    // A digit selects on every Claude Code menu; some also confirm on it,
    // others wait for Enter. Read the screen back: if the same menu still
    // shows with the cursor on the pick, send Enter.
    async function sendPick(n) {
      if (disposed || askSending || !view()) return;
      askSending = true; askEl.dataset.sending = 'true';
      try {
        const arrows = Boolean(lastMenu.arrows);
        if (arrows) {
          // No numbers to type: walk the cursor there one key at a time,
          // reading the screen before every key. If the menu has gone (closed
          // in the terminal meanwhile) nothing is sent: an arrow key at the
          // idle prompt would recall an earlier message from its history.
          let lastKey = '';
          for (let step = 0; step <= lastMenu.options.length; step++) {
            const now = view() ? parseMenuScreen(view().screenLines()) : null;
            if (!sameMenu(now)) {
              // Closed between the read and the key: an Up may have reached
              // the idle prompt and recalled history; one Down puts the empty
              // draft back (and does nothing at a prompt already on it).
              if (lastKey === UP_KEY && view()) view().send(DOWN_KEY, { focus: false });
              break;
            }
            if (now.selected === n) break;
            lastKey = arrowKeys(now.selected, n)[0];
            view().send(lastKey, { focus: false });
            await later(150);
          }
          await later(100);
        } else {
          view().send(String(n), { focus: false });
          await later(350);
        }
        // `lastMenu.options[0]` exists: a pick comes from a drawn button.
        // Enter only once the same menu shows the cursor on the pick — never
        // on a cursor that could not be confirmed (a wrap, an overshoot, a
        // menu closed in the terminal meanwhile).
        const again = view() ? parseMenuScreen(view().screenLines()) : null;
        if (sameMenu(again) && again.selected === n) {
          view().send('\r', { focus: false });
          menuSend = arrows ? 'arrows then Enter' : 'digit then Enter';
        } else menuSend = arrows ? 'arrows, not confirmed' : 'digit alone';
        askEl.dataset.send = menuSend; // observed, for the record (drive reads it)
      } finally { askSending = false; delete askEl.dataset.sending; }
      await later(250);
      readScreen();
    }
    let lastMenu = null;
    let menuSend = '';
    const [UP_KEY] = arrowKeys(2, 1);
    const [DOWN_KEY] = arrowKeys(1, 2);
    // The menu the card was drawn from is still the one on screen.
    const sameMenu = (st) => Boolean(st && lastMenu && st.options.length === lastMenu.options.length && st.options[0].label === lastMenu.options[0].label && Boolean(st.arrows) === Boolean(lastMenu.arrows));
    function drawMenu(st) {
      lastMenu = st;
      askEl.dataset.kind = 'menu';
      askEl.replaceChildren(menuCard(st, h, { pick: sendPick, cancel: () => sendKeys(['\x1b']), openTerminal }));
    }
    function drawAsk(st) {
      askEl.dataset.kind = st.kind;
      const term = h('button', { type: 'button', class: 'small ask-term', onclick: openTerminal }, 'Answer in terminal');
      if (st.kind === 'review') {
        askEl.replaceChildren(
          h('div', {}, h('strong', {}, 'Review your answers')),
          // ← from the review opens the last question and each further ← one
          // back, so question i of n is n-i presses away (bounded by backKeys).
          ...st.answers.map((a, i) => h('div', { class: 'ask-q ask-row', dir: 'auto' },
            h('div', {}, a.question ? h('div', { class: 'muted' }, a.question) : null, h('div', {}, a.answer)),
            st.answers.length - i <= BACK_MAX
              ? h('button', { type: 'button', class: 'small ghost ask-change', 'aria-label': `Change the answer to: ${a.question || `question ${i + 1}`}`, onclick: () => sendKeys(backKeys(st.answers.length - i)) }, 'Change')
              : null)),
          h('div', { class: 'ask-foot' },
            h('div', { class: 'conv-opts' },
              h('button', { type: 'button', class: 'small primary ask-submit', onclick: () => sendKeys(submitKeys()) }, 'Submit answers'),
              h('button', { type: 'button', class: 'small ask-back', onclick: () => sendKeys(backKeys()) }, 'Back')),
            term));
        return;
      }
      const typing = st.other > 0 && st.cursor === st.other; // "Type something" is selected
      if (typing && !askText) askText = { value: '' };
      if (!typing) askText = null;
      const tabs = st.tabs.length > 1 ? h('div', { class: 'ask-tabs conv-opts' },
        ...st.tabs.map((t) => h('span', { class: 'chip', 'data-done': String(t.done), dir: 'auto' }, t.done ? '✓ ' : '', t.label))) : null;
      const opts = st.options.map((o) => h('button', {
        type: 'button', class: `conv-opt${o.on ? ' on' : ''}`, 'data-n': String(o.n), 'aria-pressed': st.multi ? String(o.on) : null, dir: 'auto',
        onclick: () => sendKeys(pickKeys(o.n)),
      }, o.label));
      const other = st.other ? h('button', { type: 'button', class: `conv-opt ask-other${typing ? ' on' : ''}`,
        onclick: () => { if (!typing) sendKeys(pickKeys(st.other)); } }, 'Other…') : null;
      // The box only exists while the cursor is on "Type something", so the
      // number is never re-sent: it would be typed into the answer.
      const submitText = () => { const t = askText ? askText.value : ''; if (!t.trim()) return; askText = null; sendKeys(textKeys(st.other, t, { selected: true })); };
      const sendBtn = h('button', { type: 'button', class: 'small primary ask-send', disabled: !(askText && askText.value.trim()), onclick: submitText }, 'Send answer');
      const input = typing ? h('input', {
        class: 'ask-text', type: 'text', maxlength: '2000', placeholder: 'Type your answer', 'aria-label': 'Your answer', dir: 'auto', value: askText.value,
        oninput: (e) => { askText.value = e.target.value; sendBtn.disabled = !e.target.value.trim(); },
        onkeydown: (e) => { if (e.key === 'Enter' && askText.value.trim()) { e.preventDefault(); submitText(); } },
      }) : null;
      // "Next" only while another question follows; otherwise → opens the
      // review screen, and the button says so.
      const more = st.tabs.filter((t) => !t.done).length > 1;
      const action = typing ? sendBtn
        : st.multi ? h('div', { class: 'conv-opts' },
          h('span', { class: 'muted' }, 'Pick any that apply.'),
          h('button', { type: 'button', class: 'small primary ask-next', onclick: () => sendKeys(nextKeys()) }, more ? 'Next' : 'Review answers'))
          : h('span', { class: 'muted' }, st.other ? 'Pick one, or write your own.' : 'Pick one.');
      askEl.replaceChildren(
        h('div', {}, h('strong', {}, 'Claude is asking')),
        tabs,
        h('div', { class: 'ask-q' }, h('div', { dir: 'auto' }, st.question), h('div', { class: 'conv-opts' }, ...opts, other), input),
        h('div', { class: 'ask-foot' }, action, term));
      if (input) input.focus();
    }
    const visible = () => !document.hidden && isShown(el);
    async function poll(fromTick = false) {
      if (disposed || !visible()) return;
      // No network: the terminal buffer is local. Runs before the view check
      // so a card is cleared, and the composer unlocked, once the view ends.
      readScreen(fromTick);
      if (!view()) return;
      try {
        const r = await api.get(`/api/v1/claude/live/${view().vid}/conversation?v=${encodeURIComponent(version)}`);
        if (disposed) return;
        othersEl.hidden = !r.others_active;
        refreshEl.hidden = true; // any successful poll, unchanged or not
        if (r.unchanged) return;
        version = r.version;
        lastItems = r.items;
        const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
        const lastA = [...r.items].reverse().find((it) => it.k === 'assistant');
        lastAssistantText = lastA ? lastA.text : '';
        if (liveText && lastAssistantText.includes(liveText.slice(0, 60))) updateLive(null);
        if (r.items.length) renderConversation(listEl, r.items, h, { openTerminal, expanded, localArtifact, openArtifact, copy, state: renderState });
        else listEl.replaceChildren(h('div', { class: 'conv-note' }, 'No messages yet. Write the first one below — text only, no attachments.'));
        if (!first && !near) newerBtn.hidden = false;
        truncNote.hidden = !r.truncated;
        drawTasks(Array.isArray(r.tasks) ? r.tasks : []);
        void onArtifacts(r.artifacts);
        composer.picker('model').set(r.model_label ? givenLabel(r.model_label) : modelLabel(r.model));
        const eff = EFFORTS.find(([v]) => v === r.effort);
        composer.picker('effort').set(eff ? eff[1] : 'Effort');
        modeEl.textContent = MODE_LABEL[r.mode] || '';
        if (first || near) scroller.scrollTop = scroller.scrollHeight;
        first = false;
        listEl.dataset.loaded = 'true';
      } catch (err) {
        if (err.status !== 404) refreshEl.hidden = false;
        if (err.status === 404) {
          listEl.replaceChildren(h('div', { class: 'conv-note' }, 'No conversation found for this session yet.'));
          listEl.dataset.loaded = 'true';
        }
      }
    }
    let soon = null;
    const pollSoon = () => { clearTimeout(soon); soon = setTimeout(poll, 400); };
    const timer = setInterval(() => poll(true), 1500);
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVisible);

    let row = s;
    // An open question is answered on its card, so the terminal banner is
    // for the other "needs you" cases (a permission prompt and the like).
    function setSession(next) {
      row = next;
      const [label] = stateOf(row);
      const busy = label === 'working';
      // the fallback notice is the miss counter's to show (readScreen)
      composer.setBusy(busy);
      if (!busy) updateThinking(null);
      // Typing while Claude works is fine — Claude queues it (the bubble
      // shows as Queued). The box says so, unless a question holds it.
      if (!lockedByAsk) composer.input.placeholder = busy ? 'Message Claude — it will be queued until Claude is ready' : composer.placeholder;
      const why = busy ? 'Wait until Claude finishes' : '';
      composer.picker('model').disable(busy, why); // the reason shows once, after the first pill
      composer.picker('effort').disable(busy, '');
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
        catch (err) { toast(serverError(err, 'Something went wrong — try again.'), 'error'); }
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
    } catch (err) { clear(list); list.append(h('div', { class: 'empty' }, err.status === 429 ? 'Too many refreshes — wait a minute.' : serverError(err, 'Something went wrong — try again.'))); }
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
    autosizeTextarea(promptInput, 12);
    promptInput.focus();
    promptInput.setSelectionRange(promptInput.value.length, promptInput.value.length);
  }
  await load();
  // A link like #/claude/<id> (from the Artifacts tab) opens that session.
  const wantedId = decodeURIComponent((location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[1]) || '');
  // `#/claude?artifact=<id>` (from the Artifacts tab) opens that page beside.
  const wantedArtifact = hashQuery().get('artifact');
  await loadArtifacts();
  // Left while loading: undo what render already set up and open nothing more.
  if (ac.signal.aborted) { closeCurrent(); artPane.dispose(); return; }
  if (wantedId) {
    const s = sessions.find((x) => x.id === wantedId);
    if (s) select(s);
  }
  if (wantedArtifact) {
    const a = [...artifactsByUrl.values()].find((x) => x.id === wantedArtifact);
    if (a) openArtifact(a);
    else toast('That artifact has no local copy to show here.', 'error');
  }
  if (wantedId || wantedArtifact) history.replaceState(null, '', '#/claude');
  bus.addEventListener('artifact', () => loadArtifacts(), { signal: ac.signal });
  bus.addEventListener('csession', (e) => {
    if (e.detail && e.detail.sessions) { sessions = e.detail.sessions.map((s) => { const o = sessions.find((x) => x.id === s.id) || {}; return { ...s, last_active: o.last_active, pinned: Boolean(o.pinned) }; }); draw(); }
    else load();
  }, { signal: ac.signal });
  bus.addEventListener('refresh', () => load(), { signal: ac.signal });
  refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 45_000);
  bus.addEventListener('view-unmount', () => { clearInterval(refreshTimer); closeCurrent(); artPane.dispose(); document.removeEventListener('pointerdown', onPagesOutside); }, { once: true });
}
