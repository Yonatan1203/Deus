#!/usr/bin/env node
// Speed check for the control UI: cold-load timings and bytes, the biggest
// resources, API latency and tab-switch time. Same login as the screenshot
// script: CONTROL_UI_URL (default the dev port) and CONTROL_UI_PASSWORD_FILE.
//   CONTROL_UI_URL=http://127.0.0.1:3017 CONTROL_UI_PASSWORD_FILE=~/.config/deus/pw node scripts/control-ui-perf.mjs
import fs from 'fs';
import { chromium } from 'playwright';

const url =
  (process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3017').replace(/\/$/, '') +
  '/';
const file = process.env.CONTROL_UI_PASSWORD_FILE;
if (!file) {
  console.error('CONTROL_UI_PASSWORD_FILE is required');
  process.exit(2);
}
const password = fs.readFileSync(file, 'utf-8').trim();
const APIS = [
  '/api/v1/claude/sessions',
  '/api/v1/agents',
  '/api/v1/artifacts',
  '/api/v1/chat/commands',
  '/api/v1/claude/commands',
];
const TABS = ['agents', 'artifacts', 'claude'];

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 900 } })
).newPage();
const encodings = new Map();
page.on('response', (r) => {
  encodings.set(
    r.url().replace(url, '/'),
    r.headers()['content-encoding'] || 'identity',
  );
});
await page.goto(url);
await page.fill('#password', password);
await page.press('#password', 'Enter');
await page.waitForSelector('#app:not([hidden])');

const t0 = Date.now();
await page.goto(url + '#/claude');
await page.waitForSelector('.session-item, #view .empty', { timeout: 20_000 });
const claudeMs = Date.now() - t0;
const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0];
  const fp = performance.getEntriesByName('first-contentful-paint')[0];
  return {
    dcl: Math.round(n.domContentLoadedEventEnd),
    fcp: fp ? Math.round(fp.startTime) : null,
  };
});
const res = await page.evaluate(() =>
  performance
    .getEntriesByType('resource')
    .map((r) => ({
      name: r.name.split('/').slice(3).join('/'),
      ms: Math.round(r.duration),
      kb: Math.round((r.transferSize || r.encodedBodySize || 0) / 102.4) / 10,
    }))
    .sort((a, b) => b.kb - a.kb),
);
console.log(
  `cold load: first paint ${nav.fcp} ms · dom ready ${nav.dcl} ms · Claude tab ready ${claudeMs} ms`,
);
console.log(
  `bytes: ${res.reduce((n, r) => n + r.kb, 0).toFixed(0)} KB over ${res.length} requests`,
);
for (const r of res.slice(0, 8))
  console.log(
    `  ${r.name.padEnd(34)} ${String(r.kb).padStart(6)} KB ${String(r.ms).padStart(4)} ms ${encodings.get('/' + r.name) ?? ''}`,
  );
for (const p of APIS) {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await page.evaluate(async (u) => {
      await fetch(u, {
        headers: {
          'x-deus-session': localStorage.getItem('deus_ctl_token') || '',
        },
      });
    }, p);
    times.push(Date.now() - t);
  }
  console.log(`api ${p.padEnd(28)} ${times.join(' / ')} ms`);
}
for (const tab of TABS) {
  const t = Date.now();
  await page.goto(url + '#/' + tab);
  await page.waitForFunction(
    () =>
      !document
        .querySelector('#view .muted')
        ?.textContent?.startsWith('Loading'),
  );
  console.log(`switch to ${tab.padEnd(10)} ${Date.now() - t} ms`);
}
await browser.close();
