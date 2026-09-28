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

describe('markdown: page links open beside', () => {
  const URL = 'https://claude.ai/artifact/abc123';
  const entry = { id: 'art-1', url: URL, title: 'Workbench' };
  const find = (n: unknown, pred: (x: Node) => boolean): Node[] => {
    if (typeof n !== 'object' || n === null) return [];
    const node = n as Node;
    return [
      ...(pred(node) ? [node] : []),
      ...node.children.flatMap((c) => find(c, pred)),
    ];
  };
  const render = (md: string, handlers: Record<string, unknown> = {}) =>
    renderBlocks(parseMarkdown(md), h, handlers).map((b: unknown) => b);
  const buttons = (nodes: unknown[]) =>
    nodes.flatMap((n) =>
      find(n, (x) => x.tag === 'button' && x.attrs.class === 'md-open-beside'),
    );
  const opened: unknown[] = [];
  const handlers = {
    localArtifact: (u: string) => (u === URL ? entry : null),
    openArtifact: (e: unknown) => opened.push(e),
  };

  it('a known page link gets an Open beside button that opens it', () => {
    const out = render(`See [the workbench](${URL}) now.`, handlers);
    const b = buttons(out);
    expect(b).toHaveLength(1);
    expect(text(b[0])).toBe('Open beside');
    (b[0].attrs.onclick as () => void)();
    expect(opened).toEqual([entry]);
    expect(
      out.flatMap((n) => find(n, (x) => x.tag === 'a'))[0].attrs.href,
    ).toBe(URL);
  });
  it('unknown links, no handlers, or only a copy handler: link only', () => {
    expect(
      buttons(render('[x](https://claude.ai/artifact/other)', handlers)),
    ).toHaveLength(0);
    expect(buttons(render(`[x](${URL})`))).toHaveLength(0);
    expect(buttons(render(`[x](${URL})`, { copy: () => {} }))).toHaveLength(0);
  });
  it('inside a list item, a table cell and bold; a bare URL before a full stop', () => {
    expect(buttons(render(`- item [x](${URL})`, handlers))).toHaveLength(1);
    expect(
      buttons(render(`| a |\n|---|\n| [x](${URL}) |`, handlers)),
    ).toHaveLength(1);
    expect(buttons(render(`**[x](${URL})**`, handlers))).toHaveLength(1);
    expect(buttons(render(`Open ${URL}.`, handlers))).toHaveLength(1);
  });
});
