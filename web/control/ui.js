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
