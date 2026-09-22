import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { instagram } from './instagram.js';
import { alibaba } from './alibaba.js';

// The adapters are exercised against local HTML that mimics each site's shape.
// The *test* drives navigation and hands the adapter a page already on the
// fixture — adapters take no URL, so there is no retargeting seam here for
// Phase E2 to inherit with a live cookie jar attached.
//
// The sandbox is disabled for this context on purpose: the test process is
// root and these pages hold no session state and reach no network. The
// production path (Phase E2) refuses that combination outright and runs as a
// dedicated unprivileged account instead.
const FIXTURES = path.join(import.meta.dirname, '..', '__fixtures__');
const hasBrowser = (() => {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

let server: http.Server;
let browser: Browser;
let context: BrowserContext;
let base = '';

beforeAll(async () => {
  if (!hasBrowser) return;
  server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(FIXTURES, name);
    if (!name.endsWith('.html') || !fs.existsSync(file)) {
      res.writeHead(404).end('no fixture');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  context = await browser.newContext();
}, 120_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
});

const open = async (fixture: string): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(`${base}/${fixture}`);
  return page;
};
const describeBrowser = hasBrowser ? describe : describe.skip;

describeBrowser('instagram adapter', () => {
  it('follows, and reports what the page said when it cannot', async () => {
    const page = await open('instagram-profile.html');
    expect(await instagram.actions['instagram.follow'](page, {})).toEqual({
      ok: true,
      detail: 'followed',
    });
    await page.close();
  });

  it('treats already-following as success and never clicks (a click there would unfollow)', async () => {
    const page = await open('instagram-already.html');
    const clicks: string[] = [];
    page.on('console', (m) => clicks.push(m.text()));
    expect(await instagram.actions['instagram.follow'](page, {})).toEqual({
      ok: true,
      detail: 'already',
    });
    expect(clicks).toEqual([]);
    await page.close();
  });

  it('stops on every blocked shape the site can show', async () => {
    const cases: [string, string][] = [
      ['instagram-challenge.html', 'challenge'],
      ['instagram-ratelimited.html', 'rate-limited'],
      ['instagram-missing.html', 'not-found'],
      ['instagram-signedout.html', 'signed-out'],
      ['instagram-changed.html', 'changed-page'],
    ];
    for (const [fixture, reason] of cases) {
      const page = await open(fixture);
      expect(
        await instagram.actions['instagram.follow'](page, {}),
        fixture,
      ).toEqual({
        ok: false,
        reason,
      });
      await page.close();
    }
  });
});

describeBrowser('alibaba adapter', () => {
  it('sends the approved body verbatim', async () => {
    const page = await open('alibaba-thread.html');
    const body = 'Confirmed: 200 units, ship by the 12th.';
    expect(
      await alibaba.actions['alibaba.reply'](page, { thread_id: 'T1', body }),
    ).toEqual({
      ok: true,
      detail: 'sent',
    });
    expect(
      await page.locator('[data-testid="message-sent"]').textContent(),
    ).toBe(body);
    await page.close();
  });

  it('stops when signed out rather than typing into nothing', async () => {
    const page = await open('alibaba-signedout.html');
    expect(
      await alibaba.actions['alibaba.reply'](page, {
        thread_id: 'T1',
        body: 'hi',
      }),
    ).toEqual({
      ok: false,
      reason: 'signed-out',
    });
    await page.close();
  });

  it('lists thread ids and subjects, and nothing else', async () => {
    const page = await open('alibaba-inbox.html');
    const r = await alibaba.actions['alibaba.list_threads'](page, {});
    expect(r.ok).toBe(true);
    expect(r.ok && r.detail).toBe('T1 Overalls MOQ\nT2 Sample shipping');
    await page.close();
  });

  it('reports a changed page rather than guessing', async () => {
    const page = await open('instagram-already.html'); // not an alibaba thread at all
    expect(
      await alibaba.actions['alibaba.reply'](page, {
        thread_id: 'T1',
        body: 'hi',
      }),
    ).toEqual({
      ok: false,
      reason: 'changed-page',
    });
    await page.close();
  });
});

describe('adapter shape', () => {
  it('exposes exactly the kinds its site declares, and takes no URL', () => {
    expect(Object.keys(instagram.actions)).toEqual(['instagram.follow']);
    expect(Object.keys(alibaba.actions)).toEqual([
      'alibaba.reply',
      'alibaba.list_threads',
    ]);
    for (const action of [
      ...Object.values(instagram.actions),
      ...Object.values(alibaba.actions),
    ]) {
      // (page, params) — a third URL parameter would be the seam we refuse.
      expect(action.length).toBeLessThanOrEqual(2);
    }
    if (!hasBrowser)
      console.warn('no Chromium build present: adapter page tests skipped');
  });
});
