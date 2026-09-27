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
      run = { k: 'tools', label: '', calls: [], files: [], artifacts: [] };
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
    return h('div', { class: 'conv-card' },
      h('span', { class: 'conv-card-title' }, a.summary ? a.summary.split('/').pop() : 'Artifact'),
      a.url && isClaudeArtifact(a.url)
        ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'Artifact · Open')
        : h('span', { class: 'muted' }, 'Artifact'),
      local ? h('button', { type: 'button', class: 'small', onclick: () => handlers.openArtifact(local) }, 'Open beside') : null);
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
      ? h('button', { type: 'button', class: 'small', onclick: () => handlers.openTerminal() }, 'Answer in terminal') : null);
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
  const prompt = st.prompt.length ? h('div', { class: 'ask-prompt', dir: 'auto' }, ...st.prompt.map((l) => h('div', {}, l))) : null;
  // The first option is Claude Code's default and reads as primary; a "No…"
  // option reads as the decline; the terminal's cursor is a styling cue only
  // (clicking any option is equally valid), never a selection announced to AT.
  const kindOf = (o, i) => (/^no\b/i.test(o.label) ? 'decline' : i === 0 ? 'primary' : 'neutral');
  const opts = st.options.map((o, i) => h('button', {
    type: 'button', class: `conv-opt menu-opt menu-${kindOf(o, i)}`, 'data-n': String(o.n), 'data-cursor': o.n === st.selected ? 'true' : null, dir: 'auto',
    onclick: () => handlers.pick && handlers.pick(o.n),
  }, h('span', { class: 'menu-label' }, o.label), o.hint && !KEY_HINT_RE.test(o.hint) ? h('span', { class: 'muted menu-hint' }, o.hint) : null));
  // Esc is a second way to decline; when a "No…" option is on the card it
  // would only duplicate it, so Cancel shows on menus without one.
  const hasDecline = st.options.some((o, i) => kindOf(o, i) === 'decline');
  const cancel = st.esc && !hasDecline && handlers.cancel ? h('button', { type: 'button', class: 'small ghost ask-cancel', onclick: () => handlers.cancel() }, 'Cancel') : null;
  const term = handlers.openTerminal ? h('button', { type: 'button', class: 'small ask-term', onclick: () => handlers.openTerminal() }, 'Answer in terminal') : null;
  return h('div', { class: 'ask-menu' },
    h('div', {}, h('strong', {}, 'Claude is asking')),
    prompt,
    h('div', { class: 'conv-opts menu-opts' }, ...opts),
    h('div', { class: 'ask-foot' }, cancel, term));
}

/**
 * When the session is blocked but the screen matches no card the view knows
 * (ask-fallback.js decides when): said, not hidden, with the way to answer.
 */
export function fallbackNotice(h, handlers = {}) {
  return h('div', { class: 'conv-banner conv-fallback' },
    h('span', {}, h('span', { class: 'fallback-glyph', 'aria-hidden': 'true' }, '?'), "Claude is asking something this view can't show yet."),
    handlers.openTerminal ? h('button', { type: 'button', class: 'small', onclick: () => handlers.openTerminal() }, 'Open terminal') : null);
}

/**
 * Draws items into `el`. `handlers.openTerminal()` is called by the
 * "Answer in terminal" button on an open question; `handlers.expanded`, a
 * Set, keeps opened folds open across redraws.
 */
export function renderConversation(el, items, h, handlers = {}) {
  const nodes = groupItems(items).map((it, i) => {
    switch (it.k) {
      // Sent while Claude was working: shown at once, marked until it lands.
      case 'user': return h('div', { class: `conv-user${it.queued ? ' queued' : ''}`, dir: 'auto' }, it.text,
        it.queued ? h('span', { class: 'conv-queued' }, 'Queued') : null);
      case 'assistant': return h('div', { class: 'conv-assistant', dir: 'auto' }, ...renderBlocks(parseMarkdown(it.text), h));
      case 'tools': return toolsItem(it, h, i, handlers.expanded, handlers);
      case 'command': return h('div', { class: 'conv-command' },
        h('code', {}, [it.name, it.args].filter(Boolean).join(' ')),
        it.output ? h('span', { class: 'muted' }, it.output) : null);
      case 'note': return h('div', { class: 'conv-note' }, it.text);
      case 'ask': return askCard(it, h, handlers);
      default: return null;
    }
  });
  el.replaceChildren(...nodes.filter(Boolean));
}
