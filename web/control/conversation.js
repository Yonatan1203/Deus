import { parseMarkdown, renderBlocks } from './markdown.js';

// The Claude tab's conversation view: items from the server (see
// src/control-ui/api/claude-conversation.ts) drawn like the Claude app.
// Consecutive tool calls fold into one line; file changes and artifacts stay
// visible. Every string is rendered as text.

const KIND = {
  Bash: 'command', BashOutput: 'command', KillShell: 'command',
  Read: 'read', NotebookRead: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'search', ToolSearch: 'search',
};
const PHRASE = {
  command: ['Ran', 'command', 'commands'],
  read: ['Read', 'file', 'files'],
  edit: ['Edited', 'file', 'files'],
  search: ['Searched', 'time', 'times'],
  other: ['Used', 'tool', 'tools'],
};

/** "Ran 2 commands, read 1 file". Zero parts are dropped. */
export function toolLabel(calls) {
  const n = {};
  for (const c of calls) {
    const k = KIND[c.tool] || 'other';
    n[k] = (n[k] || 0) + 1;
  }
  const parts = Object.keys(PHRASE)
    .filter((k) => n[k])
    .map((k, i) => {
      const [verb, one, many] = PHRASE[k];
      const v = i === 0 ? verb : verb.toLowerCase();
      return `${v} ${n[k]} ${n[k] === 1 ? one : many}`;
    });
  return parts.join(', ');
}

/** Folds runs of tool items into one `tools` item; file changes and artifacts ride along visibly. */
export function groupItems(items) {
  const out = [];
  let run = null;
  for (const it of items) {
    if (it.k !== 'tool') { run = null; out.push(it); continue; }
    if (!run) {
      run = { k: 'tools', label: '', calls: [], files: [], artifacts: [], ts: it.ts }; // the run's day is its first call's
      out.push(run);
    }
    run.calls.push(it);
    if (it.tool === 'Artifact') run.artifacts.push(it);
    else if (it.file && typeof it.added === 'number') {
      const f = run.files.find((x) => x.file === it.file);
      if (f) { f.added += it.added; f.removed += it.removed || 0; }
      else run.files.push({ file: it.file, added: it.added, removed: it.removed || 0 });
    }
  }
  for (const g of out) if (g.k === 'tools') g.label = toolLabel(g.calls);
  return out;
}

const isClaudeArtifact = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && x.hostname === 'claude.ai'; } catch { return false; } };

function toolsItem(g, h, key, expanded, handlers = {}) {
  const open = Boolean(expanded && expanded.has(key));
  const list = h('ul', { class: 'conv-calls', hidden: !open },
    ...g.calls.map((c) => h('li', {}, h('span', { class: 'conv-tool' }, c.tool), c.summary ? ` ${c.summary}` : '')));
  const toggle = h('button', { type: 'button', class: 'conv-fold', 'aria-expanded': String(open) }, g.label, h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    if (expanded) { if (list.hidden) expanded.delete(key); else expanded.add(key); }
  });
  const files = g.files.length
    ? h('div', { class: 'conv-files' }, ...g.files.map((f) => h('span', { class: 'conv-file' },
      h('code', {}, f.file), h('span', { class: 'plus' }, `+${f.added}`), h('span', { class: 'minus' }, `-${f.removed}`))))
    : null;
  const cards = g.artifacts.map((a) => {
    const local = a.url && handlers.localArtifact ? handlers.localArtifact(a.url) : null;
    const title = (local && local.title) || (a.summary ? a.summary.split('/').pop() : 'Page');
    const link = a.url && isClaudeArtifact(a.url)
      ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open on claude.ai in a new tab', onclick: (e) => { if (e) e.stopPropagation(); } }, 'Open on claude.ai ↗')
      : null;
    const card = h('div', { class: `conv-card${local ? ' openable' : ''}` },
      h('span', { class: 'conv-card-icon', 'aria-hidden': 'true' }),
      h('div', { class: 'conv-card-text' },
        h('span', { class: 'conv-card-title', dir: 'auto', title }, title),
        h('span', { class: 'conv-card-sub' }, 'Page', link ? ' · ' : null, link)),
      local ? h('button', { type: 'button', 'aria-label': 'Open beside', title: 'Open beside', class: 'small conv-card-open icon-btn', onclick: (e) => { if (e) e.stopPropagation(); handlers.openArtifact(local); } }, (handlers.icon ? handlers.icon('beside') : 'Open beside')) : null);
    // The whole card opens it too; the button stays the keyboard target.
    if (local && card.addEventListener) card.addEventListener('click', () => handlers.openArtifact(local));
    return card;
  });
  return h('div', { class: 'conv-tools' }, toggle, list, files, ...cards);
}
// `handlers.localArtifact(url)` returns the registry entry when the dashboard
// holds a local copy of that artifact; `handlers.openArtifact(entry)` opens it
// beside the conversation.

/**
 * A question from Claude, as the transcript records it — which is only once
 * it has been answered (Claude Code writes the call and the answer
 * together). The open question is the live card the Claude tab builds from
 * the terminal screen, not this.
 */
function askCard(it, h, handlers) {
  const answered = it.answered;
  return h('div', { class: `conv-ask${answered ? ' answered' : ''}` },
    h('div', {}, h('strong', {}, answered ? 'Claude asked' : 'Claude is asking')),
    ...it.questions.map((q) => h('div', { class: 'ask-q' },
      q.header ? h('span', { class: 'chip' }, q.header) : null,
      h('div', { dir: 'auto' }, q.question),
      h('div', { class: 'conv-opts' }, ...q.options.map((o) => h('span', { class: 'conv-opt', dir: 'auto' }, o))))),
    answered && it.answer ? h('div', { class: 'ask-answer', dir: 'auto' }, 'You answered: ', it.answer) : null,
    !answered && handlers.openTerminal
      ? h('button', { type: 'button', 'aria-label': 'Answer in terminal', title: 'Answer in terminal', class: 'small icon-btn', onclick: () => handlers.openTerminal() }, (handlers.icon ? handlers.icon('terminal') : 'Answer in terminal')) : null);
}

/**
 * The live card for one of Claude Code's other menus (plan approval, "Switch
 * model?", a tool permission — parseMenuScreen in ask-screen.js): the prompt
 * rows as text, one button per option with its hint, Cancel when Esc is
 * offered. `handlers.pick(n)` sends the choice, `handlers.cancel()` Esc,
 * `handlers.openTerminal()` opens the terminal view.
 */
// A hint that names a key chord is the terminal's; on a touch screen it promises nothing.
const KEY_HINT_RE = /\b(shift|ctrl|alt|cmd)\s*\+/i;
export function menuCard(st, h, handlers = {}) {
  // `mono` rows are the command being approved and its description.
  const mono = new Set(Array.isArray(st.mono) ? st.mono : []);
  const prompt = st.prompt.length ? h('div', { class: 'ask-prompt', dir: 'auto' }, ...st.prompt.map((l, k) => h('div', mono.has(k) ? { class: 'ask-prompt-code', dir: 'ltr' } : {}, l))) : null;
  // The first option is Claude Code's default and reads as primary; a "No…"
  // option reads as the decline; the terminal's cursor is a styling cue only
  // (clicking any option is equally valid), never a selection announced to AT.
  const kindOf = (o, i) => (/^no\b/i.test(o.label) ? 'decline' : i === 0 ? 'primary' : 'neutral');
  // A QR code is drawn in the terminal and leads to a screen this card does
  // not read, so that row is shown but only the terminal can take it.
  const terminalOnly = (o) => /QR code/i.test(o.label);
  const opts = st.options.map((o, i) => h('button', {
    type: 'button', class: `conv-opt menu-opt menu-${kindOf(o, i)}`, 'data-n': String(o.n), 'data-cursor': o.n === st.selected ? 'true' : null, dir: 'auto',
    disabled: terminalOnly(o),
    onclick: () => handlers.pick && handlers.pick(o.n),
  }, h('span', { class: 'menu-label' }, o.label),
  terminalOnly(o) ? h('span', { class: 'muted menu-hint' }, 'Only in the terminal')
    : o.hint && !KEY_HINT_RE.test(o.hint) ? h('span', { class: 'muted menu-hint' }, o.hint) : null));
  // Esc is a second way to decline; when a "No…" option is on the card it
  // would only duplicate it, so Cancel shows on menus without one.
  const hasDecline = st.options.some((o, i) => kindOf(o, i) === 'decline');
  const cancel = st.esc && !hasDecline && handlers.cancel ? h('button', { type: 'button', class: 'small ghost ask-cancel', onclick: () => handlers.cancel() }, 'Cancel') : null;
  const term = handlers.openTerminal ? h('button', { type: 'button', 'aria-label': 'Answer in terminal', title: 'Answer in terminal', class: 'small ask-term icon-btn', onclick: () => handlers.openTerminal() }, (handlers.icon ? handlers.icon('terminal') : 'Answer in terminal')) : null;
  return h('div', { class: 'ask-menu' },
    h('div', {}, h('strong', {}, 'Claude is asking')),
    prompt,
    h('div', { class: 'conv-opts menu-opts' }, ...opts),
    h('div', { class: 'ask-foot' }, cancel, term));
}

/**
 * A command the operator ran with `!` in the terminal: the command, then what
 * it printed — folded to a few lines, errors in the error colour.
 */
const SHELL_LINES = 6;
function shellCard(it, h) {
  const block = (text, cls) => {
    const lines = text.split('\n');
    const pre = h('pre', { class: `shell-out${cls ? ` ${cls}` : ''}` }, lines.length > SHELL_LINES ? lines.slice(0, SHELL_LINES).join('\n') : text);
    if (lines.length <= SHELL_LINES) return [pre];
    const more = h('button', { type: 'button', class: 'shell-more' }, `Show all (${lines.length} lines)`);
    more.addEventListener('click', () => {
      const open = more.dataset.open === '1';
      pre.textContent = open ? lines.slice(0, SHELL_LINES).join('\n') : text;
      more.dataset.open = open ? '' : '1';
      more.textContent = open ? `Show all (${lines.length} lines)` : 'Show less';
    });
    return [pre, more];
  };
  return h('div', { class: 'conv-shell' },
    h('div', { class: 'shell-cmd' }, h('span', { class: 'shell-prompt', 'aria-hidden': 'true' }, '$'), h('code', {}, it.command)),
    ...(it.output ? block(it.output) : []),
    ...(it.error ? block(it.error, 'err') : []),
    !it.output && !it.error ? h('span', { class: 'shell-none' }, 'no output') : null);
}

/**
 * When the session is blocked but the screen matches no card the view knows
 * (ask-fallback.js decides when): said, not hidden, with the way to answer.
 */
export function fallbackNotice(h, handlers = {}) {
  return h('div', { class: 'conv-banner conv-fallback' },
    h('span', {}, h('span', { class: 'fallback-glyph', 'aria-hidden': 'true' }, '?'), "Claude is asking something this view can't show yet."),
    handlers.openTerminal ? h('button', { type: 'button', 'aria-label': 'Open terminal', title: 'Open terminal', class: 'small icon-btn', onclick: () => handlers.openTerminal() }, (handlers.icon ? handlers.icon('terminal') : 'Open terminal')) : null);
}

// ---- day separators: only when the conversation spans more than one day.
const dayOf = (ts) => (typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : null);
/** "Today", "Yesterday" or the date, for a day key (YYYY-MM-DD) against `now`. */
export function dayLabel(day, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
/** Map of item index → label to show above it; empty when all items share a day. */
export function daySeparators(items, now = Date.now()) {
  const out = new Map();
  const days = new Set(items.map((it) => dayOf(it.ts)).filter(Boolean));
  if (days.size < 2) return out;
  let last = null;
  items.forEach((it, i) => {
    const d = dayOf(it.ts);
    if (d && d !== last) { out.set(i, dayLabel(d, now)); last = d; }
  });
  return out;
}
// A text cut at the server's bound says so; the rest is in the terminal.
const clippedNote = (h, handlers) => h('div', { class: 'conv-clipped' },
  h('span', {}, 'Clipped — the rest is in the Terminal view.'),
  handlers.openTerminal ? h('button', { type: 'button', class: 'small linkish', onclick: () => handlers.openTerminal() }, 'Open terminal') : null);

/**
 * Draws items into `el`. `handlers.openTerminal()` is called by the
 * "Answer in terminal" button on an open question; `handlers.expanded`, a
 * Set, keeps opened folds open across redraws.
 */
// What the renderer reads of an item, so an unchanged prefix can be kept.
const itemKey = (it) => {
  switch (it.k) {
    case 'user': return `user:${it.queued ? 'q' : ''}${it.clipped ? 'c' : ''}:${it.text}`;
    case 'assistant': return `assistant:${it.clipped ? 'c' : ''}:${it.text}`;
    case 'tools': return `tools:${it.label}:${it.calls.length}:${it.files.map((f) => `${f.file}${f.added}${f.removed}`).join(',')}:${it.artifacts.map((a) => a.url || a.summary).join(',')}`;
    case 'command': return `command:${it.name}:${it.args || ''}:${it.output || ''}:${it.link || ''}`;
    case 'shell': return `shell:${it.command}:${it.output || ''}:${it.error || ''}`;
    case 'ask': return `ask:${it.id}:${it.answered ? 'a' : ''}:${JSON.stringify(it.answer || null)}`;
    default: return `${it.k}:${it.text || ''}`;
  }
};
export function renderConversation(el, items, h, handlers = {}) {
  const grouped = groupItems(items);
  const days = daySeparators(grouped, handlers.now);
  const nodes = grouped.map((it, i) => {
    const day = days.get(i);
    const sep = day ? h('div', { class: 'conv-day', role: 'separator' }, h('span', {}, day)) : null;
    const node = (() => {
    switch (it.k) {
      // Sent while Claude was working: shown at once, marked until it lands.
      case 'user': return h('div', { class: `conv-user${it.queued ? ' queued' : ''}`, dir: 'auto' }, it.text,
        it.queued ? h('span', { class: 'conv-queued' }, 'Queued') : null,
        it.clipped ? clippedNote(h, handlers) : null);
      case 'assistant': return h('div', { class: 'conv-assistant', dir: 'auto' }, ...renderBlocks(parseMarkdown(it.text), h, handlers),
        it.clipped ? clippedNote(h, handlers) : null);
      case 'tools': return toolsItem(it, h, i, handlers.expanded, handlers);
      case 'shell': return shellCard(it, h);
      case 'command': return h('div', { class: 'conv-command' },
        h('code', {}, [it.name, it.args].filter(Boolean).join(' ')),
        // `/remote-control`: the server only sets `link` to a claude.ai session URL.
        it.link
          ? [h('span', { class: 'muted' }, 'Remote Control is on'),
            h('a', { href: it.link, target: '_blank', rel: 'noopener noreferrer', class: 'conv-command-link' }, 'Open on claude.ai ↗')]
          : it.output ? h('span', { class: 'muted' }, it.output) : null);
      case 'note': return h('div', { class: 'conv-note' }, it.text);
      case 'ask': return askCard(it, h, handlers);
      default: return null;
    }
    })();
    if (!node) return [];
    const key = itemKey(it);
    return sep ? [{ key: `day:${day}`, node: sep }, { key, node }] : [{ key, node }];
  }).flat();
  // Append only when the list merely grew (the common case: a new message) and
  // the day has not turned — a changed earlier item (a queued bubble landing),
  // a shrunk list or a new day redraw everything, so the `role="log"` region is
  // not re-announced on every poll.
  const state = handlers.state;
  const dayKey = new Date(handlers.now ?? Date.now()).toISOString().slice(0, 10);
  const keys = nodes.map((n) => n.key);
  if (state && state.keys && state.day === dayKey && keys.length >= state.keys.length && state.keys.every((k, i) => k === keys[i])) {
    if (keys.length > state.keys.length) el.append(...nodes.slice(state.keys.length).map((n) => n.node));
  } else {
    el.replaceChildren(...nodes.map((n) => n.node));
  }
  if (state) { state.keys = keys; state.day = dayKey; }
}
