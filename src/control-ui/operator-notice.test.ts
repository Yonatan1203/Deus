import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../logger.js';
import type { Channel, RegisteredGroup } from '../types.js';
import { notifyOperator } from './operator-notice.js';

const group = (folder: string, isControlGroup: boolean): RegisteredGroup => ({
  name: folder,
  folder,
  trigger: '@d',
  added_at: '',
  isControlGroup,
});

function fakeChannel(
  owns: (jid: string) => boolean,
  send: Channel['sendMessage'] = vi.fn(async () => {}),
) {
  return {
    name: 'fake',
    ownsJid: vi.fn(owns),
    sendMessage: vi.fn(send),
  } as unknown as Channel & {
    sendMessage: ReturnType<typeof vi.fn>;
    ownsJid: ReturnType<typeof vi.fn>;
  };
}

const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
const notices = () =>
  warnSpy.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((o) => o?.event === 'control_ui_operator_notice');

beforeEach(() => warnSpy.mockClear());

describe('notifyOperator', () => {
  it('sends the text as-is to the control group through the channel that owns its JID', () => {
    const other = fakeChannel((j) => j === 'side@x');
    const owner = fakeChannel((j) => j === 'main@x');
    notifyOperator(
      {
        runtime: {
          registeredGroups: () => ({
            'side@x': group('side', false),
            'main@x': group('main', true),
          }),
        },
        channels: () => [other, owner],
      },
      'hello',
    );
    expect(owner.sendMessage).toHaveBeenCalledExactlyOnceWith(
      'main@x',
      'hello',
    );
    expect(other.sendMessage).not.toHaveBeenCalled();
    expect(notices()).toHaveLength(0);
  });

  it('picks the first control group by JID when there are several', () => {
    const ch = fakeChannel(() => true);
    notifyOperator(
      {
        runtime: {
          registeredGroups: () => ({
            'zz@x': group('z', true),
            'aa@x': group('a', true),
            '00@x': group('n', false),
          }),
        },
        channels: () => [ch],
      },
      't',
    );
    expect(ch.sendMessage).toHaveBeenCalledExactlyOnceWith('aa@x', 't');
  });

  it('no runtime, no control group, or no owning channel: one warn, no send', () => {
    const ch = fakeChannel(() => false);
    notifyOperator({}, 't');
    notifyOperator(
      {
        runtime: { registeredGroups: () => ({ 'x@x': group('x', false) }) },
        channels: () => [ch],
      },
      't',
    );
    notifyOperator(
      {
        runtime: { registeredGroups: () => ({ 'm@x': group('m', true) }) },
        channels: () => [ch],
      },
      't',
    );
    expect(ch.sendMessage).not.toHaveBeenCalled();
    expect(notices().map((n) => n.outcome)).toEqual([
      'no_control_group',
      'no_control_group',
      'no_channel',
    ]);
  });

  it('never throws: a rejected or synchronously throwing send is one warn', async () => {
    const deps = (send: Channel['sendMessage']) => ({
      runtime: { registeredGroups: () => ({ 'm@x': group('m', true) }) },
      channels: () => [fakeChannel(() => true, send)],
    });
    expect(() =>
      notifyOperator(
        deps(() => Promise.reject(new Error('offline'))),
        't',
      ),
    ).not.toThrow();
    expect(() =>
      notifyOperator(
        deps(() => {
          throw new Error('boom');
        }),
        't',
      ),
    ).not.toThrow();
    expect(() =>
      notifyOperator(
        {
          runtime: {
            registeredGroups: () => {
              throw new Error('db gone');
            },
          },
        },
        't',
      ),
    ).not.toThrow();
    await vi.waitFor(() => expect(notices()).toHaveLength(3));
    expect(notices().every((n) => n.outcome === 'send_failed')).toBe(true);
  });
});
