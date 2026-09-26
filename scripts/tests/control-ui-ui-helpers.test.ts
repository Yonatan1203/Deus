import { describe, expect, it, vi } from 'vitest';

// ui.js touches the document on import for toasts; give it a minimal one.
const el = { textContent: '', dataset: {}, hidden: true, _t: 0 };
vi.stubGlobal('document', { getElementById: () => el });
vi.stubGlobal('setTimeout', () => 0);
vi.stubGlobal('clearTimeout', () => {});
// @ts-expect-error — plain JS module without type declarations
const { limitToast, serverError } = await import('../../web/control/ui.js');

describe('ui helpers', () => {
  it('rate-limit toasts share one sentence', () => {
    limitToast('changes');
    expect(el.textContent).toBe('Too many changes — wait a minute.');
    limitToast('starts', 'a few minutes');
    expect(el.textContent).toBe('Too many starts — wait a few minutes.');
  });

  it('shows only server messages that are known to be plain', () => {
    const fb = 'Something went wrong — try again.';
    expect(serverError({ message: 'not found' }, fb)).toBe('not found');
    expect(serverError({ message: 'confirmation required' }, fb)).toBe(
      'confirmation required',
    );
    expect(serverError({ message: 'invalid size' }, fb)).toBe(fb);
    expect(serverError({ message: 'ENOENT: no such file' }, fb)).toBe(fb);
    expect(serverError(undefined, fb)).toBe(fb);
  });
});
