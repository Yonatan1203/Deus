import fs from 'fs';
import os from 'os';
import { IS_LINUX, IS_MACOS, IS_WINDOWS } from '../../platform.js';
import type { DockerRunner } from './docker.js';

export interface SystemView {
  platform: string;
  arch: string;
  node: string;
  version: string;
  pid_uptime_s: number;
  os_uptime_s: number;
  load: [number, number, number];
  mem: { total: number; free: number; rss: number };
  disk:
    | { total: number; free: number; used_pct: number; path: 'repo' }
    | { error: string };
  docker: { version?: string; df?: DfRow[]; error?: string };
  alert?: 'disk';
}

export interface DfRow {
  type: string;
  total: string;
  active: string;
  size: string;
  reclaimable: string;
}

export const DISK_ALERT_PCT = 85;
const CACHE_MS = 30_000;

type StatfsLike = (
  p: string,
) => Promise<{ bsize: number; blocks: number; bfree: number; bavail: number }>;

export async function readSystem(deps: {
  repoRoot: string;
  docker: DockerRunner;
  version: string;
  statfs?: StatfsLike;
}): Promise<SystemView> {
  const statfs = deps.statfs ?? ((p: string) => fs.promises.statfs(p));
  let disk: SystemView['disk'];
  try {
    const st = await statfs(deps.repoRoot);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    disk = {
      total,
      free,
      used_pct: total ? Math.round((1 - free / total) * 100) : 0,
      path: 'repo',
    };
  } catch (err) {
    disk = { error: (err as Error).message };
  }
  const docker: SystemView['docker'] = {};
  const v = await deps.docker.cached('version', CACHE_MS, [
    'version',
    '--format',
    '{{.Server.Version}}',
  ]);
  if (v.ok) docker.version = v.stdout.trim();
  else docker.error = v.error;
  if (v.ok) {
    const df = await deps.docker.cached('df', CACHE_MS, [
      'system',
      'df',
      '--format',
      '{{json .}}',
    ]);
    if (df.ok) {
      docker.df = [];
      for (const line of df.stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as Record<string, unknown>;
          docker.df.push({
            type: String(r.Type ?? ''),
            total: String(r.TotalCount ?? ''),
            active: String(r.Active ?? ''),
            size: String(r.Size ?? ''),
            reclaimable: String(r.Reclaimable ?? ''),
          });
        } catch {
          /* skip a malformed row */
        }
      }
    } else docker.error = df.error;
  }
  const out: SystemView = {
    platform: IS_WINDOWS
      ? 'windows'
      : IS_MACOS
        ? 'macos'
        : IS_LINUX
          ? 'linux'
          : 'other',
    arch: process.arch,
    node: process.version,
    version: deps.version,
    pid_uptime_s: Math.round(process.uptime()),
    os_uptime_s: Math.round(os.uptime()),
    load: os.loadavg() as [number, number, number],
    mem: {
      total: os.totalmem(),
      free: os.freemem(),
      rss: process.memoryUsage().rss,
    },
    disk,
    docker,
  };
  if ('used_pct' in disk && disk.used_pct >= DISK_ALERT_PCT) out.alert = 'disk';
  return out;
}
