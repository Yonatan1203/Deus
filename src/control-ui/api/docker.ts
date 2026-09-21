import { execFile } from 'child_process';

export type DockerResult =
  { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

export interface DockerRunner {
  run(argv: string[], opts?: { maxBuffer?: number }): Promise<DockerResult>;
  cached(key: string, ttlMs: number, argv: string[]): Promise<DockerResult>;
}

type ExecFileLike = (
  bin: string,
  argv: string[],
  opts: { timeout: number; maxBuffer: number },
  cb: (
    err: (Error & { code?: unknown; killed?: boolean }) | null,
    stdout: string,
    stderr: string,
  ) => void,
) => unknown;

/**
 * The only place the control UI executes the container runtime. Every argv
 * is built by the caller from literals plus an already-validated container
 * name; this helper bounds concurrency and time and never throws.
 */
export function createDockerRunner(
  bin: string,
  opts: {
    maxInFlight?: number;
    timeoutMs?: number;
    now?: () => number;
    execFile?: ExecFileLike;
  } = {},
): DockerRunner {
  const maxInFlight = opts.maxInFlight ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? Date.now;
  const exec = opts.execFile ?? (execFile as unknown as ExecFileLike);
  const cache = new Map<string, { at: number; value: DockerResult }>();
  let inFlight = 0;
  const waiters: (() => void)[] = [];

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (inFlight < maxInFlight) {
        inFlight++;
        resolve();
      } else waiters.push(resolve);
    });
  const release = () => {
    const next = waiters.shift();
    if (next) next();
    else inFlight--;
  };

  const run: DockerRunner['run'] = async (argv, o = {}) => {
    await acquire();
    try {
      return await new Promise<DockerResult>((resolve) => {
        exec(
          bin,
          argv,
          { timeout: timeoutMs, maxBuffer: o.maxBuffer ?? 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              const code = String(err.code ?? '');
              const error =
                err.killed || code === 'ETIMEDOUT'
                  ? 'timeout'
                  : code === 'ENOENT'
                    ? `${bin} not found`
                    : (stderr || err.message || 'runtime error')
                        .trim()
                        .slice(0, 300);
              resolve({ ok: false, error });
            } else resolve({ ok: true, stdout, stderr });
          },
        );
      });
    } finally {
      release();
    }
  };

  return {
    run,
    async cached(key, ttlMs, argv) {
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;
      const value = await run(argv);
      if (value.ok) cache.set(key, { at: now(), value });
      return value;
    },
  };
}
