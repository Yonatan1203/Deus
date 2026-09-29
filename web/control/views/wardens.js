import { h, clear } from '../dom.js';
import { banner, confirmTyped, toast } from '../ui.js';
import { header } from '../app.js';
import { modelPicker } from './agent-model.js';

function updateBanner(list) {
  const off = list.filter((w) => !w.enabled).length;
  banner(off ? `${off} warden${off === 1 ? '' : 's'} disabled — review gates are weakened.` : '');
}

// The optional GPT second opinion (code-reviewer, ai-eng-warden): each commit
// then also needs a SHIP from the cheap OpenAI model; turning it on sends
// every commit's diff to OpenAI, so it asks for the typed confirm.
function secondOpinion(w, status, api, readOnly, onChange) {
  if (w.second_opinion === undefined) return null;
  const model = status.model || 'the GPT reviewer';
  const sw = h('button', {
    class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(w.second_opinion),
    'aria-label': `GPT second opinion for ${w.name}`,
    disabled: readOnly || (!status.available && !w.second_opinion),
    onclick: async () => {
      const next = !w.second_opinion;
      const headers = {};
      if (next) {
        const ok = await confirmTyped(w.name, `Add a GPT second opinion to ${w.name}?`, [
          `Every commit, in every worktree, then also needs a SHIP from ${model} (about $0.003 a review).`,
          'Run it before committing: cogate.py --backend openai_compat.',
          'The diff goes to OpenAI. A diff that looks like it holds a key is not sent and passes on Claude\'s review alone.',
        ]);
        if (!ok) return;
        headers['X-Confirm'] = w.name;
      }
      sw.disabled = true;
      try {
        const updated = await api.patch(`/api/v1/wardens/${encodeURIComponent(w.name)}`, { second_opinion: next }, headers);
        onChange(updated);
        if (updated.warning) toast(updated.warning, 'error');
        else toast(`${w.name}: GPT second opinion ${updated.second_opinion ? 'on' : 'off'}`, 'ok');
      } catch (err) {
        toast(err.status === 403 ? 'Read-only mode' : err.message, 'error');
        sw.disabled = false;
      }
    },
  });
  return h('div', { class: 'second-opinion' },
    sw,
    h('span', {}, 'GPT second opinion',
      h('span', { class: 'muted' }, status.available
        ? ` — ${model}, about $0.003 a review`
        : ' — set OPENAI_API_KEY, WARDEN_OPENAI_COMPAT_BASE_URL and _MODEL in .env first')));
}

function row(w, agent, status, api, readOnly, onChange, onModel) {
  const sw = h('button', {
    class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(w.enabled), 'aria-label': `${w.name} enabled`,
    hidden: readOnly,
    onclick: async () => {
      const next = !w.enabled;
      const headers = {};
      if (!next) {
        const ok = await confirmTyped(w.name, `Disable ${w.name}? Its gate stops running until re-enabled.`);
        if (!ok) return;
        headers['X-Confirm'] = w.name;
      }
      sw.disabled = true;
      try {
        const updated = await api.patch(`/api/v1/wardens/${encodeURIComponent(w.name)}`, { enabled: next }, headers);
        onChange(updated);
        toast(`${w.name} ${updated.enabled ? 'enabled' : 'disabled'}`, 'ok');
      } catch (err) {
        toast(err.status === 403 ? 'Read-only mode' : err.message, 'error');
      } finally {
        sw.disabled = false;
      }
    },
  });
  const el = h('div', { class: 'row', 'data-name': w.name },
    h('div', {},
      h('div', { class: 'name' }, w.name),
      h('div', { class: 'meta' },
        h('span', {}, w.rules_file ? `rules: ${w.rules_file}` : 'no rules file'),
        h('div', { class: 'chips' },
          ...w.tools.map((t) => h('span', { class: 'chip' }, t)),
          ...(w.backends || []).map((b) => h('span', { class: 'chip' }, `backend: ${b}`)),
          w.auto_threshold != null ? h('span', { class: 'chip' }, `auto: ${w.auto_threshold}`) : null),
        agent ? modelPicker(agent, api, readOnly, onModel) : null,
        secondOpinion(w, status, api, readOnly, onChange))),
    sw);
  return el;
}

export async function render(root, api, bus, me) {
  // Ends this view's listeners on the next navigation — registered before the first
  // await, so leaving while it loads cannot leak them (listeners added later with an
  // already-aborted signal are never added).
  const ac = new AbortController();
  bus.addEventListener('view-unmount', () => ac.abort(), { once: true });
  let [list, agents, status] = await Promise.all([
    api.get('/api/v1/wardens'),
    api.get('/api/v1/agents').catch(() => []),
    api.get('/api/v1/wardens/second-opinion').catch(() => ({ available: false, model: null })),
  ]);
  const agentFor = (name) => agents.find((a) => a.name === name) || null;
  const onModel = (updated) => {
    agents = agents.map((a) => (a.name === updated.name ? { ...a, model: updated.model } : a));
    draw();
  };
  clear(root);
  const holder = h('div', {});
  const readOnly = Boolean(me && me.read_only);
  const draw = () => {
    clear(holder);
    if (list.length === 0) holder.append(h('div', { class: 'empty' }, 'No wardens configured.'));
    else holder.append(h('div', { class: 'list' }, ...list.map((w) => row(w, agentFor(w.name), status, api, readOnly, apply, onModel))));
    updateBanner(list);
  };
  const apply = (updated) => {
    list = list.map((w) => (w.name === updated.name ? updated : w));
    draw();
  };
  root.append(header('Wardens', { eyebrow: 'Advanced', count: list.length }), holder);
  draw();
  bus.addEventListener('warden', (e) => apply(e.detail), { signal: ac.signal });
  bus.addEventListener('refresh', async () => { list = await api.get('/api/v1/wardens'); draw(); }, { signal: ac.signal });
}
