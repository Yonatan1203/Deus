import crypto from 'crypto';
import type { ServerResponse } from 'http';

import { buildConversationPrompt } from '../../odysseus-server.js';
import {
  abortWebTurn,
  startWebTurn,
  type WebTurnDeps,
} from '../../web-turn.js';
import type { ChatMessage, ChatStore } from './chat-store.js';

export const CHAT_SOURCE = 'control-ui';
const MAX_MESSAGE_CHARS = 32 * 1024;
export const PROMPT_MESSAGES_MAX = 200;
export const PROMPT_BYTES_MAX = 256 * 1024;
const ACTIVITY_KEEP = 30;
const KEEPALIVE_MS = 20_000;
const CHAT_ID_RE = /^[0-9a-f]{16}$/;

type Parsed = { chatId: string; message: string } | { error: string };

function parseBody(body: unknown): Parsed {
  const b = body as { chat_id?: unknown; message?: unknown } | null;
  if (typeof b?.chat_id !== 'string' || !CHAT_ID_RE.test(b.chat_id))
    return { error: 'chat_id is required — refresh the page' };
  const message = b.message;
  if (typeof message !== 'string' || !message.trim())
    return { error: 'message is required' };
  if (message.length > MAX_MESSAGE_CHARS) return { error: 'message too long' };
  return { chatId: b.chat_id, message };
}

/**
 * Which saved messages are offered to buildConversationPrompt, which then
 * applies its own tighter history budget (MAX_HISTORY_CHARS in
 * src/odysseus-server.ts, 24 000 chars by default) — that is the effective cap.
 * What Amos is shown of the chat: saved text only (never activity lines or
 * errors), newest first until 200 messages or 256 KiB, then back in order —
 * buildConversationPrompt finds the live ask by scanning from the end.
 */
export function promptWindow(
  messages: ChatMessage[],
): { role: 'user' | 'assistant'; content: string }[] {
  const picked: { role: 'user' | 'assistant'; content: string }[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.text) continue;
    const size = Buffer.byteLength(m.text);
    if (picked.length >= PROMPT_MESSAGES_MAX || bytes + size > PROMPT_BYTES_MAX)
      break;
    picked.push({ role: m.role, content: m.text });
    bytes += size;
  }
  return picked.reverse();
}

function frame(res: ServerResponse, type: string, data: unknown): void {
  if (res.writable)
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export type ChatStart =
  | { id: string; chatId: string; promptHash: string }
  | { status: 400 | 404 | 409 | 429 | 503; error: string };

/**
 * Runs one turn of a saved chat and streams it as SSE. The user's message is
 * saved as soon as the turn is admitted and Amos's reply when it ends —
 * whether or not the browser is still there, so a phone that locks mid-reply
 * finds the answer when it comes back.
 */
export function startChatTurn(
  runtime: WebTurnDeps,
  store: ChatStore,
  body: unknown,
  remoteAddr: string,
  res: ServerResponse,
  notify: (chatId: string, action: string) => void,
): ChatStart {
  const parsed = parseBody(body);
  if ('error' in parsed) return { status: 400, error: parsed.error };
  const chat = store.get(parsed.chatId);
  if (!chat) return { status: 404, error: 'chat not found' };
  if (chat.running_turn_id)
    return { status: 429, error: 'Amos is still replying in this chat' };
  const userMsg: ChatMessage = {
    role: 'user',
    text: parsed.message,
    at: Date.now(),
  };
  const refused = store.checkAppend(chat.id, userMsg);
  if (refused) return { status: 409, error: refused };

  const prompt = buildConversationPrompt({
    messages: promptWindow([...chat.messages, userMsg]),
  });
  const promptHash = crypto
    .createHash('sha256')
    .update(prompt)
    .digest('hex')
    .slice(0, 12);

  let text = '';
  const activity: string[] = [];
  const note = (line: string) => {
    activity.push(line);
    if (activity.length > ACTIVITY_KEEP) activity.shift();
  };
  let firstEvent = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const end = () => {
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (res.writable) res.end();
  };

  const turn = startWebTurn(runtime, {
    prompt,
    latest: parsed.message,
    stream: true,
    source: CHAT_SOURCE,
    remoteAddr,
    ...(chat.model && { model: chat.model }),
    ...(chat.effort && { effort: chat.effort }),
    onAccepted: (id) => {
      store.append(chat.id, userMsg);
      store.setRunning(chat.id, id);
      notify(chat.id, 'message');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      frame(res, 'turn_started', { id, chat_id: chat.id });
      keepalive = setInterval(() => {
        if (res.writable && !firstEvent) res.write(': ping\n\n');
      }, KEEPALIVE_MS);
      keepalive.unref();
    },
    onEvent: (event) => {
      firstEvent = true;
      if (event.type === 'output_text') text += event.text;
      else if (event.type === 'activity') note(event.text);
      else if (event.type === 'tool_call') note(`Used ${event.name}`);
      frame(res, event.type, event);
    },
    onDone: (error) => {
      // A deleted chat stays deleted: append and setRunning do nothing then.
      const reply: ChatMessage = { role: 'assistant', text, at: Date.now() };
      if (activity.length) reply.activity = activity;
      if (error)
        reply.error = error === 'turn stopped by user' ? 'Stopped' : error;
      else if (!text) reply.error = 'Amos finished without a reply.';
      store.append(chat.id, reply);
      store.setRunning(chat.id, null);
      notify(chat.id, 'message');
      if (error) frame(res, 'error', { error });
      end();
    },
  });
  if (!turn.ok) return { status: turn.status, error: turn.error };
  // The browser leaving is not a reason to stop: the reply is still saved.
  res.on('close', () => {
    if (keepalive) clearInterval(keepalive);
  });
  return { id: turn.id, chatId: chat.id, promptHash };
}

export function abortChatTurn(id: string): boolean {
  return abortWebTurn(id, { stop: true, source: CHAT_SOURCE });
}
