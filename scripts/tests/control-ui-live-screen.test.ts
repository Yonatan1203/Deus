import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import {
  parseLiveReply,
  parseRunningTool,
} from '../../web/control/ask-screen.js';

// Real screens captured 2026-09-27 (Claude Code 2.1.283), paths replaced.
const MID_REPLY = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.283',
  '▝▜██████▀  Opus 5.5 with medium effort · Claude Max',
  ' ▝▝   ▝▝   ~/project',
  '',
  '',
  '❯ Write a 15-sentence paragraph about tea, then a second short paragraph. No tools.',
  '',
  '● Tea began, according to Chinese legend, when leaves from a wild bush drifted into Emperor Shen',
  "  Nong's pot of boiling water around 2737 BCE. Whatever the truth of that story, the plant behind",
  '  nearly every true tea is Camellia sinensis, an evergreen shrub native to East Asia. From that one',
  '  species come white, green, oolong, black, and pu-erh teas, and what separates them is mostly how',
  '  the leaves are processed after picking. Green tea is heated soon after harvest to stop oxidation,',
  '  which keeps its fresh, grassy character. Black tea is left to oxidize fully, which darkens the',
  '  leaves and gives a stronger, malty flavor. Oolong sits between the two, partly oxidized, and can',
  '  taste anywhere from floral to toasty. During the Tang and Song dynasties, tea drinking in China',
  '  grew into an art with its own tools and rituals. Buddhist monks carried the practice to Japan,',
  '  where it eventually became the formal tea ceremony known as chanoyu. In the seventeenth century,',
  '  Dutch and Portuguese traders brought tea to Europe, and it soon became a fixture of British social',
  "  life. Britain's demand for tea was so large that it shaped trade routes, colonial policy, and",
  '  conflicts such as the Opium Wars. Today tea is the most widely consumed beverage in the world',
  '  after water. Its caffeine comes paired with L-theanine, an amino acid often linked to a calm,',
  '  focused alertness. Brewing matters a great deal, since water temperature and steeping time can',
  '  make the same leaves taste sweet or harshly bitter. Herbal infusions such as chamomile and rooibos',
  '  are commonly called tea, but strictly speaking they are tisanes, because they contain no Camellia',
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
  '· Unfurling… (9s · ↓ 554 tokens)',
  '',
  '─────────────────────────────────────────────────────────────────────────────── Stream-delete-me-2 ─',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents · esc to interrupt',
  '',
];
const MID_TOOL = [
  '',
  ' ▐▛███▛█   Claude Code v2.1.283',
  '▝▜██████▀  Opus 5.5 with medium effort · Claude Max',
  ' ▝▝   ▝▝   ~/project',
  '',
  '',
  '❯ First run this bash command: sleep 6. Then write a 12-sentence paragraph about tea, then a second',
  '  short paragraph.',
  '',
  '● Running 1 shell command · 5s…',
  '  ⎿  $ sleep 6 (4s)',
  '     (ctrl+b to run in background)',
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
  '',
  '',
  '· Ideating… (9s · ↓ 78 tokens)',
  '',
  '───────────────────────────────────────────────────────────────────────────────── Stream-delete-me ─',
  '❯ ',
  '────────────────────────────────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents · esc to interrupt',
  '',
];

const WORKING = '· Ideating… (9s · ↓ 78 tokens)';
describe('parseLiveReply', () => {
  it('reads the whole visible reply under way, start row included', () => {
    const r = parseLiveReply(MID_REPLY);
    expect(r && r.partial).toBe(false);
    expect(r && r.text.startsWith('Tea began')).toBe(true);
    expect(r && r.text.endsWith('contain no Camellia')).toBe(true);
    expect(r && r.text).not.toMatch(/^● /m);
  });
  it('is null while only a tool is running', () => {
    expect(parseLiveReply(MID_TOOL)).toBeNull();
    expect(parseLiveReply(['● Bash(ls)', '  ⎿  Running…', WORKING])).toBeNull();
    expect(parseLiveReply(['❯ hello'])).toBeNull();
  });
  it('joins continuation rows and keeps a paragraph break; a tail is partial', () => {
    expect(
      parseLiveReply(['❯ ask', '● a', '  b', '', '  c', '', WORKING]),
    ).toEqual({ text: 'a b\n\nc'.replace(' b', '\nb'), partial: false });
    const tail = parseLiveReply([
      '  second half of a row',
      '  and more',
      '',
      WORKING,
    ]);
    expect(tail).toEqual({
      text: 'second half of a row\nand more',
      partial: true,
    });
  });
  it('a reply that begins with a tool-like word is still a reply', () => {
    const r = parseLiveReply([
      '● Searched through my notes and found two things.',
      '  First, …',
      WORKING,
    ]);
    expect(r && r.partial).toBe(false);
    expect(r && r.text.startsWith('Searched through')).toBe(true);
  });
});
describe('parseWorking with the effort suffix', () => {
  it('still reads verb, seconds and tokens', async () => {
    // @ts-expect-error plain JS browser module
    const { parseWorking } = await import('../../web/control/ask-screen.js');
    expect(
      parseWorking([
        '✢ Ideating… (14s · ↓ 78 tokens · thinking with medium effort)',
      ]),
    ).toMatchObject({ verb: 'Ideating', seconds: 14, tokens: '78' });
    expect(parseWorking(['· Unfurling… (9s · ↓ 554 tokens)'])).toMatchObject({
      verb: 'Unfurling',
      seconds: 9,
    });
  });
});
describe('parseRunningTool', () => {
  it('names the running command with its elapsed time', () => {
    expect(parseRunningTool(MID_TOOL)).toEqual({ label: '$ sleep 6 · 4s' });
    expect(
      parseRunningTool(['● Bash(npm test)', '  ⎿  Running…', WORKING]),
    ).toEqual({ label: 'Bash(npm test)' });
  });
  it('is null while a reply is being written or nothing is running', () => {
    expect(parseRunningTool(MID_REPLY)).toBeNull();
    expect(
      parseRunningTool([
        '● Ran 1 shell command',
        '  ⎿  $ ls',
        '● Done.',
        WORKING,
      ]),
    ).toBeNull();
  });
  it('clips a long running command so the working line fits a phone', () => {
    const cmd =
      'find . -name "*.tmp" -exec rm {} \\; -o -name "*.bak" -exec rm {} \\; -o -name "*.orig" -print';
    const r = parseRunningTool([
      '● Running 1 shell command · 3s…',
      `  ⎿  $ ${cmd} (2s)`,
      '',
      WORKING,
    ]);
    expect(r?.label.length).toBeLessThanOrEqual(2 + 60 + 5); // "$ " + the clipped command + " · 2s"
    expect(r?.label.startsWith('$ find . -name')).toBe(true);
    expect(r?.label.endsWith('… · 2s')).toBe(true);
  });
});
