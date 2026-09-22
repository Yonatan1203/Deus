import type { Page } from 'playwright';

// One adapter per site behind one interface, chosen by the closed SITES table:
// the engine holds no site knowledge, and a new site is one file plus one row.
//
// Adapters never navigate. The engine puts the page on a URL built by
// `urlFor` from the closed table plus validated params, and the adapter acts
// on the page it is handed — so "never leaves the site" is structural rather
// than a promise, and the fixture tests need no retargeting seam. Adapters
// also never read files, never log, and never construct a context.

/** The five things a *site* can tell us. Distinct from the operator's rules
 *  refusing (`RefuseReason`) and from this phase refusing to run at all. */
export type BlockedReason =
  'challenge' | 'signed-out' | 'rate-limited' | 'not-found' | 'changed-page';

export type AdapterResult =
  { ok: true; detail?: string } | { ok: false; reason: BlockedReason };

export interface Adapter {
  id: string;
  actions: Record<
    string,
    (page: Page, params: Record<string, string>) => Promise<AdapterResult>
  >;
}

/**
 * Shared shape recognition. Anything a page can say that means "stop" is
 * checked before anything that means "act", so an unexpected page is never
 * treated as a successful one.
 */
export async function detectBlock(
  page: Page,
  selectors: {
    challenge: string[];
    signedOut: string[];
    rateLimited: string[];
    notFound: string[];
  },
): Promise<BlockedReason | null> {
  const first = async (list: string[]): Promise<boolean> => {
    for (const sel of list) {
      if ((await page.locator(sel).count()) > 0) return true;
    }
    return false;
  };
  if (await first(selectors.challenge)) return 'challenge';
  if (await first(selectors.signedOut)) return 'signed-out';
  if (await first(selectors.rateLimited)) return 'rate-limited';
  if (await first(selectors.notFound)) return 'not-found';
  return null;
}
