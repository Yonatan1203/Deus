import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { createEventHub } from './events.js';

function fakeRes() {
  const chunks: string[] = [];
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writeHead: () => res,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    end: () => {},
    chunks,
  });
  return res;
}

describe('control-ui event hub', () => {
  it('broadcasts frames, replays from Last-Event-ID, caps clients', () => {
    const hub = createEventHub({
      maxClients: 1,
      ringSize: 2,
      keepaliveMs: 60_000,
    });
    const req1 = Object.assign(new EventEmitter(), { headers: {} });
    const res1 = fakeRes();
    expect(hub.attach(req1 as never, res1 as never)).toBe(true);
    hub.broadcast('warden', { name: 'a' });
    expect(res1.chunks.join('')).toContain('event: warden');
    expect(res1.chunks.join('')).toContain('data: {"name":"a"}');
    const res2 = fakeRes();
    expect(hub.attach(req1 as never, res2 as never)).toBe(false);
    req1.emit('close');
    expect(hub.clientCount()).toBe(0);
    hub.broadcast('warden', { name: 'b' });
    hub.broadcast('warden', { name: 'c' });
    const req3 = Object.assign(new EventEmitter(), {
      headers: { 'last-event-id': '1' },
    });
    const res3 = fakeRes();
    hub.attach(req3 as never, res3 as never);
    expect(hub.recent(5).map((f) => [f.id, f.type])).toEqual([
      [2, 'warden'],
      [3, 'warden'],
    ]);
    const replay = res3.chunks.join('');
    expect(replay).toContain('"name":"b"');
    expect(replay).toContain('"name":"c"');
    expect(replay).not.toContain('"name":"a"');
    hub.close();
  });
});
