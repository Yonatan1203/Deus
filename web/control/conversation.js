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

function toolsItem(g, h, key, expanded) {
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
  const cards = g.artifacts.map((a) => h('div', { class: 'conv-card' },
    h('span', { class: 'conv-card-title' }, a.summary ? a.summary.split('/').pop() : 'Artifact'),
    a.url && isClaudeArtifact(a.url)
      ? h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'Artifact · Open')
      : h('span', { class: 'muted' }, 'Artifact')));
  return h('div', { class: 'conv-tools' }, toggle, list, files, ...cards);
}

/**
 * Draws items into `el`. `handlers.openTerminal()` is called by the
 * "Answer in terminal" button on an open question; `handlers.expanded`, a
 * Set, keeps opened folds open across redraws.
 */
export function renderConversation(el, items, h, handlers = {}) {
  const nodes = groupItems(items).map((it, i) => {
    switch (it.k) {
      case 'user': return h('div', { class: 'conv-user' }, it.text);
      case 'assistant': return h('div', { class: 'conv-assistant' }, ...renderBlocks(parseMarkdown(it.text), h));
      case 'tools': return toolsItem(it, h, i, handlers.expanded);
      case 'command': return h('div', { class: 'conv-command' },
        h('code', {}, [it.name, it.args].filter(Boolean).join(' ')),
        it.output ? h('span', { class: 'muted' }, it.output) : null);
      case 'note': return h('div', { class: 'conv-note' }, it.text);
      case 'ask': return h('div', { class: `conv-ask${it.answered ? ' answered' : ''}` },
        h('div', {}, h('strong', {}, it.answered ? 'Claude asked: ' : 'Claude is asking: '), it.question),
        h('div', { class: 'conv-opts' }, ...it.options.map((o) => h('span', { class: 'conv-opt' }, o)),
          it.answered || !handlers.openTerminal ? null
            : h('button', { type: 'button', class: 'small', onclick: () => handlers.openTerminal() }, 'Answer in terminal')));
      default: return null;
    }
  });
  el.replaceChildren(...nodes.filter(Boolean));
}
