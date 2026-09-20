#!/usr/bin/env node
// Captures the running control UI for the visual verification record.
// Logs in once per viewport and walks every tab in that one session, because
// the server deletes the first-password file after the first successful login.
// Usage: CONTROL_UI_URL=http://127.0.0.1:3117 CONTROL_UI_PASSWORD_FILE=<0600 file> \
//        node scripts/control-ui-screenshot.mjs [outPrefix] [tab,tab,...]
import fs from 'fs';
import { chromium } from 'playwright';

const [prefix = 'docs/control-ui/artifacts/phase1', tabsArg = 'agents,wardens,mcps'] = process.argv.slice(2);
const tabs = tabsArg.split(',').filter(Boolean);
const url = process.env.CONTROL_UI_URL ?? 'http://127.0.0.1:3017';
const file = process.env.CONTROL_UI_PASSWORD_FILE;
if (!file) {
  console.error('CONTROL_UI_PASSWORD_FILE is required');
  process.exit(2);
}
const password = fs.readFileSync(file, 'utf-8').trim();
const browser = await chromium.launch();
const viewports = [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 800 }]];
for (const [name, viewport] of viewports) {
  const page = await browser.newPage({ viewport, colorScheme: 'dark' });
  await page.goto(`${url}/#/${tabs[0]}`);
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit]');
  for (const tab of tabs) {
    await page.goto(`${url}/#/${tab}`);
    await page.waitForSelector('#view .card, #view table, #view .row', { timeout: 10_000 });
    const out = `${prefix}-${tab}-${name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`wrote ${out}`);
  }
  await page.close();
}
await browser.close();
