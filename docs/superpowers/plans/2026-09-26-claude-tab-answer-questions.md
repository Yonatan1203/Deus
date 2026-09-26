# Claude tab: answer a question from the conversation view — plan (revision 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Claude asks a question (`AskUserQuestion`), the operator answers it with buttons in the conversation view — single choice, multiple choice, several questions at once, or free text — without opening the terminal.

**Architecture:** An open question is read from the **live terminal screen**, not the transcript: Claude Code writes the `AskUserQuestion` row to the transcript only after it is answered (verified 2026-09-26 on session d9ab238e — dialog on screen, no assistant row in the JSONL), so the transcript can only show a question *afterwards*. The conversation view already keeps the terminal attached and reads its buffer (`inputLine()`), so a pure module parses the question screen (current question, options, `[✔]` toggles, the review screen) into a card; every click sends its keys at once through the existing input path and the card re-reads the screen. Once submitted, the transcript's `ask` item (now carrying every question and the parsed answer) shows "Claude asked … You answered: …".

**Tech Stack:** TypeScript (server parser), vanilla ES modules (`h()` text-node helper, no HTML strings), vitest with the spike's real screen captures as fixtures, Playwright drive against the real-Claude fixture.

**Spec:** the operator's order 2026-09-26 ("add to the conversation Claude page an option to answer a question, not only from the terminal") and the keystroke spike below.

**Revision 2 (deviation from revision 1):** revision 1 built the open card from transcript items and batched all picks into one key sequence. Its drive timed out: the card never appeared because the open question is not in the transcript. Revision 2 reads the screen and sends per click; the batch builder is replaced by four small key helpers. Tasks 1 (parser) is done and unchanged; Tasks 2–4 are reworked; Task 5 is the same drive.

## Global Constraints

- Never render HTML strings; `h()` builds text nodes. CSP `style-src 'self'` — no inline styles.
- Keystrokes go only through `view().send` → `POST /api/v1/claude/live/:vid/input` (already audited, owner-checked, rate-limited). No new server route.
- No typed confirmation for typing into a session (operator decision, scope 2): answering is typing.
- Bump `web/control/sw.js` cache to `deus-control-v22` and add new modules to its SHELL list (root-relative, e.g. `'/ask-screen.js'`; `cache.addAll` is atomic).
- Verification record with screenshots in `docs/control-ui-notes.md` and `docs/control-ui/artifacts/`; screenshots use throwaway sessions only.

## The screen contract (spike, Claude Code 2.1.283, 2026-09-26)

Real captures (blank lines removed). A single question:

```
 ☐ Colour
Which colour?
❯ 1. Red
     Red
  2. Green
     Green
  3. Blue
     Blue
  4. Type something.
─────────────────────────────────────�
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```

A multi-select question inside a set of two (tab row lists every question; `☒` = answered):

```
←  ☒ Colour  ☐ Fruit  ✔ Submit  →
Which fruits?
❯ 1. [ ] Apple
         Apple
  2. [ ] Banana
         Banana
  3. [✔] Cherry
         Cherry
  4. [ ] Type something
     Submit
─────────────────────────────────────�
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
```

The review screen (after the last question is answered, or `→` past it):

```
←  ☒ Colour  ☒ Fruit  ✔ Submit  →
Review your answers
 ● Which colour?
   → Green
 ● Which fruits?
   → Apple, Cherry
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
```

"Type something" after its number is pressed: the option line becomes `❯ 4. ` followed by the typed text; Enter submits (one question) or advances (a set).

Keys, verified: a number **selects** (single choice: also advances; the only question: submits) or **toggles** (multi-select); `→` advances / opens review; `←` goes back; Enter on the review screen submits; `N+1`, text, Enter for free text. Line under each option is its description (skipped); `5. Chat about this` is below the rule and is not an option; the rule line starts with `─`.

---

### Task 1: Parser carries every question and the answer — DONE (unchanged)

`src/control-ui/api/claude-conversation.ts`: `AskQuestion`, `ask` item `{ id, questions, answered, answer? }`, `parseAskAnswer`. Tests pass (11). Used by Task 4 for the answered card only.

### Task 2: Screen parser — `parseAskScreen(lines)`

**Files:**
- Create: `web/control/ask-screen.js`
- Test: `scripts/tests/control-ui-ask-screen.test.ts` (`// @ts-expect-error` above the plain-JS import, as `control-ui-composer.test.ts`)

**Interfaces:**
- Produces: `parseAskScreen(lines: string[]) → null | Question | Review`
  - `Question = { kind: 'question', question: string, tabs: [{ label, done }], multi: boolean, options: [{ n, label, on }], other: number, cursor: number }` — `other` is the number of "Type something", `cursor` the `❯` line's number (0 if none), `on` from `[✔]`.
  - `Review = { kind: 'review', answers: [{ question, answer }] }`.
  - `null` when no question screen is on the last 60 lines.
- Bounds: labels clipped to 120 chars, at most 8 options, 6 tabs. (Independent of Task 1's transcript-side caps — two data sources, no shared contract; the screen shows what Claude Code drew, the transcript what the tool received.)

- [ ] **Step 1: Tests** — the three captures above verbatim as string arrays, plus a no-dialog buffer (an ordinary `❯ ` prompt and some assistant text) → `null`, plus the "Type something selected" state (`❯ 4. Purple` line) → `cursor: 4`, `other: 4`.

```ts
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import { parseAskScreen } from '../../web/control/ask-screen.js';

const SINGLE = [' ☐ Colour', 'Which colour?', '❯ 1. Red', '     Red', '  2. Green', '     Green', '  3. Blue', '     Blue', '  4. Type something.', '─────────', '  5. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel'];
const MULTI = ['←  ☒ Colour  ☐ Fruit  ✔ Submit  →', 'Which fruits?', '❯ 1. [ ] Apple', '         Apple', '  2. [ ] Banana', '         Banana', '  3. [✔] Cherry', '         Cherry', '  4. [ ] Type something', '     Submit', '─────────', '  5. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'];
const REVIEW = ['←  ☒ Colour  ☒ Fruit  ✔ Submit  →', 'Review your answers', ' ● Which colour?', '   → Green', ' ● Which fruits?', '   → Apple, Cherry', 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'];
const PROMPT = ['● Done.', '─────────', '❯ ', '─────────', '  ⏵⏵ auto mode on'];

describe('parseAskScreen', () => {
  it('reads a single-choice question', () => {
    expect(parseAskScreen([...PROMPT.slice(0, 1), ...SINGLE])).toEqual({
      kind: 'question', question: 'Which colour?', tabs: [{ label: 'Colour', done: false }], multi: false,
      options: [{ n: 1, label: 'Red', on: false }, { n: 2, label: 'Green', on: false }, { n: 3, label: 'Blue', on: false }],
      other: 4, cursor: 1,
    });
  });
  it('reads a multi-select question with its toggles and the tab row', () => {
    const q = parseAskScreen(MULTI);
    expect(q.multi).toBe(true);
    expect(q.tabs).toEqual([{ label: 'Colour', done: true }, { label: 'Fruit', done: false }]);
    expect(q.options.map((o) => [o.label, o.on])).toEqual([['Apple', false], ['Banana', false], ['Cherry', true]]);
    expect(q.other).toBe(4);
  });
  it('reads the review screen', () => {
    expect(parseAskScreen(REVIEW)).toEqual({ kind: 'review', answers: [{ question: 'Which colour?', answer: 'Green' }, { question: 'Which fruits?', answer: 'Apple, Cherry' }] });
  });
  it('sees the typed text on the "Type something" line', () => {
    const lines = SINGLE.map((l) => l.replace('❯ 1. Red', '  1. Red').replace('  4. Type something.', '❯ 4. Purple'));
    expect(parseAskScreen(lines)).toMatchObject({ cursor: 4, other: 4, options: [{ n: 1, label: 'Red', on: false }, { n: 2 }, { n: 3 }] });
  });
  it('is null on an ordinary prompt and on stale text above a prompt', () => {
    expect(parseAskScreen(PROMPT)).toBeNull();
    expect(parseAskScreen([...SINGLE, ...PROMPT])).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement**

```js
// Reads Claude Code's question screen out of the terminal buffer: the
// current question, its options with their [✔] toggles, the tab row of a
// multi-question set, and the "Review your answers" screen. Captures the
// parser is written against are in
// docs/superpowers/plans/2026-09-26-claude-tab-answer-questions.md.
const FOOT_RE = /^Enter to select ·/;
const REVIEW_RE = /^Ready to submit your answers\?/;
const OPT_RE = /^\s*(❯)?\s*(\d+)\.\s+(?:\[([ ✔x])\]\s+)?(.*)$/;
const TAB_RE = /([☐☒])\s+([^☐☒✔←→]+?)(?=\s{2,}|\s*$)/g;
const RULE_RE = /^[─]/;
const OPTIONS_MAX = 8;
const TABS_MAX = 6;
const LABEL_MAX = 120;
const clip = (s) => s.trim().slice(0, LABEL_MAX);

/** `lines`: the last rows of the screen, top to bottom. */
export function parseAskScreen(lines) {
  const last = lines.length - 1;
  // The question screen must be the live one: nothing but blanks after its footer.
  const tail = (i) => lines.slice(i + 1).every((l) => !l.trim());
  for (let i = last; i >= 0; i--) {
    if (REVIEW_RE.test(lines[i])) {
      if (!lines.slice(i + 1).some((l) => /^\s*❯?\s*1\.\s+Submit answers/.test(l))) return null;
      const answers = [];
      for (let j = i - 1; j >= 0 && answers.length < TABS_MAX; j--) {
        const a = /^\s*→\s+(.*)$/.exec(lines[j]);
        const q = /^\s*●\s+(.*)$/.exec(lines[j]);
        if (a) answers.unshift({ question: '', answer: clip(a[1]) });
        else if (q && answers.length && !answers[0].question) answers[0].question = clip(q[1]);
        else if (/^Review your answers/.test(lines[j])) break;
      }
      return { kind: 'review', answers };
    }
    if (FOOT_RE.test(lines[i]) && tail(i)) return question(lines, i);
    if (/^\s*❯\s?/.test(lines[i]) && lines[i].trim().length <= 2) return null; // an ordinary empty prompt
  }
  return null;
}

function question(lines, foot) {
  let rule = foot - 1;
  while (rule >= 0 && !RULE_RE.test(lines[rule])) rule--;
  if (rule < 0) return null;
  const options = [];
  let other = 0, cursor = 0, multi = false, first = rule;
  for (let j = rule - 1; j >= 0; j--) {
    const m = OPT_RE.exec(lines[j]);
    if (!m) { if (options.length || other) { first = j + 1; if (!/^\s+\S/.test(lines[j])) break; else continue; } continue; }
    const n = Number(m[2]);
    if (m[1]) cursor = n;
    if (m[3] !== undefined) { multi = true; }
    if (/^Type something\.?$/.test(m[4].trim()) || (cursor === n && !other && n > options.length && !options.some((o) => o.n === n))) { other = n; first = j; continue; }
    options.unshift({ n, label: clip(m[4]), on: m[3] === '✔' || m[3] === 'x' });
    first = j;
    if (options.length > OPTIONS_MAX) return null;
  }
  // "Type something" with text typed replaces its label; it is the highest number.
  if (!other) { const top = Math.max(0, ...options.map((o) => o.n)); const typed = options.find((o) => o.n === top && o.n > 1 && cursor === o.n && !/^\S/.test(o.label) === false); if (typed) { other = typed.n; options.splice(options.indexOf(typed), 1); } }
  if (!options.length) return null;
  // The question is the first non-empty line above the options; the tab row above it.
  let q = first - 1;
  while (q >= 0 && !lines[q].trim()) q--;
  const questionText = q >= 0 ? clip(lines[q]) : '';
  const tabs = [];
  if (q - 1 >= 0) for (const t of lines[q - 1].matchAll(TAB_RE)) { if (tabs.length >= TABS_MAX) break; tabs.push({ label: clip(t[2]), done: t[1] === '☒' }); }
  return { kind: 'question', question: questionText, tabs, multi, options, other, cursor };
}
```

The implementer simplifies the "Type something" detection to one rule and keeps the tests green: an option line whose label is `Type something`/`Type something.` is `other`; otherwise, when the cursor sits on the highest-numbered option and that option's number is one above the last real option, it is the typed "Type something" line (its label is the typed text). Descriptions (the indented line under each option without a number) are skipped by `OPT_RE` not matching.

- [ ] **Step 4: Run — expect PASS.**

### Task 3: Key helpers — `ask-keys.js` reworked

**Files:**
- Modify: `web/control/ask-keys.js` (replace `answerKeys`)
- Modify: `scripts/tests/control-ui-ask-keys.test.ts`

**Interfaces:**
- Produces: `pickKeys(n) → [String(n)]`; `nextKeys() → ['\x1b[C']`; `backKeys() → ['\x1b[D']`; `submitKeys() → ['\r']`; `textKeys(other, text, { selected = false } = {}) → [String(other)?, PASTE_START + cleanText(text) + PASTE_END, '\r']` — the leading number is sent only when `selected` is false, i.e. the cursor is not already on "Type something" (once it is, a digit would be typed into the text). Throws `'incomplete'` on empty text, `'bad pick'` when `n` is not a positive integer ≤ 9. `cleanText`, `PASTE_*`, `TEXT_MAX` stay.

- [ ] **Step 1: Tests** — replace the file's cases: each helper's exact output; `textKeys(4, 'Purple')` is `['4', paste, '\r']` and `textKeys(4, 'Purple', { selected: true })` is `[paste, '\r']`; `textKeys(4, 'a\x1bb\r\nc')[1]` is `PASTE_START + 'ab c' + PASTE_END`; `textKeys(4, '  ')` throws `incomplete`; `pickKeys(0)` and `pickKeys(10)` throw `bad pick`.
- [ ] **Step 2: Implement** as listed; the header comment keeps the verified-keys summary.
- [ ] **Step 3: Run — expect PASS.**

### Task 4: The live card in the conversation view; the answered card from the transcript

**Files:**
- Modify: `web/control/conversation.js` — `askCard(it, h, handlers)` renders the **answered/plain** card only (drop the open-with-buttons branch, `handlers.answer`, `handlers.picks`; keep "Answer in terminal" for an unanswered transcript item, which cannot occur today but costs nothing).
- Modify: `web/control/views/claude.js` — `screenLines()` on the view; the live card; **and the removal of the revision-1 code** (Step 0 below).
- Modify: `web/control/composer.js` — a real lock (Step 3).
- Modify: `web/control/app.css` — keep the declarations from revision 1, rename the selectors: `.conv-ask[data-open]` → `.conv-ask.live`, `.conv-ask[data-sending]` → `.conv-ask.live[data-sending]`, and extend the dimming rule's descendant list to `.conv-opt, .ask-send, .ask-submit, .ask-back, .ask-next` so review-screen actions dim while their keys are being sent (plan-review round 5).
- Modify: `web/control/sw.js` — `deus-control-v22`, SHELL gains `'/ask-screen.js'` (and `'/ask-keys.js'`, already added).

- [ ] **Step 0: Remove the revision-1 wiring in `conversationView`** (already in the worktree, uncommitted) so nothing is declared twice: delete `const picks = new Map();`, `let sending = false;`, `let openAsk = false;`, the whole `async function answer(...)`, the `|| sending` / `|| sending` guards added to `poll()`, the `answer, picks` handler entries in the `renderConversation(...)` call, and the `open` set / `picks` pruning / `openAsk = ...` lines after it. Keep the existing `const later = ...` (declared once, above `stop()`) and reuse it — do not redeclare. `setSession` keeps `let row = s;` and the `row = next;` assignment; its banner line changes in Step 3.

**Interfaces:**
- `view.screenLines(max = 60) → string[]`: the last `max` rows of `term.buffer.active`, `translateToString(true)`, trailing blank rows dropped.
- DOM contract for the drive: `.conv-ask.live[data-kind="question"|"review"]`, `.ask-tabs .chip[data-done]`, `button.conv-opt[data-n]` (`aria-pressed` on multi), `button.ask-other`, `input.ask-text`, `button.ask-send` (free text), `button.ask-next` (multi: `→`), `button.ask-submit` (review: Enter), `button.ask-back` (review: `←`), `button.ask-term`; the answered transcript card `.conv-ask.answered .ask-answer`.

- [ ] **Step 1: `screenLines()`** next to `inputLine()`:

```js
    /** The last rows of the screen, top to bottom, trailing blanks dropped. */
    screenLines(max = 60) {
      const b = term.buffer.active;
      const out = [];
      for (let y = Math.max(0, b.length - max); y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) ?? '');
      while (out.length && !out[out.length - 1].trim()) out.pop();
      return out;
    },
```

- [ ] **Step 2: The live card** in `conversationView`, after `listEl`:

```js
    import { parseAskScreen } from '../ask-screen.js';
    import { pickKeys, nextKeys, backKeys, submitKeys, textKeys } from '../ask-keys.js';
    ...
    const askEl = h('div', { class: 'conv-ask live', hidden: true });
    // placed inside .conv-col after listEl so it scrolls with the conversation
    let askState = null;     // last parsed screen, to avoid redrawing an unchanged card
    let askText = null;      // { value } while "Other…" is open; kept across redraws
    let askSending = false;  // `later` is the existing helper declared above stop()
    async function sendKeys(keys) {
      if (askSending || !view()) return;
      askSending = true; askEl.dataset.sending = 'true';
      try { for (const k of keys) { if (!view()) break; view().send(k, { focus: false }); await later(150); } }
      finally { askSending = false; delete askEl.dataset.sending; }
      await later(250); readScreen();
    }
    function readScreen() {
      if (askSending) return;
      const v = view();
      const st = v ? parseAskScreen(v.screenLines()) : null;
      const key = JSON.stringify(st);
      if (key === askState) return;
      askState = key;
      if (!st) { askText = null; askEl.hidden = true; askEl.replaceChildren(); setSession(row); return; }
      drawAsk(st); askEl.hidden = false; setSession(row);
      if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 200) scroller.scrollTop = scroller.scrollHeight;
    }
```

`drawAsk(st)`:

```js
    function drawAsk(st) {
      askEl.dataset.kind = st.kind;
      const term = h('button', { type: 'button', class: 'small ask-term', onclick: openTerminal }, 'Answer in terminal');
      if (st.kind === 'review') {
        askEl.replaceChildren(
          h('div', {}, h('strong', {}, 'Review your answers')),
          ...st.answers.map((a) => h('div', { class: 'ask-q', dir: 'auto' }, a.question ? h('div', { class: 'muted' }, a.question) : null, h('div', {}, a.answer))),
          h('div', { class: 'ask-foot' },
            h('div', { class: 'conv-opts' },
              h('button', { type: 'button', class: 'small primary ask-submit', onclick: () => sendKeys(submitKeys()) }, 'Submit answers'),
              h('button', { type: 'button', class: 'small ask-back', onclick: () => sendKeys(backKeys()) }, 'Change answers')),
            term));
        return;
      }
      const typing = st.cursor === st.other && st.other > 0; // "Type something" is selected
      if (typing && !askText) askText = { value: '' };
      if (!typing) askText = null;
      const tabs = st.tabs.length > 1 ? h('div', { class: 'ask-tabs conv-opts' }, ...st.tabs.map((t) => h('span', { class: 'chip', 'data-done': String(t.done) }, t.done ? '✓ ' : '', t.label))) : null;
      const opts = st.options.map((o) => h('button', {
        type: 'button', class: `conv-opt${o.on ? ' on' : ''}`, 'data-n': String(o.n), 'aria-pressed': st.multi ? String(o.on) : null,
        onclick: () => sendKeys(pickKeys(o.n)),
      }, o.label));
      const other = h('button', { type: 'button', class: `conv-opt ask-other${typing ? ' on' : ''}`, onclick: () => { if (!typing) sendKeys(pickKeys(st.other)); } }, 'Other…');
      const input = typing ? h('input', { class: 'ask-text', type: 'text', maxlength: '2000', placeholder: 'Type your answer', 'aria-label': 'Your answer', dir: 'auto', value: askText.value,
        oninput: (e) => { askText.value = e.target.value; sendBtn.disabled = !e.target.value.trim(); },
        onkeydown: (e) => { if (e.key === 'Enter' && askText.value.trim()) { e.preventDefault(); submitText(); } } }) : null;
      const sendBtn = h('button', { type: 'button', class: 'small primary ask-send', disabled: !(askText && askText.value.trim()), onclick: submitText }, 'Send answer');
      // The box only exists while the cursor is on "Type something", so the
      // number is never re-sent: it would be typed into the answer.
      function submitText() { const t = askText ? askText.value : ''; if (!t.trim()) return; askText = null; sendKeys(textKeys(st.other, t, { selected: true })); }
      askEl.replaceChildren(
        h('div', {}, h('strong', {}, 'Claude is asking')),
        tabs,
        h('div', { class: 'ask-q' }, h('div', { dir: 'auto' }, st.question), h('div', { class: 'conv-opts' }, ...opts, st.other ? other : null), input),
        h('div', { class: 'ask-foot' },
          typing ? sendBtn : st.multi ? h('button', { type: 'button', class: 'small primary ask-next', onclick: () => sendKeys(nextKeys()) }, st.tabs.length > 1 ? 'Next' : 'Done') : h('span', { class: 'muted' }, 'Pick one, or write your own.'),
          term));
      if (input) input.focus();
    }
```

The screen is read at the start of every poll tick (see Step 3 for the placement — before the transcript fetch, never behind `r.unchanged`), 400 ms after any composer send, and after each `sendKeys`. The typed text box keeps focus and value across redraws because `askText` survives and an unchanged screen is not redrawn.

- [ ] **Step 3: Banner and composer lock.** `setSession`: `banner.hidden = label !== 'needs you' || !askEl.hidden;`. While a question is open, anything typed into the composer would land in the dialog, so the composer is **locked**, not merely marked busy. In `web/control/composer.js` add to the returned object:

```js
    /** A locked box takes no input and cannot submit; `why` is shown in its place. */
    lock(why) { locked = true; input.disabled = true; input.placeholder = why; sendBtn.disabled = true; },
    unlock() { locked = false; input.disabled = false; input.placeholder = o.placeholder; sendBtn.disabled = false; },
```

with `let locked = false;` and `if (locked) return;` as the first line of `submit()` (the `keydown` Enter path calls `submit()`, so this gates both routes; `setBusy` is unchanged; `o` is `createComposer`'s options object, the only place the placeholder text lives). `readScreen()` calls `composer.lock('Answer the question above first')` when a card is shown and `composer.unlock()` when it hides (only if it locked it — a `lockedByAsk` flag — so the busy state from a running turn is untouched). No unit test: this repo runs vitest without a DOM (no jsdom/happy-dom; `control-ui-composer.test.ts` covers the pure helpers only, by design), so the lock is verified in the browser by Task 5's drive — composer disabled with that placeholder while the card is open, Enter in it sends nothing, unlocked after submit.

`poll()` reads the screen **before** the transcript fetch, unconditionally — the transcript is unchanged for the whole time a question is open (`r.unchanged` every tick), so a screen read placed after that early return would never run while it matters:

```js
    async function poll() {
      if (disposed || !view() || !visible()) return;
      readScreen();            // no network; the terminal buffer is local
      try {
        const r = await api.get(`/api/v1/claude/live/${view().vid}/conversation?v=${encodeURIComponent(version)}`);
        if (disposed || r.unchanged) return;
        ... (unchanged from here)
```

`readScreen()` guards itself against re-entry while `askSending` (return early) so a poll tick cannot redraw the card mid-send.

- [ ] **Step 4: `conversation.js`** — `askCard` keeps only the plain/answered branch (no `handlers.answer`); update its doc comment; `renderConversation`'s comment loses the `answer`/`picks` sentence.

- [ ] **Step 5: sw.js** — `'/ask-screen.js'` added; version v22.

- [ ] **Step 6: Unit run** `npx vitest run scripts/tests src/control-ui`; syntax-check the three modules; `npm run build`.

### Task 5: Drive against the real-Claude fixture, screenshots, notes

**Files:**
- Modify: `$CLAUDE_JOB_DIR/tmp/live/ask.mjs` (drive, not committed)
- Create: `docs/control-ui/artifacts/claude-ask-{open,review,answered,mobile}.png`
- Modify: `docs/control-ui-notes.md` (verification record)

- [ ] **Step 1: Drive** — fixture `serve.mjs` (3117, real claude). Session A (single Colour + multi Fruit): wait `.conv-ask.live[data-kind="question"]`; assert tabs `Colour`, `Fruit`; assert the composer is locked (`.conv-input` disabled, placeholder `Answer the question above first`) and the banner hidden; screenshot; click `Green` → the card now shows `Which fruits?` with `aria-pressed` buttons; click `Apple`, `Cherry` → both `.on`; click `Next` → `[data-kind="review"]` listing `Green` and `Apple, Cherry`; screenshot; click `Submit answers` → card hides, composer unlocked, then `.conv-ask.answered .ask-answer` text is **exactly** `You answered: Green · Apple, Cherry`; the transcript `tool_result` contains `"Which colour?"="Green", "Which fruits?"="Apple, Cherry"` exactly. Session B (single question): click `Other…` → `.ask-text`; type `Purple`, Enter → answered card text is exactly `You answered: Purple` (a stray digit would fail this). Session C (two questions, free text on the first): `Other…`, `Purple`, `Send answer` → second question shows; pick `Banana`, `Next`, `Submit answers` → exactly `You answered: Purple · Banana`. Phone viewport (390×844) screenshot of A's open card via `#/claude/<id>`; `scripts/control-ui-screenshot.mjs` overflow check. Stop the three sessions afterwards (`ask-cleanup.mjs`).

- [ ] **Step 2: Record** the results (what was clicked, what the screen and transcript said, screenshot names, the transcript-timing finding) in `docs/control-ui-notes.md`.

- [ ] **Step 3: Reviews** — code-reviewer, ux-reviewer, copy-writer (strings: "Claude is asking", "Review your answers", "Submit answers", "Change answers", "Other…", "Send answer", "Next", "Done", "Pick one, or write your own.", "You answered: ", "Answer the question above first"), verification-gate; commit; merge into the live checkout; `npm run build`; restart; confirm v22 served.

## Self-review

- Spec coverage: single ✔, multi ✔ (toggle + Next), several questions ✔ (tabs + review), free text ✔ (Other… → text → Send), answered state ✔ (transcript), terminal fallback ✔, banner/composer ✔.
- The parser is written against real captures; the unverified case (free text inside a set) is exercised by Session C, and the review screen by Session A.
- Nothing keyed by list position; the live card is a single element outside the item list.
