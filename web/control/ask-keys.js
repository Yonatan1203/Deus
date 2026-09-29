// The keys Claude Code's question screen expects, one helper per action
// (verified 2026-09-26 against Claude Code 2.1.283; the table is in
// docs/superpowers/plans/2026-09-26-claude-tab-answer-questions.md).
// A number selects an option: on a single-choice question that also
// advances, on a multi-select it toggles and → advances. The last advance
// opens "Review your answers", where Enter submits and ← goes back. A lone
// single-choice question submits on the number alone. "Type something" is
// the last option: its number, the text as a paste, then Enter.

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const ENTER = '\r';
export const TEXT_MAX = 2000;

/** One line, no control characters, bounded. */
export const cleanText = (t) => String(t)
  .replace(/[\r\n]+/g, ' ')
  .replace(/[\x00-\x1f\x7f]/g, '')
  .trim()
  .slice(0, TEXT_MAX);

const number = (n) => {
  if (!Number.isInteger(n) || n < 1 || n > 9) throw new Error('bad pick');
  return String(n);
};

export const pickKeys = (n) => [number(n)];
export const nextKeys = () => [RIGHT];
const UP = '\x1b[A';
const DOWN = '\x1b[B';
/** Menus without numbers: move the cursor from row `selected` to row `n`. */
export const arrowKeys = (selected, n) => Array(Math.abs(n - selected)).fill(n < selected ? UP : DOWN);
/**
 * The most ← presses a jump may take: headroom over the six tabs the screen
 * parser reads (TABS_MAX in ask-screen.js), so a longer set still fails
 * loudly here rather than typing arrows into Claude.
 */
export const BACK_MAX = 8;
/** ← from the review screen opens the last question; each further ← one back. */
export const backKeys = (times = 1) => {
  if (!Number.isInteger(times) || times < 1 || times > BACK_MAX) throw new Error('bad back count');
  return Array.from({ length: times }, () => LEFT);
};
export const submitKeys = () => [ENTER];

/**
 * Free text into "Type something" (option `other`). With `selected`, the
 * cursor is already on it and its number is not sent — it would be typed.
 */
export function textKeys(other, text, { selected = false } = {}) {
  const n = number(other);
  const t = cleanText(text);
  if (!t) throw new Error('incomplete');
  const keys = [`${PASTE_START}${t}${PASTE_END}`, ENTER];
  return selected ? keys : [n, ...keys];
}
