// When a session is blocked (Claude Code's own state) but neither the
// question parser nor the menu parser recognises the screen, the conversation
// view says so rather than staying silent. Counted on the poll's interval
// ticks only, so a read between ticks (after a key, on becoming visible)
// neither counts nor resets. DOM-free so it can be tested.
export function createMissCounter(threshold = 2) {
  let misses = 0;
  return {
    /** True while the fallback notice should show. */
    tick({ fromTick = false, blocked = false, matched = false } = {}) {
      if (matched || !blocked) { misses = 0; return false; }
      if (fromTick) misses += 1;
      return misses >= threshold;
    },
    reset() { misses = 0; },
  };
}
