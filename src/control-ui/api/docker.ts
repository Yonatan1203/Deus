// The container runtime is one host binary among several; the runner lives
// in host-cli.ts so there is exactly one execFile site for all of them.
import { createHostCli, type HostCli, type HostCliResult } from './host-cli.js';

export type DockerResult = HostCliResult;
export type DockerRunner = HostCli;

export const createDockerRunner: typeof createHostCli = (bin, opts) =>
  createHostCli(bin, opts);
