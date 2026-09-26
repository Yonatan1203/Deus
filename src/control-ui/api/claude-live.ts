import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import type { ServerResponse } from 'http';
import { IS_WINDOWS } from '../../platform.js';

// Live views: the dashboard attaches to a Claude background session exactly
// the way the operator's terminal does — `claude attach <id>` — inside a
// private tmux server, and relays that screen to one browser. Two attaches to
// one session stay in lockstep (driven first-hand before this was built), so
// typing here is typing in that session. Killing a view only ends `claude
// attach`; the session itself keeps running.
//
// Everything written to tmux's control-mode stdin is built here from checked
// values: hex byte pairs, a target from this registry, integer sizes. Nothing
// from a request is ever interpolated into a tmux command.

export const SOCKET = 'deus-dash';
export const VIEW_PREFIX = 'v-';
export const MAX_VIEWS_PER_OWNER = 4;
export const MAX_VIEWS_TOTAL = 8;
export const INPUT_MAX_BYTES = 16 * 1024;
export const CHUNK_BYTES = 512;
export const QUEUE_MAX_BYTES = 256 * 1024;
export const INPUT_PER_SECOND = 50;
export const COALESCE_MS = 10;
export const STREAM_BUFFER_MAX = 1024 * 1024;
export const STREAM_GONE_MS = 60_000;
export const COLS = { min: 20, max: 400 };
export const ROWS = { min: 5, max: 200 };
export const VID_RE = /^[0-9a-f]{32}$/;

export type ControlEvent =
  { kind: 'output'; data: Buffer } | { kind: 'exit' } | { kind: 'other' };

const isOct = (b: number | undefined): boolean =>
  b !== undefined && b >= 48 && b <= 55;

/**
 * One control-mode line. tmux escapes bytes below 0x20 and the backslash as
 * three-digit octal in `%output`; everything else, multi-byte UTF-8 included,
 * arrives as-is. Checked against captured tmux 3.4 output (the fixture).
 */
export function parseControlLine(line: Buffer): ControlEvent {
  if (line.length === 0 || line[0] !== 0x25 /* % */) return { kind: 'other' };
  const head = line.subarray(0, Math.min(line.length, 16)).toString('latin1');
  if (head === '%exit' || head.startsWith('%exit ')) return { kind: 'exit' };
  if (!head.startsWith('%output ')) return { kind: 'other' };
  // "%output %<pane> <data>"
  const paneEnd = line.indexOf(0x20, 8);
  if (paneEnd < 0) return { kind: 'output', data: Buffer.alloc(0) };
  const raw = line.subarray(paneEnd + 1);
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (
      b === 0x5c &&
      isOct(raw[i + 1]) &&
      isOct(raw[i + 2]) &&
      isOct(raw[i + 3])
    ) {
      out.push(
        ((raw[i + 1] - 48) << 6) | ((raw[i + 2] - 48) << 3) | (raw[i + 3] - 48),
      );
      i += 3;
    } else out.push(b);
  }
  return { kind: 'output', data: Buffer.from(out) };
}

/** Splits a byte stream into complete lines; keeps the tail for next time. */
export function createLineSplitter(onLine: (line: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = pending.indexOf(0x0a, start);
      if (nl < 0) break;
      onLine(pending.subarray(start, nl));
      start = nl + 1;
    }
    pending = Buffer.from(pending.subarray(start));
  };
}

/** The tmux formats `repaint` reads, in the order `modeSequences` expects. */
export const MODE_FORMAT =
  '#{alternate_on} #{mouse_standard_flag} #{mouse_button_flag} ' +
  '#{mouse_all_flag} #{mouse_sgr_flag} #{mouse_utf8_flag} ' +
  '#{keypad_cursor_flag} #{cursor_flag} #{cursor_x} #{cursor_y}';

/**
 * The terminal modes a pane is in, as the escape sequences that put a fresh
 * terminal into the same state. A browser that connects after the program
 * started never saw those sequences, so without this it does not know the
 * session is on the alternate screen with mouse reporting on — and the mouse
 * wheel scrolls the browser's own empty history instead of reaching Claude.
 * Only a fixed table is emitted, chosen by 0/1 flags; no pane text is used.
 */
export function modeSequences(flags: string): {
  before: string;
  after: string;
} {
  const f = flags.trim().split(/\s+/);
  if (f.length < 10 || !f.slice(0, 8).every((x) => x === '0' || x === '1'))
    return { before: '', after: '' };
  const on = (i: number) => f[i] === '1';
  const set = (code: number, v: boolean) => `\x1b[?${code}${v ? 'h' : 'l'}`;
  const before =
    set(1049, on(0)) +
    // Clear every mouse mode first, then set the ones the pane has.
    '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l' +
    (on(1) ? set(1000, true) : '') +
    (on(2) ? set(1002, true) : '') +
    (on(3) ? set(1003, true) : '') +
    (on(4) ? set(1006, true) : '') +
    (on(5) ? set(1005, true) : '') +
    set(1, on(6));
  const x = Number(f[8]);
  const y = Number(f[9]);
  const move =
    Number.isInteger(x) && Number.isInteger(y) ? `\x1b[${y + 1};${x + 1}H` : '';
  return { before, after: move + set(25, on(7)) };
}

/** `send-keys -H` lines for these bytes, at most CHUNK_BYTES per command. */
export function sendKeysCommands(target: string, bytes: Buffer): string[] {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
    const chunk = bytes.subarray(off, off + CHUNK_BYTES);
    const hex: string[] = [];
    for (const b of chunk) hex.push(b.toString(16).padStart(2, '0'));
    lines.push(`send-keys -t ${target} -H ${hex.join(' ')}\n`);
  }
  return lines;
}

export function validSize(cols: unknown, rows: unknown): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    (cols as number) >= COLS.min &&
    (cols as number) <= COLS.max &&
    (rows as number) >= ROWS.min &&
    (rows as number) <= ROWS.max
  );
}

/** tmux on this host, or null (Windows, or not installed). */
export function resolveTmuxBin(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (IS_WINDOWS) return null;
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, 'tmux');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

export type ExecFileFn = (
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string },
  cb: (err: Error | null, stdout: string) => void,
) => unknown;

export interface LiveDeps {
  tmuxBin: string;
  /** Private tmux socket name; tests pass their own so they never touch the live one. */
  socket?: string;
  claudeBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  execFile?: ExecFileFn;
  spawn?: (file: string, args: string[], opts: object) => ChildProcess;
  audit?: (event: string, fields: Record<string, unknown>) => void;
}

interface View {
  vid: string;
  owner: string;
  target: string;
  claudeId: string;
  child: ChildProcess;
  stream: ServerResponse | null;
  streamGoneAt: number;
  pending: Buffer[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  needRepaint: boolean;
  queue: string[];
  queueBytes: number;
  writing: boolean;
  inputTimes: number[];
  bytesIn: number;
  closed: boolean;
}

export type LiveResult =
  { ok: true } | { ok: false; status: number; error: string };
export type OpenResult =
  { ok: true; vid: string } | { ok: false; status: number; error: string };

export function createLiveViews(deps: LiveDeps) {
  const now = deps.now ?? Date.now;
  const exec: ExecFileFn = deps.execFile ?? (execFile as unknown as ExecFileFn);
  const spawnFn = deps.spawn ?? spawn;
  const audit = deps.audit ?? (() => undefined);
  const views = new Map<string, View>();
  const TMUX_BASE = ['-f', os.devNull, '-L', deps.socket ?? SOCKET];

  const tmux = (args: string[]): Promise<{ ok: boolean; out: string }> =>
    new Promise((resolve) => {
      exec(
        deps.tmuxBin,
        [...TMUX_BASE, ...args],
        { env: deps.env, timeout: 10_000, cwd: deps.cwd },
        (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') }),
      );
    });

  const send = (v: View, event: 'o' | 'x', data: string) => {
    if (!v.stream || v.stream.writableEnded) return;
    v.stream.write(`event: ${event}\ndata: ${data}\n\n`);
  };

  const flush = (v: View) => {
    v.flushTimer = null;
    if (!v.stream || !v.pending.length) return;
    const buf = Buffer.concat(v.pending);
    v.pending = [];
    v.pendingBytes = 0;
    send(v, 'o', buf.toString('base64'));
  };

  /**
   * Paints the current screen: the catch-up path, never a replay ring. It
   * re-sends the pane's modes (alternate screen, mouse) every time, so it runs
   * only when a stream (re)attaches or a slow browser catches up — never per
   * frame, where re-entering the alternate screen would flicker.
   */
  const repaint = async (v: View) => {
    v.needRepaint = false;
    v.pending = [];
    v.pendingBytes = 0;
    const [screen, modes] = await Promise.all([
      tmux(['capture-pane', '-p', '-e', '-t', v.target]),
      tmux(['display-message', '-p', '-t', v.target, MODE_FORMAT]),
    ]);
    if (v.closed || !screen.ok) return;
    const lines = screen.out.replace(/\n$/, '').split('\n');
    const { before, after } = modeSequences(modes.ok ? modes.out : '');
    const paint = `${before}\x1b[0m\x1b[2J\x1b[H${lines.join('\r\n')}${after}`;
    send(v, 'o', Buffer.from(paint, 'utf8').toString('base64'));
  };

  const onOutput = (v: View, data: Buffer) => {
    if (!v.stream || v.needRepaint) return;
    if (v.stream.writableLength + v.pendingBytes > STREAM_BUFFER_MAX) {
      // A slow browser: drop what is queued and repaint once it drains.
      v.needRepaint = true;
      v.pending = [];
      v.pendingBytes = 0;
      v.stream.once('drain', () => void repaint(v));
      return;
    }
    v.pending.push(data);
    v.pendingBytes += data.length;
    if (!v.flushTimer) v.flushTimer = setTimeout(() => flush(v), COALESCE_MS);
  };

  const pump = (v: View) => {
    if (v.writing || v.closed) return;
    const line = v.queue.shift();
    if (line === undefined) return;
    v.queueBytes -= line.length;
    v.writing = true;
    const ok = v.child.stdin?.write(line);
    const next = () => {
      v.writing = false;
      pump(v);
    };
    if (ok === false) v.child.stdin?.once('drain', next);
    else setImmediate(next);
  };

  const enqueue = (v: View, line: string) => {
    v.queue.push(line);
    v.queueBytes += line.length;
    pump(v);
  };

  function close(vid: string, reason: string): void {
    const v = views.get(vid);
    if (!v || v.closed) return;
    v.closed = true;
    views.delete(vid);
    if (v.flushTimer) clearTimeout(v.flushTimer);
    if (v.stream && !v.stream.writableEnded) {
      send(v, 'x', reason);
      v.stream.end();
    }
    try {
      v.child.kill();
    } catch {
      /* already gone */
    }
    void tmux(['kill-session', '-t', v.target]);
    audit('control_ui_claude_live_closed', {
      vid: vid.slice(0, 8),
      id: v.claudeId,
      reason,
      bytes_in: v.bytesIn,
    });
  }

  const owned = (vid: string, owner: string): View | null => {
    if (!VID_RE.test(vid)) return null;
    const v = views.get(vid);
    return v && v.owner === owner && !v.closed ? v : null;
  };

  return {
    async open(
      owner: string,
      claudeId: string,
      cols: unknown,
      rows: unknown,
    ): Promise<OpenResult> {
      if (!validSize(cols, rows))
        return { ok: false, status: 400, error: 'invalid size' };
      let mine = 0;
      for (const v of views.values()) if (v.owner === owner) mine++;
      if (mine >= MAX_VIEWS_PER_OWNER || views.size >= MAX_VIEWS_TOTAL)
        return { ok: false, status: 429, error: 'too many live views' };
      const vid = crypto.randomBytes(16).toString('hex');
      const target = `${VIEW_PREFIX}${crypto.randomBytes(8).toString('hex')}`;
      // Separate argv items: with more than one, tmux execs them directly
      // instead of joining them into a `sh -c` string.
      const made = await tmux([
        'new-session',
        '-d',
        '-s',
        target,
        '-x',
        String(cols),
        '-y',
        String(rows),
        '-c',
        deps.cwd,
        deps.claudeBin,
        'attach',
        claudeId,
      ]);
      if (!made.ok)
        return { ok: false, status: 503, error: 'could not start live view' };
      let child: ChildProcess;
      try {
        child = spawnFn(
          deps.tmuxBin,
          [...TMUX_BASE, '-C', 'attach', '-t', target],
          { env: deps.env, cwd: deps.cwd, stdio: ['pipe', 'pipe', 'ignore'] },
        );
      } catch {
        // The session exists but has no client and is not registered yet, so
        // nothing else would ever reach it: remove it here.
        void tmux(['kill-session', '-t', target]);
        return { ok: false, status: 503, error: 'could not start live view' };
      }
      const v: View = {
        vid,
        owner,
        target,
        claudeId,
        child,
        stream: null,
        streamGoneAt: now(),
        pending: [],
        pendingBytes: 0,
        flushTimer: null,
        needRepaint: false,
        queue: [],
        queueBytes: 0,
        writing: false,
        inputTimes: [],
        bytesIn: 0,
        closed: false,
      };
      views.set(vid, v);
      child.stdout?.on(
        'data',
        createLineSplitter((line) => {
          const ev = parseControlLine(line);
          if (ev.kind === 'output') onOutput(v, ev.data);
          else if (ev.kind === 'exit') close(vid, 'exited');
        }),
      );
      child.on('exit', () => close(vid, 'exited'));
      child.on('error', () => close(vid, 'error'));
      child.stdin?.on('error', () => close(vid, 'error'));
      // Only now that a control client is attached: a crash of this process
      // then removes the tmux session at once instead of orphaning it.
      enqueue(v, `set-option -t ${target} destroy-unattached on\n`);
      enqueue(v, `refresh-client -C ${cols as number}x${rows as number}\n`);
      audit('control_ui_claude_live_opened', {
        vid: vid.slice(0, 8),
        id: claudeId,
      });
      return { ok: true, vid };
    },

    /** Binds the browser's stream; ends any previous one for this view. */
    attachStream(vid: string, owner: string, res: ServerResponse): boolean {
      const v = owned(vid, owner);
      if (!v) return false;
      if (v.stream && !v.stream.writableEnded) v.stream.end();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': live\n\n');
      v.stream = res;
      res.on('close', () => {
        if (v.stream === res) {
          v.stream = null;
          v.streamGoneAt = now();
        }
      });
      void repaint(v);
      return true;
    },

    input(vid: string, owner: string, bytes: Buffer): LiveResult {
      const v = owned(vid, owner);
      if (!v) return { ok: false, status: 404, error: 'not found' };
      if (bytes.length === 0 || bytes.length > INPUT_MAX_BYTES)
        return { ok: false, status: 400, error: 'invalid input' };
      const t = now();
      v.inputTimes = v.inputTimes.filter((x) => t - x < 1000);
      if (v.inputTimes.length >= INPUT_PER_SECOND)
        return { ok: false, status: 429, error: 'typing too fast' };
      const lines = sendKeysCommands(v.target, bytes);
      const size = lines.reduce((n, l) => n + l.length, 0);
      if (v.queueBytes + size > QUEUE_MAX_BYTES)
        return { ok: false, status: 429, error: 'input queue full' };
      v.inputTimes.push(t);
      for (const l of lines) enqueue(v, l);
      v.bytesIn += bytes.length;
      return { ok: true };
    },

    resize(
      vid: string,
      owner: string,
      cols: unknown,
      rows: unknown,
    ): LiveResult {
      const v = owned(vid, owner);
      if (!v) return { ok: false, status: 404, error: 'not found' };
      if (!validSize(cols, rows))
        return { ok: false, status: 400, error: 'invalid size' };
      enqueue(v, `refresh-client -C ${cols as number}x${rows as number}\n`);
      return { ok: true };
    },

    closeOwned(vid: string, owner: string): boolean {
      if (!owned(vid, owner)) return false;
      close(vid, 'closed');
      return true;
    },

    closeOwner(owner: string, reason: string): void {
      for (const v of [...views.values()])
        if (v.owner === owner) close(v.vid, reason);
    },

    closeAll(reason: string): void {
      for (const vid of [...views.keys()]) close(vid, reason);
    },

    /** Ends views whose login is gone or whose browser left > 60 s ago. */
    sweep(isLive: (owner: string) => boolean): void {
      const t = now();
      for (const v of [...views.values()]) {
        if (!isLive(v.owner)) close(v.vid, 'login-ended');
        else if (!v.stream && t - v.streamGoneAt > STREAM_GONE_MS)
          close(v.vid, 'abandoned');
      }
    },

    /** Removes tmux sessions a previous process left on the private socket. */
    async killLeftovers(): Promise<void> {
      await tmux(['kill-server']);
    },

    size: () => views.size,
    has: (vid: string) => views.has(vid),
    /** Who opened a view and which session it shows; null once it closed. */
    meta(vid: string): { owner: string; claudeId: string } | null {
      const v = views.get(vid);
      return v && !v.closed ? { owner: v.owner, claudeId: v.claudeId } : null;
    },
  };
}

export type LiveViews = ReturnType<typeof createLiveViews>;
