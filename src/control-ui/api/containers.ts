import { spawn, execFile } from 'child_process';
import path from 'path';
import { isOwnContainer } from '../../container-runtime.js';
import type { GroupSnapshot } from '../../group-queue.js';
import { forceKillProcess, IS_WINDOWS } from '../../platform.js';
import type { DockerRunner } from './docker.js';
import type { EventHub } from '../events.js';
import { redactSecrets } from './logs.js';

export interface ContainerView {
  name: string;
  image: string;
  state: string;
  status: string;
  created_at: string;
  group_folder?: string | null;
  jid?: string;
  is_task_container?: boolean;
  running_task_id?: string | null;
}

export interface ContainerDeps {
  docker: DockerRunner;
  instanceId: string;
  snapshot: () => GroupSnapshot[];
}

const PS_ARGV = [
  'ps',
  '-a',
  '--filter',
  'name=^deus-',
  '--format',
  '{{json .}}',
];

export async function listContainers(
  deps: ContainerDeps,
): Promise<{ containers: ContainerView[]; probe_error?: string }> {
  const r = await deps.docker.run(PS_ARGV);
  if (!r.ok) return { containers: [], probe_error: r.error };
  const byName = new Map(deps.snapshot().map((s) => [s.containerName, s]));
  const containers: ContainerView[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // a malformed row is skipped, never surfaced
    }
    const name = String(row.Names ?? '');
    if (!isOwnContainer(name, deps.instanceId)) continue;
    const q = byName.get(name);
    containers.push({
      name,
      image: String(row.Image ?? ''),
      state: String(row.State ?? ''),
      status: String(row.Status ?? ''),
      created_at: String(row.CreatedAt ?? ''),
      ...(q && {
        group_folder: q.groupFolder,
        jid: q.jid,
        is_task_container: q.isTaskContainer,
        running_task_id: q.runningTaskId,
      }),
    });
  }
  return { containers };
}

export async function stopContainer(
  deps: ContainerDeps,
  name: string,
): Promise<{ stopped: true } | { status: 404 } | { error: string }> {
  // Validated before it can become an argv element; `-t 5` gives an agent
  // mid-turn a graceful window (the internal kill path uses `-t 1`).
  if (!isOwnContainer(name, deps.instanceId)) return { status: 404 };
  const r = await deps.docker.run(['stop', '-t', '5', name]);
  return r.ok ? { stopped: true } : { error: r.error };
}

// ---- image rebuild -------------------------------------------------------

export interface BuildStatus {
  running: boolean;
  started_at: number | null;
  finished_at: number | null;
  code: number | null;
  image_ref: string | null;
  head: string | null;
  dirty: boolean | null;
  lines: string[];
}

export interface BuildRunner {
  start(): Promise<'started' | 'running' | 'unsupported'>;
  status(): BuildStatus;
}

type SpawnLike = typeof spawn;
type ExecFileLike = typeof execFile;

const BUILD_LINES_MAX = 200;
const BUILD_TIMEOUT_MS = 30 * 60_000;
const KILL_GRACE_MS = 10_000;
// An allowlist because build output is streamed to the browser. The proxy
// variables may carry userinfo; docker needs them, and redactSecrets covers
// that shape on the output path.
const CHILD_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'CONTAINER_IMAGE',
  'CONTAINER_RUNTIME',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'XDG_RUNTIME_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV_KEYS)
    if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function gitInfo(
  exec: ExecFileLike,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ head: string | null; dirty: boolean | null }> {
  const one = (argv: string[]) =>
    new Promise<string | null>((resolve) => {
      try {
        exec('git', argv, { cwd, env, timeout: 5000 }, (err, stdout) =>
          resolve(err ? null : String(stdout)),
        );
      } catch {
        resolve(null);
      }
    });
  return Promise.all([
    one(['rev-parse', 'HEAD']),
    one(['status', '--porcelain']),
  ]).then(([head, porcelain]) => ({
    head: head ? head.trim() : null,
    dirty: porcelain === null ? null : porcelain.trim().length > 0,
  }));
}

export function createBuildRunner(deps: {
  repoRoot: string;
  hub: EventHub;
  spawn?: SpawnLike;
  execFile?: ExecFileLike;
  setTimeout?: typeof setTimeout;
  now?: () => number;
  isWindows?: boolean;
}): BuildRunner {
  const doSpawn = deps.spawn ?? spawn;
  const exec = deps.execFile ?? execFile;
  const timer = deps.setTimeout ?? setTimeout;
  const now = deps.now ?? Date.now;
  const status: BuildStatus = {
    running: false,
    started_at: null,
    finished_at: null,
    code: null,
    image_ref: null,
    head: null,
    dirty: null,
    lines: [],
  };
  const push = (line: string) => {
    const clean = redactSecrets(line);
    status.lines.push(clean);
    if (status.lines.length > BUILD_LINES_MAX) status.lines.shift();
    deps.hub.broadcast('build', { line: clean });
  };

  return {
    status: () => ({ ...status, lines: status.lines.slice() }),
    async start() {
      if (deps.isWindows ?? IS_WINDOWS) return 'unsupported';
      if (status.running) return 'running';
      status.running = true; // lock held until `close`
      status.started_at = now();
      status.finished_at = null;
      status.code = null;
      status.lines = [];
      const env = childEnv();
      status.image_ref = process.env.CONTAINER_IMAGE || 'deus-agent:latest';
      const git = await gitInfo(exec, deps.repoRoot, env);
      status.head = git.head;
      status.dirty = git.dirty;
      const child = doSpawn(
        path.join(deps.repoRoot, 'container', 'build.sh'),
        [],
        {
          cwd: deps.repoRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const onData = (chunk: Buffer | string) => {
        for (const l of String(chunk).split('\n')) if (l.trim()) push(l);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      // POSIX signals only reach here (Windows answered 'unsupported'); the
      // platform branch keeps the fallback honest if that ever changes.
      const signal = (sig: 'SIGTERM' | 'SIGKILL') => {
        if (IS_WINDOWS) {
          if (child.pid != null) forceKillProcess(child.pid);
        } else child.kill(sig);
      };
      const stale = timer(() => {
        push('[control-ui] build exceeded 30 min; terminating');
        signal('SIGTERM');
        killTimer = timer(() => signal('SIGKILL'), KILL_GRACE_MS);
      }, BUILD_TIMEOUT_MS);
      const finish = (code: number | null) => {
        clearTimeout(stale);
        if (killTimer) clearTimeout(killTimer);
        status.running = false;
        status.finished_at = now();
        status.code = code;
        deps.hub.broadcast('build', { done: true, code });
      };
      child.on('error', (err) => {
        push(`[control-ui] ${err.message}`);
        finish(-1);
      });
      child.on('close', (code) => finish(code));
      return 'started';
    },
  };
}
