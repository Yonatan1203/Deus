import { describe, expect, it } from 'vitest';

import { isWhatsAppJid } from './whatsapp-jid.js';

describe('isWhatsAppJid', () => {
  it('accepts the chat ids the WhatsApp channel emits', () => {
    for (const jid of [
      '120363000000000000@g.us',
      '972500000000-1612345678@g.us',
      '972500000000@s.whatsapp.net',
      '972500000000:12@s.whatsapp.net',
      '123456789012345@lid',
      '123456789012345:4@lid',
    ]) {
      expect(isWhatsAppJid(jid), jid).toBe(true);
    }
  });

  it("rejects other channels' ids and WhatsApp forms it does not handle", () => {
    for (const jid of [
      'tg:1@g.us',
      'tg:123',
      'gmail:abc',
      'gmail-triage:inbox',
      'webhook:x',
      'slack:C1',
      'x@newsletter',
      '1@broadcast',
      'status@broadcast',
      '1@c.us',
      '+972500000000@s.whatsapp.net',
      '',
    ]) {
      expect(isWhatsAppJid(jid), jid).toBe(false);
    }
  });
});
