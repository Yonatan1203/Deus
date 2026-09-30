import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

import { isOwnSend, outgoingText } from './whatsapp.js';

/**
 * Deus's WhatsApp can run on the operator's own number. Host-side approvals (social-publish
 * posts, story-flight commands) then accept his own-account messages and tell Deus's sends
 * apart only by the "<name>: " prefix and the is_bot_message flag it produces (#61). These tests
 * pin that pair so a change here cannot silently turn Deus's output into an approval.
 */
describe('own sends on a shared number', () => {
  it('prefixes every send and recognises the echo as a bot message', () => {
    for (const text of [
      'approve IG1',
      '',
      '  approve flight x',
      'Amos: approve IG1',
    ]) {
      const sent = outgoingText(text, 'Amos', false);
      expect(sent.startsWith('Amos: ')).toBe(true);
      expect(isOwnSend(sent, true, 'Amos', false)).toBe(true);
    }
  });

  it("does not flag the operator's own unprefixed message", () => {
    expect(isOwnSend('approve IG1', true, 'Amos', false)).toBe(false);
  });

  it('on its own number, flags everything sent from it and sends text unchanged', () => {
    expect(outgoingText('hi', 'Amos', true)).toBe('hi');
    expect(isOwnSend('approve IG1', true, 'Amos', true)).toBe(true);
    expect(isOwnSend('approve IG1', false, 'Amos', true)).toBe(false);
  });

  it('sends only prefixed text: every sock.sendMessage call uses the prefixed or queued text', () => {
    const src = fs.readFileSync(path.join(__dirname, 'whatsapp.ts'), 'utf8');
    const calls = src.match(/sock\.sendMessage\([^;]*;/g) ?? [];
    expect(calls.length).toBe(2);
    expect(calls.filter((c) => c.includes('{ text: prefixed }')).length).toBe(
      1,
    );
    expect(calls.filter((c) => c.includes('{ text: item.text }')).length).toBe(
      1,
    );
    expect(src).toMatch(
      /outgoingQueue\.push\(\{ jid: chatId, text: prefixed \}\)/,
    );
    expect(src.match(/outgoingQueue\.push\(/g)?.length).toBe(
      src.match(/outgoingQueue\.push\(\{ jid: chatId, text: prefixed \}\)/g)
        ?.length,
    );
  });
});
