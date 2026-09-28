import { h, clear, badge } from '../dom.js';
import { header } from '../app.js';
import { confirmTyped, fmtTime, toast } from '../ui.js';

// Browser jobs: what the assistant may do on sites that have no API, and what
// it has asked to do. Nothing here can act yet — approving records the
// decision and the job stops, which the card says plainly rather than
// implying a click happened somewhere.
const KIND_LABEL = {
  'instagram.follow': 'follow',
  'alibaba.reply': 'reply to supplier',
  'alibaba.list_threads': 'list supplier threads',
};
const STATUS = {
  proposed: ['waiting for you', 'warn'],
  approved: ['approved', 'ok'],
  running: ['running', 'ok'],
  done: ['done', 'ok'],
  'maybe-sent': ['may have been sent', 'warn'],
  failed: ['failed', 'bad'],
  blocked: ['not run', ''],
  rejected: ['rejected', ''],
  expired: ['expired', ''],
};
const REASON = {
  'sandbox-unavailable': 'execution is not enabled on this server yet',
  disabled: 'the site is switched off in your rules',
  'quiet-hours': 'inside your quiet hours',
  'daily-cap': "today's cap is used up",
  'weekly-cap': "this week's cap is used up",
  'too-soon': 'too soon after the last action',
  'not-allowed': 'the target is not on your allow-list',
  'rules-invalid': 'the rules file is not readable',
  'needs-attention': 'the site needs your attention first',
  expired: 'the proposal sat unanswered for a day',
  'counts-unavailable': 'the queue could not be counted exactly',
  challenge: 'the site asked for a verification',
  'signed-out': 'the session is signed out',
  'rate-limited': 'the site is rate-limiting',
  'not-found': 'the page was not found',
  'changed-page': 'the page was not what we expected',
  // The propose route answers with the validator's own reason, so these four
  // reach this surface too. Without a row each, the operator reads a raw
  // token like "bad-params" where every other reason is a sentence.
  'bad-schema': 'that job record was not in a shape this server accepts',
  'bad-id': 'that job id did not match its record',
  'bad-kind': 'that is not an action this server can do',
  'bad-params': 'the handle or message in that request was not accepted',
};
const PROVENANCE = { rules: 'your rules', cli: 'a session (CLI)' };
const provenance = (by) =>
  PROVENANCE[by] ??
  (String(by).startsWith('session:')
    ? `dashboard ${String(by).slice(8)}`
    : String(by));

export async function render(root, api, bus, me) {
  const readOnly = Boolean(me && me.read_only);
  const sitesEl = h('div', { class: 'wf-grid' });
  const queueEl = h('div', { class: 'list' });
  const logEl = h('div', { class: 'list' });
  let data = { sites: [], jobs: [] };

  function ruleLine(s) {
    const r = s.rules;
    if (!r.enabled)
      return h(
        'p',
        { class: 'muted' },
        'Switched off. No job for this site can run.',
      );
    const bits = [
      `${s.counts.day}/${r.daily_cap} today`,
      `${s.counts.week}/${r.weekly_cap} this week`,
      `${r.min_gap_seconds}s apart`,
    ];
    if (r.quiet_hours)
      bits.push(`quiet ${r.quiet_hours[0]}:00–${r.quiet_hours[1]}:00`);
    return h('p', {}, bits.join(' · '));
  }

  function siteCard(s) {
    const targets =
      (s.rules.allow &&
        (s.rules.allow.handles || []).length +
          (s.rules.allow.threads || []).length) ||
      0;
    const card = h(
      'div',
      { class: 'card wf-card', 'data-site': s.site },
      h(
        'div',
        { class: 'title' },
        h('span', {}, s.site),
        badge(s.rules.enabled ? 'on' : 'off', s.rules.enabled ? 'ok' : ''),
      ),
      h(
        'div',
        { class: 'chips' },
        badge(
          s.rules.autonomous ? 'runs without asking' : 'asks every time',
          s.rules.autonomous ? 'warn' : 'ok',
        ),
        h(
          'span',
          { class: 'chip' },
          `${targets} allowed target${targets === 1 ? '' : 's'}`,
        ),
        s.counts_exact ? null : badge('counts unavailable', 'bad'),
      ),
      ruleLine(s),
      s.invalid
        ? h(
            'p',
            { class: 'error' },
            `Rules unreadable (${s.reason}). The site stays off until that file is fixed on the host.`,
          )
        : null,
    );
    if (s.attention) {
      card.append(
        h(
          'div',
          { class: 'attention' },
          h(
            'p',
            {},
            `${s.site} needs your attention: something came back from the site that stopped the run. Check the account, then clear this.`,
          ),
          readOnly
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  class: 'small',
                  onclick: async () => {
                    const ok = await confirmTyped(
                      s.site,
                      `Clear the attention flag for ${s.site}? Do this once you have checked the account yourself.`,
                    );
                    if (!ok) return;
                    try {
                      await api.post(
                        `/api/v1/browser/sites/${s.site}/attention/clear`,
                        undefined,
                        { 'X-Confirm': s.site },
                      );
                      toast('Cleared', 'ok');
                      await load();
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                'Clear',
              ),
        ),
      );
    }
    card.append(
      h(
        'p',
        { class: 'muted small-note' },
        'Execution arrives in the next phase: approving records your decision, and the job stops there.',
      ),
    );
    return card;
  }

  function paramLines(job) {
    if (!job.params) return null; // read-only withholds them
    return h(
      'div',
      { class: 'job-params' },
      ...Object.entries(job.params).map(([k, v]) =>
        h('p', {}, h('span', { class: 'muted' }, `${k}: `), v),
      ),
    );
  }

  function queueRow(job) {
    const actions = readOnly
      ? []
      : [
          h(
            'button',
            {
              type: 'button',
              class: 'small primary',
              onclick: async () => {
                const body = job.params && job.params.body;
                const ok = await confirmTyped(
                  job.id,
                  `Approve this ${KIND_LABEL[job.kind] ?? job.kind}?`,
                  body
                    ? ['This text will be sent in your name:', body]
                    : undefined,
                );
                if (!ok) return;
                try {
                  const r = await api.post(
                    `/api/v1/browser/jobs/${job.id}/approve`,
                    undefined,
                    { 'X-Confirm': job.id },
                  );
                  toast(
                    r.reason
                      ? `Approved — ${REASON[r.reason] ?? r.reason}`
                      : 'Approved',
                    r.reason ? 'info' : 'ok',
                  );
                  await load();
                } catch (err) {
                  toast(
                    err.data && err.data.error
                      ? (REASON[err.data.error] ?? err.data.error)
                      : err.message,
                    'error',
                  );
                }
              },
            },
            'Approve',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'small ghost',
              onclick: async () => {
                try {
                  await api.post(`/api/v1/browser/jobs/${job.id}/reject`);
                  toast('Rejected', 'ok');
                  await load();
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            },
            'Reject',
          ),
        ];
    return h(
      'div',
      { class: 'row job', 'data-id': job.id },
      h(
        'div',
        {},
        h(
          'div',
          { class: 'name' },
          `${job.site}: ${KIND_LABEL[job.kind] ?? job.kind}`,
        ),
        paramLines(job),
        h(
          'div',
          { class: 'meta' },
          h(
            'span',
            {},
            `proposed by ${provenance(job.proposed_by)} · ${fmtTime(job.proposed_at)}`,
          ),
        ),
      ),
      h('div', { class: 'actions-col' }, ...actions),
    );
  }

  function logRow(job) {
    const [label, kind] = STATUS[job.status] ?? [job.status, ''];
    return h(
      'div',
      { class: 'row job', 'data-id': job.id },
      h(
        'div',
        {},
        h(
          'div',
          { class: 'name' },
          `${job.site}: ${KIND_LABEL[job.kind] ?? job.kind}`,
        ),
        h(
          'div',
          { class: 'meta' },
          h(
            'span',
            {},
            [
              job.approved_by
                ? `approved by ${provenance(job.approved_by)}`
                : null,
              job.finished_at ? fmtTime(job.finished_at) : null,
            ]
              .filter(Boolean)
              .join(' · '),
          ),
          job.reason
            ? h('div', { class: 'muted' }, REASON[job.reason] ?? job.reason)
            : null,
        ),
      ),
      badge(label, kind),
    );
  }

  function draw() {
    clear(sitesEl);
    sitesEl.append(...data.sites.map(siteCard));
    const waiting = data.jobs.filter((x) => x.status === 'proposed');
    const rest = data.jobs.filter((x) => x.status !== 'proposed');
    clear(queueEl);
    queueEl.append(
      waiting.length
        ? h('div', { class: 'list' }, ...waiting.map(queueRow))
        : h('div', { class: 'empty' }, 'Nothing waiting for you.'),
    );
    clear(logEl);
    logEl.append(
      rest.length
        ? h('div', { class: 'list' }, ...rest.slice(0, 50).map(logRow))
        : h(
            'div',
            { class: 'empty' },
            'No jobs yet. Sessions propose them with scripts/browser-job.mjs.',
          ),
    );
  }

  async function load() {
    try {
      data = await api.get('/api/v1/browser');
      draw();
    } catch (err) {
      clear(sitesEl);
      sitesEl.append(
        h(
          'div',
          { class: 'empty' },
          err.status === 503
            ? 'The browser job list is unavailable on the server.'
            : err.status === 429
              ? 'Too many refreshes — wait a minute.'
              : err.message,
        ),
      );
    }
  }

  clear(root);
  root.append(
    header('Browser', { eyebrow: 'Advanced' }),
    sitesEl,
    h('h2', { class: 'section-title' }, 'Waiting for you'),
    queueEl,
    h('h2', { class: 'section-title' }, 'Recent'),
    logEl,
  );
  await load();
  bus.addEventListener('browser', (e) => {
    if (e.detail && e.detail.jobs) {
      data = { ...data, jobs: e.detail.jobs };
      draw();
    }
  });
  bus.addEventListener('refresh', load);
}
