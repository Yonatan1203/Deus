import { describe, expect, it } from 'vitest';
import { PROMPT_BYTES_MAX, PROMPT_MESSAGES_MAX, promptWindow } from './chat.js';
import type { ChatMessage } from './chat-store.js';

const m = (role: 'user' | 'assistant', text: string, extra = {}) =>
  ({ role, text, at: 1, ...extra }) as ChatMessage;

describe('promptWindow', () => {
  it('keeps chronological order with the newest user message last, text only', () => {
    const w = promptWindow([
      m('user', 'first'),
      m('assistant', '', { error: 'Interrupted' }),
      m('assistant', 'answer', { activity: ['Used Bash rm -rf'] }),
      m('user', 'latest'),
    ]);
    expect(w).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'latest' },
    ]);
    expect(JSON.stringify(w)).not.toContain('rm -rf');
  });

  it('stops at 200 messages or 256 KiB, dropping the oldest', () => {
    const many = Array.from({ length: 300 }, (_, i) => m('user', `m${i}`));
    const w = promptWindow(many);
    expect(w).toHaveLength(PROMPT_MESSAGES_MAX);
    expect(w.at(-1)?.content).toBe('m299');
    const big = Array.from({ length: 20 }, (_, i) =>
      m('assistant', `${i}`.padEnd(30 * 1024, '.')),
    );
    const wb = promptWindow(big);
    const bytes = wb.reduce((n, x) => n + Buffer.byteLength(x.content), 0);
    expect(bytes).toBeLessThanOrEqual(PROMPT_BYTES_MAX);
    expect(wb.at(-1)?.content.startsWith('19')).toBe(true);
  });
});
