import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHUNK_BYTES,
  createLineSplitter,
  createLiveViews,
  INPUT_MAX_BYTES,
  INPUT_PER_SECOND,
  modeSequences,
  parseControlLine,
  resolveTmuxBin,
  sendKeysCommands,
  SOCKET,
  validSize,
  type LiveViews,
  isTerminalReply,
} from './claude-live.js';

const FIXTURE = path.join(
  import.meta.dirname,
  '__fixtures__',
  'tmux34-control.txt',
);

describe('control-mode parsing', () => {
  it('decodes captured tmux 3.4 output: octal escapes and raw bytes both', () => {
    const lines: Buffer[] = [];
    createLineSplitter((l) => lines.push(l))(fs.readFileSync(FIXTURE));
    const out = Buffer.concat(
      lines
        .map(parseControlLine)
        .flatMap((e) => (e.kind === 'output' ? [e.data] : [])),
    ).toString('utf8');
    expect(out).toContain('\r\n');
    expect(out).toContain('\x1b[32mgreen\x1b[0m');
    expect(out).toContain('é ✓'); // multi-byte UTF-8 passes through intact
    expect(out).toContain('echo hi^[[31m'); // the shell's own visible echo of a typed ESC
    expect(lines.some((l) => parseControlLine(l).kind === 'exit')).toBe(true);
  });

  it('ignores notifications it does not know rather than failing', () => {
    for (const s of ['%begin 1 2 0', '%layout-change @0 x', 'plain', ''])
      expect(parseControlLine(Buffer.from(s)).kind).toBe('other');
  });

  it('keeps a partial line until its newline arrives', () => {
    const got: string[] = [];
    const push = createLineSplitter((l) => got.push(l.toString()));
    push(Buffer.from('%output %0 he'));
    expect(got).toEqual([]);
    push(Buffer.from('llo\n%exit\n'));
    expect(got).toEqual(['%output %0 hello', '%exit']);
  });
});

describe('isTerminalReply', () => {
  it("knows the terminal's own answers from typing", () => {
    for (const s of [
      '\x1b[?1;2c',
      '\x1b[>0;276;0c',
      '\x1b[24;80R',
      '\x1b[I',
      '\x1b[O',
      '\x1b[0n',
      '\x1b]11;rgb:1c1c/1c1c/1c1cA\x07',
      '\x1b]10;rgb:ffff/ffff/ffff\x1b\\',
      '\x1b[?1;2c\x1b[24;80R',
    ])
      expect(isTerminalReply(Buffer.from(s, 'latin1')), JSON.stringify(s)).toBe(
        true,
      );
    for (const s of [
      'a',
      '\r',
      '\x1b',
      '\x1b[A',
      '\x1b[<64;10;5M',
      '\x1b[200~hi\x1b[201~',
      '\x1b[?1;2cq',
    ])
      expect(isTerminalReply(Buffer.from(s, 'latin1')), JSON.stringify(s)).toBe(
        false,
      );
  });
});

describe('what reaches the tmux command line', () => {
  it('sends bytes as hex only, chunked', () => {
    const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 3, 0x61);
    const lines = sendKeysCommands('v-0011223344556677', bytes);
    expect(lines).toHaveLength(3);
    for (const l of lines)
      expect(l).toMatch(/^send-keys -t v-[0-9a-f]{16} -H( [0-9a-f]{2})+\n$/);
  });

  it('turns a newline or tmux syntax in the input into inert hex', () => {
    const [line] = sendKeysCommands(
      'v-0011223344556677',
      Buffer.from('\n; kill-server'),
    );
    expect(line).not.toContain('kill-server');
    expect(line.split('\n')).toHaveLength(2); // exactly one command
  });

  it('accepts only integer sizes in range', () => {
    expect(validSize(80, 24)).toBe(true);
    for (const [c, r] of [
      ['80\nkill-server', 24],
      [80.5, 24],
      [19, 24],
      [401, 24],
      [80, 4],
      [80, 201],
      [null, 24],
    ])
      expect(validSize(c, r)).toBe(false);
  });
});

describe('terminal mode replay', () => {
  it('turns pane flags into the sequences a fresh terminal needs', () => {
    // alt screen, button-event mouse + SGR, app cursor keys, cursor visible at 4,2
    const m = modeSequences('1 0 1 0 1 0 1 1 4 2');
    expect(m.before).toContain('\x1b[?1049h');
    expect(m.before).toContain('\x1b[?1002h');
    expect(m.before).toContain('\x1b[?1006h');
    expect(m.before).toContain('\x1b[?1h');
    expect(m.before).not.toContain('\x1b[?1000h');
    expect(m.after).toBe('\x1b[3;5H\x1b[?25h');
    // A plain pane leaves the alternate screen and clears mouse modes.
    const plain = modeSequences('0 0 0 0 0 0 0 1 0 0');
    expect(plain.before).toContain('\x1b[?1049l');
    for (const code of [1000, 1002, 1003, 1005, 1006])
      expect(plain.before).not.toContain(`\x1b[?${code}h`);
  });

  it('emits nothing for output it does not recognise', () => {
    for (const bad of ['', 'garbage', '1 1 1', '2 0 0 0 0 0 0 1 0 0'])
      expect(modeSequences(bad)).toEqual({ before: '', after: '' });
  });
});

// ---- real tmux, with a stand-in for `claude attach` ------------------------
const tmuxBin = resolveTmuxBin();
const describeTmux = tmuxBin ? describe : describe.skip;

class FakeStream extends EventEmitter {
  writableEnded = false;
  writableLength = 0;
  chunks: string[] = [];
  head = 0;
  writeHead(code: number) {
    this.head = code;
  }
  write(s: string) {
    this.chunks.push(s);
    return true;
  }
  end() {
    this.writableEnded = true;
    this.emit('close');
  }
  screen(): string {
    return this.chunks
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => Buffer.from(l.slice(6), 'base64').toString('utf8'))
      .join('');
  }
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
// A socket of its own per run: these tests must never touch the live dashboard's.
const TEST_SOCKET = `${SOCKET}-test-${crypto.randomBytes(4).toString('hex')}`;
const sessions = (): string =>
  (() => {
    try {
      return execFileSync(tmuxBin as string, ['-L', TEST_SOCKET, 'ls'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  })();

describeTmux('live views against real tmux', () => {
  let dir = '';
  let views: LiveViews | null = null;
  afterEach(async () => {
    views?.closeAll('test');
    await views?.killLeftovers();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A stand-in for the claude binary: `<bin> attach <id>` runs this script.
  const fake = (body: string): string => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
    const bin = path.join(dir, 'fake-claude');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return bin;
  };
  const make = (claudeBin: string) =>
    createLiveViews({
      tmuxBin: tmuxBin as string,
      socket: TEST_SOCKET,
      claudeBin,
      cwd: os.tmpdir(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: os.tmpdir(),
        TERM: 'xterm-256color',
      },
    });

  it('types into the session and streams its screen back', async () => {
    views = make(fake('echo "attached to $2"; exec cat'));
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    expect(r.ok).toBe(true);
    const vid = (r as { vid: string }).vid;
    const s = new FakeStream();
    expect(views.attachStream(vid, 'owner-a', s as never)).toBe(true);
    await until(() => s.screen().includes('attached to abcd1234'));
    expect(views.input(vid, 'owner-a', Buffer.from('hello live\r')).ok).toBe(
      true,
    );
    await until(() => s.screen().includes('hello live'));
  }, 20000);

  it('tells a late-joining browser the pane is on the alternate screen with the mouse on', async () => {
    // Like `claude attach`: switch modes at startup, before anyone connects.
    views = make(
      fake(
        "printf '\\033[?1049h\\033[?1002h\\033[?1006hALT-SCREEN-UP'; exec cat",
      ),
    );
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    const vid = (r as { vid: string }).vid;
    await new Promise((res) => setTimeout(res, 800)); // modes set before the stream exists
    const s = new FakeStream();
    views.attachStream(vid, 'owner-a', s as never);
    await until(() => s.screen().includes('ALT-SCREEN-UP'));
    expect(s.screen()).toContain('\x1b[?1049h');
    expect(s.screen()).toContain('\x1b[?1002h');
    expect(s.screen()).toContain('\x1b[?1006h');
  }, 20000);

  it('answers 429 past 50 inputs a second, and accepts again once the second rolls over', async () => {
    let t = 1_000;
    views = createLiveViews({
      tmuxBin: tmuxBin as string,
      socket: TEST_SOCKET,
      claudeBin: fake('exec cat'),
      cwd: os.tmpdir(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: os.tmpdir(),
        TERM: 'xterm-256color',
      },
      now: () => t,
    });
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    const vid = (r as { vid: string }).vid;
    for (let i = 0; i < INPUT_PER_SECOND; i++)
      expect(
        views.input(vid, 'owner-a', Buffer.from('x')).ok,
        `input ${i}`,
      ).toBe(true);
    expect(views.input(vid, 'owner-a', Buffer.from('x'))).toEqual({
      ok: false,
      status: 429,
      error: 'typing too fast',
    });
    t += 1_001;
    expect(views.input(vid, 'owner-a', Buffer.from('x')).ok).toBe(true);
  }, 20000);

  it('refuses input that would overflow the queue, whole, never partly', async () => {
    views = make(fake('exec cat'));
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    const vid = (r as { vid: string }).vid;
    // Synchronously, so the queue cannot drain between calls.
    const results = Array.from({ length: 8 }, () =>
      views!.input(vid, 'owner-a', Buffer.alloc(INPUT_MAX_BYTES, 0x61)),
    );
    const refused = results.filter((x) => !x.ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused[0]).toEqual({
      ok: false,
      status: 429,
      error: 'input queue full',
    });
    // Every accepted call is whole: once one is refused, none after it slipped in.
    const first = results.findIndex((x) => !x.ok);
    expect(results.slice(first).every((x) => !x.ok)).toBe(true);
  }, 20000);

  it('delivers a 16 KB paste intact', async () => {
    const out = path.join(
      os.tmpdir(),
      `paste-${crypto.randomBytes(4).toString('hex')}`,
    );
    views = make(fake(`stty raw -echo; exec head -c 16384 > ${out}`));
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    const vid = (r as { vid: string }).vid;
    views.attachStream(vid, 'owner-a', new FakeStream() as never);
    await new Promise((res) => setTimeout(res, 500));
    const payload = crypto.randomBytes(8192).toString('hex'); // 16384 ASCII bytes
    expect(views.input(vid, 'owner-a', Buffer.from(payload)).ok).toBe(true);
    await until(() => fs.existsSync(out) && fs.statSync(out).size === 16384);
    expect(fs.readFileSync(out, 'utf8')).toBe(payload);
    fs.rmSync(out, { force: true });
  }, 30000);

  it('refuses another login, and closing leaves no tmux session behind', async () => {
    views = make(fake('exec cat'));
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    const vid = (r as { vid: string }).vid;
    expect(views.attachStream(vid, 'owner-b', new FakeStream() as never)).toBe(
      false,
    );
    expect(views.input(vid, 'owner-b', Buffer.from('x')).ok).toBe(false);
    expect(views.closeOwned(vid, 'owner-b')).toBe(false);
    await until(() => sessions().includes('v-'));
    views.sweep((owner) => owner !== 'owner-a'); // owner-a's login ended
    expect(views.size()).toBe(0);
    await until(() => !sessions().includes('v-'));
  }, 20000);

  it('tells a view when another view of the same session typed recently', async () => {
    let t = 1_000;
    views = createLiveViews({
      tmuxBin: tmuxBin as string,
      socket: TEST_SOCKET,
      claudeBin: fake('exec cat'),
      cwd: os.tmpdir(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: os.tmpdir(),
        TERM: 'xterm-256color',
      },
      now: () => t,
    });
    const open = async (owner: string, id: string) =>
      ((await views!.open(owner, id, 80, 20)) as { vid: string }).vid;
    const a = await open('owner-a', 'abcd1234');
    const b = await open('owner-b', 'abcd1234');
    const c = await open('owner-c', 'ffff0000');
    expect(views.othersActive(a, 10_000)).toBe(false);
    expect(views.input(a, 'owner-a', Buffer.from('x')).ok).toBe(true);
    expect(views.othersActive(b, 10_000)).toBe(true); // a typed
    expect(views.othersActive(a, 10_000)).toBe(false); // its own typing is not "others"
    expect(views.othersActive(c, 10_000)).toBe(false); // another session
    t += 10_001;
    expect(views.othersActive(b, 10_000)).toBe(false);
    views.closeOwned(a, 'owner-a');
    expect(views.othersActive('v-unknown', 10_000)).toBe(false);
  }, 20000);

  it("names a view's owner and session until it closes, by any path", async () => {
    views = make(fake('exec cat'));
    const open = async (owner: string) =>
      ((await views!.open(owner, 'abcd1234', 80, 20)) as { vid: string }).vid;
    const a = await open('owner-a');
    expect(views.meta(a)).toEqual({ owner: 'owner-a', claudeId: 'abcd1234' });
    expect(views.meta('v-unknown')).toBeNull();
    views.closeOwned(a, 'owner-a');
    expect(views.meta(a)).toBeNull();
    const b = await open('owner-b');
    views.closeOwner('owner-b', 'logout');
    expect(views.meta(b)).toBeNull();
    const c = await open('owner-c');
    views.closeAll('rotated');
    expect(views.meta(c)).toBeNull();
  }, 20000);

  it('removes the tmux session when its control client dies (destroy-unattached)', async () => {
    views = make(fake('exec cat'));
    const r = await views.open('owner-a', 'abcd1234', 80, 20);
    expect(r.ok).toBe(true);
    await until(() => sessions().includes('v-'));
    await new Promise((res) => setTimeout(res, 300)); // let set-option land
    // Simulate this process crashing: kill the control client from outside.
    execFileSync('pkill', ['-f', '--', `-L ${TEST_SOCKET} -C attach`]);
    await until(() => !sessions().includes('v-'));
  }, 20000);
});
