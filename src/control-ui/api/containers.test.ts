import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupSnapshot } from '../../group-queue.js';
import {
  createBuildRunner,
  listContainers,
  stopContainer,
} from './containers.js';
import { createDockerRunner, type DockerRunner } from './docker.js';

const ID = 'abcdef12';
const own = `deus-MyProject-1758000000000-i${ID}`;
const ownB = `deus-main-1758000000001-i${ID}`;
const foreign = 'deus-main-1758000000002-i00000000';

const fake = (
  stdout: string,
  ok = true,
): DockerRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      return ok
        ? { ok: true, stdout, stderr: '' }
        : { ok: false, error: 'boom' };
    },
    cached: async () => ({ ok: false, error: 'unused' }),
  };
};
const snap: GroupSnapshot[] = [
  {
    jid: 'a@x',
    active: true,
    idleWaiting: false,
    isTaskContainer: true,
    runningTaskId: 'task-1',
    containerName: own,
    groupFolder: 'MyProject',
    pendingTaskCount: 0,
    retryCount: 0,
  },
];

describe('containers api', () => {
  it('lists only own containers, skips bad rows, joins queue state', async () => {
    const docker = fake(
      [
        JSON.stringify({
          Names: own,
          Image: 'deus-agent:latest',
          State: 'running',
          Status: 'Up 2 minutes',
          CreatedAt: '2026-09-20',
        }),
        'not json',
        JSON.stringify({
          Names: foreign,
          Image: 'x',
          State: 'running',
          Status: '',
          CreatedAt: '',
        }),
        JSON.stringify({
          Names: ownB,
          Image: 'x',
          State: 'exited',
          Status: 'Exited (0)',
          CreatedAt: '',
        }),
      ].join('\n'),
    );
    const r = await listContainers({
      docker,
      instanceId: ID,
      snapshot: () => snap,
    });
    expect(docker.calls[0]).toEqual([
      'ps',
      '-a',
      '--filter',
      'name=^deus-',
      '--format',
      '{{json .}}',
    ]);
    expect(r.containers.map((c) => c.name)).toEqual([own, ownB]);
    expect(r.containers[0]).toMatchObject({
      group_folder: 'MyProject',
      jid: 'a@x',
      is_task_container: true,
      running_task_id: 'task-1',
    });
    expect(r.containers[1]).not.toHaveProperty('jid');
    expect(r.probe_error).toBeUndefined();
  });

  it('reports a probe error instead of throwing', async () => {
    const r = await listContainers({
      docker: fake('', false),
      instanceId: ID,
      snapshot: () => [],
    });
    expect(r).toEqual({ containers: [], probe_error: 'boom' });
  });

  it('stop: refuses foreign/malformed names before touching the runner', async () => {
    const docker = fake('');
    const deps = { docker, instanceId: ID, snapshot: () => [] };
    expect(await stopContainer(deps, foreign)).toEqual({ status: 404 });
    expect(await stopContainer(deps, `${own}; rm -rf /`)).toEqual({
      status: 404,
    });
    expect(docker.calls).toHaveLength(0);
    expect(await stopContainer(deps, own)).toEqual({ stopped: true });
    expect(docker.calls[0]).toEqual(['stop', '-t', '5', own]);
    expect(
      await stopContainer({ ...deps, docker: fake('', false) }, own),
    ).toEqual({ error: 'boom' });
  });
});

describe('docker runner', () => {
  type Cb = (
    e: (Error & { code?: string; killed?: boolean }) | null,
    so: string,
    se: string,
  ) => void;
  it('bounds concurrency, maps errors, caches successes', async () => {
    const pending: (() => void)[] = [];
    const execFile = vi.fn(
      (_bin: string, argv: string[], _o: unknown, cb: Cb) => {
        if (argv[0] === 'enoent')
          return cb(Object.assign(new Error('nf'), { code: 'ENOENT' }), '', '');
        if (argv[0] === 'slow')
          return cb(Object.assign(new Error('k'), { killed: true }), '', '');
        if (argv[0] === 'fail')
          return cb(
            Object.assign(new Error('bad'), { code: '1' }),
            '',
            'stderr says no',
          );
        if (argv[0] === 'now') return cb(null, 'immediate', '');
        pending.push(() => cb(null, `out-${argv[0]}`, ''));
      },
    );
    let t = 0;
    const d = createDockerRunner('docker', {
      maxInFlight: 2,
      execFile: execFile as never,
      now: () => t,
    });
    const a = d.run(['a']);
    const b = d.run(['b']);
    const c = d.run(['c']);
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(2));
    expect(pending).toHaveLength(2); // c is queued behind the semaphore
    pending.shift()!();
    expect(await a).toEqual({ ok: true, stdout: 'out-a', stderr: '' });
    await vi.waitFor(() => expect(execFile).toHaveBeenCalledTimes(3));
    pending.shift()!();
    pending.shift()!();
    expect((await b).ok && (await c).ok).toBe(true);
    expect(await d.run(['enoent'])).toEqual({
      ok: false,
      error: 'docker not found',
    });
    expect(await d.run(['slow'])).toEqual({ ok: false, error: 'timeout' });
    expect(await d.run(['fail'])).toEqual({
      ok: false,
      error: 'stderr says no',
    });
    const before = execFile.mock.calls.length;
    expect(await d.cached('k', 1000, ['now'])).toMatchObject({
      ok: true,
      stdout: 'immediate',
    });
    await d.cached('k', 1000, ['now']);
    expect(execFile.mock.calls.length).toBe(before + 1);
    t = 2000;
    await d.cached('k', 1000, ['now']);
    expect(execFile.mock.calls.length).toBe(before + 2);
  });
});

describe('build runner', () => {
  const hub = {
    broadcast: vi.fn(),
    attach: () => true,
    clientCount: () => 0,
    recent: () => [],
    close: () => {},
  };
  const mkChild = () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    return child;
  };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs one build at a time, streams lines, kills a stale child, survives git failing', async () => {
    const child = mkChild();
    const spawn = vi.fn(() => child);
    const execFile = vi.fn(
      (
        _b: string,
        _a: string[],
        _o: unknown,
        cb: (e: Error | null, so: string) => void,
      ) => cb(new Error('no git'), ''),
    );
    hub.broadcast.mockClear();
    const runner = createBuildRunner({
      repoRoot: '/repo',
      hub,
      spawn: spawn as never,
      execFile: execFile as never,
      isWindows: false,
    });
    expect(await runner.start()).toBe('started');
    expect(await runner.start()).toBe('running');
    expect((spawn.mock.calls[0] as unknown[])[0]).toBe(
      '/repo/container/build.sh',
    );
    const env = (
      spawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string> },
      ]
    )[2].env;
    expect(Object.keys(env).every((k) => !/KEY|TOKEN|SECRET/.test(k))).toBe(
      true,
    );
    expect(runner.status()).toMatchObject({
      running: true,
      head: null,
      dirty: null,
      image_ref: expect.any(String),
    });
    child.stdout.emit('data', Buffer.from('step one\napi_key=abc\n'));
    expect(runner.status().lines).toEqual(['step one', 'api_key=[redacted]']);
    expect(hub.broadcast).toHaveBeenCalledWith('build', { line: 'step one' });
    vi.advanceTimersByTime(30 * 60_000 + 1);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    vi.advanceTimersByTime(10_001);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(runner.status().running).toBe(true); // lock held until close
    child.emit('close', 137);
    expect(runner.status()).toMatchObject({ running: false, code: 137 });
    expect(hub.broadcast).toHaveBeenCalledWith('build', {
      done: true,
      code: 137,
    });
    expect(await runner.start()).toBe('started');
  });

  it('is unsupported on Windows', async () => {
    const runner = createBuildRunner({
      repoRoot: '/repo',
      hub,
      isWindows: true,
    });
    expect(await runner.start()).toBe('unsupported');
  });
});
