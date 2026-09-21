import { describe, expect, it } from 'vitest';
import { createLogRing } from './log-ring.js';

const write = (ring: ReturnType<typeof createLogRing>, s: string) =>
  new Promise<void>((resolve) => ring.stream.write(s, () => resolve()));

describe('log ring', () => {
  it('keeps the newest N info+ lines and drops debug', async () => {
    const ring = createLogRing(3);
    for (let i = 1; i <= 5; i++)
      await write(ring, `{"level":30,"time":${i},"msg":"m${i}"}\n`);
    await write(ring, '{"level":20,"time":9,"msg":"debug"}\n');
    expect(ring.entries().map((e) => e.msg)).toEqual(['m3', 'm4', 'm5']);
  });

  it('stores a non-JSON line as a message and truncates long lines', async () => {
    const ring = createLogRing(5);
    await write(ring, 'plain text\n');
    await write(ring, `{"level":40,"msg":"${'x'.repeat(10_000)}"}\n`);
    const [a, b] = ring.entries();
    expect(a).toMatchObject({ level: 30, msg: 'plain text' });
    expect(b.line.length).toBeLessThanOrEqual(4096);
  });

  it('redacts secret-looking fields and never stores hostname or pid', async () => {
    const ring = createLogRing(5);
    await write(
      ring,
      '{"level":30,"pid":1,"hostname":"box","msg":"hi","token":"xoxb-1","nested":{"password":"p","ok":1}}\n',
    );
    const [e] = ring.entries();
    expect(e.fields).toEqual({
      token: '[redacted]',
      nested: { password: '[redacted]', ok: 1 },
    });
    expect(e.line).not.toContain('box');
    expect(e.line).not.toContain('xoxb');
    expect(JSON.parse(e.line)).toMatchObject({ token: '[redacted]' });
  });

  it('notifies listeners until unsubscribed and handles split chunks', async () => {
    const ring = createLogRing(5);
    const seen: string[] = [];
    const off = ring.onEntry((e) => seen.push(e.msg));
    await write(ring, '{"level":30,"ms');
    await write(ring, 'g":"joined"}\n{"level":30,"msg":"two"}\n');
    off();
    await write(ring, '{"level":30,"msg":"three"}\n');
    expect(seen).toEqual(['joined', 'two']);
    expect(ring.entries()).toHaveLength(3);
  });
});
