import { describe, expect, it, vi } from 'vitest';
import { createHostCli } from './host-cli.js';

type Cb = (
  e: (Error & { code?: string; killed?: boolean }) | null,
  so: string,
  se: string,
) => void;

describe('host cli runner', () => {
  it('passes cwd/env, bounds concurrency, maps errors, caches', async () => {
    const pending: (() => void)[] = [];
    const seen: unknown[] = [];
    const execFile = vi.fn(
      (_bin: string, argv: string[], o: unknown, cb: Cb) => {
        seen.push(o);
        if (argv[0] === 'enoent')
          return cb(Object.assign(new Error('nf'), { code: 'ENOENT' }), '', '');
        if (argv[0] === 'slow')
          return cb(Object.assign(new Error('k'), { killed: true }), '', '');
        if (argv[0] === 'now') return cb(null, 'immediate', '');
        pending.push(() => cb(null, `out-${argv[0]}`, ''));
      },
    );
    let t = 0;
    const cli = createHostCli('claude', {
      maxInFlight: 2,
      cwd: '/repo',
      env: { PATH: '/bin' },
      execFile: execFile as never,
      now: () => t,
    });
    const a = cli.run(['a']);
    const b = cli.run(['b']);
    const c = cli.run(['c']);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    expect(seen[0]).toMatchObject({
      cwd: '/repo',
      env: { PATH: '/bin' },
      timeout: 15_000,
    });
    pending.shift()!();
    expect(await a).toEqual({ ok: true, stdout: 'out-a', stderr: '' });
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(3));
    pending.shift()!();
    pending.shift()!();
    expect((await b).ok && (await c).ok).toBe(true);
    expect(await cli.run(['enoent'])).toEqual({
      ok: false,
      error: 'claude not found',
    });
    expect(await cli.run(['slow'])).toEqual({ ok: false, error: 'timeout' });
    const before = execFile.mock.calls.length;
    await cli.cached('k', 1000, ['now']);
    await cli.cached('k', 1000, ['now']);
    expect(execFile.mock.calls.length).toBe(before + 1);
    t = 5000;
    await cli.cached('k', 1000, ['now']);
    expect(execFile.mock.calls.length).toBe(before + 2);
  });
});
