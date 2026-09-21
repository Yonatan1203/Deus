import { h, clear } from './dom.js';
import { icon } from './icons.js';
import * as chat from './views/chat.js';
import * as agents from './views/agents.js';
import * as wardens from './views/wardens.js';
import * as mcps from './views/mcps.js';
import * as sessions from './views/sessions.js';
import * as groups from './views/groups.js';
import * as tasks from './views/tasks.js';
import * as channels from './views/channels.js';
import * as memory from './views/memory.js';
import * as containers from './views/containers.js';
import * as logs from './views/logs.js';
import * as system from './views/system.js';
import * as config from './views/config.js';
import * as debug from './views/debug.js';

const TOKEN_KEY = 'deus_ctl_token';
const CHAT_KEY = 'deus_ctl_chat';
// Rail groups on desktop; on mobile the first four are tabs and the rest sit
// behind "More" so the bottom bar never exceeds five targets.
const VIEWS = {
  chat: { title: 'Chat', group: 'Operate', render: chat.render },
  sessions: { title: 'Sessions', group: 'Operate', render: sessions.render },
  tasks: { title: 'Tasks', group: 'Operate', render: tasks.render },
  agents: { title: 'Agents', group: 'Configure', render: agents.render },
  wardens: { title: 'Wardens', group: 'Configure', render: wardens.render },
  mcps: { title: 'MCPs', group: 'Configure', render: mcps.render },
  groups: { title: 'Groups', group: 'Configure', render: groups.render },
  channels: { title: 'Channels', group: 'Configure', render: channels.render },
  memory: { title: 'Memory', group: 'Configure', render: memory.render },
  containers: { title: 'Containers', group: 'System', render: containers.render },
  logs: { title: 'Logs', group: 'System', render: logs.render },
  system: { title: 'System', group: 'System', render: system.render },
  config: { title: 'Config', group: 'System', render: config.render },
  debug: { title: 'Debug', group: 'System', render: debug.render },
};
const GROUPS = ['Operate', 'Configure', 'System'];
const MOBILE_PRIMARY = ['chat', 'sessions', 'tasks', 'agents'];
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
  for (const type of ['warden', 'session', 'group', 'queue', 'task', 'memory', 'container', 'build', 'system', 'alert', 'log']) {
    source.addEventListener(type, (e) =>
      bus.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(e.data) })));
  }
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

function currentView() {
  const key = location.hash.replace(/^#\/?/, '').split('/')[0];
  return VIEWS[key] ? key : DEFAULT_VIEW;
}

function link(k) {
  const active = k === currentView();
  return h('a', { href: `#/${k}`, class: active ? 'active' : '', 'aria-current': active ? 'page' : 'false' },
    icon(k, { size: 18 }), h('span', {}, VIEWS[k].title));
}

function drawNav() {
  const nav = $('nav');
  clear(nav);
  for (const group of GROUPS) {
    nav.append(h('div', { class: 'nav-group' },
      h('span', { class: 'eyebrow' }, group),
      ...Object.keys(VIEWS).filter((k) => VIEWS[k].group === group).map(link)));
  }
  const rest = Object.keys(VIEWS).filter((k) => !MOBILE_PRIMARY.includes(k));
  const tabbar = $('tabbar');
  clear(tabbar);
  const moreActive = rest.includes(currentView());
  tabbar.append(
    ...MOBILE_PRIMARY.map(link),
    h('button', { type: 'button', class: moreActive ? 'active' : '', 'aria-haspopup': 'dialog', onclick: () => $('more').showModal() },
      icon('more', { size: 18 }), h('span', {}, 'More')));
  const list = $('more-list');
  clear(list);
  for (const group of GROUPS.slice(1)) {
    list.append(h('span', { class: 'eyebrow' }, group), ...rest.filter((k) => VIEWS[k].group === group).map(link));
  }
}

async function route() {
  drawNav();
  const more = $('more');
  if (more.open) more.close();
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
  try {
    me = await api.get('/api/v1/me');
  } catch {
    return; // showLogin already ran
  }
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
      ? `Too many attempts. Try again in ${Math.ceil((ex.data?.retry_after_ms || 1000) / 1000)} s.`
      : ex.status === 503 ? 'Credential unavailable on the server.' : 'Wrong password.';
  }
});

async function logout() {
  await api.post('/auth/logout').catch(() => {});
  forgetSession();
  if (source) source.close();
  if ($('more').open) $('more').close();
  showLogin();
}
$('logout').addEventListener('click', logout);
$('more-logout').addEventListener('click', logout);
$('more').addEventListener('click', (e) => { if (e.target === $('more')) $('more').close(); });

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && source && source.readyState === EventSource.CLOSED) connectEvents();
});
window.addEventListener('online', () => { if (source) connectEvents(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
