import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import { renderConversation } from '../../web/control/conversation.js';

// A tiny h(): the shape the real one produces, without a DOM. Children that
// are null/false are skipped, as dom.js does; the few element methods the
// renderer touches are stubs.
type Node = {
  tag: string;
  attrs: Record<string, unknown>;
  children: unknown[];
  hidden: boolean;
  addEventListener: () => void;
  setAttribute: () => void;
  dataset: Record<string, string>;
  classList: {
    add: () => void;
    remove: () => void;
    toggle: () => void;
    contains: () => boolean;
  };
};
function h(
  tag: string,
  attrs: Record<string, unknown> = {},
  ...children: unknown[]
): Node {
  return {
    tag,
    attrs,
    children: children
      .flat()
      .filter((c) => c !== null && c !== false && c !== undefined),
    hidden: false,
    addEventListener: () => {},
    setAttribute: () => {},
    dataset: {},
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false,
    },
  };
}
const text = (n: unknown): string =>
  typeof n === 'string' ? n : (n as Node).children.map(text).join('');
const find = (n: unknown, pred: (x: Node) => boolean): Node | null => {
  if (typeof n !== 'object' || n === null) return null;
  const node = n as Node;
  if (pred(node)) return node;
  for (const c of node.children) {
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
};

describe('renderConversation with an artifact card', () => {
  const items = [
    { k: 'user', text: 'Build the page' },
    {
      k: 'tools',
      label: 'used 1 tool',
      calls: [{ name: 'Artifact', summary: 'publish' }],
      files: [],
      artifacts: [
        {
          tool: 'Artifact',
          summary: 'site/index.html',
          url: 'https://claude.ai/artifact/abc',
        },
      ],
    },
    { k: 'assistant', text: 'Done.' },
  ];
  const el = {
    last: [] as unknown[],
    replaceChildren(...nodes: unknown[]) {
      this.last = nodes;
    },
  };
  it('renders (regression: the card once read a `handlers` that was out of scope) and offers Open beside only with a copy', () => {
    renderConversation(el, items, h, { expanded: new Set() });
    expect(el.last.length).toBe(3);
    const card = find(el.last[1], (n) => n.attrs.class === 'conv-card');
    expect(card).not.toBeNull();
    expect(
      find(card, (n) => n.tag === 'button' && text(n) === 'Open beside'),
    ).toBeNull();
    const opened: unknown[] = [];
    renderConversation(el, items, h, {
      expanded: new Set(),
      localArtifact: (url: string) =>
        url.endsWith('/abc') ? { id: 'art-0123456789ab', local: true } : null,
      openArtifact: (a: unknown) => opened.push(a),
    });
    const btn = find(
      el.last[1],
      (n) => n.tag === 'button' && text(n) === 'Open beside',
    );
    expect(btn).not.toBeNull();
    (btn!.attrs.onclick as () => void)();
    expect(opened).toEqual([{ id: 'art-0123456789ab', local: true }]);
  });
});
