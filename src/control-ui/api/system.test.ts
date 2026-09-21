import { describe, expect, it } from 'vitest';
import type { DockerRunner } from './docker.js';
import { readSystem } from './system.js';

const docker = (ok: boolean): DockerRunner & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    run: async () => ({ ok: false, error: 'unused' }),
    cached: async (key) => {
      calls.push(key);
      if (!ok) return { ok: false, error: 'docker not found' };
      return key === 'version'
        ? { ok: true, stdout: '27.1.0\n', stderr: '' }
        : {
            ok: true,
            stdout:
              '{"Type":"Images","TotalCount":"3","Active":"1","Size":"1.2GB","Reclaimable":"0B"}\nbad\n',
            stderr: '',
          };
    },
  };
};
const statfs = (pct: number) => async () => ({
  bsize: 4096,
  blocks: 100,
  bfree: 100 - pct,
  bavail: 100 - pct,
});

describe('system api', () => {
  it('computes disk usage, raises the alert at 85, parses docker df', async () => {
    const d = docker(true);
    const s = await readSystem({
      repoRoot: '/r',
      docker: d,
      version: '1.0',
      statfs: statfs(84),
    });
    expect(s.disk).toEqual({
      total: 409600,
      free: 65536,
      used_pct: 84,
      path: 'repo',
    });
    expect(s.alert).toBeUndefined();
    expect(s.docker).toEqual({
      version: '27.1.0',
      df: [
        {
          type: 'Images',
          total: '3',
          active: '1',
          size: '1.2GB',
          reclaimable: '0B',
        },
      ],
    });
    expect(s).toMatchObject({ version: '1.0', node: process.version });
    const hot = await readSystem({
      repoRoot: '/r',
      docker: d,
      version: '1.0',
      statfs: statfs(90),
    });
    expect(hot.alert).toBe('disk');
    expect(d.calls).toEqual(['version', 'df', 'version', 'df']);
  });

  it('degrades when docker or statfs fail', async () => {
    const s = await readSystem({
      repoRoot: '/r',
      docker: docker(false),
      version: '1.0',
      statfs: async () => {
        throw new Error('nope');
      },
    });
    expect(s.docker).toEqual({ error: 'docker not found' });
    expect(s.disk).toEqual({ error: 'nope' });
    expect(s.alert).toBeUndefined();
  });
});
