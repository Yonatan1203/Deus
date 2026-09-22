import type { Page } from 'playwright';
import { detectBlock, type Adapter, type AdapterResult } from './types.js';

// Every string this adapter knows about the site lives here, so a site change
// is one edit in one place rather than a hunt through logic.
const SELECTORS = {
  challenge: [
    '[data-testid="challenge"]',
    'form[action*="/challenge"]',
    '#challenge_form',
    'text=/suspicious login attempt/i',
  ],
  signedOut: [
    'form#loginForm',
    'input[name="password"]',
    'a[href^="/accounts/login"]',
  ],
  rateLimited: [
    'text=/try again later/i',
    'text=/action blocked/i',
    '[data-testid="rate-limit"]',
  ],
  notFound: [
    "text=/sorry, this page isn't available/i",
    '[data-testid="not-found"]',
  ],
  follow: 'button[data-testid="follow-button"]',
  following: 'button[data-testid="following-button"]',
  confirmed: 'button[data-testid="following-button"]',
};
const SETTLE_MS = 1500;

/**
 * Follow the account whose profile page the engine has already opened.
 * Already-following is success without a click: re-clicking there would
 * unfollow, which is the one thing this action must never do.
 */
async function follow(page: Page): Promise<AdapterResult> {
  const blocked = await detectBlock(page, SELECTORS);
  if (blocked) return { ok: false, reason: blocked };
  if ((await page.locator(SELECTORS.following).count()) > 0)
    return { ok: true, detail: 'already' };
  const button = page.locator(SELECTORS.follow);
  if ((await button.count()) === 0)
    return { ok: false, reason: 'changed-page' };
  await button.first().click();
  // A challenge can arrive in place of the confirmation, so the wait is for
  // either outcome and the block check runs again on whatever appeared.
  await page
    .locator(SELECTORS.confirmed)
    .first()
    .waitFor({ state: 'visible', timeout: SETTLE_MS })
    .catch(() => undefined);
  const after = await detectBlock(page, SELECTORS);
  if (after) return { ok: false, reason: after };
  if ((await page.locator(SELECTORS.confirmed).count()) === 0)
    return { ok: false, reason: 'changed-page' };
  return { ok: true, detail: 'followed' };
}

export const instagram: Adapter = {
  id: 'instagram',
  actions: { 'instagram.follow': (page) => follow(page) },
};
