import { h, clear } from './dom.js';
import * as agents from './views/agents.js';
import * as wardens from './views/wardens.js';
import * as mcps from './views/mcps.js';

const TOKEN_KEY = 'deus_ctl_token';
const VIEWS = {
  agents: { title: 'Agents', icon: '◈', render: agents.render },
  wardens: { title: 'Wardens', icon: '◎', render: wardens.render },
  mcps: { title: 'MCPs', icon: '▦', render: mcps.render },
};
const DEFAULT_VIEW = 'agents';
const $ = (id) => document.getElementById(id);

function token() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(v) {
  try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable: session lasts the page */ }
}

async function call(method, path, body, extra = {}) {
  const headers = { Accept: 'application/json', 'X-Deus-Session': token(), ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    setToken('');
    showLogin();
    throw new Error('unauthorized');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `HTTP ${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

const api = {
  get: (p) => call('GET', p),
  post: (p, b, extra) => call('POST', p, b, extra),
  patch: (p, b, extra) => call('PATCH', p, b, extra),
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
  };
  source.onerror = () => {
    if (!pollTimer) pollTimer = setInterval(() => bus.dispatchEvent(new CustomEvent('refresh')), 10_000);
  };
  for (const type of ['warden']) {
    source.addEventListener(type, (e) =>
      bus.dispatchEvent(new CustomEvent(type, { detail: JSON.parse(e.data) })));
  }
}

export function toast(msg, kind = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 3500);
}

export function banner(msg) {
  const el = $('banner');
  el.textContent = msg || '';
  el.hidden = !msg;
}

export function confirmTyped(expected, message) {
  const dlg = $('confirm');
  const input = $('confirm-input');
  const ok = $('confirm-ok');
  $('confirm-message').textContent = message;
  $('confirm-expected').textContent = expected;
  input.value = '';
  ok.disabled = true;
  input.oninput = () => { ok.disabled = input.value !== expected; };
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value === expected);
    dlg.showModal();
    input.focus();
  });
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

function navItems() {
  const key = currentView();
  return Object.entries(VIEWS).map(([k, v]) =>
    h('a', { href: `#/${k}`, class: k === key ? 'active' : '', 'aria-current': k === key ? 'page' : 'false' },
      h('span', { class: 'icon', 'aria-hidden': 'true' }, v.icon),
      h('span', {}, v.title)));
}

async function route() {
  for (const id of ['nav', 'tabbar']) {
    const el = $(id);
    clear(el);
    el.append(...navItems());
  }
  const root = $('view');
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

$('logout').addEventListener('click', async () => {
  await api.post('/auth/logout').catch(() => {});
  setToken('');
  if (source) source.close();
  showLogin();
});

window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && source && source.readyState === EventSource.CLOSED) connectEvents();
});
window.addEventListener('online', () => { if (source) connectEvents(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
