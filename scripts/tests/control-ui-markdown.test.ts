import { describe, expect, it } from 'vitest';
// Browser modules with no DOM dependency at import time, so they run under vitest directly.
// @ts-expect-error — plain JS module without type declarations
import { parseInline, parseMarkdown } from '../../web/control/markdown.js';
// @ts-expect-error — plain JS module without type declarations
import { groupItems, toolLabel } from '../../web/control/conversation.js';

describe('markdown', () => {
  it('keeps only http(s) links; everything else stays text', () => {
    expect(parseInline('[x](javascript:alert(1)) [y](https://a.b/c)')).toEqual([
      { type: 'text', text: '[x](javascript:alert(1)) ' },
      { type: 'link', text: 'y', href: 'https://a.b/c' },
    ]);
    expect(parseInline('see https://claude.ai/x.')).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'link',
        text: 'https://claude.ai/x',
        href: 'https://claude.ai/x',
      },
      { type: 'text', text: '.' },
    ]);
  });

  it('reads bold, italics and code spans, nested, and markdown escapes', () => {
    expect(parseInline('**reply `approve FB11`** \\#newly')).toEqual([
      {
        type: 'strong',
        text: 'reply `approve FB11`',
        children: [
          { type: 'text', text: 'reply ' },
          { type: 'code', text: 'approve FB11' },
        ],
      },
      { type: 'text', text: ' #newly' },
    ]);
    expect(parseInline('**IG16** — *soft* `add_cards.py`')).toEqual([
      {
        type: 'strong',
        text: 'IG16',
        children: [{ type: 'text', text: 'IG16' }],
      },
      { type: 'text', text: ' — ' },
      { type: 'em', text: 'soft', children: [{ type: 'text', text: 'soft' }] },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'add_cards.py' },
    ]);
  });

  it('builds paragraphs, headings, lists, quotes and rules', () => {
    const b = parseMarkdown(
      '## Plan\nFirst line\nsecond line\n\n- a\n- b\n  more b\n1. one\n2. two\n> quoted\n---',
    );
    expect(b.map((x: { type: string }) => x.type)).toEqual([
      'h',
      'p',
      'ul',
      'ol',
      'quote',
      'hr',
    ]);
    expect(b[1].inline).toEqual([
      { type: 'text', text: 'First line second line' },
    ]);
    expect(b[2].items[1]).toEqual([{ type: 'text', text: 'b more b' }]);
  });

  it('keeps an unclosed fence as one code block, and a table as code', () => {
    const b = parseMarkdown('```ts\nconst a = 1;\n\n**not bold**');
    expect(b).toEqual([
      { type: 'code', lang: 'ts', text: 'const a = 1;\n\n**not bold**' },
    ]);
    const t = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(t).toEqual([
      { type: 'code', lang: 'table', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ]);
  });
});

describe('conversation grouping', () => {
  const tool = (t: string, extra: Record<string, unknown> = {}) => ({
    k: 'tool',
    tool: t,
    summary: '',
    ...extra,
  });

  it('labels runs with the right plurals and drops zero parts', () => {
    expect(toolLabel([tool('Bash')])).toBe('Ran 1 command');
    expect(
      toolLabel([
        tool('Bash'),
        tool('Bash'),
        tool('Read'),
        tool('Grep'),
        tool('Grep'),
      ]),
    ).toBe('Ran 2 commands, read 1 file, searched 2 times');
    expect(toolLabel([tool('Edit'), tool('TaskUpdate')])).toBe(
      'Edited 1 file, used 1 tool',
    );
  });

  it('folds consecutive tools, sums file changes, keeps artifacts visible', () => {
    const g = groupItems([
      { k: 'assistant', text: 'Checking' },
      tool('Bash'),
      tool('Edit', { file: 'a.py', added: 3, removed: 1 }),
      tool('Edit', { file: 'a.py', added: 2, removed: 0 }),
      tool('Artifact', {
        summary: '/t/posts.html',
        url: 'https://claude.ai/code/artifact/x',
      }),
      { k: 'assistant', text: 'Done' },
      tool('Read'),
    ]);
    expect(g.map((x: { k: string }) => x.k)).toEqual([
      'assistant',
      'tools',
      'assistant',
      'tools',
    ]);
    expect(g[1].label).toBe('Ran 1 command, edited 2 files, used 1 tool');
    expect(g[1].files).toEqual([{ file: 'a.py', added: 5, removed: 1 }]);
    expect(g[1].artifacts).toHaveLength(1);
    expect(g[3].label).toBe('Read 1 file');
  });
});
