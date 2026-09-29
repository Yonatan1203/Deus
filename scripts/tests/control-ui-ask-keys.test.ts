import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import {
  PASTE_END,
  PASTE_START,
  arrowKeys,
  backKeys,
  nextKeys,
  pickKeys,
  submitKeys,
  textKeys,
} from '../../web/control/ask-keys.js';

// The keystroke contract was verified against Claude Code 2.1.283 on
// 2026-09-26; the table is in docs/superpowers/plans/2026-09-26-claude-tab-answer-questions.md.
describe('ask keys', () => {
  it('a pick is its number; next, back and submit are one key each', () => {
    expect(pickKeys(2)).toEqual(['2']);
    expect(nextKeys()).toEqual(['\x1b[C']);
    expect(backKeys()).toEqual(['\x1b[D']);
    expect(backKeys(3)).toEqual(['\x1b[D', '\x1b[D', '\x1b[D']); // review → question n-2
    expect(() => backKeys(0)).toThrow('bad back count');
    expect(() => backKeys(9)).toThrow('bad back count');
    expect(() => backKeys(1.5)).toThrow('bad back count');
    expect(submitKeys()).toEqual(['\r']);
  });

  it('free text: the option number, the text as a paste, Enter', () => {
    expect(textKeys(4, 'Purple')).toEqual([
      '4',
      `${PASTE_START}Purple${PASTE_END}`,
      '\r',
    ]);
  });

  it('free text with "Type something" already selected: no number, it would be typed', () => {
    expect(textKeys(4, 'Purple', { selected: true })).toEqual([
      `${PASTE_START}Purple${PASTE_END}`,
      '\r',
    ]);
  });

  it('cleans the text to one line without control characters', () => {
    expect(textKeys(4, 'a\x1bb\r\nc')[1]).toBe(
      `${PASTE_START}ab c${PASTE_END}`,
    );
  });

  it('refuses empty text and impossible numbers', () => {
    expect(() => textKeys(4, '  ')).toThrow('incomplete');
    expect(() => pickKeys(0)).toThrow('bad pick');
    expect(() => pickKeys(10)).toThrow('bad pick');
    expect(() => textKeys(0, 'x')).toThrow('bad pick');
  });
});

describe('arrowKeys (#57)', () => {
  it('moves the cursor from the selected row to the picked one', () => {
    expect(arrowKeys(3, 1)).toEqual(['\x1b[A', '\x1b[A']);
    expect(arrowKeys(1, 3)).toEqual(['\x1b[B', '\x1b[B']);
    expect(arrowKeys(2, 2)).toEqual([]);
  });
});
