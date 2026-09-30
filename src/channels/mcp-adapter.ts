/**
 * Generic MCP-to-Channel adapter.
 *
 * Spawns an MCP channel server as a child process (stdio transport),
 * bridges it to the Deus Channel interface. Incoming messages arrive
 * via MCP logging notifications; outbound messages go through callTool.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { RetryableError } from '../errors/index.js';
import { logger } from '../logger.js';
import type {
  Channel,
  AudioAttachmentRef,
  NewMessage,
  NewReaction,
  OnChatMetadata,
  OnInboundMessage,
  OnInboundReaction,
} from '../types.js';

export interface McpChannelAdapterOpts {
  /** Channel name (e.g., 'whatsapp', 'telegram'). */
  name: string;
  /** Command to spawn the MCP server. */
  command: string;
  /** Arguments for the command. */
  args: string[];
  /** Environment variables passed to the child process. */
  env?: Record<string, string>;
  /** Callback for incoming messages. */
  onMessage: OnInboundMessage;
  /** Callback for incoming reactions. Channels without reaction support never call it. */
  onReaction?: OnInboundReaction;
  /** Callback for chat metadata discovery. */
  onChatMetadata: OnChatMetadata;
  /** JID ownership check — return true if this channel owns the JID. */
  ownsJid: (jid: string) => boolean;
}

/** Distinct dropped chat ids remembered per adapter, so each warns once (bounded: a child controls them). */
const DROP_WARN_CAP = 500;
const DROP_ID_MAX = 256;

export class McpChannelAdapter implements Channel {
  readonly name: string;

  private droppedWarned = new Set<string>();

  private client: Client;
  private transport: StdioClientTransport;
  private connected = false;
  private opts: McpChannelAdapterOpts;

  /**
   * Minimal shape check on the channel-supplied audio reference. The channel
   * process is a separate, credential-less child; the host's real boundary
   * control is `validateAudioRef` in src/openai-transcription.ts (realpath
   * containment, mimetype allow-map, size from fs.stat).
   */
  static toAudioRef(raw: unknown): AudioAttachmentRef | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const a = raw as Record<string, unknown>;
    if (typeof a.path !== 'string' || typeof a.mimetype !== 'string') {
      return undefined;
    }
    return {
      path: a.path,
      mimetype: a.mimetype,
      fileName: typeof a.fileName === 'string' ? a.fileName : undefined,
      isVoiceNote: a.isVoiceNote === true,
      bytes: typeof a.bytes === 'number' ? a.bytes : undefined,
    };
  }

  constructor(opts: McpChannelAdapterOpts) {
    this.opts = opts;
    this.name = opts.name;

    this.transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...opts.env }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });

    this.client = new Client({ name: 'deus-host', version: '1.0.0' });

    // Listen for incoming message notifications from the MCP server
    this.client.setNotificationHandler(
      LoggingMessageNotificationSchema,
      (notification) => {
        const params = notification.params;
        const data = params.data as Record<string, unknown> | undefined;
        if (!data) return;

        if (
          params.logger === 'incoming_reaction' ||
          params.logger === 'incoming_message'
        ) {
          if (!this.owns(data.chat_id)) return;
        }

        if (params.logger === 'incoming_reaction') {
          if (!opts.onReaction) return;
          const chatJid = data.chat_id as string;
          const reaction: NewReaction = {
            chat_jid: chatJid,
            sender: data.sender as string,
            sender_name: data.sender_name as string,
            reacted_to_message_id: data.reacted_to_message_id as string,
            emoji: (data.emoji as string) ?? '',
            timestamp: data.timestamp as string,
            is_group: data.is_group as boolean | undefined,
          };
          opts.onReaction(chatJid, reaction);
          return;
        }

        if (params.logger !== 'incoming_message') return;

        const chatJid = data.chat_id as string;
        if (!chatJid) return;
        const meta = data.metadata as Record<string, unknown> | undefined;
        const msg: NewMessage = {
          id: data.id as string,
          chat_jid: chatJid,
          sender: data.sender as string,
          sender_name: data.sender_name as string,
          content: data.content as string,
          timestamp: data.timestamp as string,
          is_from_me: data.is_from_me as boolean | undefined,
          is_bot_message: meta?.is_bot_message as boolean | undefined,
          imageData: meta?.imageData as string | undefined,
          audio: McpChannelAdapter.toAudioRef(meta?.audio),
        };

        // Chat metadata MUST be emitted before the message: messages.chat_jid
        // has a foreign key onto chats(jid) (db.ts), better-sqlite3 enforces
        // foreign keys by default, and storeMessage does not upsert its parent.
        // Emitting the message first meant the FIRST message in a newly
        // registered chat violated the constraint and was lost, with the user
        // simply seeing no reply (#1163). webhook.ts has always had this order.
        opts.onChatMetadata(
          chatJid,
          msg.timestamp,
          data.chat_name as string | undefined,
          opts.name,
          data.is_group as boolean | undefined,
        );

        opts.onMessage(chatJid, msg);
      },
    );
  }

  /**
   * The channel child is a separate trust zone (third-party credentials, untrusted network input):
   * its inbound items may only name chats this channel owns, or it could write into another
   * channel's chat, e.g. the WhatsApp main group from a Telegram child (#60).
   */
  private owns(chatId: unknown): chatId is string {
    if (typeof chatId === 'string' && chatId && this.opts.ownsJid(chatId)) {
      return true;
    }
    const id = typeof chatId === 'string' ? chatId : String(chatId);
    const shown = id.length > 64 ? `${id.slice(0, 64)}…` : id;
    const first =
      id.length <= DROP_ID_MAX &&
      this.droppedWarned.size < DROP_WARN_CAP &&
      !this.droppedWarned.has(id);
    if (first) {
      this.droppedWarned.add(id);
      logger.warn(
        { channel: this.name, chatJid: shown },
        'Dropped inbound item for a chat this channel does not own',
      );
    } else {
      logger.debug(
        { channel: this.name, chatJid: shown },
        'Dropped inbound item for a chat this channel does not own',
      );
    }
    return false;
  }

  async connect(): Promise<void> {
    logger.info({ channel: this.name }, 'Connecting MCP channel server');

    await this.client.connect(this.transport);

    // The MCP server auto-connects if credentials exist.
    // Call connect tool to ensure it's ready.
    try {
      await this.client.callTool({ name: 'get_status', arguments: {} });
      this.connected = true;
      logger.info({ channel: this.name }, 'MCP channel server connected');
    } catch (err) {
      logger.error(
        { channel: this.name, err },
        'MCP channel server status check failed',
      );
      this.connected = true; // Server is running, connection may be pending
    }
  }

  /** Call one of the channel server's own tools; throws on a tool error. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const text = Array.isArray(result.content)
      ? result.content.map((c) => ('text' in c ? c.text : '')).join(' ')
      : '';
    if (result.isError) {
      throw new Error(`${name} failed: ${text || 'unknown error'}`);
    }
    return text;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const result = await this.client.callTool({
      name: 'send_message',
      arguments: { chat_id: jid, text },
    });
    if (result.isError) {
      const msg = Array.isArray(result.content)
        ? result.content.map((c) => ('text' in c ? c.text : '')).join(' ')
        : 'unknown error';
      throw new RetryableError(`send_message failed: ${msg}`, {
        context: { jid, channel: this.name },
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return this.opts.ownsJid(jid);
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.callTool({ name: 'disconnect', arguments: {} });
    } catch {
      // Server may already be stopped
    }
    await this.client.close();
    this.connected = false;
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.client.callTool({
        name: 'send_typing',
        arguments: { chat_id: jid, is_typing: isTyping },
      });
    } catch {
      // Best effort
    }
  }

  async syncGroups(): Promise<void> {
    try {
      await this.client.callTool({
        name: 'sync_groups',
        arguments: { force: true },
      });
    } catch {
      // Best effort
    }
  }
}
