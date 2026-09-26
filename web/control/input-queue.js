// The Claude tab's keystroke sender, kept free of the DOM so it can be tested.
// Keystrokes go out as soon as nothing is in flight; anything typed while a
// request is on the wire rides the next one. One request in flight at a time
// and at most one start per `minGapMs` (the server allows 50/s), so a single
// key is never held back and a burst or a paste batches itself. A failed send
// is put back in front, so order is kept; nothing is dropped without `onWarn`
// saying so.
export function createInputQueue({
  post,
  onEnded,
  onWarn,
  now = () => performance.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  maxChunk = 12 * 1024,
  minGapMs = 20,
  backoffMs = [250, 500, 1000],
  busyRetryMs = 250,
  busyWarnAfter = 20,
  maxPending = 256 * 1024,
}) {
  let pending = new Uint8Array(0);
  let inFlight = false;
  let lastStart = -Infinity;
  // A boolean, not the timer id: a cleared id is still truthy, and treating it
  // as "already scheduled" would stop input for good.
  let scheduled = false;
  let timerId = null;
  let attempts = 0;
  let busy = 0;
  let disposed = false;

  const schedule = (ms) => {
    if (scheduled || disposed) return;
    scheduled = true;
    timerId = setTimer(() => { scheduled = false; timerId = null; pump(); }, ms);
  };
  const prepend = (chunk) => {
    const next = new Uint8Array(chunk.length + pending.length);
    next.set(chunk); next.set(pending, chunk.length);
    pending = next;
  };
  function pump() {
    if (disposed || inFlight || scheduled || !pending.length) return;
    const wait = lastStart + minGapMs - now();
    if (wait > 0) { schedule(wait); return; }
    const chunk = pending.slice(0, maxChunk);
    pending = pending.slice(chunk.length);
    inFlight = true;
    lastStart = now();
    let retryIn = 0;
    // Called synchronously, so the first key leaves in this same tick.
    let sent;
    try { sent = Promise.resolve(post(chunk)); } catch (err) { sent = Promise.reject(err); }
    sent
      .then(() => { attempts = 0; busy = 0; })
      .catch((err) => {
        const status = err && err.status;
        if (status === 404 || status === 403) { disposed = true; onEnded(); return; }
        if (status === 429) {
          // Busy, not broken: keep the bytes and keep trying, but say so once
          // it has lasted a while instead of looking like success.
          busy += 1;
          if (busy === busyWarnAfter) onWarn('The session is not taking input right now — still trying');
          prepend(chunk);
          retryIn = busyRetryMs;
          return;
        }
        if (attempts >= backoffMs.length) {
          attempts = 0;
          onWarn('Some keystrokes were not delivered — the connection dropped');
          return;
        }
        prepend(chunk);
        retryIn = backoffMs[attempts++];
      })
      .finally(() => {
        inFlight = false;
        if (retryIn) schedule(retryIn); else pump();
      });
  }
  return {
    push(u8) {
      if (disposed || !u8.length) return;
      if (pending.length + u8.length > maxPending) {
        onWarn('Too much unsent typing is waiting — the newest keys were not queued');
        return;
      }
      const next = new Uint8Array(pending.length + u8.length);
      next.set(pending); next.set(u8, pending.length);
      pending = next;
      pump();
    },
    dispose() {
      disposed = true;
      if (timerId !== null) clearTimer(timerId);
      scheduled = false;
      timerId = null;
    },
    get pendingBytes() { return pending.length; },
  };
}
