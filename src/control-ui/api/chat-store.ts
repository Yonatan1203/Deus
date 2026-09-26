import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  AGENT_MODELS,
  VALID_EFFORT_LEVELS,
  type AgentEffortLevel,
  type AgentModel,
} from '../../types.js';

// Chats with Amos from the dashboard, one JSON file each, so every device the
// operator signs in from sees the same list. The folder is the operator's own
// config dir: never mounted into a container. Limits refuse rather than drop:
// a full chat says so, and nothing already saved is ever trimmed.

export const CHATS_MAX = 50;
export const MESSAGES_MAX = 400;
export const CHAT_BYTES_MAX = 4 * 1024 * 1024; // write budget
export const CHAT_READ_MAX = 5 * 1024 * 1024; // above it, so a saved chat always reads
const TEXT_MAX = 32 * 1024; // what you send
const REPLY_MAX = 256 * 1024; // what Amos sends back
const CUT_NOTE = '\n\n[Reply cut at 256 KB.]';
const ACTIVITY_LINES = 30;
const ACTIVITY_CHARS = 200;
const TITLE_MAX = 80;
const DEFAULT_TITLE = 'New chat';
const ID_RE = /^[0-9a-f]{16}$/;
const TURN_RE = /^[0-9a-f]{16}$/;
const FULL = 'this chat is full — start a new chat';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
  activity?: string[];
  error?: string;
}
export interface Chat {
  id: string;
  title: string;
  created: number;
  updated: number;
  model: AgentModel | null;
  effort: AgentEffortLevel | null;
  running_turn_id: string | null;
  messages: ChatMessage[];
}
export interface ChatSummary {
  id: string;
  title: string;
  updated: number;
  preview: string;
  model: AgentModel | null;
  effort: AgentEffortLevel | null;
  running: boolean;
}

const isModel = (v: unknown): v is AgentModel =>
  typeof v === 'string' && (AGENT_MODELS as readonly string[]).includes(v);
const isEffort = (v: unknown): v is AgentEffortLevel =>
  typeof v === 'string' &&
  (VALID_EFFORT_LEVELS as readonly string[]).includes(v);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A clean copy of a message, or null when it is not one. */
function cleanMessage(m: unknown): ChatMessage | 'too long' | null {
  const x = m as Partial<ChatMessage> | null;
  if (!x || (x.role !== 'user' && x.role !== 'assistant')) return null;
  if (typeof x.text !== 'string') return null;
  if (x.role === 'user' && x.text.length > TEXT_MAX) return 'too long';
  const text =
    x.text.length > REPLY_MAX
      ? x.text.slice(0, REPLY_MAX - CUT_NOTE.length) + CUT_NOTE
      : x.text;
  const out: ChatMessage = {
    role: x.role,
    text,
    at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : Date.now(),
  };
  if (Array.isArray(x.activity))
    out.activity = x.activity
      .filter((l): l is string => typeof l === 'string')
      .slice(-ACTIVITY_LINES)
      .map((l) => l.slice(0, ACTIVITY_CHARS));
  if (typeof x.error === 'string') out.error = x.error.slice(0, 500);
  return out;
}

function parseChat(text: string, id: string): Chat | null {
  try {
    const v = JSON.parse(text) as Partial<Chat> & { v?: number };
    if (v?.v !== 1 || v.id !== id || !Array.isArray(v.messages)) return null;
    const messages: ChatMessage[] = [];
    for (const m of v.messages) {
      const c = cleanMessage(m);
      if (c && c !== 'too long') messages.push(c);
    }
    return {
      id,
      title: typeof v.title === 'string' ? v.title : DEFAULT_TITLE,
      created: Number(v.created) || 0,
      updated: Number(v.updated) || 0,
      model: isModel(v.model) ? v.model : null,
      effort: isEffort(v.effort) ? v.effort : null,
      running_turn_id:
        typeof v.running_turn_id === 'string' && TURN_RE.test(v.running_turn_id)
          ? v.running_turn_id
          : null,
      messages,
    };
  } catch {
    return null;
  }
}

export function createChatStore(dir: string, now: () => number = Date.now) {
  const file = (id: string) => path.join(dir, `${id}.json`);

  /** Reads a chat only when its file is a plain file of sane size. */
  const read = (id: string): Chat | null => {
    if (!ID_RE.test(id)) return null;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file(id));
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > CHAT_READ_MAX) return null;
    try {
      return parseChat(fs.readFileSync(file(id), 'utf-8'), id);
    } catch {
      return null;
    }
  };

  const serialize = (c: Chat) => JSON.stringify({ v: 1, ...c }) + '\n';

  /** Temp file, then rename: a crash never leaves half a chat. */
  const write = (c: Chat): boolean => {
    const tmp = path.join(
      dir,
      `.${c.id}.tmp-${crypto.randomBytes(4).toString('hex')}`,
    );
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, serialize(c), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file(c.id));
      return true;
    } catch {
      fs.rmSync(tmp, { force: true });
      return false;
    }
  };

  const ids = (): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json') && ID_RE.test(f.slice(0, -5)))
        .map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  };

  const fits = (c: Chat) =>
    c.messages.length <= MESSAGES_MAX &&
    Buffer.byteLength(serialize(c)) <= CHAT_BYTES_MAX;

  const summary = (c: Chat): ChatSummary => {
    const last = c.messages[c.messages.length - 1];
    return {
      id: c.id,
      title: c.title,
      updated: c.updated,
      preview: last ? oneLine(last.text || last.error || '').slice(0, 120) : '',
      model: c.model,
      effort: c.effort,
      running: c.running_turn_id !== null,
    };
  };

  return {
    dir,

    list(): ChatSummary[] {
      return ids()
        .map(read)
        .filter((c): c is Chat => c !== null)
        .sort((a, b) => b.updated - a.updated)
        .map(summary);
    },

    get: read,

    create(
      init: { title?: string; messages?: unknown[] } = {},
    ): Chat | { error: string } {
      if (ids().length >= CHATS_MAX)
        return { error: 'too many chats — delete one first' };
      const messages: ChatMessage[] = [];
      for (const m of init.messages ?? []) {
        const c = cleanMessage(m);
        if (c === 'too long') return { error: 'message too long' };
        if (!c) return { error: 'invalid message' };
        messages.push(c);
      }
      const t = now();
      const title = oneLine(init.title ?? '').slice(0, TITLE_MAX);
      const chat: Chat = {
        id: crypto.randomBytes(8).toString('hex'),
        title: title || DEFAULT_TITLE,
        created: t,
        updated: t,
        model: null,
        effort: null,
        running_turn_id: null,
        messages,
      };
      if (!fits(chat)) return { error: FULL };
      return write(chat) ? chat : { error: 'could not save the chat' };
    },

    update(
      id: string,
      patch: {
        title?: string;
        model?: AgentModel | null;
        effort?: AgentEffortLevel | null;
      },
    ): Chat | null {
      const c = read(id);
      if (!c) return null;
      if (patch.title !== undefined) {
        const t = oneLine(patch.title).slice(0, TITLE_MAX);
        if (t) c.title = t;
      }
      if (patch.model !== undefined)
        c.model = isModel(patch.model) ? patch.model : null;
      if (patch.effort !== undefined)
        c.effort = isEffort(patch.effort) ? patch.effort : null;
      c.updated = now();
      return write(c) ? c : null;
    },

    /** Why `append` would refuse this message, or null when it would fit. Writes nothing. */
    checkAppend(id: string, m: ChatMessage): string | null {
      const c = read(id);
      if (!c) return 'not found';
      const clean = cleanMessage(m);
      if (clean === 'too long') return 'message too long';
      if (!clean) return 'invalid message';
      return fits({ ...c, messages: [...c.messages, clean] }) ? null : FULL;
    },

    /**
     * Adds a message. Amos's reply to a message already accepted may use the
     * headroom up to the read cap, so an answer is never lost to a full chat.
     */
    append(id: string, m: ChatMessage): Chat | { error: string } {
      const c = read(id);
      if (!c) return { error: 'not found' };
      const clean = cleanMessage(m);
      if (clean === 'too long') return { error: 'message too long' };
      if (!clean) return { error: 'invalid message' };
      const next: Chat = {
        ...c,
        messages: [...c.messages, clean],
        updated: now(),
      };
      // An untitled chat takes its first user message's first line.
      if (
        c.title === DEFAULT_TITLE &&
        clean.role === 'user' &&
        !c.messages.some((x) => x.role === 'user')
      ) {
        const first = oneLine(clean.text.split('\n')[0] ?? '').slice(
          0,
          TITLE_MAX,
        );
        if (first) next.title = first;
      }
      const ok =
        clean.role === 'assistant'
          ? Buffer.byteLength(serialize(next)) <= CHAT_READ_MAX
          : fits(next);
      if (!ok) return { error: FULL };
      return write(next) ? next : { error: 'could not save the chat' };
    },

    /** Marks a turn as running (or clears it); a deleted chat stays deleted. */
    setRunning(id: string, turnId: string | null): boolean {
      const c = read(id);
      if (!c) return false;
      c.running_turn_id =
        turnId !== null && TURN_RE.test(turnId) ? turnId : null;
      return write(c);
    },

    /** At startup: a chat still marked running was cut off by a restart. Says so in the chat. */
    interruptStale(): number {
      let n = 0;
      for (const id of ids()) {
        const c = read(id);
        if (!c || c.running_turn_id === null) continue;
        c.running_turn_id = null;
        const note: ChatMessage = {
          role: 'assistant',
          text: '',
          at: now(),
          error: 'Interrupted — the service restarted before Amos replied.',
        };
        // Even a full chat gets the note: it is small, and silence would be worse.
        c.messages.push(note);
        c.updated = now();
        if (write(c)) n++;
      }
      return n;
    },

    remove(id: string): boolean {
      if (!ID_RE.test(id)) return false;
      try {
        const st = fs.lstatSync(file(id));
        if (!st.isFile()) return false;
        fs.rmSync(file(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
