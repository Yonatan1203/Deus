import fs from 'fs';
import path from 'path';
import { readTail, transcriptPath } from './claude-sessions.js';
import { redactSecrets } from './logs.js';

// A Claude session's transcript, shaped for the Claude tab's conversation
// view. Only what the view draws leaves this module: text, a one-line summary
// per tool call, line counts for file edits and artifact links. Tool output
// and thinking stay on the host. Every string is redacted.

// Tool results (images especially) are large: 2 MiB held about five replies
// of a real session, 8 MiB about thirty, parsed in ~50 ms and memoized.
export const TAIL_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const TEXT_MAX = 20_000;
const SUMMARY_MAX = 120;
const OUTPUT_MAX = 300;
const DEFAULT_LIMIT = 300;
const MEMO_MAX = 8; // entries can be large; only open views are read
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
  'dontAsk',
];
const ARTIFACT_URL_RE =
  /https:\/\/claude\.ai\/[A-Za-z0-9/_-]*artifact[A-Za-z0-9/_-]*/;

export type ConvItem =
  | { k: 'user'; text: string; queued?: boolean }
  | { k: 'assistant'; text: string }
  | {
      k: 'tool';
      tool: string;
      summary: string;
      file?: string;
      added?: number;
      removed?: number;
      url?: string;
    }
  | {
      k: 'ask';
      id: string;
      questions: AskQuestion[];
      answered: boolean;
      answer?: string;
    }
  | { k: 'command'; name: string; args: string; output?: string }
  | { k: 'note'; text: string };

export interface Conversation {
  items: ConvItem[];
  truncated: boolean;
  model: string | null;
  effort: string | null;
  mode: string | null;
}

type Block = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
};

const clip = (s: string, n: number) => redactSecrets(s).slice(0, n);
const lines = (s: unknown) =>
  typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n').length : 0;
const tag = (s: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(s)?.[1]?.trim() ?? null;

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .map((b) =>
      b?.type === 'text' && typeof b.text === 'string' ? b.text : '',
    )
    .join('\n');
}

function toolItem(b: Block): ConvItem {
  const inp = b.input ?? {};
  const name = String(b.name).slice(0, 40);
  const hint = [
    'description',
    'command',
    'file_path',
    'pattern',
    'url',
    'prompt',
  ]
    .map((k) => inp[k])
    .find((v) => typeof v === 'string' && v) as string | undefined;
  const item: Extract<ConvItem, { k: 'tool' }> = {
    k: 'tool',
    tool: name,
    summary: clip(hint ?? '', SUMMARY_MAX),
  };
  const file =
    typeof inp.file_path === 'string'
      ? clip(path.basename(inp.file_path), 80)
      : undefined;
  if (name === 'Edit') {
    Object.assign(item, {
      file,
      added: lines(inp.new_string),
      removed: lines(inp.old_string),
    });
  } else if (name === 'MultiEdit') {
    const edits = Array.isArray(inp.edits)
      ? (inp.edits as Record<string, unknown>[])
      : [];
    Object.assign(item, {
      file,
      added: edits.reduce((n, e) => n + lines(e?.new_string), 0),
      removed: edits.reduce((n, e) => n + lines(e?.old_string), 0),
    });
  } else if (name === 'Write') {
    Object.assign(item, { file, added: lines(inp.content), removed: 0 });
  }
  return item;
}

/** One question of an AskUserQuestion call, as the card shows it. */
export interface AskQuestion {
  question: string;
  header: string;
  options: string[];
  multi: boolean;
}

const ASK_QUESTIONS_MAX = 4;
const ASK_OPTIONS_MAX = 6;
const ASK_RESULT_SCAN = 4096;

// `id` is the tool_use id: the card keys the operator's picks by it, so
// nothing depends on the item's position in the list.
function askItem(b: Block): ConvItem | null {
  const raw = (b.input ?? {}).questions;
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const questions: AskQuestion[] = [];
  for (const q of list.slice(0, ASK_QUESTIONS_MAX)) {
    if (!q || typeof q.question !== 'string') continue;
    const opts = Array.isArray(q.options) ? (q.options as unknown[]) : [];
    questions.push({
      question: clip(q.question, 500),
      header: typeof q.header === 'string' ? clip(q.header, 30) : '',
      options: opts
        .slice(0, ASK_OPTIONS_MAX)
        .map((o) =>
          clip(String((o as { label?: unknown })?.label ?? o ?? ''), 80),
        ),
      multi: q.multiSelect === true,
    });
  }
  if (!questions.length) return null;
  return {
    k: 'ask',
    id: clip(typeof b.id === 'string' ? b.id : '', 64),
    questions,
    answered: false,
  };
}

/** The answers out of Claude Code's result text: `"question"="answer"` pairs, joined. */
export function parseAskAnswer(text: string): string {
  const found: string[] = [];
  for (const m of text
    .slice(0, ASK_RESULT_SCAN)
    .matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g))
    found.push(m[2]);
  return clip(found.join(' · '), 400);
}

export function buildConversation(
  rows: Record<string, unknown>[],
  limit = DEFAULT_LIMIT,
): Conversation {
  const items: ConvItem[] = [];
  const pending = new Map<string, ConvItem>(); // tool_use id → its item
  let model: string | null = null;
  let effort: string | null = null;
  let mode: string | null = null;

  const userText = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    if (
      s.startsWith('<system-reminder>') ||
      s.startsWith('<task-notification>')
    )
      return;
    const cmd = tag(s, 'command-name');
    if (cmd !== null) {
      items.push({
        k: 'command',
        name: clip(cmd, 64),
        args: clip(tag(s, 'command-args') ?? '', 200),
      });
      return;
    }
    const out = tag(s, 'local-command-stdout');
    if (out !== null) {
      const m = /Set effort level to (\w+)/.exec(out);
      if (m) effort = EFFORT_LEVELS.includes(m[1]) ? m[1] : null;
      const prev = items[items.length - 1];
      const clean = clip(out, OUTPUT_MAX);
      if (prev && prev.k === 'command' && prev.output === undefined)
        prev.output = clean;
      else if (clean) items.push({ k: 'note', text: clean });
      return;
    }
    if (s.startsWith('This session is being continued'))
      return void items.push({
        k: 'note',
        text: 'Continued from an earlier conversation',
      });
    if (s.startsWith('[Request interrupted by user'))
      return void items.push({ k: 'note', text: 'Interrupted' });
    items.push({ k: 'user', text: clip(s, TEXT_MAX) });
  };

  // A message typed while Claude works is a queue-operation row: `enqueue`,
  // then either a user row with the same text (delivered as the next turn —
  // with or without a `dequeue` row first) or `remove` with
  // `absorbed_mid_turn` (delivered inside the running turn — no user row
  // ever). Queued bubbles show at once; the delivered user row retires one;
  // other removes drop it. `dequeue` itself is ignored so a bubble is never
  // retired twice. Dropped items are tombstoned and filtered at the end so
  // tool-result pairing by reference is untouched.
  const queued = new Map<string, ConvItem[]>(); // content → queued items
  const dropped = new Set<ConvItem>();
  const takeQueued = (content: string): ConvItem | undefined =>
    queued.get(content)?.pop();

  for (const e of rows) {
    if (e.type === 'permission-mode') {
      const pm = String(e.permissionMode);
      mode = PERMISSION_MODES.includes(pm) ? pm : null;
      continue;
    }
    if (e.type === 'queue-operation') {
      if (typeof e.content !== 'string') continue;
      if (e.operation === 'enqueue') {
        const it: ConvItem = {
          k: 'user',
          text: clip(e.content.trim(), TEXT_MAX),
          queued: true,
        };
        items.push(it);
        const list = queued.get(e.content) ?? [];
        list.push(it);
        queued.set(e.content, list);
      } else if (e.operation === 'remove') {
        const it = takeQueued(e.content);
        if (!it) continue;
        if (e.reason === 'absorbed_mid_turn' && it.k === 'user')
          delete it.queued;
        else dropped.add(it);
      }
      continue;
    }
    if (e.isSidechain === true || e.isMeta === true) continue;
    const msg = e.message as { content?: unknown; model?: unknown } | undefined;
    const content = msg?.content;
    if (e.type === 'user') {
      if (typeof content === 'string') {
        // A queued message delivered as the next turn (with or without a
        // dequeue row before it): the real row takes over from the bubble.
        const q = takeQueued(content);
        if (q) dropped.add(q);
        userText(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content as Block[]) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const it = pending.get(b.tool_use_id);
          if (it?.k === 'ask') {
            it.answered = true;
            const answer = parseAskAnswer(resultText(b.content));
            if (answer) it.answer = answer;
          } else if (it?.k === 'tool' && it.tool === 'Artifact') {
            const url = ARTIFACT_URL_RE.exec(resultText(b.content))?.[0];
            if (url) it.url = url;
          }
          pending.delete(b.tool_use_id);
        } else if (b?.type === 'image') {
          items.push({ k: 'note', text: 'Image' });
        } else if (b?.type === 'text' && typeof b.text === 'string') {
          userText(b.text);
        }
      }
    } else if (e.type === 'assistant') {
      if (typeof msg?.model === 'string' && msg.model.startsWith('claude'))
        model = msg.model.slice(0, 64);
      if (!Array.isArray(content)) continue;
      for (const b of content as Block[]) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          items.push({ k: 'assistant', text: clip(b.text.trim(), TEXT_MAX) });
        } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const it = b.name === 'AskUserQuestion' ? askItem(b) : toolItem(b);
          if (!it) continue;
          items.push(it);
          if (typeof b.id === 'string') pending.set(b.id, it);
        }
      }
    }
  }
  const kept = dropped.size ? items.filter((it) => !dropped.has(it)) : items;
  return {
    items: kept.slice(-limit),
    truncated: kept.length > limit,
    model,
    effort,
    mode,
  };
}

/** Transcript → conversation, memoized on the file's mtime and size (its version). */
export function createConversationReader(projectsDir: string) {
  const memo = new Map<string, { version: string; conv: Conversation }>();
  return (
    sessionId: string,
  ): { version: string; conv: Conversation } | null => {
    const file = transcriptPath(projectsDir, sessionId);
    if (!file) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const version = `${Math.trunc(st.mtimeMs)}:${st.size}`;
    const hit = memo.get(sessionId);
    if (hit && hit.version === version) return hit;
    const tail = readTail(file, TAIL_TRANSCRIPT_BYTES);
    const conv = buildConversation(tail.rows);
    if (tail.truncated) conv.truncated = true;
    const entry = { version, conv };
    memo.delete(sessionId);
    memo.set(sessionId, entry);
    if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
    return entry;
  };
}
