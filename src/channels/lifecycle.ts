import type { Channel } from '../types.js';
import { logger } from '../logger.js';
import { getChannelFactory, type ChannelOpts } from './registry.js';

// Start or stop one registered channel in the running process — the same
// factory and options boot uses, minus boot's abort-on-failure: a request
// must never take the assistant down, so a failed connect is returned, not
// thrown, and the half-started channel is not kept.
export interface ChannelLifecycle {
  startChannel(name: string): Promise<
    | { ok: true }
    | {
        ok: false;
        reason: 'unknown' | 'live' | 'not configured' | 'connect failed';
      }
  >;
  stopChannel(name: string): Promise<boolean>;
  /** Named to match `ControlDeps.isChannelLive`, which `index.ts` fills by spreading this object. */
  isChannelLive(name: string): boolean;
}

export function createChannelLifecycle(
  channels: Channel[],
  channelOpts: ChannelOpts,
  factoryFor: (
    name: string,
  ) => ((opts: ChannelOpts) => Channel | null) | undefined = getChannelFactory,
): ChannelLifecycle {
  const find = (name: string) => channels.find((c) => c.name === name);
  return {
    isChannelLive: (name) => Boolean(find(name)?.isConnected()),
    async startChannel(name) {
      const factory = factoryFor(name);
      if (!factory) return { ok: false, reason: 'unknown' };
      if (find(name)) return { ok: false, reason: 'live' };
      const channel = factory(channelOpts);
      if (!channel) return { ok: false, reason: 'not configured' };
      channels.push(channel);
      try {
        await channel.connect();
      } catch (err) {
        const i = channels.indexOf(channel);
        if (i >= 0) channels.splice(i, 1);
        logger.error(
          { err, channel: name },
          'channel connect failed after a dashboard request',
        );
        return { ok: false, reason: 'connect failed' };
      }
      logger.info({ channel: name }, 'channel started from the dashboard');
      return { ok: true };
    },
    async stopChannel(name) {
      const channel = find(name);
      if (!channel) return false;
      const i = channels.indexOf(channel);
      if (i >= 0) channels.splice(i, 1);
      try {
        await channel.disconnect();
      } catch (err) {
        logger.warn({ err, channel: name }, 'channel disconnect failed');
      }
      return true;
    },
  };
}
