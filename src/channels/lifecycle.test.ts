import { describe, expect, it, vi } from 'vitest';
import { createChannelLifecycle } from './lifecycle.js';
import type { Channel } from '../types.js';
import type { ChannelOpts } from './registry.js';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const opts = {} as ChannelOpts;
function fakeChannel(
  name: string,
  connect: () => Promise<void> = async () => {},
): Channel {
  let connected = false;
  return {
    name,
    connect: async () => {
      await connect();
      connected = true;
    },
    disconnect: vi.fn(async () => {
      connected = false;
    }),
    isConnected: () => connected,
    ownsJid: () => false,
    sendMessage: async () => {},
  } as unknown as Channel;
}

describe('createChannelLifecycle', () => {
  it('starts through the registered factory, refuses unknown, live and unconfigured names', async () => {
    const channels: Channel[] = [];
    const ch = fakeChannel('gmail');
    const factories: Record<string, (o: ChannelOpts) => Channel | null> = {
      gmail: () => ch,
      telegram: () => null,
    };
    const life = createChannelLifecycle(channels, opts, (n) => factories[n]);
    expect(await life.startChannel('nope')).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(await life.startChannel('telegram')).toEqual({
      ok: false,
      reason: 'not configured',
    });
    expect(await life.startChannel('gmail')).toEqual({ ok: true });
    expect(channels).toEqual([ch]);
    expect(life.isChannelLive('gmail')).toBe(true);
    expect(await life.startChannel('gmail')).toEqual({
      ok: false,
      reason: 'live',
    });
    expect(await life.stopChannel('gmail')).toBe(true);
    expect(ch.disconnect).toHaveBeenCalledTimes(1);
    expect(channels).toEqual([]);
    expect(life.isChannelLive('gmail')).toBe(false);
    expect(await life.stopChannel('gmail')).toBe(false);
  });

  it('does not keep a channel whose connect threw, so a retry is possible', async () => {
    const channels: Channel[] = [];
    let attempts = 0;
    const life = createChannelLifecycle(
      channels,
      opts,
      () => () =>
        fakeChannel('gmail', async () => {
          if (attempts++ === 0) throw new Error('boom');
        }),
    );
    expect(await life.startChannel('gmail')).toEqual({
      ok: false,
      reason: 'connect failed',
    });
    expect(channels).toEqual([]);
    expect(await life.startChannel('gmail')).toEqual({ ok: true });
    expect(channels).toHaveLength(1);
  });
});
