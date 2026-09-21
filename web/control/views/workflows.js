import { h, clear, badge } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';

// Every string here was written by a session through scripts/workflow.mjs and
// cleaned by the server: text nodes only. URLs arrive already cleared by the
// server's allow-list, or withheld (`*_blocked`) — this view never builds a
// link from anything else.
const STATUS = { running: ['running', 'ok'], waiting: ['waiting for you', 'warn'], done: ['done', ''], failed: ['failed', 'bad'] };
const KIND = { posts: 'Posts', product_images: 'Product images', site_images: 'Site images', other: 'Other' };
const BLOCKED = { userinfo: 'link withheld · credentials in URL', host: 'link withheld · host not allowed', protocol: 'link withheld · scheme not allowed', 'secret-query': 'link withheld · secret in query' };
const REASON = { unreadable: 'file unreadable', 'too-large': 'file too large', 'not-json': 'not JSON', 'bad-id': 'id mismatch', 'bad-kind': 'unknown kind', 'bad-percent': 'bad percent', 'bad-url': 'bad URL', 'bad-schema': 'bad schema' };
const SESSION = { working: ['session working', 'ok'], blocked: ['session waiting for you', 'warn'], done: ['session done', ''], unknown: ['session unknown', ''] };

const elapsed = (from, to) => {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const grid = h('div', { class: 'wf-grid' });
  const notice = h('p', { class: 'muted wf-notice', hidden: true });
  const filter = h('select', { 'aria-label': 'Filter by status' },
    h('option', { value: '' }, 'All statuses'),
    ...Object.keys(STATUS).map((k) => h('option', { value: k }, STATUS[k][0])),
    h('option', { value: 'invalid' }, 'invalid'));
  filter.addEventListener('change', draw);
  let data = { workflows: [], scanned: 0, candidates: 0, truncated: 0 };
  let sessions = null; // id → state, fetched only when a record reports one
  let refreshTimer = null;

  function link(label, url, blocked) {
    if (url) {
      return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'wf-link' },
        icon('external', { size: 14 }), h('span', {}, label), h('span', { class: 'muted' }, ` · ${hostOf(url)}`));
    }
    return h('span', { class: 'wf-link withheld muted' }, `${label} · ${BLOCKED[blocked] || 'link withheld'}`);
  }

  function archiveOne(w) {
    return h('button', { type: 'button', class: 'small ghost', onclick: async () => {
      const ok = await confirmTyped('archive', `Archive "${w.name}"? It moves out of this list into the registry's archive folder.`);
      if (!ok) return;
      try {
        const r = await api.post('/api/v1/workflows/archive', { id: w.id }, { 'X-Confirm': 'archive' });
        toast(r.stale ? 'Archived (stale run)' : 'Archived', 'ok');
        await load();
      } catch (err) { toast(err.status === 409 ? 'Still active — a run older than a day can be archived' : err.message, 'error'); }
    } }, 'Archive');
  }

  function card(w) {
    if (w.invalid) {
      return h('div', { class: 'card wf-card invalid', 'data-id': w.id },
        h('div', { class: 'title' }, h('span', { class: 'mono' }, w.id), badge('invalid record', 'bad')),
        h('p', {}, `Not shown: ${REASON[w.reason] || w.reason}.`),
        readOnly ? null : h('div', { class: 'editor-actions' }, archiveOne({ id: w.id, name: w.id })));
    }
    const [label, kind] = STATUS[w.status] || ['unknown', ''];
    const terminal = w.status === 'done' || w.status === 'failed';
    const stepText = [w.steps_total ? `step ${Math.max(1, Math.min(w.steps_total, Math.ceil((w.percent / 100) * w.steps_total)))}/${w.steps_total}` : null, w.step].filter(Boolean).join(' · ');
    const sess = w.session_id && sessions && sessions.get(w.session_id);
    const links = [];
    if (w.preview_url !== undefined) links.push(link('Preview', w.preview_url, w.preview_blocked));
    for (const o of w.outputs || []) links.push(link(o.label, o.url, o.blocked));
    // The browser-side counterpart of the ask-to-register rule: only for a
    // preview the server cleared (a string), never for a withheld one.
    const addToArtifacts = !readOnly && w.status === 'done' && typeof w.preview_url === 'string'
      ? h('button', { type: 'button', class: 'small ghost', onclick: async () => {
        try {
          await api.post('/api/v1/artifacts', { title: w.name, url: w.preview_url, kind: 'preview' });
          toast('Added to Artifacts', 'ok');
        } catch (err) { toast(err.status === 429 ? 'Too many changes — wait a minute' : err.message, 'error'); }
      } }, icon('plus', { size: 14 }), 'Add to artifacts')
      : null;
    return h('div', { class: `card wf-card ${w.status}`, 'data-id': w.id },
      h('div', { class: 'title' }, h('span', {}, w.name), badge(label, kind)),
      h('div', { class: 'chips' },
        h('span', { class: 'chip' }, KIND[w.kind] || w.kind),
        h('span', { class: 'chip' }, terminal ? `took ${elapsed(w.started_at, w.finished_at)}` : `running ${elapsed(w.started_at)}`),
        sess ? badge(...(SESSION[sess] || SESSION.unknown)) : null),
      h('div', { class: 'wf-progress' },
        h('progress', { class: `bar${w.status === 'failed' ? ' bad' : ''}`, max: '100', value: String(w.percent), 'aria-label': 'Progress' }),
        h('span', { class: 'mono' }, `${w.percent}%`)),
      stepText ? h('p', { class: 'wf-step' }, stepText) : null,
      w.message ? h('p', { class: 'wf-message' }, w.message) : null,
      links.length ? h('div', { class: 'wf-links' }, ...links) : null,
      h('div', { class: 'wf-foot muted' },
        h('span', {}, terminal ? `finished ${fmtTime(w.finished_at)}` : `updated ${fmtTime(w.updated_at)}`),
        h('span', { class: 'wf-foot-actions' }, addToArtifacts, !readOnly && terminal ? archiveOne(w) : null)));
  }

  function draw() {
    clear(grid);
    const want = filter.value;
    const rows = data.workflows.filter((w) => !want || (want === 'invalid' ? w.invalid : w.status === want));
    if (rows.length === 0) {
      grid.append(h('div', { class: 'empty' }, data.workflows.length ? 'Nothing matches this filter.' : 'No workflows reported yet. Sessions report long-running orders with scripts/workflow.mjs.'));
    } else grid.append(...rows.map(card));
    notice.hidden = !(data.truncated && data.truncated !== 0);
    notice.textContent = data.truncated === -1
      ? `Registry too large to list (${data.scanned} records). Archive finished work to recover.`
      : `Showing the ${data.workflows.length} most relevant of ${data.scanned} records; the filter applies to those only. Archive finished work to see more.`;
  }

  async function joinSessions() {
    if (readOnly || !data.workflows.some((w) => w.session_id)) return;
    try {
      const r = await api.get('/api/v1/claude/sessions');
      sessions = new Map((r.sessions || []).map((s) => [s.id, s.state]));
    } catch { sessions = null; }
  }
  async function load() {
    try {
      data = await api.get('/api/v1/workflows');
      await joinSessions();
      draw();
    } catch (err) {
      clear(grid);
      grid.append(h('div', { class: 'empty' }, err.status === 503 ? 'Workflow registry unavailable on the server.' : err.status === 429 ? 'Too many refreshes — wait a minute.' : err.message));
    }
  }

  const archiveAll = readOnly ? null : h('button', { type: 'button', class: 'small', onclick: async () => {
    const ok = await confirmTyped('archive', 'Archive every finished workflow older than 30 days?', ['Records move into the registry archive folder; nothing is deleted']);
    if (!ok) return;
    try {
      const r = await api.post('/api/v1/workflows/archive', {}, { 'X-Confirm': 'archive' });
      toast(`Archived ${r.archived}${r.skipped ? `, skipped ${r.skipped} already archived` : ''}`, 'ok');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  } }, icon('archive', { size: 14 }), 'Archive finished');

  clear(root);
  root.append(header('Workflows', { eyebrow: 'Operate', actions: [filter, archiveAll].filter(Boolean) }), notice, grid);
  await load();
  bus.addEventListener('workflow', (e) => { if (e.detail && e.detail.workflows) { data = e.detail; joinSessions().then(draw); } });
  bus.addEventListener('csession', (e) => { if (e.detail && e.detail.sessions && sessions) { sessions = new Map(e.detail.sessions.map((s) => [s.id, s.state])); draw(); } });
  bus.addEventListener('refresh', load);
  refreshTimer = setInterval(() => { if (!document.hidden) draw(); }, 60_000); // elapsed times tick
  bus.addEventListener('view-unmount', () => clearInterval(refreshTimer), { once: true });
}
