import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import { parseAskScreen, parseWorking } from '../../web/control/ask-screen.js';

// Real screens from the 2026-09-26 spike (Claude Code 2.1.283), as the
// terminal buffer holds them: a blank row between the tab row, the
// question and the options, and blank rows plus a closing rule after the
// footer; see docs/superpowers/plans/2026-09-26-claude-tab-answer-questions.md.
const RULE = '──────────────────────────────';
const SINGLE = [
  ' ☐ Colour',
  '',
  'Which colour?',
  '',
  '❯ 1. Red',
  '     Red',
  '  2. Green',
  '     Green',
  '  3. Blue',
  '     Blue',
  '  4. Type something.',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '',
  '',
  RULE,
];
const MULTI = [
  '←  ☒ Colour  ☐ Fruit  ✔ Submit  →',
  'Which fruits?',
  '❯ 1. [ ] Apple',
  '         Apple',
  '  2. [ ] Banana',
  '         Banana',
  '  3. [✔] Cherry',
  '         Cherry',
  '  4. [ ] Type something',
  '     Submit',
  RULE,
  '  5. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  RULE,
];
const REVIEW = [
  '←  ☒ Colour  ☒ Fruit  ✔ Submit  →',
  'Review your answers',
  ' ● Which colour?',
  '   → Green',
  ' ● Which fruits?',
  '   → Apple, Cherry',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel',
  '',
  RULE,
];
const PROMPT = ['● Done.', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on'];
// A phone-width terminal (42 columns): the footer wraps, the question may
// wrap, and the closing rule carries the session name.
const NARROW = [
  '←  ☐ Colour  ☐ Fruit  ✔ Submit  →',
  '',
  'Which colour do you want for the',
  'first batch?',
  '',
  '❯ 1. Red',
  '     Red',
  '  2. Green',
  '     Green',
  '  4. Type something.',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to ',
  'navigate · Esc to cancel',
  '',
  '──────────────────────── Ask-delete-me ─',
];

// Claude Code's status line while working, captured at 6 s and 14 s.
const WORKING = [
  '❯ Run this command',
  '',
  '✽ Spinning… (4s · ↓ 28 tokens)',
  '                                        ● high · /effort',
  RULE,
  '❯ ',
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt',
];

describe('parseWorking', () => {
  it('reads the verb, the seconds and the tokens', () => {
    expect(parseWorking(WORKING)).toEqual({
      verb: 'Spinning',
      seconds: 4,
      tokens: '28',
    });
    expect(
      parseWorking(
        WORKING.map((l) =>
          l.replace(
            '✽ Spinning… (4s · ↓ 28 tokens)',
            '✻ Spinning… (14s · ↓ 103 tokens)',
          ),
        ),
      ),
    ).toEqual({
      verb: 'Spinning',
      seconds: 14,
      tokens: '103',
    });
  });
  it('reads a line without tokens and returns null on an idle prompt', () => {
    expect(parseWorking(['✻ Thinking… (2s)', RULE, '❯ '])).toEqual({
      verb: 'Thinking',
      seconds: 2,
      tokens: '',
    });
    expect(parseWorking(PROMPT)).toBeNull();
    expect(parseWorking([])).toBeNull();
  });
});

describe('parseAskScreen', () => {
  it('reads a single-choice question', () => {
    expect(parseAskScreen([...PROMPT.slice(0, 1), ...SINGLE])).toEqual({
      kind: 'question',
      question: 'Which colour?',
      tabs: [{ label: 'Colour', done: false }],
      multi: false,
      options: [
        { n: 1, label: 'Red', on: false },
        { n: 2, label: 'Green', on: false },
        { n: 3, label: 'Blue', on: false },
      ],
      other: 4,
      cursor: 1,
    });
  });

  it('reads a multi-select question with its toggles and the tab row', () => {
    const q = parseAskScreen(MULTI);
    expect(q.multi).toBe(true);
    expect(q.tabs).toEqual([
      { label: 'Colour', done: true },
      { label: 'Fruit', done: false },
    ]);
    expect(
      q.options.map((o: { label: string; on: boolean }) => [o.label, o.on]),
    ).toEqual([
      ['Apple', false],
      ['Banana', false],
      ['Cherry', true],
    ]);
    expect(q.other).toBe(4);
    expect(q.cursor).toBe(1);
  });

  it('reads the review screen', () => {
    expect(parseAskScreen(REVIEW)).toEqual({
      kind: 'review',
      answers: [
        { question: 'Which colour?', answer: 'Green' },
        { question: 'Which fruits?', answer: 'Apple, Cherry' },
      ],
    });
  });

  it('sees the typed text on the "Type something" line', () => {
    const lines = SINGLE.map((l) =>
      l
        .replace('❯ 1. Red', '  1. Red')
        .replace('  4. Type something.', '❯ 4. Purple'),
    );
    expect(parseAskScreen(lines)).toMatchObject({
      cursor: 4,
      other: 4,
      options: [{ n: 1, label: 'Red', on: false }, { n: 2 }, { n: 3 }],
    });
  });

  it('reads a phone-width screen: wrapped footer, wrapped question, named rule', () => {
    expect(parseAskScreen(NARROW)).toEqual({
      kind: 'question',
      question: 'Which colour do you want for the first batch?',
      tabs: [
        { label: 'Colour', done: false },
        { label: 'Fruit', done: false },
      ],
      multi: false,
      options: [
        { n: 1, label: 'Red', on: false },
        { n: 2, label: 'Green', on: false },
      ],
      other: 4,
      cursor: 1,
    });
  });

  it('marks a clipped label with an ellipsis', () => {
    const long = 'x'.repeat(150);
    const lines = SINGLE.map((l) => l.replace('  2. Green', `  2. ${long}`));
    const q = parseAskScreen(lines);
    expect(q.options[1].label).toHaveLength(120);
    expect(q.options[1].label.endsWith('…')).toBe(true);
  });

  it('is null on an ordinary prompt and on stale screens above a prompt', () => {
    expect(parseAskScreen(PROMPT)).toBeNull();
    expect(parseAskScreen([...SINGLE, ...PROMPT])).toBeNull();
    expect(parseAskScreen([...REVIEW, ...PROMPT])).toBeNull();
    expect(parseAskScreen([])).toBeNull();
  });
});

describe('back on an answered question', () => {
  it('reads the trailing ✔ Claude Code puts on the earlier answer as the selected option', () => {
    const lines = SINGLE.map((l) => (l === '  3. Blue' ? '  3. Blue ✔' : l));
    const st = parseAskScreen(lines);
    expect(st && st.kind).toBe('question');
    const blue =
      st && st.kind === 'question'
        ? st.options.find((o) => o.n === 3)
        : undefined;
    expect(blue).toMatchObject({ label: 'Blue', on: true });
    expect(
      st && st.kind === 'question'
        ? st.options.find((o) => o.n === 1)?.on
        : null,
    ).toBe(false);
  });
});
