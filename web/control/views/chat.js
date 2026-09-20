import { h, clear } from '../dom.js';
import { toast } from '../ui.js';

const KEY = 'deus_ctl_chat';
const MAX_ENTRIES = 100;

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant')) : [];
  } catch {
    return [];
  }
}
function save(history) {
  try { localStorage.setItem(KEY, JSON.stringify(history.slice(-MAX_ENTRIES))); } catch { /* ignore */ }
}

function bubble(role, text) {
  return h('div', { class: `msg ${role}` }, h('div', { class: 'body' }, text));
}

export async function render(root, api, bus, me) {
  clear(root);
  const readOnly = Boolean(me && me.read_only);
  // Invariant: only final assistant text and user messages are stored and
  // replayed. Tool arguments and activity lines are LLM-authored and never
  // re-enter a later prompt.
  let history = load();
  let turnId = null;
  let controller = null;

  const transcript = h('div', { class: 'transcript', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'composer-input', rows: '2', placeholder: readOnly ? 'Read-only mode — chat is disabled' : 'Message the assistant…', disabled: readOnly });
  const send = h('button', { type: 'button', class: 'primary', disabled: readOnly }, 'Send');
  const stop = h('button', { type: 'button', class: 'danger', hidden: true }, 'Stop');
  const fresh = h('button', { type: 'button', class: 'ghost', onclick: () => { history = []; save(history); draw(); } }, 'New chat');

  const scroll = () => { transcript.scrollTop = transcript.scrollHeight; };
  const draw = () => {
    clear(transcript);
    if (history.length === 0) transcript.append(h('div', { class: 'empty' }, 'No messages yet.'));
    for (const m of history) transcript.append(bubble(m.role, m.content));
    scroll();
  };

  async function submit() {
    const message = input.value.trim();
    if (!message || turnId !== null) return;
    input.value = '';
    history.push({ role: 'user', content: message });
    save(history);
    draw();
    const live = h('div', { class: 'msg assistant live' });
    const body = h('div', { class: 'body' });
    live.append(body);
    transcript.append(live);
    let text = '';
    turnId = 'pending';
    send.disabled = true;
    stop.hidden = false;
    controller = new AbortController();
    try {
      await api.stream('/api/v1/chat/turns', { message, history: history.slice(0, -1) }, (type, data) => {
        if (type === 'turn_started') turnId = data.id;
        else if (type === 'output_text') { text += data.text; body.textContent = text; scroll(); }
        else if (type === 'activity') { live.append(h('div', { class: 'activity' }, data.text)); scroll(); }
        else if (type === 'tool_call') {
          live.append(h('details', { class: 'tool' },
            h('summary', {}, `tool: ${data.name}`),
            h('pre', {}, JSON.stringify(data.arguments, null, 2))));
          scroll();
        } else if (type === 'error') { live.append(h('div', { class: 'error' }, data.error)); toast(data.error, 'error'); }
      }, controller.signal);
    } catch (err) {
      if (err.name !== 'AbortError') {
        const msg = err.status === 429 ? 'A turn is already in progress' : err.status === 403 ? 'Read-only mode' : err.message;
        live.append(h('div', { class: 'error' }, msg));
        toast(msg, 'error');
      }
    } finally {
      if (text) { history.push({ role: 'assistant', content: text }); save(history); }
      live.classList.remove('live');
      turnId = null;
      controller = null;
      send.disabled = readOnly;
      stop.hidden = true;
      input.focus();
    }
  }

  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  stop.addEventListener('click', async () => {
    if (!turnId || turnId === 'pending') return;
    try { await api.del(`/api/v1/chat/turns/${encodeURIComponent(turnId)}`); toast('Stopping…'); }
    catch (err) { toast(err.message, 'error'); }
  });

  root.append(
    h('div', { class: 'chat' },
      h('div', { class: 'chat-head' }, h('h1', {}, 'Chat'), fresh),
      transcript,
      h('div', { class: 'composer' }, input, h('div', { class: 'composer-actions' }, stop, send))));
  draw();
}
