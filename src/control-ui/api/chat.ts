import crypto from 'crypto';
import type { ServerResponse } from 'http';

import { buildConversationPrompt } from '../../odysseus-server.js';
import {
  abortWebTurn,
  startWebTurn,
  type WebTurnDeps,
} from '../../web-turn.js';

export const CHAT_SOURCE = 'control-ui';
const MAX_MESSAGE_CHARS = 32 * 1024;
const MAX_HISTORY = 200;
const KEEPALIVE_MS = 20_000;

interface HistoryEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

type Parsed = { message: string; history: HistoryEntry[] } | { error: string };

function parseBody(body: unknown): Parsed {
  const b = body as { message?: unknown; history?: unknown } | null;
  const message = b?.message;
  if (typeof message !== 'string' || !message.trim())
    return { error: 'message is required' };
  if (message.length > MAX_MESSAGE_CHARS) return { error: 'message too long' };
  const history: HistoryEntry[] = [];
  if (b?.history !== undefined) {
    if (!Array.isArray(b.history) || b.history.length > MAX_HISTORY) {
      return { error: 'history must be an array of at most 200 entries' };
    }
    for (const h of b.history) {
      const e = h as { role?: unknown; content?: unknown } | null;
      if (
        !e ||
        (e.role !== 'user' && e.role !== 'assistant' && e.role !== 'system') ||
        typeof e.content !== 'string'
      ) {
        return { error: 'history entries need a role and string content' };
      }
      history.push({ role: e.role, content: e.content });
    }
  }
  return { message, history };
}

function frame(res: ServerResponse, type: string, data: unknown): void {
  if (res.writable)
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

export type ChatStart =
  | { id: string; promptHash: string }
  | { status: 400 | 429 | 503; error: string };

/**
 * Runs one dashboard chat turn and streams its RuntimeEvents as SSE frames.
 * Transport events are written only while the response is writable; the
 * turn itself (admission, wind-down, consolidation) is web-turn's.
 */
export function startChatTurn(
  runtime: WebTurnDeps,
  body: unknown,
  remoteAddr: string,
  res: ServerResponse,
): ChatStart {
  const parsed = parseBody(body);
  if ('error' in parsed) return { status: 400, error: parsed.error };
  const prompt = buildConversationPrompt({
    messages: [...parsed.history, { role: 'user', content: parsed.message }],
  });
  const promptHash = crypto
    .createHash('sha256')
    .update(prompt)
    .digest('hex')
    .slice(0, 12);

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
    onAccepted: (id) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      frame(res, 'turn_started', { id });
      keepalive = setInterval(() => {
        if (res.writable && !firstEvent) res.write(': ping\n\n');
      }, KEEPALIVE_MS);
      keepalive.unref();
    },
    onEvent: (event) => {
      firstEvent = true;
      frame(res, event.type, event);
    },
    onDone: (error) => {
      if (error) frame(res, 'error', { error });
      end();
    },
  });
  if (!turn.ok) return { status: turn.status, error: turn.error };
  res.on('close', () => turn.abort());
  return { id: turn.id, promptHash };
}

export function abortChatTurn(id: string): boolean {
  return abortWebTurn(id, { stop: true, source: CHAT_SOURCE });
}
