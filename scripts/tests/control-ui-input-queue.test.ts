import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// A browser module with no DOM dependency, so it runs under vitest directly.
// @ts-expect-error — plain JS module without type declarations
import { createInputQueue } from '../../web/control/input-queue.js';

type Call = {
  bytes: string;
  resolve: () => void;
  reject: (e: unknown) => void;
};

function harness(over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const warns: string[] = [];
  let ended = 0;
  const q = createInputQueue({
    post: (chunk: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ bytes: Buffer.from(chunk).toString(), resolve, reject });
      }),
    onEnded: () => {
      ended++;
    },
    onWarn: (m: string) => warns.push(m),
    now: () => Date.now(),
    ...over,
  });
  const push = (s: string) => q.push(new Uint8Array(Buffer.from(s)));
  return { q, calls, warns, push, ended: () => ended };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => vi.useFakeTimers({ now: 10_000 }));
afterEach(() => vi.useRealTimers());

describe('Claude tab input queue', () => {
  it('sends a single key at once, and batches what is typed while one is in flight', async () => {
    const h = harness();
    h.push('a');
    expect(h.calls.map((c) => c.bytes)).toEqual(['a']); // no delay
    h.push('b');
    h.push('c');
    expect(h.calls).toHaveLength(1); // one in flight
    h.calls[0].resolve();
    await settle();
    vi.advanceTimersByTime(20);
    await settle();
    expect(h.calls.map((c) => c.bytes)).toEqual(['a', 'bc']);
  });

  it('never starts two requests less than 20 ms apart', async () => {
    const h = harness();
    h.push('a');
    h.calls[0].resolve();
    await settle();
    h.push('b');
    expect(h.calls).toHaveLength(1);
    vi.advanceTimersByTime(19);
    await settle();
    expect(h.calls).toHaveLength(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(h.calls.map((c) => c.bytes)).toEqual(['a', 'b']);
  });

  it('keeps order when a retry races new typing', async () => {
    const h = harness();
    h.push('ab');
    h.push('cd'); // typed while 'ab' is in flight
    h.calls[0].reject({ status: 503 });
    await settle();
    vi.advanceTimersByTime(250);
    await settle();
    expect(h.calls.map((c) => c.bytes)).toEqual(['ab', 'abcd']);
  });

  // The resize bug was a caller clearing the queue's timer and leaving it wedged.
  // The timer is now private to the queue, so no caller can reach it; this checks
  // that typing keeps flowing across the 20 ms pause and its completion.
  it('keeps typing across a pacing pause and its completion', async () => {
    const cleared: unknown[] = [];
    const h = harness({
      clearTimer: (id: unknown) => {
        cleared.push(id);
        clearTimeout(id as never);
      },
    });
    h.push('a');
    h.calls[0].resolve();
    await settle();
    h.push('b'); // now waiting in the 20 ms gap
    // Nothing outside the queue can reach its timer any more; typing must go on.
    vi.advanceTimersByTime(20);
    await settle();
    h.calls[1].resolve();
    await settle();
    vi.advanceTimersByTime(20);
    h.push('c');
    await settle();
    expect(h.calls.map((c) => c.bytes)).toEqual(['a', 'b', 'c']);
  });

  it('gives up after three failed retries, says so, and keeps working afterwards', async () => {
    const h = harness();
    h.push('x');
    for (const wait of [250, 500, 1000]) {
      h.calls.at(-1)!.reject({ status: 0 });
      await settle();
      vi.advanceTimersByTime(wait);
      await settle();
    }
    h.calls.at(-1)!.reject({ status: 0 });
    await settle();
    expect(h.warns).toEqual([
      'Some keystrokes were not delivered — the connection dropped',
    ]);
    expect(h.calls).toHaveLength(4);
    vi.advanceTimersByTime(20);
    h.push('y');
    await settle();
    expect(h.calls.at(-1)!.bytes).toBe('y');
  });

  it('keeps retrying while the server is busy, and says so once it lasts', async () => {
    const h = harness({ busyWarnAfter: 3 });
    h.push('z');
    for (let i = 0; i < 4; i++) {
      h.calls.at(-1)!.reject({ status: 429 });
      await settle();
      vi.advanceTimersByTime(250);
      await settle();
    }
    expect(h.calls.every((c) => c.bytes === 'z')).toBe(true); // nothing dropped
    expect(h.warns).toEqual([
      'The session is not taking input right now — still trying',
    ]);
  });

  it('stops for good when the view is gone, and after dispose', async () => {
    const h = harness();
    h.push('a');
    h.calls[0].reject({ status: 404 });
    await settle();
    expect(h.ended()).toBe(1);
    h.push('b');
    await settle();
    expect(h.calls).toHaveLength(1);
    const g = harness();
    g.push('a');
    g.calls[0].resolve();
    await settle();
    g.push('b');
    g.q.dispose();
    vi.advanceTimersByTime(100);
    await settle();
    expect(g.calls).toHaveLength(1);
  });

  it('refuses to queue past the cap and says so', () => {
    const h = harness({ maxPending: 4 });
    h.push('ab'); // in flight, not pending
    h.push('cdef');
    h.push('g');
    expect(h.warns).toEqual([
      'Too much unsent typing is waiting — the newest keys were not queued',
    ]);
    expect(h.q.pendingBytes).toBe(4);
  });
});
