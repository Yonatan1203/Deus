const $ = (id) => document.getElementById(id);

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

export function confirmTyped(expected, message, details) {
  const dlg = $('confirm');
  const input = $('confirm-input');
  const ok = $('confirm-ok');
  $('confirm-message').textContent = message;
  const list = $('confirm-details');
  while (list.firstChild) list.removeChild(list.firstChild);
  for (const d of details || []) {
    const li = document.createElement('li');
    li.textContent = d;
    list.append(li);
  }
  list.hidden = !(details && details.length);
  $('confirm-expected').textContent = expected;
  input.value = '';
  ok.disabled = true;
  input.oninput = () => { ok.disabled = input.value !== expected; };
  // Enter would submit the form with its first button, Cancel. It confirms
  // when the text matches and otherwise does nothing; Escape still cancels.
  // (keyCode 229: Safari's Enter that ends an IME composition.)
  input.onkeydown = (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (!ok.disabled) dlg.close('ok');
  };
  return new Promise((resolve) => {
    dlg.onclose = () => resolve(dlg.returnValue === 'ok' && input.value === expected);
    dlg.showModal();
    input.focus();
  });
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** One wording for every rate limit: "Too many <what> — wait <wait>." */
export const limitToast = (what, wait = 'a minute') => toast(`Too many ${what} — wait ${wait}.`, 'error');

// Server errors the page may show as they are; anything else gets the fallback,
// so a code path never leaks a fragment like "invalid size" to the operator.
const SAFE_ERRORS = new Set(['confirmation required', 'not found', 'read-only from the dashboard', 'chat not found', 'too many session starts',
  'Session name: letters, numbers, spaces and . _ - only (up to 60)', 'First message: 1 to 8192 characters', 'live-session ledger unreadable']);
// Fixed-format messages with a number in them (server.ts, the live-session cap).
const SAFE_PATTERNS = [/^\d+ dashboard-started sessions are already working$/];
export const serverError = (err, fallback) =>
  (err && (SAFE_ERRORS.has(err.message) || SAFE_PATTERNS.some((re) => re.test(err.message))) ? err.message : fallback);
