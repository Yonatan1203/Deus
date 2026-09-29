import { h } from './dom.js';
import { icon } from './icons.js';

// The message box both the Claude tab and Chat use: a growing text area, the
// `/` command menu with the recognised command marked above the box, pill
// pickers, and a send button that turns into Stop while a reply runs. What a
// message, a pick or Stop actually does is the caller's.

/** Control characters could end a paste early or send keys; only text, newlines and tabs go in. */
export const cleanInput = (t) => t.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\s+$/, '');

/**
 * Commands for the `/` menu given what is typed: prefix matches first, then
 * the rest that contain it, at most 8. With nothing after `/`, `rank`
 * (source → order) decides which lead. Null when the menu should be shut.
 */
export function filterCommands(commands, value, rank = {}) {
  const m = /^\/(\S*)$/.exec(value);
  if (!m || !commands || !commands.length) return null;
  const q = m[1].toLowerCase();
  if (!q) return [...commands].sort((a, b) => (rank[a.source] ?? 9) - (rank[b.source] ?? 9)).slice(0, 8);
  // Exact name or alias, then prefix, then contains; each command once, at
  // its best tier. `alias` is set when only an alias earned that tier, so a
  // pick keeps what was typed (`/rc`, not `/remote-control`).
  const tiers = [[], [], []];
  for (const c of commands) {
    const aliases = Array.isArray(c.aliases) ? c.aliases : [];
    const tests = [(n) => n === q, (n) => n.startsWith(q), (n) => n.includes(q)];
    for (let t = 0; t < tests.length; t++) {
      if (tests[t](c.name)) { tiers[t].push(c); break; }
      const a = aliases.find(tests[t]);
      if (a) { tiers[t].push({ ...c, alias: a }); break; }
    }
  }
  return tiers.flat().slice(0, 8);
}

/** The command a `/name` (or `/alias`) at the start of the input refers to. */
export function commandFor(commands, value) {
  const t = /^\/(\S+)(\s|$)/.exec(value);
  if (!t || !commands) return undefined;
  return commands.find((c) => c.name === t[1] || (Array.isArray(c.aliases) && c.aliases.includes(t[1])));
}

/** A small pop-up picker: a pill button and its menu. */
export function pillMenu(initial, options, onPick, note) {
  const btn = h('button', { type: 'button', class: 'pill-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, `${initial} ▾`);
  const list = h('div', { class: 'pill-menu', role: 'menu', hidden: true });
  const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  if (note) list.append(h('div', { class: 'pill-note' }, note));
  list.append(...options.map(([v, label]) => h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); onPick(v); } }, label)));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = list.hidden;
    for (const m of document.querySelectorAll('.pill-menu')) m.hidden = true;
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  return {
    wrap: h('div', { class: 'pill-wrap' }, btn, list),
    set(text) { btn.textContent = `${text} ▾`; },
    // The reason is visible text, not only a hover title: phones have no hover.
    disable(d, why) { btn.disabled = d; btn.title = why || ''; if (d) close(); if (btn.nextSibling && btn.nextSibling.classList && btn.nextSibling.classList.contains('pill-why')) btn.nextSibling.remove(); if (d && why) btn.after(h('span', { class: 'pill-why muted' }, why)); },
    hide(hidden) { btn.parentElement.hidden = hidden; },
    dispose() { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey); },
  };
}

/**
 * @param {object} o
 * @param {string} o.placeholder
 * @param {string} o.label             accessible name of the text box
 * @param {() => Array} o.commands     current `/` commands ({ name, description, source })
 * @param {object} [o.rank]            source → order when nothing is typed after `/`
 * @param {(text: string) => boolean} o.onSubmit  true when the text was taken
 * @param {() => void} o.onStop
 * @param {Array} [o.pickers]          { id, initial, options: [[value, label]], onPick, note }
 * @param {Node} [o.lead]              left side of the footer
 * @param {string} [o.stopLabel]
 */
/** Grows a textarea with its content, up to `maxRows` lines. */
export function autosizeTextarea(el, maxRows = 8) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, maxRows * 22 + 16)}px`;
}

export function createComposer(o) {
  const input = h('textarea', { class: 'conv-input', rows: '1', placeholder: o.placeholder, 'aria-label': o.label });
  // A draft survives switching away and back (sessionStorage, per box).
  const draft = {
    read() { try { return o.draftKey ? sessionStorage.getItem(o.draftKey) || '' : ''; } catch { return ''; } },
    save(v) { try { if (!o.draftKey) return; if (v) sessionStorage.setItem(o.draftKey, v); else sessionStorage.removeItem(o.draftKey); } catch { /* not remembered */ } },
  };
  const saved = draft.read();
  if (saved) input.value = saved;
  input.addEventListener('input', () => draft.save(input.value));
  const token = h('div', { class: 'conv-token', hidden: true });
  const slash = h('div', { class: 'conv-slash', role: 'listbox', 'aria-label': 'Commands', hidden: true });
  const pickers = new Map((o.pickers || []).map((p) => [p.id, pillMenu(p.initial, p.options, p.onPick, p.note)]));
  const sendBtn = h('button', { type: 'button', class: 'conv-send', 'aria-label': 'Send' }, icon('send', { size: 16 }));
  const el = h('div', { class: 'conv-box' }, slash, token, input,
    h('div', { class: 'conv-foot' }, o.lead || null, h('span', { class: 'sp' }), ...[...pickers.values()].map((p) => p.wrap), sendBtn));

  let busy = false;
  let items = [];
  let sel = 0;

  const autosize = () => autosizeTextarea(input, 8);
  function drawSlash() {
    slash.replaceChildren(...items.map((c, i) => {
      const b = h('button', { type: 'button', role: 'option', 'aria-selected': String(i === sel), class: i === sel ? 'on' : '' },
        h('code', {}, `/${c.name}`, c.alias ? h('span', { class: 'conv-slash-alias' }, ` /${c.alias}`) : null), h('span', {}, c.description));
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => pick(c));
      return b;
    }));
    slash.hidden = items.length === 0;
  }
  function updateToken() {
    const cmd = commandFor(o.commands(), input.value);
    token.hidden = !cmd;
    if (cmd) token.replaceChildren(h('code', {}, `/${cmd.name}`), h('span', {}, cmd.description));
  }
  function updateSlash() {
    items = filterCommands(o.commands(), input.value, o.rank) || [];
    sel = 0;
    drawSlash();
    updateToken();
  }
  function pick(c) {
    input.value = `/${c.alias || c.name} `;
    items = [];
    drawSlash();
    updateToken();
    input.focus();
  }
  let locked = false;
  function submit() {
    if (locked) return;
    const text = cleanInput(input.value);
    if (!text || !o.onSubmit(text)) return;
    draft.save('');
    input.value = '';
    autosize();
    updateSlash();
  }

  sendBtn.addEventListener('click', () => {
    if (busy) o.onStop();
    else submit();
    input.focus();
  });
  input.addEventListener('input', () => { autosize(); updateSlash(); });
  input.addEventListener('keydown', (e) => {
    if (!slash.hidden && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        drawSlash();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pick(items[sel]); return; }
      if (e.key === 'Escape') { e.preventDefault(); items = []; drawSlash(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });

  return {
    el,
    input,
    /** The placeholder the box was created with, for callers that swap it temporarily. */
    placeholder: o.placeholder,
    /** A locked box takes no input and cannot submit; `why` shows in its place. */
    lock(why) { locked = true; input.disabled = true; input.placeholder = why; sendBtn.disabled = true; },
    unlock() { locked = false; input.disabled = false; input.placeholder = o.placeholder; sendBtn.disabled = false; },
    /** Send ↔ Stop. */
    setBusy(b) {
      busy = b;
      sendBtn.replaceChildren(icon(b ? 'stop' : 'send', { size: 16 }));
      sendBtn.setAttribute('aria-label', b ? (o.stopLabel || 'Stop') : 'Send');
      sendBtn.classList.toggle('busy', b);
    },
    picker: (id) => pickers.get(id),
    /** Puts text back in the box (only when it is empty). */
    restore(text) {
      if (input.value || !text) return;
      input.value = text;
      autosize();
    },
    focus() { input.focus(); },
    dispose() { for (const p of pickers.values()) p.dispose(); },
  };
}
