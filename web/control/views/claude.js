import { h, clear, badge } from '../dom.js';
import { icon } from '../icons.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';

// Every string here comes from the Claude Code CLI or a transcript: text
// nodes only, no markdown, no auto-linking.
const STATE = { working: ['working', 'ok'], blocked: ['waiting for you', 'warn'], done: ['done', ''], unknown: ['unknown', ''] };
const age = (ms) => {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const list = h('div', { class: 'list claude-list' });
  const panel = h('div', { class: 'claude-panel', hidden: true });
  let sessions = [];
  let open = null;
  let refreshTimer = null;

  const form = h('div', { class: 'card new-session', hidden: true });
  const nameInput = h('input', { type: 'text', placeholder: 'Session name', 'aria-label': 'Session name', maxlength: '60' });
  const promptInput = h('textarea', { rows: '3', placeholder: 'What should it do?', 'aria-label': 'First prompt' });
  const startBtn = h('button', { type: 'button', class: 'primary', onclick: async () => {
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name || !prompt) { toast('Name and prompt are required', 'error'); return; }
    const ok = await confirmTyped('start', `Start "${name}" as a background Claude Code session in the repo?`, ['Runs with bypassPermissions — exactly like a terminal session', 'It can read and change anything the repo can']);
    if (!ok) return;
    startBtn.disabled = true;
    try {
      const r = await api.post('/api/v1/claude/sessions', { name, prompt }, { 'X-Confirm': 'start' });
      toast(`Started ${r.id}`, 'ok');
      nameInput.value = ''; promptInput.value = ''; form.hidden = true;
      await load(true);
    } catch (err) { toast(err.status === 429 ? 'Too many starts — wait a few minutes' : err.message, 'error'); }
    finally { startBtn.disabled = false; }
  } }, 'Start session');
  form.append(
    h('div', { class: 'form-grid' }, h('label', {}, 'Name', nameInput), h('label', { class: 'wide' }, 'Prompt', promptInput)),
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => { form.hidden = true; } }, 'Cancel'), startBtn));
  const newSession = readOnly ? null : h('button', { type: 'button', class: 'small primary', onclick: () => { form.hidden = !form.hidden; if (!form.hidden) nameInput.focus(); } }, icon('plus', { size: 14 }), 'New session');

  function row(s) {
    const [label, kind] = STATE[s.state] || STATE.unknown;
    const el = h('button', { type: 'button', class: `row claude-row${open === s.id ? ' open' : ''}`, 'data-id': s.id, onclick: () => show(s) },
      h('div', {},
        h('div', { class: 'name' }, s.name, s.started_here ? h('span', { class: 'chip' }, 'started here') : null),
        h('div', { class: 'meta' },
          h('span', {}, [s.kind, s.cwd_rel === '.' ? null : s.cwd_rel, age(s.started_at)].filter(Boolean).join(' · ')),
          s.waiting_on ? h('div', { class: 'waiting' }, s.waiting_on) : null)),
      badge(label, kind));
    return el;
  }
  function draw() {
    clear(list);
    if (sessions.length === 0) { list.append(h('div', { class: 'empty' }, 'No Claude Code sessions under this repo.')); return; }
    list.append(...sessions.map(row));
  }
  async function load(fresh) {
    try {
      const r = await api.get('/api/v1/claude/sessions');
      if (r.unavailable) { clear(list); list.append(h('div', { class: 'empty' }, `Session list unavailable: ${r.error || 'claude CLI not found'}`)); return; }
      sessions = r.sessions;
      draw();
      if (fresh && open && !sessions.some((s) => s.id === open)) { panel.hidden = true; open = null; }
    } catch (err) { clear(list); list.append(h('div', { class: 'empty' }, err.status === 429 ? 'Too many refreshes — wait a minute.' : err.message)); }
  }

  async function show(s) {
    open = s.id;
    draw();
    clear(panel);
    panel.hidden = false;
    const transcript = h('div', { class: 'transcript claude-transcript' });
    const head = h('div', { class: 'editor-head' }, h('h2', {}, s.name), h('span', { class: 'muted mono' }, s.id));
    const actions = h('div', { class: 'actions-col' });
    if (!readOnly && s.kind === 'background') {
      actions.append(h('button', { type: 'button', class: 'small danger', onclick: async () => {
        const ok = await confirmTyped(s.id, `Stop ${s.name}? Its conversation is kept; resume it later from the terminal or by messaging it here.`);
        if (!ok) return;
        try { await api.post(`/api/v1/claude/sessions/${s.id}/stop`, undefined, { 'X-Confirm': s.id }); toast('Stop requested', 'ok'); await load(true); }
        catch (err) { toast(err.message, 'error'); }
      } }, icon('stop', { size: 14 }), 'Stop'));
    }
    const logsBtn = readOnly ? null : h('button', { type: 'button', class: 'small ghost', onclick: async () => {
      try {
        const r = await api.get(`/api/v1/claude/sessions/${s.id}/logs`);
        clear(transcript);
        transcript.append(h('pre', { class: 'console' }, r.lines.join('\n')));
      } catch (err) { toast(err.message, 'error'); }
    } }, 'Recent output');
    if (logsBtn) actions.append(logsBtn);
    panel.append(head, actions);
    if (s.kind !== 'background') panel.append(h('p', { class: 'muted' }, 'Interactive session — open it in your terminal.'));
    if (readOnly) { panel.append(h('p', { class: 'muted' }, 'Read-only mode: transcripts are withheld.')); return; }
    panel.append(transcript);
    try {
      const t = await api.get(`/api/v1/claude/sessions/${s.id}/transcript?limit=200`);
      clear(transcript);
      if (t.truncated) transcript.append(h('div', { class: 'muted' }, 'Older messages not shown.'));
      for (const r of t.rows) {
        if (r.role === 'tool') transcript.append(h('div', { class: 'msg tool-row' }, h('span', { class: 'eyebrow' }, `tool · ${r.tool}`), r.summary ? h('div', { class: 'body muted' }, r.summary) : null));
        else transcript.append(h('div', { class: `msg ${r.role}` }, h('div', { class: 'eyebrow' }, r.role === 'user' ? 'You' : 'Claude'), h('div', { class: 'body' }, r.text)));
      }
      transcript.scrollTop = transcript.scrollHeight;
    } catch (err) { clear(transcript); transcript.append(h('div', { class: 'empty' }, err.status === 404 ? 'No transcript yet.' : err.message)); }
    if (s.resumable) {
      const input = h('textarea', { class: 'composer-input', rows: '2', placeholder: 'Message this session…' });
      const send = h('button', { type: 'button', class: 'primary', 'aria-label': 'Send' }, icon('send'));
      send.addEventListener('click', async () => {
        const prompt = input.value.trim();
        if (!prompt) return;
        const ok = await confirmTyped(s.id, `Send this to ${s.name}? If the session is busy the daemon starts a copy.`);
        if (!ok) return;
        send.disabled = true;
        try {
          const r = await api.post(`/api/v1/claude/sessions/${s.id}/message`, { prompt }, { 'X-Confirm': s.id });
          toast(r.copied ? `Session busy — started a copy ${r.new_id}` : 'Message delivered', r.copied ? 'info' : 'ok');
          input.value = '';
          await load(true);
        } catch (err) { toast(err.status === 409 ? 'This session cannot take messages' : err.message, 'error'); }
        finally { send.disabled = false; }
      });
      panel.append(h('div', { class: 'composer' }, input, h('div', { class: 'composer-actions' }, send)));
    }
  }

  clear(root);
  root.append(header('Claude', { eyebrow: 'Operate', actions: newSession ? [newSession] : [] }), form, h('div', { class: 'claude' }, list, panel));
  await load(false);
  bus.addEventListener('csession', (e) => { if (e.detail && e.detail.sessions) { sessions = e.detail.sessions.map((s) => ({ ...s, started_here: (sessions.find((o) => o.id === s.id) || {}).started_here })); draw(); } else load(true); });
  bus.addEventListener('refresh', () => load(true));
  refreshTimer = setInterval(() => { if (!document.hidden) load(true); }, 45_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
  bus.addEventListener('view-unmount', () => clearInterval(refreshTimer), { once: true });
}
