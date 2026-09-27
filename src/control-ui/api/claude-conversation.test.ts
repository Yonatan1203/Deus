import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IS_WINDOWS } from '../../platform.js';
import {
  buildConversation,
  parseAskAnswer,
  createConversationReader,
  createDefaultsReader,
  resolveDefaults,
} from './claude-conversation.js';

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (content: unknown[], model = 'claude-opus-5-5') => ({
  type: 'assistant',
  message: { role: 'assistant', model, content },
});
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'tool_use',
  id,
  name,
  input,
});
const toolResult = (id: string, content: unknown) =>
  user([{ type: 'tool_result', tool_use_id: id, content }]);

describe('buildConversation', () => {
  it('keeps user and assistant text, skips meta, sidechain, thinking and tool results', () => {
    const c = buildConversation([
      user('Make three posts'),
      user('skill body', { isMeta: true }),
      assistant([{ type: 'thinking', thinking: 'hmm' }, text('On it.')]),
      { ...assistant([text('side')]), isSidechain: true },
      toolResult('t1', 'output'),
      user('<system-reminder>x</system-reminder>'),
      user('<task-notification><task-id>a</task-id></task-notification>'),
    ]);
    expect(c.items).toEqual([
      { k: 'user', text: 'Make three posts' },
      { k: 'assistant', text: 'On it.' },
    ]);
  });

  it('turns slash commands into command items and attaches their output', () => {
    const c = buildConversation([
      user(
        '<command-message>effort</command-message>\n<command-name>/effort</command-name>\n<command-args>high</command-args>',
      ),
      user(
        '<local-command-stdout>Set effort level to high (this session only)</local-command-stdout>',
      ),
      user('<local-command-stdout>orphan output</local-command-stdout>'),
    ]);
    expect(c.items[0]).toEqual({
      k: 'command',
      name: '/effort',
      args: 'high',
      output: 'Set effort level to high (this session only)',
    });
    expect(c.items[1]).toEqual({ k: 'note', text: 'orphan output' });
    expect(c.effort).toBe('high');
  });

  it('maps continuation, interruption and images to notes', () => {
    const c = buildConversation([
      user('This session is being continued from a previous conversation...'),
      user([text('[Request interrupted by user]')]),
      user([{ type: 'image', source: {} }, text('look at this')]),
    ]);
    expect(c.items).toEqual([
      { k: 'note', text: 'Continued from an earlier conversation' },
      { k: 'note', text: 'Interrupted' },
      { k: 'note', text: 'Image' },
      { k: 'user', text: 'look at this' },
    ]);
  });

  it('summarises tools and counts edited lines', () => {
    const c = buildConversation([
      assistant([
        toolUse('a', 'Bash', { command: 'ls -la', description: 'List files' }),
        toolUse('b', 'Edit', {
          file_path: '/x/y/add_cards.py',
          old_string: 'a\nb',
          new_string: 'a\nb\nc\nd',
        }),
        toolUse('c', 'MultiEdit', {
          file_path: '/x/z.ts',
          edits: [
            { old_string: 'a', new_string: 'b\nc' },
            { old_string: 'd\ne', new_string: '' },
          ],
        }),
        toolUse('d', 'Write', { file_path: '/x/new.md', content: '1\n2\n3\n' }),
      ]),
    ]);
    expect(c.items).toEqual([
      { k: 'tool', tool: 'Bash', summary: 'List files' },
      {
        k: 'tool',
        tool: 'Edit',
        summary: '/x/y/add_cards.py',
        file: 'add_cards.py',
        added: 4,
        removed: 2,
      },
      {
        k: 'tool',
        tool: 'MultiEdit',
        summary: '/x/z.ts',
        file: 'z.ts',
        added: 2,
        removed: 3,
      },
      {
        k: 'tool',
        tool: 'Write',
        summary: '/x/new.md',
        file: 'new.md',
        added: 3,
        removed: 0,
      },
    ]);
  });

  it('takes an artifact url only from the matching tool result, and only claude.ai', () => {
    const c = buildConversation([
      assistant([
        toolUse('a1', 'Artifact', { file_path: '/t/posts.html' }),
        toolUse('a2', 'Artifact', { file_path: '/t/other.html' }),
      ]),
      toolResult('a1', [
        text('Published: https://claude.ai/code/artifact/6dcaedd5-7446-4588'),
      ]),
      toolResult('a2', 'see https://evil.example/artifact/x'),
    ]);
    expect(c.items[0]).toMatchObject({
      tool: 'Artifact',
      url: 'https://claude.ai/code/artifact/6dcaedd5-7446-4588',
    });
    expect(c.items[1]).not.toHaveProperty('url');
  });

  it('artifactCalls: the absolute file_path paired with a non-error result carrying exactly one link', () => {
    const c = buildConversation([
      assistant([
        toolUse('a1', 'Artifact', { file_path: '/t/posts.html' }),
        toolUse('a2', 'Artifact', { file_path: 'relative.html' }),
        toolUse('a3', 'Artifact', { file_path: '/t/err.html' }),
        toolUse('a4', 'Artifact', { file_path: '/t/two.html' }),
        toolUse('a5', 'Artifact', {
          url: 'https://claude.ai/artifact/existing',
        }),
      ]),
      toolResult('a1', [
        text('Published: https://claude.ai/code/artifact/6dcaedd5-7446-4588'),
      ]),
      toolResult('a2', [
        text('Published: https://claude.ai/code/artifact/rel'),
      ]),
      user([
        {
          type: 'tool_result',
          tool_use_id: 'a3',
          is_error: true,
          content: 'failed https://claude.ai/code/artifact/err',
        },
      ]),
      toolResult(
        'a4',
        'https://claude.ai/code/artifact/one and https://claude.ai/code/artifact/two',
      ),
      toolResult('a5', 'https://claude.ai/artifact/existing'),
    ]);
    expect(c.artifactCalls).toEqual([
      {
        file_path: '/t/posts.html',
        url: 'https://claude.ai/code/artifact/6dcaedd5-7446-4588',
      },
    ]);
    expect(c.items.filter((i) => i.k === 'tool' && i.url).length).toBe(5); // the card link is kept even where the capture is not
  });

  it('shows every question, its kind, and the answer once given', () => {
    const ask = (id: string) =>
      assistant([
        toolUse(id, 'AskUserQuestion', {
          questions: [
            {
              question: 'Post now or Friday?',
              header: 'When',
              multiSelect: false,
              options: [{ label: 'Post now' }, { label: 'Keep for Friday' }],
            },
            {
              question: 'Which?',
              header: 'Sizes',
              multiSelect: true,
              options: [{ label: 'S' }, { label: 'M' }],
            },
          ],
        }),
      ]);
    const c = buildConversation([
      ask('q1'),
      toolResult(
        'q1',
        'Your questions have been answered: "Post now or Friday?"="Post now", "Which?"="S, M". You can now continue.',
      ),
      ask('q2'),
    ]);
    expect(c.items[0]).toEqual({
      k: 'ask',
      id: 'q1',
      questions: [
        {
          question: 'Post now or Friday?',
          header: 'When',
          options: ['Post now', 'Keep for Friday'],
          multi: false,
        },
        {
          question: 'Which?',
          header: 'Sizes',
          options: ['S', 'M'],
          multi: true,
        },
      ],
      answered: true,
      answer: 'Post now · S, M',
    });
    expect(c.items[1]).toMatchObject({ k: 'ask', id: 'q2', answered: false });
    expect(c.items[1]).not.toHaveProperty('answer');
  });

  it('shows a message sent while Claude works: queued, then delivered or absorbed', () => {
    const op = (
      operation: string,
      content: string,
      extra: Record<string, unknown> = {},
    ) => ({ type: 'queue-operation', operation, content, ...extra });
    // dequeued: the normal user row follows and takes over
    expect(
      buildConversation([op('enqueue', 'hi'), op('dequeue', 'hi'), user('hi')])
        .items,
    ).toEqual([{ k: 'user', text: 'hi' }]);
    // absorbed mid-turn: no user row ever comes; the bubble stays, not queued
    expect(
      buildConversation([
        assistant([text('working')]),
        op('enqueue', 'also this'),
        op('remove', 'also this', { reason: 'absorbed_mid_turn' }),
        assistant([text('done')]),
      ]).items,
    ).toEqual([
      { k: 'assistant', text: 'working' },
      { k: 'user', text: 'also this' },
      { k: 'assistant', text: 'done' },
    ]);
    // still waiting
    expect(buildConversation([op('enqueue', 'later')]).items).toEqual([
      { k: 'user', text: 'later', queued: true },
    ]);
    // cleared by the operator
    expect(
      buildConversation([
        op('enqueue', 'x'),
        op('remove', 'x', { reason: 'cleared' }),
      ]).items,
    ).toEqual([]);
    // the same text twice, one delivered
    expect(
      buildConversation([
        op('enqueue', 'a'),
        op('enqueue', 'a'),
        op('dequeue', 'a'),
        user('a'),
      ]).items,
    ).toEqual([
      { k: 'user', text: 'a', queued: true },
      { k: 'user', text: 'a' },
    ]);
    // delivered as the next turn with no dequeue row (seen 2026-09-26)
    expect(
      buildConversation([
        op('enqueue', 'next'),
        assistant([text('ok')]),
        user('next'),
      ]).items,
    ).toEqual([
      { k: 'assistant', text: 'ok' },
      { k: 'user', text: 'next' },
    ]);
    // an operation whose enqueue fell outside the tail is a no-op
    expect(
      buildConversation([
        op('dequeue', 'gone'),
        op('remove', 'gone', { reason: 'absorbed_mid_turn' }),
      ]).items,
    ).toEqual([]);
  });

  it('hides what the harness puts into the session, as a row or queued', () => {
    const op = (
      operation: string,
      content: string,
      extra: Record<string, unknown> = {},
    ) => ({
      type: 'queue-operation',
      operation,
      content,
      ...extra,
    });
    const harness = [
      '<agent-message from="a1">[Subagent hand-back] report</agent-message>',
      'Another Claude session sent a message:\n<agent-message from="a2">x</agent-message>',
      '<task-notification><task-id>t</task-id></task-notification>',
      '<cross-session-message from="s">hi</cross-session-message>',
      '<artifact-content-authored-by-others>page</artifact-content-authored-by-others>',
      '<local-command-caveat>Caveat: …</local-command-caveat>',
    ];
    for (const text of harness) {
      expect(buildConversation([user(text)]).items).toEqual([]);
      expect(buildConversation([op('enqueue', text)]).items).toEqual([]);
      expect(
        buildConversation([
          op('enqueue', text),
          op('remove', text, { reason: 'absorbed_mid_turn' }),
        ]).items,
      ).toEqual([]);
    }
    // the operator's own paste stays, without its wrapper
    expect(
      buildConversation([user('<pasted_content id="1">hello</pasted_content>')])
        .items,
    ).toEqual([{ k: 'user', text: 'hello' }]);
    expect(
      buildConversation([
        user('Look at this:\n<pasted_content id="2">x</pasted_content>'),
      ]).items,
    ).toEqual([{ k: 'user', text: 'Look at this:\nx' }]);
    expect(
      buildConversation([
        user(
          '<pasted_content id="1">a</pasted_content> and <pasted_content id="2">b</pasted_content>',
        ),
      ]).items,
    ).toEqual([{ k: 'user', text: 'a and b' }]);
    expect(
      buildConversation([
        user(
          '<pasted_content id="1">a</pasted_content>\n<pasted_content id="2">b</pasted_content>',
        ),
      ]).items,
    ).toEqual([{ k: 'user', text: 'a\nb' }]);
    expect(
      buildConversation([
        op('enqueue', '<pasted_content id="3">later</pasted_content>'),
      ]).items,
    ).toEqual([{ k: 'user', text: 'later', queued: true }]);
    // the closing tag repeats the id (seen in a real transcript)
    expect(
      buildConversation([
        user('<pasted_content id="3f15">\nwhy?\n</pasted_content id="3f15">'),
      ]).items,
    ).toEqual([{ k: 'user', text: 'why?' }]);
  });

  it('parses the answers out of the result text', () => {
    expect(
      parseAskAnswer(
        'The user answered: "Which colour?"="Purple". Read the answers carefully.',
      ),
    ).toBe('Purple');
    expect(parseAskAnswer('no pairs here')).toBe('');
  });

  it('reports the last model, redacts secrets and caps items', () => {
    const key = 'sk-ant-api03-' + 'A'.repeat(90);
    const rows = [
      assistant([text('old')], 'claude-sonnet-5'),
      user(`my key is ${key}`),
      assistant([text('new')], 'claude-opus-5-5'),
    ];
    const c = buildConversation(rows, 2);
    expect(c.model).toBe('claude-opus-5-5');
    expect(c.items).toHaveLength(2);
    expect(c.truncated).toBe(true);
    expect(JSON.stringify(c.items)).not.toContain(key);
  });

  it('reports the last known permission mode only', () => {
    expect(
      buildConversation([
        { type: 'permission-mode', permissionMode: 'plan' },
        { type: 'permission-mode', permissionMode: 'auto' },
      ]).mode,
    ).toBe('auto');
    expect(
      buildConversation([{ type: 'permission-mode', permissionMode: '<b>x' }])
        .mode,
    ).toBeNull();
  });

  it('ignores an effort value outside the known levels', () => {
    const c = buildConversation([
      user('<command-name>/effort</command-name>'),
      user(
        '<local-command-stdout>Set effort level to bogus</local-command-stdout>',
      ),
    ]);
    expect(c.effort).toBeNull();
  });
});

describe('createConversationReader', () => {
  it('reads a transcript, versions it and memoizes on mtime and size', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'));
    const id = '11111111-2222-3333-4444-555555555555';
    fs.mkdirSync(path.join(root, 'proj'));
    const file = path.join(root, 'proj', `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify(user('hello')) + '\n');
    const read = createConversationReader(root);
    const a = read(id);
    expect(a?.conv.items).toEqual([{ k: 'user', text: 'hello' }]);
    expect(read(id)).toBe(a);
    fs.appendFileSync(file, JSON.stringify(assistant([text('hi')])) + '\n');
    const b = read(id);
    expect(b?.version).not.toBe(a?.version);
    expect(b?.conv.items).toHaveLength(2);
    expect(read('not-a-session-id')).toBeNull();
  });
});

describe('the model switch and the settings defaults', () => {
  it('shows the printed name after /model until the next reply names the id', () => {
    const c1 = buildConversation([
      assistant([text('hi')], 'claude-fable-5-1'),
      user(
        '<local-command-stdout>Set model to `Opus 5.5` · Also the default for new sessions</local-command-stdout>',
      ),
    ]);
    expect(c1.model).toBeNull();
    expect(c1.model_label).toBe('Opus 5.5');
    const c2 = buildConversation([
      assistant([text('hi')], 'claude-fable-5-1'),
      user(
        '<local-command-stdout>Set model to `Opus 5.5`</local-command-stdout>',
      ),
      assistant([text('now')], 'claude-opus-5-5'),
    ]);
    expect(c2.model).toBe('claude-opus-5-5');
    expect(c2.model_label).toBeNull();
  });
  it('resolves the effort deterministically', () => {
    const live = {
      model: 'opus',
      modelSettings: {
        'claude-opus-5': { effortLevel: 'medium' },
        'claude-opus-5-5': { effortLevel: 'high' },
        'claude-opus-5-5-fast': { effortLevel: 'low' },
      },
    };
    expect(resolveDefaults(live, null)).toEqual({
      model: 'opus',
      effort: 'high',
    }); // highest version, anchored
    expect(resolveDefaults(live, 'claude-opus-5')).toEqual({
      model: 'opus',
      effort: 'medium',
    }); // the exact id wins
    expect(
      resolveDefaults(
        { model: 'sonnet', modelSettings: live.modelSettings },
        null,
      ),
    ).toEqual({ model: 'sonnet', effort: null });
    expect(
      resolveDefaults(
        {
          model: 'opus',
          modelSettings: { 'claude-opus-5-5': { effortLevel: 'ultra' } },
        },
        null,
      ).effort,
    ).toBeNull();
    expect(
      resolveDefaults(
        {
          model: 'claude-opus-5-5',
          modelSettings: { 'claude-opus-5-5': { effortLevel: 'max' } },
        },
        null,
      ),
    ).toEqual({ model: 'claude-opus-5-5', effort: 'max' });
    expect(resolveDefaults('nope', null)).toEqual({
      model: null,
      effort: null,
    });
    expect(resolveDefaults({ model: 'x'.repeat(41) }, null).model).toBeNull();
  });
  it('reads the settings file once per version and never follows a link', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
    try {
      const file = path.join(dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify({ model: 'opus' }));
      const read = createDefaultsReader(file);
      const a = read();
      expect(a && (a.settings as { model: string }).model).toBe('opus');
      expect(read()).toBe(a); // memoized
      fs.writeFileSync(file, JSON.stringify({ model: 'sonnet' }));
      fs.utimesSync(file, new Date(), new Date(Date.now() + 2000));
      const b = read();
      expect(b && (b.settings as { model: string }).model).toBe('sonnet');
      expect(b && b.version).not.toBe(a && a.version);
      fs.writeFileSync(file, '{not json');
      fs.utimesSync(file, new Date(), new Date(Date.now() + 4000));
      expect(read()).toBeNull();
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(file, link);
      if (!IS_WINDOWS) expect(createDefaultsReader(link)()).toBeNull();
      expect(createDefaultsReader(path.join(dir, 'missing.json'))()).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('clipped texts and row times', () => {
  it('marks a reply cut at TEXT_MAX and leaves short ones unmarked', () => {
    const long = 'x'.repeat(25_000);
    const c = buildConversation([user('short'), assistant([text(long)])]);
    expect(c.items[0]).not.toHaveProperty('clipped');
    expect(c.items[1]).toMatchObject({ k: 'assistant', clipped: true });
    expect((c.items[1] as { text: string }).text.length).toBe(20_000);
  });
  it('stamps every item with its row time when the row has one', () => {
    const c = buildConversation([
      { ...user('one'), timestamp: '2026-09-25T10:00:00.000Z' },
      { ...assistant([text('two')]), timestamp: '2026-09-26T11:00:00.000Z' },
      assistant([text('three')]),
    ]);
    expect(c.items.map((it) => it.ts)).toEqual([
      '2026-09-25T10:00:00.000Z',
      '2026-09-26T11:00:00.000Z',
      undefined,
    ]);
  });
});
