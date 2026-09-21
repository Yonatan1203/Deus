#!/usr/bin/env node
// Captures the running control UI for the visual verification record.
// Logs in once per viewport and walks every tab in that one session, because
// the server deletes the first-password file after the first successful login.
// Pseudo-tabs: `login` (before signing in) and `more` (the mobile sheet).
// Usage: CONTROL_UI_URL=http://127.0.0.1:3117 CONTROL_UI_PASSWORD_FILE=<0600 file> \
//        node scripts/control-ui-screenshot.mjs [outPrefix] [tab,tab,...]
import fs from 'fs';
import { chromium } from 'playwright';

const [prefix = 'docs/control-ui/artifacts/phase2', tabsArg = 'chat,sessions,groups'] = process.argv.slice(2);
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
const shoot = async (page, tab, name) => {
  const out = `${prefix}-${tab}-${name}.png`;
  await page.screenshot({ path: out, fullPage: false });
  console.log(`wrote ${out}`);
};
for (const [name, viewport] of viewports) {
  const page = await browser.newPage({ viewport, colorScheme: 'dark' });
  page.on('pageerror', (e) => console.error(`page error (${name}): ${e.message}`));
  const first = tabs.find((t) => t !== 'login' && t !== 'more') ?? 'chat';
  await page.goto(`${url}/#/${first}`);
  await page.waitForSelector('#login-form:not([hidden])');
  await page.evaluate(() => document.fonts.ready);
  if (tabs.includes('login')) await shoot(page, 'login', name);
  await page.fill('#password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  for (const tab of tabs) {
    if (tab === 'login') continue;
    if (tab === 'more') {
      if (name !== 'mobile') continue;
      await page.goto(`${url}/#/${first}`);
      await page.click('#tabbar button');
      await page.waitForSelector('#more[open]');
      await page.locator('#more .sheet-body').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      await shoot(page, tab, name);
      await page.keyboard.press('Escape');
      continue;
    }
    await page.goto(`${url}/#/${tab}`);
    if (tab === 'chat') {
      // Exercise the live path: send one message and wait for the reply to land.
      await page.fill('.composer-input', 'hello');
      await page.click('.composer-actions .primary');
      await page.waitForSelector('.msg.assistant:not(.live)', { timeout: 20_000 });
    } else if (tab === 'memory') {
      // Open the first file so the viewer is part of the capture.
      await page.waitForSelector('#view .memory-item', { timeout: 10_000 });
      await page.click('#view .memory-item');
      await page.waitForSelector('#view .memory-content', { timeout: 10_000 });
    } else if (tab === 'channels') {
      // Drive the pairing path so the rendered QR is in the capture.
      await page.waitForSelector('#view .card', { timeout: 10_000 });
      const qrButton = page.locator('#view button', { hasText: 'Show pairing QR' });
      if (await qrButton.count()) {
        await qrButton.first().click();
        await page.waitForSelector('#confirm[open]');
        await page.fill('#confirm-input', 'whatsapp');
        await page.click('#confirm-ok');
        await page.waitForSelector('#view .qr', { state: 'attached', timeout: 10_000 });
      }
    } else if (tab === 'config') {
      // Open one editable row so the inline editor is part of the capture.
      await page.waitForSelector('#view table.kv', { timeout: 10_000 });
      const edit = page.locator('#view table.kv button', { hasText: 'Edit' });
      if (await edit.count()) await edit.first().click();
    } else if (tab === 'logs') {
      await page.waitForSelector('#view .log .logline', { timeout: 10_000 });
    } else if (tab === 'system') {
      await page.waitForSelector('#view .tile', { timeout: 10_000 });
    } else if (tab === 'debug') {
      await page.waitForSelector('#view .health .row', { timeout: 10_000 });
    } else {
      await page.waitForSelector('#view .card, #view table, #view .row, #view .empty', { timeout: 10_000 });
    }
    await shoot(page, tab, name);
  }
  await page.close();
}
await browser.close();
