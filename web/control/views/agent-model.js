import { h } from '../dom.js';
import { confirmTyped, limitToast, toast } from '../ui.js';

// The model an agent runs on, chosen from the Agents viewer or a Wardens row.
// The server rewrites the agent file's `model:` line and commits it on the
// live branch; it also enforces the list and the floor below.

export const MODEL_LABELS = { fable: 'Fable 5.1', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 4.5' };
const GATING = new Set(['plan-reviewer', 'code-reviewer', 'threat-modeler', 'verification-gate', 'ai-eng-warden']);

export const modelLabel = (m) => MODEL_LABELS[m] || m;

/**
 * A labelled select for `agent` (an entry from /api/v1/agents). `onSaved` gets
 * the updated entry. Read-only sessions see the model as text.
 */
export function modelPicker(agent, api, readOnly, onSaved) {
  const current = agent.model || '';
  if (readOnly || !current) return h('span', { class: 'chip' }, current ? modelLabel(current) : 'model not set');
  const known = Object.prototype.hasOwnProperty.call(MODEL_LABELS, current);
  const gating = GATING.has(agent.name);
  const select = h('select', { 'aria-label': `Model for ${agent.name}`, class: 'model-select' },
    ...(known ? [] : [h('option', { value: current }, current)]),
    ...Object.entries(MODEL_LABELS).map(([value, label]) => h('option', {
      value,
      disabled: gating && value === 'haiku',
    }, gating && value === 'haiku' ? `${label} — too small for a review gate` : label)));
  select.value = current;
  select.addEventListener('change', async () => {
    const to = select.value;
    const ok = await confirmTyped(agent.name,
      `Run ${agent.name} on ${modelLabel(to)}?`,
      [
        `Now: ${modelLabel(current)}.`,
        'Saved as a commit on the live branch (pushed to the fork tonight).',
        'Takes effect from the agent\'s next run; worktrees get it when they rebase.',
      ]);
    if (!ok) { select.value = current; return; }
    select.disabled = true;
    try {
      const updated = await api.put(`/api/v1/agents/${encodeURIComponent(agent.name)}/model`, { model: to }, { 'X-Confirm': agent.name });
      toast(updated.commit
        ? `${agent.name} now runs on ${modelLabel(to)} — commit ${updated.commit.slice(0, 7)}`
        : `${agent.name} already runs on ${modelLabel(to)}`, 'ok');
      onSaved(updated);
    } catch (err) {
      select.value = current;
      if (err.status === 429) limitToast('model changes');
      else if (err.status === 403) toast('Read-only mode', 'error');
      else if (err.status === 400 || err.status === 409) toast(`Not changed: ${err.message}.`, 'error');
      else toast('Not changed — something went wrong. Try again.', 'error');
    } finally {
      select.disabled = false;
    }
  });
  return h('label', { class: 'model-field' }, h('span', { class: 'muted' }, 'Model'), select);
}
