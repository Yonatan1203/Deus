import { logger } from '../logger.js';
import { findChannel } from '../router.js';
import type { Channel } from '../types.js';
import type { WebTurnDeps } from '../web-turn.js';

export interface OperatorNoticeDeps {
  runtime?: Pick<WebTurnDeps, 'registeredGroups'>;
  channels?: () => Channel[];
}

/**
 * Sends one line to the control group (the registered group with
 * `isControlGroup`; the first by JID when there are several) through the
 * channel that owns it, as-is: the channel adds its own sender prefix (the
 * WhatsApp channel prefixes the assistant name on a shared number). Fire-and-forget: a missing group or channel, or a
 * failed send, is one warn — it never throws and never blocks the caller.
 */
export function notifyOperator(deps: OperatorNoticeDeps, text: string): void {
  const warn = (outcome: string, err?: unknown) =>
    logger.warn(
      {
        event: 'control_ui_operator_notice',
        outcome,
        ...(err === undefined
          ? {}
          : { err: err instanceof Error ? err.message : String(err) }),
      },
      'Control UI operator notice not sent',
    );
  try {
    const jid = Object.entries(deps.runtime?.registeredGroups() ?? {})
      .filter(([, g]) => g.isControlGroup === true)
      .map(([j]) => j)
      .sort()[0];
    if (!jid) return warn('no_control_group');
    const channel = findChannel(deps.channels?.() ?? [], jid);
    if (!channel) return warn('no_channel');
    channel
      .sendMessage(jid, text)
      .catch((err: unknown) => warn('send_failed', err));
  } catch (err) {
    warn('send_failed', err);
  }
}
