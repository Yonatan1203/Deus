import { h, clear } from './dom.js';
import { icon } from './icons.js';
import * as chat from './views/chat.js';
import * as agents from './views/agents.js';
import * as wardens from './views/wardens.js';
import * as mcps from './views/mcps.js';
import * as tasks from './views/tasks.js';
import * as channels from './views/channels.js';
import * as memory from './views/memory.js';
import * as logs from './views/logs.js';
import * as system from './views/system.js';
import * as config from './views/config.js';
import * as debug from './views/debug.js';
import * as claude from './views/claude.js';
import * as artifacts from './views/artifacts.js';
import * as browser from './views/browser.js';

const TOKEN_KEY = 'deus_ctl_token';
const CHAT_KEY = 'deus_ctl_chat';
// The rail shows the main views, then "Advanced" (collapsed unless opened or
// the current view is in it). On a phone the first four are tabs and the rest
// sit behind "More" so the bottom bar never exceeds five targets.
const VIEWS = {
  chat: { title: 'Chat', group: 'main', render: chat.render },
  claude: { title: 'Claude', group: 'main', render: claude.render },
  artifacts: { title: 'Artifacts', group: 'main', render: artifacts.render },
  tasks: { title: 'Tasks', group: 'main', render: tasks.render },
  channels: { title: 'Channels', group: 'main', render: channels.render },
  agents: { title: 'Agents', group: 'advanced', render: agents.render },
  wardens: { title: 'Wardens', group: 'advanced', render: wardens.render },
  mcps: { title: 'MCPs', group: 'advanced', render: mcps.render },
  memory: { title: 'Memory', group: 'advanced', render: memory.render },
  logs: { title: 'Logs', group: 'advanced', render: logs.render },
  system: { title: 'System', group: 'advanced', render: system.render }, // containers live on it
  config: { title: 'Config', group: 'advanced', render: config.render },
  debug: { title: 'Debug', group: 'advanced', render: debug.render },
  browser: { title: 'Browser', group: 'advanced', note: 'Paused', render: browser.render }, // a fixed label, not live state
};
const ALIASES = { containers: 'system' }; // old links keep working
const MOBILE_PRIMARY = ['chat', 'claude', 'artifacts', 'tasks'];
const ADVANCED_KEY = 'deus-control.nav-advanced';
const DEFAULT_VIEW = 'chat';

// Page header shared by every view: eyebrow (group), title, optional count
// and right-aligned actions.
export function header(title, { eyebrow, count, actions = [] } = {}) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'titles' },
      eyebrow ? h('span', { class: 'eyebrow' }, eyebrow) : null,
      h('h1', {}, title, count != null ? h('span', { class: 'count' }, String(count)) : null)),
    actions.length ? h('div', { class: 'actions' }, ...actions) : null);
}
const $ = (id) => document.getElementById(id);

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(v) {
  try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable: session lasts the page */ }
}
function forgetSession() {
  setToken('');
  try { localStorage.removeItem(CHAT_KEY); } catch { /* ignore */ }
}

function headersFor(method, body, extra) {
  const headers = { Accept: 'application/json', 'X-Deus-Session': token(), ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return headers;
}

function failure(res, data) {
  const e = new Error(data.error || `HTTP ${res.status}`);
  e.status = res.status;
  e.data = data;
  return e;
}

async function call(method, path, body, extra = {}) {
  const res = await fetch(path, {
    method,
    headers: headersFor(method, body, extra),
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    forgetSession();
    showLogin();
    throw new Error('unauthorized');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw failure(res, data);
  return data;
}

// POST that streams SSE frames back; resolves when the stream ends.
async function stream(path, body, onFrame, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: headersFor('POST', body, {}),
    credentials: 'same-origin',
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    forgetSession();
    showLogin();
    throw new Error('unauthorized');
  }
  if (!res.ok) throw failure(res, await res.json().catch(() => ({})));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) onFrame(type, JSON.parse(data));
    }
  }
}

const api = {
  token,
  get: (p) => call('GET', p),
  post: (p, b, extra) => call('POST', p, b, extra),
  patch: (p, b, extra) => call('PATCH', p, b, extra),
  put: (p, b, extra) => call('PUT', p, b, extra),
  del: (p, extra) => call('DELETE', p, undefined, extra),
  stream,
};

const bus = new EventTarget();
let me = null;
let source = null;
let pollTimer = null;

async function connectEvents() {
  if (source) source.close();
  let ticket;
  try {
    ({ ticket } = await api.post('/api/v1/events/ticket'));
  } catch {
    return;
  }
  source = new EventSource(`/api/v1/events?ticket=${encodeURIComponent(ticket)}`);
  source.onopen = () => {
    clearInterval(pollTimer);
    pollTimer = null;
    $('live-dot').className = 'dot live';
  };
  source.onerror = () => {
    $('live-dot').className = 'dot warn';
    if (!pollTimer) pollTimer = setInterval(() => bus.dispatchEvent(new CustomEvent('refresh')), 10_000);
  };
  for (const type of ['warden', 'session', 'group', 'queue', 'task', 'memory', 'container', 'build', 'system', 'alert', 'log', 'csession', 'workflow', 'artifact', 'browser', 'chat']) {
    source.addEventListener(type, (e) =>
      bus.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(e.data) })));
  }
}

function showLogin() {
  $('app').hidden = true;
  $('offline').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

// The server did not answer (tunnel down, a restart in progress): say so and
// keep trying, instead of leaving both panels hidden (a blank page).
let offlineTimer = null;
function showOffline() {
  $('app').hidden = true;
  $('login').hidden = true;
  $('offline').hidden = false;
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(boot, 3000);
}
$('offline-retry').addEventListener('click', () => { clearTimeout(offlineTimer); $('offline-status').textContent = 'Trying…'; boot(); });

function currentView() {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0].split('/')[0];
  const key = ALIASES[raw] || raw;
  return VIEWS[key] ? key : DEFAULT_VIEW;
}
/** The part of the hash after `?` (`#/claude?artifact=…`), empty when none. */
export function hashQuery() {
  const i = location.hash.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : location.hash.slice(i + 1));
}

function link(k) {
  const active = k === currentView();
  return h('a', { href: `#/${k}`, class: active ? 'active' : '', 'aria-current': active ? 'page' : 'false' },
    icon(k, { size: 18 }), h('span', {}, VIEWS[k].title),
    VIEWS[k].note ? h('span', { class: 'chip nav-note' }, VIEWS[k].note) : null);
}
const inGroup = (g) => Object.keys(VIEWS).filter((k) => VIEWS[k].group === g);
function advancedOpen() {
  try { return localStorage.getItem(ADVANCED_KEY) === '1'; } catch { return false; }
}

function drawNav() {
  const nav = $('nav');
  clear(nav);
  const current = currentView();
  const forced = VIEWS[current].group === 'advanced'; // the active link is never hidden
  const open = forced || advancedOpen();
  const adv = h('div', { class: 'nav-group', id: 'nav-advanced', hidden: !open }, ...inGroup('advanced').map(link));
  const toggle = h('button', { type: 'button', class: 'nav-toggle', 'aria-expanded': String(open), 'aria-controls': 'nav-advanced' },
    h('span', {}, 'Advanced'), h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
  toggle.addEventListener('click', () => {
    const willOpen = adv.hidden;
    adv.hidden = !willOpen;
    toggle.setAttribute('aria-expanded', String(willOpen));
    try { localStorage.setItem(ADVANCED_KEY, willOpen ? '1' : '0'); } catch { /* remembered for this page only */ }
  });
  nav.append(h('div', { class: 'nav-group' }, ...inGroup('main').map(link)), h('div', { class: 'nav-group' }, toggle, adv));
  const rest = Object.keys(VIEWS).filter((k) => !MOBILE_PRIMARY.includes(k));
  const tabbar = $('tabbar');
  clear(tabbar);
  const moreActive = rest.includes(current);
  tabbar.append(
    ...MOBILE_PRIMARY.map(link),
    h('button', { type: 'button', class: moreActive ? 'active' : '', 'aria-haspopup': 'dialog', onclick: () => $('more').showModal() },
      icon('more', { size: 18 }), h('span', {}, 'More')));
  const list = $('more-list');
  clear(list);
  list.append(...rest.filter((k) => VIEWS[k].group === 'main').map(link),
    h('span', { class: 'eyebrow' }, 'Advanced'), ...inGroup('advanced').map(link));
}

async function route() {
  drawNav();
  const more = $('more');
  if (more.open) more.close();
  bus.dispatchEvent(new CustomEvent('view-unmount'));
  const root = $('view');
  root.dataset.view = currentView();
  clear(root);
  root.append(h('p', { class: 'muted' }, 'Loading…'));
  try {
    await VIEWS[currentView()].render(root, api, bus, me);
    root.focus({ preventScroll: true });
  } catch (err) {
    if (err.message !== 'unauthorized') {
      clear(root);
      root.append(h('p', { class: 'error' }, err.message));
    }
  }
}

async function boot() {
  clearTimeout(offlineTimer);
  try {
    me = await api.get('/api/v1/me');
  } catch (err) {
    if (err.message === 'unauthorized') return; // showLogin already ran
    $('offline-status').textContent = 'Trying again every few seconds…';
    showOffline();
    return;
  }
  $('offline').hidden = true;
  $('brand-name').textContent = `${me.assistant} · Control`;
  document.title = `${me.assistant} Control`;
  $('mode-pill').hidden = !me.read_only;
  $('status-text').textContent = `v${me.version || '?'}${me.read_only ? ' · read-only' : ''}`;
  $('more-status').textContent = $('status-text').textContent;
  $('login').hidden = true;
  $('app').hidden = false;
  await connectEvents();
  await route();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('login-error');
  err.textContent = '';
  try {
    const r = await api.post('/auth/login', { password: $('password').value });
    setToken(r.token);
    $('password').value = '';
    await boot();
  } catch (ex) {
    err.textContent = ex.status === 429
      ? `Too many attempts — wait ${Math.ceil((ex.data?.retry_after_ms || 1000) / 1000)} s.`
      : ex.status === 503 ? 'Credential unavailable on the server.'
      : ex.status === undefined ? "Can't reach the server — check your SSH tunnel."
      : 'Wrong password.';
  }
});

async function logout() {
  await api.post('/auth/logout').catch(() => {});
  forgetSession();
  if (source) source.close();
  if ($('more').open) $('more').close();
  showLogin();
}
for (const id of ['logout', 'more-logout']) $(id).prepend(icon('logout', { size: 16 }));
$('logout').addEventListener('click', logout);
$('more-logout').addEventListener('click', logout);
$('more').addEventListener('click', (e) => { if (e.target === $('more')) $('more').close(); });

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && source && source.readyState === EventSource.CLOSED) connectEvents();
});
window.addEventListener('online', () => { if (source) connectEvents(); });
// The shell is served from the service worker's cache, so a deploy reaches an
// open tab only through a new worker. It takes over at once (sw.js: skipWaiting
// + claim) but this page still runs the old files — so an update is announced
// and the reload is the operator's. A long-lived tab checks now and then, and
// when it comes back into view.
if ('serviceWorker' in navigator) {
  const sw = navigator.serviceWorker;
  // A controller at load means this is not the first visit: a later
  // controllerchange is an update, not the first install claiming the page.
  const hadController = !!sw.controller;
  sw.register('/sw.js').then((reg) => {
    const check = () => reg.update().catch(() => {});
    setInterval(check, 30 * 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => {});
  sw.addEventListener('controllerchange', () => { if (hadController) showUpdate(); });
}
function showUpdate() {
  const bar = $('update');
  bar.replaceChildren(
    h('span', {}, 'A new version of the dashboard is ready.'),
    h('button', { type: 'button', class: 'small', onclick: () => location.reload() }, 'Reload'));
  bar.hidden = false;
}
boot();
