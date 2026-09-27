import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import {
  dayLabel,
  daySeparators,
  renderConversation,
} from '../../web/control/conversation.js';

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

describe('day separators', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  it('labels today, yesterday and older days', () => {
    expect(dayLabel('2026-09-27', now)).toBe('Today');
    expect(dayLabel('2026-09-26', now)).toBe('Yesterday');
    expect(dayLabel('2026-09-01', now)).toMatch(/2026/);
  });
  it('only when the conversation spans more than one day, once per day', () => {
    const one = [
      { k: 'user', text: 'a', ts: '2026-09-27T09:00:00Z' },
      { k: 'assistant', text: 'b', ts: '2026-09-27T09:01:00Z' },
    ];
    expect(daySeparators(one, now).size).toBe(0);
    const two = [
      { k: 'user', text: 'a', ts: '2026-09-25T09:00:00Z' },
      { k: 'assistant', text: 'b', ts: '2026-09-25T09:01:00Z' },
      { k: 'user', text: 'c' },
      { k: 'user', text: 'd', ts: '2026-09-27T09:00:00Z' },
    ];
    const seps = daySeparators(two, now);
    expect([...seps.entries()]).toEqual([
      [0, expect.stringMatching(/2026/)],
      [3, 'Today'],
    ]);
    // rendered: a separator node before the first item of each day
    const el = {
      last: [] as unknown[],
      replaceChildren(...nodes: unknown[]) {
        this.last = nodes;
      },
    };
    renderConversation(el, two, h, { now });
    expect((el.last[0] as Node).attrs.class).toBe('conv-day');
    expect(el.last.length).toBe(6);
    // a run of tool calls that opens a new day keeps that day's separator
    const tools = [
      { k: 'user', text: 'a', ts: '2026-09-25T09:00:00Z' },
      { k: 'tool', tool: 'Bash', summary: 'ls', ts: '2026-09-27T01:00:00Z' },
      { k: 'tool', tool: 'Bash', summary: 'pwd', ts: '2026-09-27T01:01:00Z' },
      { k: 'assistant', text: 'b', ts: '2026-09-27T01:02:00Z' },
    ];
    renderConversation(el, tools, h, { now });
    const classes = el.last.map((n) => (n as Node).attrs.class);
    expect(classes[0]).toBe('conv-day');
    expect(classes[2]).toBe('conv-day'); // before the tool run, not one item later
    expect(el.last.length).toBe(5);
  });
});

describe('append instead of redraw', () => {
  const mk = () => ({
    replaced: 0,
    appended: 0,
    last: [] as unknown[],
    replaceChildren(...n: unknown[]) {
      this.replaced++;
      this.last = n;
    },
    append(...n: unknown[]) {
      this.appended++;
      this.last = [...this.last, ...n];
    },
  });
  const now = Date.parse('2026-09-27T12:00:00.000Z');
  it('appends when the list only grew, redraws when an earlier item changed, shrank, or the day turned', () => {
    const el = mk();
    const state: Record<string, unknown> = {};
    const a = [
      { k: 'user', text: 'a' },
      { k: 'user', text: 'b', queued: true },
    ];
    renderConversation(el, a, h, { state, now });
    expect([el.replaced, el.appended]).toEqual([1, 0]);
    renderConversation(el, [...a, { k: 'assistant', text: 'c' }], h, {
      state,
      now,
    });
    expect([el.replaced, el.appended, el.last.length]).toEqual([1, 1, 3]);
    // the queued bubble landed: an earlier key changed → full redraw
    renderConversation(
      el,
      [
        { k: 'user', text: 'a' },
        { k: 'user', text: 'b' },
        { k: 'assistant', text: 'c' },
      ],
      h,
      { state, now },
    );
    expect([el.replaced, el.appended]).toEqual([2, 1]);
    renderConversation(el, [{ k: 'user', text: 'a' }], h, { state, now });
    expect(el.replaced).toBe(3);
    renderConversation(
      el,
      [
        { k: 'user', text: 'a' },
        { k: 'user', text: 'z' },
      ],
      h,
      { state, now: now + 86_400_000 },
    );
    expect([el.replaced, el.appended]).toEqual([4, 1]); // a new day: redraw, not append
    renderConversation(el, [{ k: 'user', text: 'a' }], h, { now }); // no state: always a redraw
    expect(el.replaced).toBe(5);
  });
});
