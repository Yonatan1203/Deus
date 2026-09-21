import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  ADAPTERS,
  listChannels,
  pairingState,
  whatsappQr,
} from './channels.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-channels-'));
const authDir = path.join(root, 'store', 'auth');
fs.mkdirSync(authDir, { recursive: true });
const telegram = {
  name: 'telegram',
  isConnected: () => true,
  ownsJid: (jid: string) => jid.endsWith('@x'),
};
const deps = {
  repoRoot: root,
  envHas: (k: string) => k === 'TELEGRAM_BOT_TOKEN',
  channels: () => [telegram] as never,
  registeredGroups: () =>
    ({
      'main@x': { folder: 'main' },
      'ops@x': { folder: 'ops' },
      'w@w': { folder: 'wa' },
    }) as never,
  whatsappAuthDir: authDir,
};

describe('control-ui channels', () => {
  it('lists every adapter with configured/connected/groups and WhatsApp pairing state', () => {
    fs.writeFileSync(
      path.join(root, 'store', 'qr-data.txt'),
      'example-qr-payload',
    );
    const out = listChannels(deps);
    expect(out.map((c) => c.name)).toEqual([...ADAPTERS]);
    const tg = out.find((c) => c.name === 'telegram')!;
    expect(tg).toMatchObject({
      package: 'mcp-telegram',
      configured: true,
      connected: true,
      groups: ['main', 'ops'],
    });
    const wa = out.find((c) => c.name === 'whatsapp')!;
    expect(wa.connected).toBe(false);
    expect(wa.configured).toBe(false);
    expect(wa.pairing).toEqual({
      needs_pairing: true,
      qr_available: true,
      pairing_code_available: false,
    });
    expect(out.find((c) => c.name === 'gmail')!.configured).toBeNull();
  });

  it('serves the QR only while unpaired', async () => {
    expect(pairingState(authDir).needs_pairing).toBe(true);
    const unpaired = await whatsappQr(authDir);
    expect(unpaired).toMatchObject({ qr: 'example-qr-payload' });
    // A rendered QR is a multi-line block; null here means the renderer threw.
    const ascii = 'ascii' in unpaired ? unpaired.ascii : null;
    expect(typeof ascii).toBe('string');
    expect((ascii as string).split('\n').length).toBeGreaterThan(10);
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    expect(await whatsappQr(authDir)).toEqual({ status: 409 });
    expect(pairingState(authDir).needs_pairing).toBe(false);
    fs.rmSync(path.join(authDir, 'creds.json'));
    fs.rmSync(path.join(root, 'store', 'qr-data.txt'));
    expect(await whatsappQr(authDir)).toEqual({ status: 404 });
  });
});
