import { h } from './dom.js';
import { icon } from './icons.js';
import { serverError } from './ui.js';

// The artifact pane: a page a session published, shown beside the
// conversation. What is framed is always the dashboard's own local copy
// (`/api/v1/artifacts/<id>/page`), never claude.ai (which refuses framing) and
// never the source file. The frame is sandboxed without allow-same-origin, so
// the page runs as its own opaque origin: it cannot read this dashboard's
// cookies, storage or DOM. The src carries a single-use ticket because an
// iframe cannot send the session header. A 2 s version poll runs the server's
// refresh step; when the copy changes, the frame reloads on a new ticket.
const ID_RE = /^art-[0-9a-f]{12}$/;
const POLL_MS = 2000;

export function createArtifactPane(api) {
  let current = null;   // { id, title, kind, url }
  let version = '';
  let timer = null;
  let expectLoad = false;
  let disposed = false;
  const title = h('span', { class: 'ap-title', dir: 'auto' });
  // "Published by <session>" when the registry knows which session's
  // transcript proved the publish (a captured entry); else the generic line.
  const what = h('div', { class: 'ap-what muted' }, 'Page written by a Claude session');
  const kind = h('span', { class: 'chip' });
  const link = h('a', { target: '_blank', rel: 'noopener noreferrer', class: 'small linkish', hidden: true }, icon('external', { size: 14 }), 'Open on claude.ai');
  const closeBtn = h('button', { type: 'button', class: 'small ghost', 'aria-label': 'Close the artifact pane' }, icon('x', { size: 14 }), 'Close');
  // Expand: the pane takes the conversation's column too; the layout decides how (opts.onExpand).
  const expandBtn = h('button', { type: 'button', class: 'small ghost ap-expand', 'aria-pressed': 'false' }, 'Expand');
  // A short-lived line when the session published a newer version and the pane followed it.
  const updated = h('div', { class: 'ap-updated', role: 'status', hidden: true });
  let updatedTimer = null;
  const frame = h('iframe', { class: 'ap-frame', sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', title: 'Artifact' });
  const note = h('div', { class: 'ap-note', role: 'status', hidden: true });
  const el = h('aside', { class: 'artifact-pane', 'aria-label': 'Artifact', hidden: true, tabindex: '-1' },
    h('div', { class: 'ap-head' },
      what,
      h('div', { class: 'ap-row' }, title, kind),
      updated,
      h('div', { class: 'ap-actions' }, link, expandBtn, closeBtn)),
    frame, note);
  let onClose = () => {};
  let onExpand = () => {};
  let expanded = false;
  function setExpanded(v) {
    expanded = v;
    expandBtn.textContent = v ? 'Restore' : 'Expand';
    expandBtn.setAttribute('aria-pressed', String(v));
    onExpand(v);
  }
  expandBtn.addEventListener('click', () => setExpanded(!expanded));
  const closeAndTell = () => { close(); onClose(); };
  closeBtn.addEventListener('click', closeAndTell);
  // Esc closes the pane, as the agent panel's does — unless the key is typed
  // into the terminal or a text box, where Esc means something else.
  const onKey = (e) => {
    if (e.key !== 'Escape' || el.hidden) return;
    const t = e.target;
    if (t && (t.closest('.term-host') || /^(TEXTAREA|INPUT|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    e.preventDefault();
    closeAndTell();
  };
  document.addEventListener('keydown', onKey);

  const ticket = async () => (await api.post('/api/v1/events/ticket')).ticket;
  // True once the frame has a fresh src; false when no ticket could be had —
  // then the note offers a retry and the version is left behind, so the next
  // poll tries again on its own as well.
  async function load() {
    if (!current || disposed) return false;
    let t;
    try { t = await ticket(); } catch (err) {
      setNote(h('span', {}, serverError(err, "Couldn't open the page. ")), h('button', { type: 'button', class: 'small', onclick: () => poll() }, 'Try again'));
      return false;
    }
    if (!current || disposed) return false;
    expectLoad = true;
    note.hidden = true;
    frame.src = `/api/v1/artifacts/${encodeURIComponent(current.id)}/page?ticket=${encodeURIComponent(t)}`;
    return true;
  }
  frame.addEventListener('load', () => {
    frame.dataset.loaded = 'true';
    if (expectLoad) { expectLoad = false; return; }
    if (!current) return;
    // Not our reload: the page navigated itself (a link inside it).
    setNote(h('span', {}, 'This page navigated away. '), h('button', { type: 'button', class: 'small', onclick: () => load() }, 'Reload'));
  });
  function setNote(...nodes) { note.replaceChildren(...nodes); note.hidden = false; }
  async function poll() {
    if (!current || disposed) return;
    const id = current.id;
    try {
      const r = await api.get(`/api/v1/artifacts/${encodeURIComponent(id)}/version`);
      if (!current || current.id !== id || disposed) return;
      if (r.version !== version) {
        const ok = await load();
        if (!current || current.id !== id || disposed) return; // another page opened meanwhile
        if (ok) version = r.version;
      }
      if (r.following) { if (note.dataset.copy) { note.hidden = true; delete note.dataset.copy; } }
      else if (!note.dataset.copy) {
        note.dataset.copy = 'true';
        setNote(h('span', {}, 'Showing the saved copy. The file it came from is gone or changed hands, so new edits won\'t show here. '),
          current.url ? h('a', { href: current.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on claude.ai') : null);
      }
    } catch (err) {
      if (err.status === 404 && err.error === 'no-copy') setNote(h('span', {}, 'The copy is gone. '), link.hidden ? null : h('a', { href: current.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open on claude.ai'));
    }
  }
  function open(artifact, opts = {}) {
    if (!artifact || !ID_RE.test(artifact.id)) return;
    onClose = opts.onClose || (() => {});
    onExpand = opts.onExpand || (() => {});
    current = { id: artifact.id, title: artifact.title, kind: artifact.kind, url: typeof artifact.url === 'string' ? artifact.url : null,
      session: artifact.session && artifact.session.id ? { id: artifact.session.id } : null };
    clearTimeout(updatedTimer);
    updated.hidden = !opts.updated;
    if (opts.updated) { updated.textContent = opts.updated; updatedTimer = setTimeout(() => { updated.hidden = true; }, 8000); }
    title.textContent = artifact.title;
    title.title = artifact.title; // the full title when the row clips it
    kind.textContent = artifact.kind;
    frame.title = artifact.title;
    if (artifact.session && artifact.session.id && artifact.session.name) {
      what.replaceChildren('Published by ', h('a', { href: `#/claude/${artifact.session.id}`, class: 'ap-by', dir: 'auto' }, artifact.session.name));
    } else what.replaceChildren('Page written by a Claude session');
    if (current.url) { link.href = current.url; link.hidden = false; } else { link.hidden = true; link.removeAttribute('href'); }
    note.hidden = true; delete note.dataset.copy;
    version = '';
    el.hidden = false;
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    poll();
    // After the tab's own render-time focus (the view root), so the pane keeps it.
    setTimeout(() => { if (current && !el.hidden) el.focus({ preventScroll: true }); }, 0);
  }
  function close() {
    clearInterval(timer); timer = null;
    clearTimeout(updatedTimer); updated.hidden = true;
    if (expanded) setExpanded(false);
    current = null;
    expectLoad = true;
    delete frame.dataset.loaded;
    frame.src = 'about:blank';
    el.hidden = true;
  }
  function dispose() { close(); disposed = true; document.removeEventListener('keydown', onKey); }
  return { el, open, close, dispose,
    get id() { return current ? current.id : null; },
    /** The open entry's title and session, for following a newer publish; null when closed. */
    get entry() { return current ? { id: current.id, title: current.title, session: current.session } : null; } };
}
