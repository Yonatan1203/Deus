import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS browser module
import { createMissCounter } from '../../web/control/ask-fallback.js';

describe('createMissCounter', () => {
  it('shows after two interval ticks of blocked-and-unmatched, not before', () => {
    const c = createMissCounter(2);
    expect(c.tick({ fromTick: true, blocked: true })).toBe(false);
    expect(c.tick({ fromTick: true, blocked: true })).toBe(true);
    expect(c.tick({ fromTick: true, blocked: true })).toBe(true); // stays up
  });
  it('a read between ticks neither counts nor resets', () => {
    const c = createMissCounter(2);
    expect(c.tick({ fromTick: true, blocked: true })).toBe(false);
    expect(c.tick({ fromTick: false, blocked: true })).toBe(false); // pollSoon / a key
    expect(c.tick({ fromTick: false, blocked: true })).toBe(false);
    expect(c.tick({ fromTick: true, blocked: true })).toBe(true); // the second tick
  });
  it('a matched card or an unblocked session resets it', () => {
    const c = createMissCounter(2);
    c.tick({ fromTick: true, blocked: true });
    expect(c.tick({ fromTick: false, blocked: true, matched: true })).toBe(
      false,
    );
    expect(c.tick({ fromTick: true, blocked: true })).toBe(false); // counting from zero again
    expect(c.tick({ fromTick: true, blocked: true })).toBe(true);
    expect(c.tick({ fromTick: true, blocked: false })).toBe(false);
    expect(c.tick({ fromTick: true, blocked: true })).toBe(false);
  });
});
