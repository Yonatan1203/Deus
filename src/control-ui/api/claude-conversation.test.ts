import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildConversation,
  parseAskAnswer,
  createConversationReader,
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
