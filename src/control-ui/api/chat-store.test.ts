import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IS_WINDOWS } from '../../platform.js';
import {
  CHAT_BYTES_MAX,
  CHAT_READ_MAX,
  CHATS_MAX,
  MESSAGES_MAX,
  createChatStore,
} from './chat-store.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chats-'));
const user = (text: string, at = 1) => ({ role: 'user' as const, text, at });
const reply = (text: string, at = 2) => ({
  role: 'assistant' as const,
  text,
  at,
});

describe('chat store: basics', () => {
  it('creates, lists newest first, reads, renames and removes', () => {
    let t = 1000;
    const dir = path.join(tmp(), 'chats');
    const s = createChatStore(dir, () => t);
    const a = s.create();
    if ('error' in a) throw new Error(a.error);
    t = 2000;
    const b = s.create({ title: 'Second' });
    if ('error' in b) throw new Error(b.error);
    expect(a.title).toBe('New chat');
    expect(s.list().map((c) => c.id)).toEqual([b.id, a.id]);
    t = 3000;
    s.append(a.id, user('What is ready for Friday?\nsecond line', 3000));
    // The first user message names an untitled chat, first line only.
    expect(s.get(a.id)?.title).toBe('What is ready for Friday?');
    expect(s.list()[0]).toMatchObject({
      id: a.id,
      preview: 'What is ready for Friday? second line',
    });
    expect(
      s.update(a.id, { title: 'Friday', model: 'claude-sonnet-5' }),
    ).toMatchObject({
      title: 'Friday',
      model: 'claude-sonnet-5',
      effort: null,
    });
    expect(s.remove(b.id)).toBe(true);
    expect(s.get(b.id)).toBeNull();
    expect(s.list()).toHaveLength(1);
  });

  it('writes 0600 files in a 0700 directory, through a temp file', () => {
    const dir = path.join(tmp(), 'chats');
    const s = createChatStore(dir);
    const c = s.create();
    if ('error' in c) throw new Error(c.error);
    if (!IS_WINDOWS) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, `${c.id}.json`)).mode & 0o777).toBe(
        0o600,
      );
    }
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('chat store: caps', () => {
  it('refuses a 51st chat rather than dropping one', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    for (let i = 0; i < CHATS_MAX; i++) s.create();
    expect(s.create()).toEqual({
      error: 'too many chats — delete one first',
    });
    expect(s.list()).toHaveLength(CHATS_MAX);
  });

  // Every append rewrites the whole chat file (atomic write), so these two fill loops are slow by design;
  // each runs on its own with room to spare on a busy machine (it timed out at the 5 s default).
  it('refuses the 401st message', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    const c = s.create();
    if ('error' in c) throw new Error(c.error);
    for (let i = 0; i < MESSAGES_MAX; i++) s.append(c.id, user('x', i));
    expect(s.append(c.id, user('one more'))).toEqual({
      error: 'this chat is full — start a new chat',
    });
  }, 20000);

  it('refuses a message that would pass the byte budget', () => {
    // Under the message count but over the byte budget.
    const s = createChatStore(path.join(tmp(), 'chats'));
    const d = s.create();
    if ('error' in d) throw new Error(d.error);
    const big = 'y'.repeat(30 * 1024);
    let last: unknown = null;
    for (let i = 0; i < 200 && !(last && 'error' in (last as object)); i++)
      last = s.append(d.id, user(big, i));
    expect(last).toEqual({ error: 'this chat is full — start a new chat' });
    const size = fs.statSync(path.join(s.dir, `${d.id}.json`)).size;
    expect(size).toBeLessThanOrEqual(CHAT_BYTES_MAX);
    expect(s.get(d.id)?.messages.length).toBeGreaterThan(100);
  }, 20000);

  it('caps text, activity and titles', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    const c = s.create({ title: 't'.repeat(200) });
    if ('error' in c) throw new Error(c.error);
    expect(c.title).toHaveLength(80);
    expect(s.append(c.id, user('z'.repeat(33 * 1024)))).toEqual({
      error: 'message too long',
    });
    const r = s.append(c.id, {
      ...reply('ok'),
      activity: Array.from({ length: 50 }, () => 'a'.repeat(500)),
    });
    if ('error' in r) throw new Error(r.error);
    const act = r.messages.at(-1)?.activity ?? [];
    expect(act).toHaveLength(30);
    expect(act[0]).toHaveLength(200);
  });

  it('validates an import like any append', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    expect(
      s.create({
        title: 'Earlier chat',
        messages: [{ role: 'system', text: 'x', at: 1 } as never],
      }),
    ).toEqual({ error: 'invalid message' });
    const ok = s.create({
      title: 'Earlier chat',
      messages: [user('hi'), reply('hello')],
    });
    expect('error' in ok ? ok : ok.messages).toHaveLength(2);
    expect(
      s.create({
        messages: Array.from({ length: MESSAGES_MAX + 1 }, () => user('x')),
      }),
    ).toEqual({ error: 'this chat is full — start a new chat' });
  });
});

describe('chat store: replies are never lost', () => {
  it('keeps a long reply (cut with a note past 256 KB) and saves a reply to a full chat', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    const c = s.create();
    if ('error' in c) throw new Error(c.error);
    const r = s.append(c.id, reply('r'.repeat(300 * 1024)));
    if ('error' in r) throw new Error(r.error);
    const saved = r.messages.at(-1)?.text ?? '';
    expect(saved.length).toBe(256 * 1024);
    expect(saved.endsWith('[Reply cut at 256 KB.]')).toBe(true);
    const full = s.create();
    if ('error' in full) throw new Error(full.error);
    for (let i = 0; i < MESSAGES_MAX; i++) s.append(full.id, user('x', i));
    expect(s.checkAppend(full.id, user('more'))).toBe(
      'this chat is full — start a new chat',
    );
    const late = s.append(full.id, reply('the answer'));
    expect('error' in late ? late : late.messages.at(-1)?.text).toBe(
      'the answer',
    );
  });
});

describe('chat store: file safety', () => {
  it('refuses bad ids and symlinks', () => {
    const root = tmp();
    const dir = path.join(root, 'chats');
    const s = createChatStore(dir);
    s.create();
    expect(s.get('../../etc/passwd')).toBeNull();
    expect(s.remove('ABC')).toBe(false);
    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(dir, '0123456789abcdef.json'));
    expect(s.get('0123456789abcdef')).toBeNull();
    expect(s.remove('0123456789abcdef')).toBe(false);
    expect(fs.existsSync(outside)).toBe(true);
    expect(s.list()).toHaveLength(1);
  });

  it('skips a corrupt or oversized file and never overwrites it', () => {
    const dir = path.join(tmp(), 'chats');
    const s = createChatStore(dir);
    fs.mkdirSync(dir, { recursive: true });
    const bad = path.join(dir, 'aaaaaaaaaaaaaaaa.json');
    fs.writeFileSync(bad, '{not json');
    const huge = path.join(dir, 'bbbbbbbbbbbbbbbb.json');
    fs.writeFileSync(huge, ' '.repeat(CHAT_READ_MAX + 1));
    expect(s.list()).toEqual([]);
    expect(s.get('aaaaaaaaaaaaaaaa')).toBeNull();
    expect(s.append('aaaaaaaaaaaaaaaa', user('x'))).toEqual({
      error: 'not found',
    });
    expect(fs.readFileSync(bad, 'utf-8')).toBe('{not json');
  });
});

describe('chat store: running turns', () => {
  it('marks, clears, and on restart turns a stale mark into a visible note', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    const c = s.create();
    if ('error' in c) throw new Error(c.error);
    s.append(c.id, user('hi'));
    s.setRunning(c.id, 'abcdef0123456789');
    expect(s.get(c.id)?.running_turn_id).toBe('abcdef0123456789');
    // A new process over the same folder.
    const again = createChatStore(s.dir);
    expect(again.interruptStale()).toBe(1);
    const after = again.get(c.id);
    expect(after?.running_turn_id).toBeNull();
    expect(after?.messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: '',
      error: 'Interrupted — the service restarted before Amos replied.',
    });
    expect(again.interruptStale()).toBe(0);
  });

  it('never brings a deleted chat back', () => {
    const s = createChatStore(path.join(tmp(), 'chats'));
    const c = s.create();
    if ('error' in c) throw new Error(c.error);
    s.remove(c.id);
    expect(s.append(c.id, reply('late reply'))).toEqual({
      error: 'not found',
    });
    s.setRunning(c.id, null);
    expect(fs.existsSync(path.join(s.dir, `${c.id}.json`))).toBe(false);
  });
});
