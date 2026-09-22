import type { Page } from 'playwright';
import { detectBlock, type Adapter, type AdapterResult } from './types.js';

const SELECTORS = {
  challenge: ['#nc_1_wrapper', '.nc-container', 'text=/verify to continue/i'],
  signedOut: [
    'form#login-form',
    'input[name="account"]',
    'a[href*="login.alibaba.com"]',
  ],
  rateLimited: ['text=/too many requests/i', 'text=/请稍后/'],
  notFound: [
    'text=/conversation not found/i',
    '[data-testid="thread-missing"]',
  ],
  composer: 'textarea[data-testid="reply-box"]',
  send: 'button[data-testid="send-reply"]',
  sent: '[data-testid="message-sent"]',
  threadRow: '[data-testid="thread-row"]',
  threadId: 'data-thread-id',
  threadSubject: '[data-testid="thread-subject"]',
};
const SETTLE_MS = 2000;
const THREADS_MAX = 50;

/**
 * Type the operator-approved body into the thread the engine opened and send
 * it. The body arrives already validated and already read by the operator in
 * the approval dialog: this adapter neither composes nor edits it.
 */
async function reply(
  page: Page,
  params: Record<string, string>,
): Promise<AdapterResult> {
  const blocked = await detectBlock(page, SELECTORS);
  if (blocked) return { ok: false, reason: blocked };
  const composer = page.locator(SELECTORS.composer);
  const send = page.locator(SELECTORS.send);
  if ((await composer.count()) === 0 || (await send.count()) === 0)
    return { ok: false, reason: 'changed-page' };
  // `validateJob` guarantees a non-empty body for this kind, so an absent one
  // means something upstream is wrong. Sending an empty message in the
  // operator's name would be acting on that confusion; refusing is the only
  // safe reading.
  if (!params.body) return { ok: false, reason: 'changed-page' };
  await composer.first().fill(params.body);
  await send.first().click();
  await page
    .locator(SELECTORS.sent)
    .first()
    .waitFor({ state: 'visible', timeout: SETTLE_MS })
    .catch(() => undefined);
  const after = await detectBlock(page, SELECTORS);
  if (after) return { ok: false, reason: after };
  if ((await page.locator(SELECTORS.sent).count()) === 0)
    return { ok: false, reason: 'changed-page' };
  return { ok: true, detail: 'sent' };
}

/** Read the inbox the engine opened: ids and subjects only, never bodies. */
async function listThreads(page: Page): Promise<AdapterResult> {
  const blocked = await detectBlock(page, SELECTORS);
  if (blocked) return { ok: false, reason: blocked };
  const rows = page.locator(SELECTORS.threadRow);
  const n = await rows.count();
  if (n === 0) return { ok: true, detail: '' };
  const seen: string[] = [];
  for (let i = 0; i < Math.min(n, THREADS_MAX); i++) {
    const row = rows.nth(i);
    const id = await row.getAttribute(SELECTORS.threadId);
    if (!id) continue;
    const subject =
      (await row.locator(SELECTORS.threadSubject).first().textContent()) ?? '';
    seen.push(`${id} ${subject.trim().slice(0, 80)}`);
  }
  return { ok: true, detail: seen.join('\n') };
}

export const alibaba: Adapter = {
  id: 'alibaba',
  actions: {
    'alibaba.reply': (page, params) => reply(page, params),
    'alibaba.list_threads': (page) => listThreads(page),
  },
};
