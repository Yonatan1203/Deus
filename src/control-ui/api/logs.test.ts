import { describe, expect, it } from 'vitest';
import { createLogRing } from '../../log-ring.js';
import { isOwnContainer } from '../../container-runtime.js';
import type { DockerRunner } from './docker.js';
import { clampLines, containerLogs, queryLogs, redactSecrets } from './logs.js';

const ID = 'abcdef12';

describe('control-ui logs', () => {
  it('redacts key:value, prefixed tokens and url userinfo without breaking json', () => {
    expect(redactSecrets('api_key=abc123 rest')).toBe(
      'api_key=[redacted] rest',
    );
    expect(redactSecrets('{"token":"xoxb-1234567890-abc"}')).toBe(
      '{"token":"[redacted]"}',
    );
    expect(redactSecrets('{"authorization":"Bearer ghp_16C7e42F292c69"}')).toBe(
      '{"authorization":"[redacted]"}',
    );
    expect(redactSecrets('my pat is ghp_16C7e42F292c69 ok')).toBe(
      'my pat is [redacted] ok',
    );
    expect(redactSecrets('OPENAI_BASE_URL=http://u:p@host/openai')).toBe(
      'OPENAI_BASE_URL=http://[redacted]@host/openai',
    );
    expect(redactSecrets('password: hunter2')).toBe('password: [redacted]');
    expect(redactSecrets('nothing to see here')).toBe('nothing to see here');
  });

  it('clamps lines to 1..1000 with a default', () => {
    expect(clampLines(undefined)).toBe(200);
    expect(clampLines('5')).toBe(5);
    expect(clampLines(0)).toBe(200);
    expect(clampLines(99_999)).toBe(1000);
  });

  it('filters by level and substring, newest last, projected in read-only', async () => {
    const ring = createLogRing(50);
    const w = (s: string) =>
      new Promise<void>((r) => ring.stream.write(`${s}\n`, () => r()));
    await w('{"level":30,"time":1,"msg":"alpha","x":1}');
    await w('{"level":40,"time":2,"msg":"beta warn"}');
    await w('{"level":50,"time":3,"msg":"gamma error","token":"t"}');
    expect(queryLogs(ring, { level: 'warn' }).map((e) => e.msg)).toEqual([
      'beta warn',
      'gamma error',
    ]);
    expect(queryLogs(ring, { q: 'GAMMA' }).map((e) => e.msg)).toEqual([
      'gamma error',
    ]);
    expect(queryLogs(ring, { lines: 1 }).map((e) => e.msg)).toEqual([
      'gamma error',
    ]);
    const ro = queryLogs(ring, { readOnly: true });
    expect(Object.keys(ro[0]).sort()).toEqual(['level', 'msg', 'seq', 'time']);
    const rw = queryLogs(ring, {});
    expect(rw[2]).toHaveProperty('fields', { token: '[redacted]' });
  });

  it('ownership is case-preserving and instance-scoped', () => {
    expect(isOwnContainer(`deus-MyProject-1758000000000-i${ID}`, ID)).toBe(
      true,
    );
    expect(isOwnContainer(`deus-main-1758000000000-i${ID}`, ID)).toBe(true);
    expect(isOwnContainer('deus-main-1758000000000-i00000000', ID)).toBe(false);
    expect(isOwnContainer(`deus-main-1758000000000-i${ID}; rm`, ID)).toBe(
      false,
    );
    expect(isOwnContainer(`--name=deus-main-1758000000000-i${ID}`, ID)).toBe(
      false,
    );
    expect(isOwnContainer('other-1758000000000-i' + ID, ID)).toBe(false);
  });

  it('container logs: refuses foreign names without calling the runner', async () => {
    const calls: string[][] = [];
    const docker: DockerRunner = {
      run: async (argv) => {
        calls.push(argv);
        return {
          ok: true,
          stdout: 'a\nsk-abcdefghijklmnop done\n',
          stderr: 'err line',
        };
      },
      cached: async () => ({ ok: false, error: 'unused' }),
    };
    expect(
      await containerLogs(docker, 'deus-x-1758000000000-i00000000', 5, ID),
    ).toEqual({ status: 404 });
    expect(calls).toHaveLength(0);
    const r = await containerLogs(
      docker,
      `deus-x-1758000000000-i${ID}`,
      '5000',
      ID,
    );
    expect(calls[0]).toEqual([
      'logs',
      '--tail',
      '1000',
      `deus-x-1758000000000-i${ID}`,
    ]);
    expect(r).toEqual({ lines: ['a', '[redacted] done', 'err line'] });
    const failing: DockerRunner = {
      ...docker,
      run: async () => ({ ok: false, error: 'timeout' }),
    };
    expect(
      await containerLogs(failing, `deus-x-1758000000000-i${ID}`, 5, ID),
    ).toEqual({ error: 'timeout' });
  });
});
