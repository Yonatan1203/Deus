import { h, clear } from '../dom.js';
import { toast } from '../ui.js';
import { icon } from '../icons.js';
import { header } from '../app.js';

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

// A turn is a document block: mono author line, then the body. The `msg`
// class is kept so the capture script's selectors still match.
function turn(role, who, text, live) {
  return h('div', { class: `msg ${role}${live ? ' live' : ''}` },
    h('div', { class: 'eyebrow' }, live ? h('span', { class: 'dot live', 'aria-hidden': 'true' }) : null, who),
    h('div', { class: 'body' }, text));
}

export async function render(root, api, bus, me) {
  clear(root);
  const readOnly = Boolean(me && me.read_only);
  const who = (me && me.assistant) || 'Assistant';
  // Invariant: only final assistant text and user messages are stored and
  // replayed. Tool arguments and activity lines are LLM-authored and never
  // re-enter a later prompt.
  let history = load();
  let turnId = null;
  let controller = null;

  const transcript = h('div', { class: 'transcript', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'composer-input', rows: '2', placeholder: readOnly ? 'Read-only mode — chat is disabled' : 'Message the assistant…', disabled: readOnly });
  const send = h('button', { type: 'button', class: 'primary', disabled: readOnly, 'aria-label': 'Send' }, icon('send'));
  const stop = h('button', { type: 'button', class: 'danger', hidden: true, 'aria-label': 'Stop' }, icon('stop'));
  const fresh = h('button', { type: 'button', class: 'ghost small', onclick: () => { history = []; save(history); draw(); } }, icon('plus', { size: 16 }), 'New chat');

  const scroll = () => { transcript.scrollTop = transcript.scrollHeight; };
  const draw = () => {
    clear(transcript);
    if (history.length === 0) transcript.append(h('div', { class: 'empty' }, 'Start a conversation.'));
    for (const m of history) transcript.append(turn(m.role, m.role === 'user' ? 'You' : who, m.content, false));
    scroll();
  };

  async function submit() {
    const message = input.value.trim();
    if (!message || turnId !== null) return;
    input.value = '';
    history.push({ role: 'user', content: message });
    save(history);
    draw();
    const live = turn('assistant', who, '', true);
    const body = live.querySelector('.body');
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
            h('summary', {}, `tool · ${data.name}`),
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
      const d = live.querySelector('.dot');
      if (d) d.remove();
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
      header('Chat', { eyebrow: 'Operate', actions: [fresh] }),
      transcript,
      h('div', { class: 'composer' }, input, h('div', { class: 'composer-actions' }, stop, send))));
  draw();
}
