// Reads Claude Code's question screen out of the terminal buffer: the
// current question, its options with their [✔] toggles, the tab row of a
// multi-question set, and the "Review your answers" screen. Written against
// real captures (docs/superpowers/plans/2026-09-26-claude-tab-answer-questions.md).
// The transcript gets the question only once it is answered, so this is the
// only way to see an open one.

const FOOT_RE = /^Enter to select ·/;
const REVIEW_RE = /^Ready to submit your answers\?/;
const SUBMIT_RE = /^\s*❯?\s*1\.\s+Submit answers/;
const OPT_RE = /^\s*(❯)?\s*(\d+)\.\s+(?:\[([ ✔x])\]\s+)?(.*)$/;
const TAB_RE = /([☐☒])\s+(.+?)(?=\s{2,}[☐☒✔←→]|\s*$)/g;
const RULE_RE = /^[─]/;
const EMPTY_PROMPT_RE = /^\s*❯\s*$/;
const OTHER_RE = /^Type something\.?$/;
const OPTIONS_MAX = 8;
const TABS_MAX = 6;
const LABEL_MAX = 120;
const clip = (s) => { const t = s.trim(); return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t; };
// Below a live dialog there are only blank rows and the closing rule line
// (which may carry the session name). On a narrow screen the footer wraps,
// so the rows between it and that rule are still the footer.
function onlyTrailing(lines, i) {
  let j = i + 1;
  while (j < lines.length && !RULE_RE.test(lines[j]) && lines[j].trim() && !/^\s*❯/.test(lines[j])) j++;
  return lines.slice(j).every((l) => !l.trim() || RULE_RE.test(l));
}

/** `lines`: the last rows of the screen, top to bottom. */
export function parseAskScreen(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (EMPTY_PROMPT_RE.test(l)) return null; // Claude's own prompt is the live screen
    if (FOOT_RE.test(l)) return onlyTrailing(lines, i) ? question(lines, i) : null;
    if (REVIEW_RE.test(l)) return review(lines, i);
  }
  return null;
}

function review(lines, ready) {
  // "1. Submit answers" and "2. Cancel" follow; anything else below is stale.
  const submit = lines.findIndex((l, j) => j > ready && SUBMIT_RE.test(l));
  if (submit < 0 || !onlyTrailing(lines, submit + 1)) return null;
  const answers = [];
  let start = ready;
  while (start > 0 && !/^Review your answers/.test(lines[start])) start--;
  for (let j = start + 1; j < ready && answers.length < TABS_MAX; j++) {
    const q = /^\s*●\s+(.*)$/.exec(lines[j]);
    const a = /^\s*→\s+(.*)$/.exec(lines[j]);
    if (q) answers.push({ question: clip(q[1]), answer: '' });
    else if (a && answers.length) answers[answers.length - 1].answer = clip(a[1]);
  }
  return { kind: 'review', answers };
}

function question(lines, foot) {
  let rule = foot - 1;
  while (rule >= 0 && !RULE_RE.test(lines[rule])) rule--;
  if (rule < 0) return null;
  const rows = []; // option rows, bottom-up: { n, label, on, cursor, described }
  let multi = false;
  let top = rule - 1;
  for (; top >= 0; top--) {
    const l = lines[top];
    const m = OPT_RE.exec(l);
    if (m) {
      const described = rows.length ? rows[rows.length - 1].descriptionOf === top : false;
      rows.push({ n: Number(m[2]), label: clip(m[4]), on: m[3] === '✔' || m[3] === 'x', cursor: !!m[1], described, descriptionOf: -1 });
      if (m[3] !== undefined) multi = true;
      if (rows.length > OPTIONS_MAX + 1) return null;
      continue;
    }
    if (!l.trim() || /^\s/.test(l)) { // an option's description line
      if (rows.length) rows[rows.length - 1].descriptionOf = top - 1;
      continue;
    }
    break; // the question line
  }
  if (top < 0 || !rows.length) return null;
  rows.reverse();
  // "Type something" is the last option; with text typed, its label is the
  // text and the cursor sits on it (a number key never moves the cursor).
  let other = 0;
  let cursor = 0;
  const options = [];
  rows.forEach((r, idx) => {
    if (r.cursor) cursor = r.n;
    const last = idx === rows.length - 1;
    if (OTHER_RE.test(r.label) || (last && r.cursor && !other && rows.length > 1 && !r.described)) { other = r.n; return; }
    options.push({ n: r.n, label: r.label, on: r.on });
  });
  if (!options.length || options.length > OPTIONS_MAX) return null;
  // A long question wraps onto several rows; they run up to a blank row or
  // the tab row.
  const isTabRow = (l) => /[☐☒]/.test(l);
  let first = top;
  while (first - 1 >= 0 && lines[first - 1].trim() && !isTabRow(lines[first - 1])) first--;
  const questionText = clip(lines.slice(first, top + 1).map((l) => l.trim()).join(' '));
  const tabs = [];
  let tabRow = first - 1;
  while (tabRow >= 0 && !lines[tabRow].trim()) tabRow--;
  if (tabRow >= 0) for (const t of lines[tabRow].matchAll(TAB_RE)) { if (tabs.length >= TABS_MAX) break; tabs.push({ label: clip(t[2]), done: t[1] === '☒' }); }
  return { kind: 'question', question: questionText, tabs, multi, options, other, cursor };
}

// Claude Code's status line while it works — `✻ Spinning… (14s · ↓ 103 tokens)`:
// one of its spinner frames, its own verb, elapsed seconds, sometimes tokens.
// The bottom-most such row is the live one (captured 2026-09-26).
const WORKING_RE = /^\s*[·✢✳✶✻✽]\s+([A-Z][A-Za-z' -]{1,40})…\s*\((\d{1,6})s(?:\s*·\s*[↑↓]\s*([\d.]+k?)\s*tokens)?\)/;

/** `{ verb, seconds, tokens }` while Claude works, else null. */
export function parseWorking(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = WORKING_RE.exec(lines[i]);
    if (m) return { verb: m[1].trim(), seconds: Number(m[2]), tokens: m[3] || '' };
  }
  return null;
}
