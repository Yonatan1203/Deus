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
const ARTIFACT_URLS_RE = new RegExp(ARTIFACT_URL_RE.source, 'g');

/** Every item may carry the transcript row's time (`ts`, ISO) and a `clipped` mark. */
export type ConvItem = (
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
  | { k: 'note'; text: string }
) & { ts?: string; clipped?: true };

/** A successful `Artifact` publish: the local page and the link it produced. */
export interface ArtifactCall {
  file_path: string;
  url: string;
}
export const ARTIFACT_CALLS_MAX = 20;

export interface Conversation {
  items: ConvItem[];
  /** Raw, bounded, for the auto-capture (artifact-capture.ts); never sent to the browser. */
  artifactCalls: ArtifactCall[];
  truncated: boolean;
  model: string | null;
  /** Between a `/model` switch and the next reply: the name Claude Code printed. */
  model_label: string | null;
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
  is_error?: boolean;
  content?: unknown;
};

const clip = (s: string, n: number) => redactSecrets(s).slice(0, n);
/** The bounded message texts: says when it cut, so the view can show it. */
const clipMarked = (
  s: string,
  n: number,
): { text: string; clipped: boolean } => {
  const t = redactSecrets(s);
  return { text: t.slice(0, n), clipped: t.length > n };
};
const marked = <T extends { text: string }>(
  it: T,
  cut: boolean,
): T & { clipped?: true } => (cut ? { ...it, clipped: true as const } : it);
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

// Text the harness puts into the session as if it were a message: subagent
// hand-backs, task notifications, other sessions' messages, artifact
// content. The terminal does not show these as the operator's words, so
// neither does the conversation view. Seen in transcripts 2026-09-26. Tag
// prefixes stop before `>` on purpose: the tags carry attributes.
const HARNESS_PREFIXES = [
  '<system-reminder>',
  '<task-notification',
  '<agent-message',
  'Another Claude session sent a message',
  '<cross-session-message',
  '<artifact-content-authored-by-others',
  '<local-command-caveat',
];
const isHarness = (s: string) => HARNESS_PREFIXES.some((p) => s.startsWith(p));

// A paste arrives wrapped in <pasted_content id="…">…</pasted_content id="…">
// (the closing tag repeats the id); the operator wrote what is inside. All
// blocks in a message, separators kept. Bounded first so a huge message
// costs no more than the text that could be shown anyway.
const PASTE_RE = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g;
const unwrapPastes = (s: string) =>
  s
    .slice(0, TEXT_MAX * 2)
    .replace(PASTE_RE, '$1')
    .trim();

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
  // Artifact publishes: the absolute file_path of the tool_use, paired with
  // its result by id; only a non-error result with exactly one link counts.
  const artifactFiles = new Map<string, string>();
  const artifactCalls: ArtifactCall[] = [];
  let model: string | null = null;
  let model_label: string | null = null;
  let effort: string | null = null;
  let mode: string | null = null;

  const userText = (raw: string) => {
    const s = raw.trim();
    if (!s) return;
    if (isHarness(s)) return;
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
      // `/model` prints a display name ("Opus 5.5"); the id arrives with the
      // next reply. Rows are in order, so the last write wins.
      const mm = /Set model to `([^`]{1,60})`/.exec(out);
      if (mm) {
        model_label = mm[1];
        model = null;
      }
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
    const m = clipMarked(unwrapPastes(s), TEXT_MAX);
    items.push(marked({ k: 'user' as const, text: m.text }, m.clipped));
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

  // Each row's time rides on the items it produced (the day separators).
  let mark = 0;
  let rowTs: string | null = null;
  const stamp = () => {
    if (!rowTs) return;
    for (let i = mark; i < items.length; i++)
      if (items[i].ts === undefined) items[i].ts = rowTs;
  };
  for (const e of rows) {
    stamp();
    mark = items.length;
    const ts = (e as { timestamp?: unknown }).timestamp;
    rowTs = typeof ts === 'string' && /^\d{4}-\d\d-\d\dT/.test(ts) ? ts : null;
    if (e.type === 'permission-mode') {
      const pm = String(e.permissionMode);
      mode = PERMISSION_MODES.includes(pm) ? pm : null;
      continue;
    }
    if (e.type === 'queue-operation') {
      if (typeof e.content !== 'string') continue;
      if (e.operation === 'enqueue') {
        // Harness text is queued like anything else; it is never registered,
        // so its later user/remove rows find nothing and do nothing.
        if (isHarness(e.content.trim())) continue;
        const m = clipMarked(unwrapPastes(e.content), TEXT_MAX);
        const it: ConvItem = marked(
          { k: 'user' as const, text: m.text, queued: true },
          m.clipped,
        );
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
            const text = resultText(b.content);
            const url = ARTIFACT_URL_RE.exec(text)?.[0];
            if (url) it.url = url;
            const file = artifactFiles.get(b.tool_use_id);
            const links = text.match(ARTIFACT_URLS_RE) ?? [];
            if (file && url && b.is_error !== true && links.length === 1) {
              artifactCalls.push({ file_path: file, url });
              if (artifactCalls.length > ARTIFACT_CALLS_MAX)
                artifactCalls.shift(); // the newest publishes are the ones to show
            }
          }
          artifactFiles.delete(b.tool_use_id);
          pending.delete(b.tool_use_id);
        } else if (b?.type === 'image') {
          items.push({ k: 'note', text: 'Image' });
        } else if (b?.type === 'text' && typeof b.text === 'string') {
          userText(b.text);
        }
      }
    } else if (e.type === 'assistant') {
      if (typeof msg?.model === 'string' && msg.model.startsWith('claude')) {
        model = msg.model.slice(0, 64);
        model_label = null;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content as Block[]) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const m = clipMarked(b.text.trim(), TEXT_MAX);
          items.push(
            marked({ k: 'assistant' as const, text: m.text }, m.clipped),
          );
        } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
          const it = b.name === 'AskUserQuestion' ? askItem(b) : toolItem(b);
          if (!it) continue;
          items.push(it);
          if (typeof b.id === 'string') {
            pending.set(b.id, it);
            const fp = b.input?.file_path;
            if (
              b.name === 'Artifact' &&
              typeof fp === 'string' &&
              path.isAbsolute(fp) &&
              fp.length <= 1024
            )
              artifactFiles.set(b.id, fp);
          }
        }
      }
    }
  }
  stamp();
  const kept = dropped.size ? items.filter((it) => !dropped.has(it)) : items;
  return {
    items: kept.slice(-limit),
    artifactCalls,
    truncated: kept.length > limit,
    model,
    model_label,
    effort,
    mode,
  };
}

/**
 * Claude Code's defaults from `~/.claude/settings.json`, resolved
 * deterministically or not at all: `model` is the alias (`opus`); the effort
 * comes from `modelSettings[<the session's model id>]` when the transcript
 * knows it, else from the highest-versioned `claude-<alias>(-N…)` key, else
 * from a key equal to the alias — never from "whichever key mentions it".
 */
export function resolveDefaults(
  settings: unknown,
  modelId: string | null,
): { model: string | null; effort: string | null } {
  const out: { model: string | null; effort: string | null } = {
    model: null,
    effort: null,
  };
  if (!settings || typeof settings !== 'object') return out;
  const s = settings as Record<string, unknown>;
  const alias =
    typeof s.model === 'string' && s.model.length > 0 && s.model.length <= 40
      ? s.model
      : null;
  out.model = alias;
  const ms =
    s.modelSettings && typeof s.modelSettings === 'object'
      ? (s.modelSettings as Record<string, unknown>)
      : null;
  if (!ms) return out;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(ms, k);
  let key: string | null = null;
  if (modelId && has(modelId)) key = modelId;
  else if (alias) {
    const re = new RegExp(
      `^claude-${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+(-\\d+)*)?$`,
    );
    const matches = Object.keys(ms)
      .filter((k) => re.test(k))
      .sort(compareVersions);
    if (matches.length) key = matches[matches.length - 1];
    else if (has(alias)) key = alias;
  }
  if (!key) return out;
  const entry = ms[key];
  const level =
    entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).effortLevel
      : undefined;
  if (typeof level === 'string' && EFFORT_LEVELS.includes(level))
    out.effort = level;
  return out;
}
const numbers = (k: string): number[] => (k.match(/\d+/g) ?? []).map(Number);
function compareVersions(a: string, b: string): number {
  const x = numbers(a);
  const y = numbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const SETTINGS_MAX = 256 * 1024;
/** The settings file, parsed, memoized on its mtime and size; null when unreadable. */
export function createDefaultsReader(file: string) {
  let memo: { version: string; settings: unknown } | null = null;
  return (): { version: string; settings: unknown } | null => {
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size > SETTINGS_MAX) return null;
      const version = `${Math.trunc(st.mtimeMs)}:${st.size}`;
      if (memo && memo.version === version) return memo;
      const buf = Buffer.alloc(st.size);
      const n = fs.readSync(fd, buf, 0, st.size, 0);
      memo = {
        version,
        settings: JSON.parse(buf.subarray(0, n).toString('utf-8')),
      };
      return memo;
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
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
