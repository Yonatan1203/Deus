import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import {
  parseAskScreen,
  parseMenuScreen,
} from '../../web/control/ask-screen.js';

// Real screens captured 2026-09-27 from Claude Code 2.1.283 (session names
// and paths replaced), as the terminal buffer holds them; the permission
// prompt is Claude Code's own wording, typed in by hand (auto mode on this
// host never showed one).
const PLAN_APPROVAL = [
  '',
  '  ⎿  /plan to preview',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '',
  '  ──────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '   Ready to code?',
  '',
  "   Here is Claude's plan:",
  '  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '   create hello.txt containing hello',
  '  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '',
  '  ──────────────────────────────────────────────────────────────────────────────────────────────────────────',
  '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
  '',
  '   ❯ 1. Yes, and use auto mode',
  '     2. Yes, manually approve edits',
  '     3. Tell Claude what to change',
  '        shift+tab to approve with this feedback',
  '',
  '   ctrl+g to edit in Vim · ~/.claude/plans/example.md',
  '',
];
const SWITCH_MODEL = [
  '● OK',
  '✻ Cogitated for 4s · done 9:25 AM',
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Switch model?',
  '   Your next response will be slower and use more tokens',
  '   This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on',
  '   your next message.',
  '',
  '   ❯ 1. Yes, switch to Sonnet 5',
  '     2. No, go back',
  '',
];
const ASK_WITH_CHAT = [
  '● Entered plan mode',
  '  Claude is now exploring and designing an implementation approach.',
  '',
  '● Updated plan',
  '  ⎿  /plan to preview',
  '  ⎿  Error: PreToolUse:ExitPlanMode hook error: [plan-review-gate] BLOCKED: no plan-reviewer',
  '     approval marker.',
  '',
  '     Run the plan-reviewer Warden for this project and wait for VERDICT: SHIP before exiting',
  '     plan mode. Then run:',
  '',
  '       python3 ~/project/scripts/codex_warden_hooks.py mark plan-reviewed SHIP "reason"',
  '     --repo-root ~/project',
  '────────────────────────────────────────────────────────────────────────────────────────────────',
  'Planning: ~/.claude/plans/example.md',
  '────────────────────────────────────────────────────────────────────────────────────────────────',
  ' ☐ Gate block',
  '',
  "│ The project's plan-review-gate hook blocked ExitPlanMode: it wants a plan-reviewer SHIP",
  '│ verdict and a marker file written first. Writing that marker changes files, which you told me',
  '│ not to do. How should I proceed?',
  '',
  '❯ 1. Run plan-reviewer, then exit',
  '     Send the one-line plan to the plan-reviewer agent. On SHIP, write the .plan-reviewed marker',
  '     (a state file, not a repo edit) and call ExitPlanMode again. README.md stays untouched.',
  '  2. Stop here',
  '     Stay in plan mode and do nothing more. The plan file is at',
  '     ~/.claude/plans/example.md.',
  '  3. Type something.',
  '────────────────────────────────────────────────────────────────────────────────────────────────',
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
  '─────────────────────────────────────────────────────────────────────────────── Example session ─',
  '',
];
const PERMISSION = [
  '  Bash command',
  '',
  '  touch /tmp/perm-probe.txt',
  '  Create the probe file',
  '',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  "    2. Yes, and don't ask again for touch commands in /tmp",
  '    3. No, and tell Claude what to do differently (esc)',
  '',
  '',
];

// Claude Code 2.1.284, `/remote-control` run a second time while connected
// (captured 2026-09-29 from a throwaway session; the session id replaced).
// No numbers: the cursor row starts with ❯, the others sit at its text column.
const RC_MENU = [
  '▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔',
  '   Remote Control',
  '',
  '   This session is available in the Claude mobile app and at https://claude.ai/code/session_0000TESTfixture0000.',
  '',
  '     Disconnect this session',
  '     Show QR code              Scan with your phone to open this session',
  '   ❯ Continue',
  '',
  '   Enter to select · Esc to continue',
  '',
];

// Claude Code 2.1.284 permission dialogs, captured 2026-09-29 from throwaway
// sessions in default permission mode (neutral commands; the edit declined).
// The Bash dialog separates its body from the question with blank rows.
const RULE_W = '─'.repeat(110);
const PERMISSION_REAL = [
  '  Counting the demo lines',
  '  ⎿  $ cd /tmp && printf "a\\nb\\n" | grep -c . ; python3 -c "print(2+2)"',
  '',
  RULE_W,
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  '',
  '   cd /tmp && printf "a\\nb\\n" | grep -c . ; python3 -c "print(2+2)"',
  '   Count the demo lines',
  '',
  ' This command requires approval',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and allow access to /tmp and "python3 -c \\"print(2+2)\\"" commands',
  '   3. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   4. No',
  '',
  ' Esc to cancel · Tab to amend',
  '',
];
const EDIT_REAL = [
  '● Update(demo.txt)',
  '',
  RULE_W,
  ' Edit file',
  ' demo.txt',
  '╌'.repeat(110),
  ' 1  alpha',
  ' 2 -beta',
  ' 2 +BETA',
  ' 3  gamma',
  '╌'.repeat(110),
  ' Do you want to make this edit to demo.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and allow Claude to edit files in its ~/.claude folder for this session',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
  '',
];
const MENU_TAIL = [
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel',
];

describe('parseMenuScreen', () => {
  it('reads the plan-approval menu: options, the hint under option 3, no esc, a one-row prompt', () => {
    const st = parseMenuScreen(PLAN_APPROVAL);
    expect(st).toEqual({
      kind: 'menu',
      prompt: [
        'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      ],
      options: [
        { n: 1, label: 'Yes, and use auto mode' },
        { n: 2, label: 'Yes, manually approve edits' },
        {
          n: 3,
          label: 'Tell Claude what to change',
          hint: 'shift+tab to approve with this feedback',
        },
      ],
      selected: 1,
      esc: false,
    });
  });
  it('reads the switch-model menu: two options, a four-row prompt in reading order, no esc', () => {
    const st = parseMenuScreen(SWITCH_MODEL);
    expect(st && st.options).toEqual([
      { n: 1, label: 'Yes, switch to Sonnet 5' },
      { n: 2, label: 'No, go back' },
    ]);
    expect(st && st.prompt.length).toBe(4);
    expect(st && st.prompt[0]).toBe('Switch model?');
    expect(st && st.prompt[3]).toBe('your next message.');
    expect(st && st.esc).toBe(false);
    expect(st && st.selected).toBe(1);
  });
  it('reads a permission prompt: the (esc) suffix leaves the label and sets esc', () => {
    const st = parseMenuScreen(PERMISSION);
    expect(st && st.options.map((o: { label: string }) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for touch commands in /tmp",
      'No, and tell Claude what to do differently',
    ]);
    expect(st && st.esc).toBe(true);
    expect(st && st.prompt).toEqual(['Do you want to proceed?']);
  });
  it('leaves AskUserQuestion screens alone: parseAskScreen owns them, and the menu run fails the 1..n check', () => {
    const ask = parseAskScreen(ASK_WITH_CHAT);
    expect(ask && ask.kind).toBe('question');
    expect(ask && ask.kind === 'question' ? ask.options.length : -1).toBe(2);
    expect(ask && ask.kind === 'question' ? ask.other : -1).toBe(3);
    expect(JSON.stringify(ask)).not.toContain('Chat about this');
    expect(parseMenuScreen(ASK_WITH_CHAT)).toBeNull();
  });
  it('joins several hint rows with a space and stops the prompt at eight rows', () => {
    const st = parseMenuScreen([
      ...Array.from({ length: 12 }, (_, i) => `  prompt row ${i + 1}`),
      '',
      '  ❯ 1. First',
      '       one more thing',
      '       and another',
      '    2. Second',
    ]);
    expect(st && st.options[0]).toEqual({
      n: 1,
      label: 'First',
      hint: 'one more thing and another',
    });
    expect(st && st.prompt.length).toBe(8);
    expect(st && st.prompt[0]).toBe('prompt row 5'); // the eight nearest rows, in reading order
    expect(st && st.prompt[7]).toBe('prompt row 12');
  });
  it('reads an unnumbered cursor menu (/remote-control) as an arrow menu (#57)', () => {
    expect(parseMenuScreen(RC_MENU)).toEqual({
      kind: 'menu',
      prompt: [
        'Remote Control',
        'This session is available in the Claude mobile app and at https://claude.ai/code/session_0000TESTfixture0000.',
      ],
      options: [
        { n: 1, label: 'Disconnect this session' },
        {
          n: 2,
          label: 'Show QR code',
          hint: 'Scan with your phone to open this session',
        },
        { n: 3, label: 'Continue' },
      ],
      selected: 3,
      esc: true,
      arrows: true,
    });
    // numbered menus are unchanged: no arrows flag
    expect(parseMenuScreen(PERMISSION).arrows).toBeUndefined();
  });

  it('shows the whole Bash permission dialog, the command in mono (#58)', () => {
    const st = parseMenuScreen(PERMISSION_REAL);
    expect(st.prompt).toEqual([
      'Bash command',
      'cd /tmp && printf "a\\nb\\n" | grep -c . ; python3 -c "print(2+2)"',
      'Count the demo lines',
      'This command requires approval',
      'Do you want to proceed?',
    ]);
    expect(st.mono).toEqual([1, 2]);
    expect(st.options.map((o: { label: string }) => o.label)[3]).toBe('No');
    expect(st.selected).toBe(1);
    expect(st.esc).toBe(true);
  });

  it('keeps the edit dialog question as it was, with no mono key', () => {
    const st = parseMenuScreen(EDIT_REAL);
    expect(st.prompt).toEqual(['Do you want to make this edit to demo.txt?']);
    expect('mono' in st).toBe(false);
  });

  it('drops a wrapped tip paragraph, and never climbs into the conversation', () => {
    const wrapped = [
      RULE_W,
      ' Bash command',
      ' Tip: auto mode handles these prompts for you — choose "switch',
      ' to auto mode" below',
      '',
      '   ls',
      ...MENU_TAIL,
    ];
    expect(parseMenuScreen(wrapped).prompt).toEqual([
      'Bash command',
      'ls',
      'Do you want to proceed?',
    ]);
    const chat = [
      '● An earlier reply',
      RULE_W,
      '● More of the reply',
      ...MENU_TAIL,
    ];
    expect(parseMenuScreen(chat).prompt).toEqual(['Do you want to proceed?']);
    // a rule inside a reply (indented) is not the dialog's edge
    const hr = [
      '● Here is the summary',
      '  ────────────────',
      '  plain reply text without a marker',
      ...MENU_TAIL,
    ];
    expect(parseMenuScreen(hr).prompt).toEqual(['Do you want to proceed?']);
    // an older menu with uneven indentation gets no mono key
    expect(
      'mono' in
        parseMenuScreen(['   Pick one', '     wrapped', ' ❯ 1. a', '   2. b']),
    ).toBe(false);
    // no edge within 30 rows: the question alone, as before
    const far = [RULE_W, ...Array(31).fill(' filler'), ...MENU_TAIL];
    expect(parseMenuScreen(far).prompt).toEqual(['Do you want to proceed?']);
  });

  it('says how many lines it left out of a long dialog', () => {
    const long = [
      RULE_W,
      ' Bash command',
      '',
      ...Array.from({ length: 10 }, (_, i) => `   line ${i + 1}`),
      ...MENU_TAIL,
    ];
    const st = parseMenuScreen(long);
    expect(st.prompt).toEqual([
      'Bash command',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      '… 5 more lines — see the terminal',
      'Do you want to proceed?',
    ]);
    expect(st.mono).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads no arrow menu without the footer, with two cursors, or with ragged rows', () => {
    const noFooter = RC_MENU.slice(0, 8);
    expect(parseMenuScreen(noFooter)).toBeNull();
    const twoCursors = [...RC_MENU];
    twoCursors[5] = '   ❯ Disconnect this session';
    expect(parseMenuScreen(twoCursors)).toBeNull();
    const ragged = [...RC_MENU];
    ragged[6] = '       Show QR code';
    expect(parseMenuScreen(ragged)).toBeNull();
    // a malformed numbered menu is not re-read as an arrow menu
    expect(
      parseMenuScreen(['Pick one', '  2. a', '❯ 3. b', '', 'Enter to select']),
    ).toBeNull();
  });

  it('is null for a numbered list in a reply, a lone prompt, and a run without a cursor', () => {
    expect(
      parseMenuScreen([
        '● Here is the plan:',
        '  1. foo',
        '  2. bar',
        '',
        '❯ ',
      ]),
    ).toBeNull();
    expect(parseMenuScreen(['❯ '])).toBeNull();
    expect(parseMenuScreen(['Pick one', '  1. a', '  2. b'])).toBeNull();
    expect(parseMenuScreen(['Pick one', '❯ 1. a', '❯ 2. b'])).toBeNull();
    expect(parseMenuScreen(['Pick one', '  2. a', '❯ 3. b'])).toBeNull();
  });
});
