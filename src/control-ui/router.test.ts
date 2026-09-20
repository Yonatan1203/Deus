import { describe, expect, it } from 'vitest';
import { createRouter } from './router.js';

describe('control-ui router', () => {
  it('matches params, flags, and distinguishes 404 from 405', () => {
    const r = createRouter();
    const h = () => {};
    r.add('GET', '/api/v1/wardens/:name', h);
    r.add('PATCH', '/api/v1/wardens/:name', h, { auth: 'none' });
    r.add('POST', '/api/v1/events/ticket', h, { mutation: false });
    expect(r.match('PATCH', '/api/v1/wardens/plan%2Dreviewer')).toMatchObject({
      kind: 'ok',
      auth: 'none',
      mutation: true,
      params: { name: 'plan-reviewer' },
    });
    expect(r.match('GET', '/api/v1/wardens/x')).toMatchObject({
      kind: 'ok',
      auth: 'session',
      mutation: false,
    });
    expect(r.match('POST', '/api/v1/events/ticket')).toMatchObject({
      kind: 'ok',
      mutation: false,
    });
    expect(r.match('DELETE', '/api/v1/wardens/x').kind).toBe(
      'method_not_allowed',
    );
    expect(r.match('GET', '/api/v1/nope').kind).toBe('not_found');
    expect(r.match('GET', '/api/v1/wardens/a/b').kind).toBe('not_found');
  });
});
