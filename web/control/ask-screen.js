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
      // Back on an answered question, Claude Code marks the earlier answer with a trailing ✔.
      const label = m[4].replace(/\s*✔\s*$/, '');
      rows.push({ n: Number(m[2]), label: clip(label), on: m[3] === '✔' || m[3] === 'x' || label !== m[4], cursor: !!m[1], described, descriptionOf: -1 });
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
// 2.1.283 adds segments such as `· thinking with medium effort` before the `)`.
const WORKING_RE = /^\s*[·✢✳✶✻✽]\s+([A-Z][A-Za-z' -]{1,40})…\s*\((\d{1,6})s(?:\s*·\s*[↑↓]\s*([\d.]+k?)\s*tokens)?(?:\s*·[^)]*)?\)/;

/** `{ verb, seconds, tokens }` while Claude works, else null. */
export function parseWorking(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = WORKING_RE.exec(lines[i]);
    if (m) return { verb: m[1].trim(), seconds: Number(m[2]), tokens: m[3] || '' };
  }
  return null;
}

// ---- Claude Code's other menus (plan approval, "Switch model?", tool
// permissions, /model without arguments): a run of numbered rows with one ❯
// cursor, optional indented hint rows under an option, footer rows below,
// the prompt text above. Written against captures of 2.1.283 (the fixtures
// in scripts/tests/control-ui-menu-screen.test.ts). The caller tries
// parseAskScreen first; an AskUserQuestion screen never reaches this, and
// would return null anyway (its last numbered row sits under a rule row).
// Wired into the conversation view by the parity card (#44b); until then it
// is exercised by its tests only.
const MENU_NUM_RE = /^(\s*)(❯)?\s*(\d{1,2})\.\s+(.*)$/;
const MENU_RULE_RE = /^\s*[─╌▔━]/;
const MENU_BORDER_RE = /^\s*[╭│╰]/;
const MENU_ESC_RE = /\besc\b/i;
const PROMPT_MAX = 8;
export function parseMenuScreen(lines) {
  const rows = lines.slice(-60);
  // 1. trailing blank and rule rows are not part of anything
  let end = rows.length;
  while (end > 0 && (!rows[end - 1].trim() || MENU_RULE_RE.test(rows[end - 1]))) end--;
  const buf = rows.slice(0, end);
  // 2a. the numbered rows; the bottommost is the anchor
  const numbered = [];
  buf.forEach((l, i) => { const m = MENU_NUM_RE.exec(l); if (m) numbered.push({ i, m }); });
  if (numbered.length < 2) return null;
  const anchor = numbered[numbered.length - 1];
  const numberCol = anchor.m[1].length + (anchor.m[2] ? 2 : 0);
  const leading = (l) => l.length - l.trimStart().length;
  const isCont = (l) => l.trim() !== '' && !MENU_NUM_RE.test(l) && !MENU_RULE_RE.test(l) && !MENU_BORDER_RE.test(l) && leading(l) > numberCol;
  // 2b. up from the anchor: numbered rows join; indented rows are held and
  // become the hint of the next numbered row reached (they sit under it)
  const run = [{ m: anchor.m, hints: [] }];
  let pending = [];
  let top = anchor.i;
  for (let i = anchor.i - 1; i >= 0; i--) {
    const l = buf[i];
    const m = MENU_NUM_RE.exec(l);
    if (m) { run.unshift({ m, hints: pending.reverse() }); pending = []; top = i; }
    else if (isCont(l)) pending.push(l.trim());
    else break;
  }
  // down from the anchor: its own hints; everything after is footer
  let below = anchor.i + 1;
  const own = [];
  for (; below < buf.length && isCont(buf[below]); below++) own.push(buf[below].trim());
  run[run.length - 1].hints = own;
  if (run.some((r, k) => Number(r.m[3]) !== k + 1)) return null;
  if (run.filter((r) => r.m[2]).length !== 1) return null;
  // 3. footer: esc offered?
  let esc = false;
  for (let i = below; i < buf.length; i++) if (MENU_ESC_RE.test(buf[i])) esc = true;
  const options = run.map((r) => {
    let label = r.m[4].trim();
    if (/\(esc\)$/i.test(label)) { esc = true; label = label.replace(/\s*\(esc\)$/i, ''); }
    const o = { n: Number(r.m[3]), label: clip(label) };
    if (r.hints.length) o.hint = clip(r.hints.join(' '));
    return o;
  });
  const selected = Number(run.find((r) => r.m[2]).m[3]);
  // 4. the prompt: skip blank rows above the run, then collect until a rule,
  // a blank row or a box border, at most PROMPT_MAX rows, in reading order
  let i = top - 1;
  while (i >= 0 && !buf[i].trim()) i--;
  const prompt = [];
  while (i >= 0 && prompt.length < PROMPT_MAX) {
    const l = buf[i];
    if (!l.trim() || MENU_RULE_RE.test(l) || MENU_BORDER_RE.test(l)) break;
    prompt.unshift(clip(l));
    i--;
  }
  return { kind: 'menu', prompt, options, selected, esc };
}

// ---- the reply as it is written, and the running tool (quality pass B).
// Claude Code streams the reply to the screen: a `● ` start row, two-space
// continuation rows, blank rows between paragraphs, then blank rows and the
// working line. Tool headers share the `● ` marker; they are matched
// strictly so a reply that merely begins with "Searched…" stays a reply.
const TOOL_HEAD_RES = [/^● [A-Z][A-Za-z]*\(/, /^● Running \d+ /, /^● Ran \d+ /, /^● Searched \d+ /, /^● Read \d+ (file|line)/, /^● (Updated plan|Entered plan mode|Compacted)\b/];
const isToolHead = (l) => TOOL_HEAD_RES.some((re) => re.test(l));
const HINT_ROW_RE = /^\s*\((ctrl|shift|alt|cmd)\+/i;
const CONT_RE = /^ {2}(?! ?⎿)\S/;
const workingIndex = (rows) => { for (let i = rows.length - 1; i >= 0; i--) if (WORKING_RE.test(rows[i])) return i; return -1; };

/** `{ text, partial }` for the reply under way, or null. */
export function parseLiveReply(lines) {
  const rows = lines.slice(-60);
  const w = workingIndex(rows);
  if (w < 0) return null;
  let i = w - 1;
  while (i >= 0 && !rows[i].trim()) i--;
  const out = [];
  let partial = true;
  for (; i >= 0; i--) {
    const l = rows[i];
    if (!l.trim()) {
      // a paragraph break only when a reply row sits above it
      const above = i > 0 ? rows[i - 1] : '';
      const aboveIsReply = CONT_RE.test(above) || (above.startsWith('● ') && !isToolHead(above));
      if (!aboveIsReply) break;
      if (out.length && out[0] !== '') out.unshift('');
      continue;
    }
    if (RULE_RE.test(l) || HINT_ROW_RE.test(l) || /^\s*⎿/.test(l) || l.startsWith('❯') || TAB_RE.test(l)) break;
    if (l.startsWith('● ')) {
      if (isToolHead(l)) break;
      out.unshift(l.slice(2));
      partial = false;
      break;
    }
    if (CONT_RE.test(l)) { out.unshift(l.slice(2)); continue; }
    break;
  }
  while (out.length && out[0] === '') out.shift();
  if (!out.some((l) => l.trim())) return null;
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
  return { text, partial };
}

const TOOL_LABEL_MAX = 60; // a long command must not push the working line past a phone's width
const clipTool = (s) => { const t = s.trim(); return t.length > TOOL_LABEL_MAX ? `${t.slice(0, TOOL_LABEL_MAX - 1)}…` : t; };
/** `{ label }` for a tool still running above the working line, or null. */
export function parseRunningTool(lines) {
  const rows = lines.slice(-60);
  const w = workingIndex(rows);
  if (w < 0) return null;
  for (let i = w - 1; i >= 0; i--) {
    const l = rows[i];
    if (!l.trim() || HINT_ROW_RE.test(l) || /^\s*⎿/.test(l)) continue; // the gap, hints and the tool's own rows
    if (l.startsWith('● ') && isToolHead(l)) {
      const child = rows.slice(i + 1, w).find((r) => /^\s*⎿/.test(r)) || '';
      const cmd = /⎿\s*\$\s*(.+?)(?:\s*\((\d+)s\))?\s*$/.exec(child);
      if (cmd) return { label: `$ ${clipTool(cmd[1])}${cmd[2] ? ` · ${cmd[2]}s` : ''}` };
      if (/⎿\s*Running/.test(child)) return { label: clipTool(l.slice(2).replace(/…$/, '')) };
      const m = /^● (Running \d+ [^·…]+)/.exec(l);
      if (m) return { label: clipTool(m[1]) };
      return null;
    }
    if (l.startsWith('● ')) return null; // a reply row: nothing is running
  }
  return null;
}

/**
 * The normal input box: a `❯` line (empty or with typed text, possibly wrapped)
 * between two horizontal rules, near the bottom, with no numbered option on
 * screen. Claude Code reports a session as blocked when its reply ended by
 * asking in plain words; at this box the answer is simply typed — nothing for
 * the fallback notice to point at. Written against a live capture (2026-09-28).
 */
export function parseIdlePrompt(lines) {
  const rows = lines.filter((l) => l.trim()).slice(-12);
  if (rows.some((l) => /^\s*❯?\s*\d{1,2}\.\s/.test(l))) return false;
  for (let i = 1; i < rows.length; i++) {
    if (!/^\s*❯(\s|$)/.test(rows[i]) || !MENU_RULE_RE.test(rows[i - 1])) continue;
    if (rows.slice(i + 1).some((l) => MENU_RULE_RE.test(l))) return true;
  }
  return false;
}
