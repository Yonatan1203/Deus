import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import { parseMarkdown, renderBlocks } from '../../web/control/markdown.js';

type Node = {
  tag: string;
  attrs: Record<string, unknown>;
  children: unknown[];
};
const h = (
  tag: string,
  attrs: Record<string, unknown> = {},
  ...children: unknown[]
): Node => ({
  tag,
  attrs,
  children: children
    .flat()
    .filter((c) => c !== null && c !== false && c !== undefined),
});
const text = (n: unknown): string =>
  typeof n === 'string' ? n : (n as Node).children.map(text).join('');

describe('markdown: tables', () => {
  it('a header, a separator and rows become a table; pipe rows without a separator stay text', () => {
    const blocks = parseMarkdown(
      'Before\n| Name | Qty |\n|---|---:|\n| Apples | 3 |\n| Pears | 5 |\nAfter',
    );
    expect(blocks.map((b: { type: string }) => b.type)).toEqual([
      'p',
      'table',
      'p',
    ]);
    const t = renderBlocks([blocks[1]], h)[0] as Node;
    expect(t.tag).toBe('table');
    expect(t.attrs.dir).toBe('auto');
    const body = t.children[1] as Node;
    expect(body.children.length).toBe(2);
    expect(text((body.children[0] as Node).children[1])).toBe('3');
    const loose = parseMarkdown('| just | pipes |\n| no | separator |');
    expect(loose.map((b: { type: string }) => b.type)).toEqual(['p']);
  });
});

describe('markdown: nested lists and direction', () => {
  it('keeps one level of nesting', () => {
    const blocks = parseMarkdown(
      '- one\n  - one a\n  - one b\n- two\n  still two',
    );
    expect(blocks.length).toBe(1);
    const ul = renderBlocks(blocks, h)[0] as Node;
    expect(ul.children.length).toBe(2);
    const first = ul.children[0] as Node;
    const sub = first.children.find(
      (c) => typeof c !== 'string' && (c as Node).tag === 'ul',
    ) as Node;
    expect(sub.children.length).toBe(2);
    expect(text(ul.children[1])).toBe('two still two');
  });
  it('every block carries dir="auto"; a code block gets a Copy button when a handler is given', () => {
    const blocks = parseMarkdown('# Title\n\nשלום\n\n> quote\n\n```js\nx\n```');
    const nodes = renderBlocks(blocks, h, { copy: () => {} }) as Node[];
    for (const n of nodes.filter((n) => n.tag !== 'div'))
      expect(n.attrs.dir).toBe('auto');
    const code = nodes.find((n) => n.tag === 'div') as Node;
    expect((code.children[0] as Node).tag).toBe('button');
    const plain = renderBlocks(blocks, h) as Node[];
    expect(
      ((plain.find((n) => n.tag === 'div') as Node).children[0] as Node).tag,
    ).toBe('pre');
  });
});
