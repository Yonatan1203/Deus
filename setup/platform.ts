/**
 * Cross-platform detection utilities for Deus setup.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type Platform = 'macos' | 'linux' | 'windows' | 'unknown';
export type ServiceManager = 'launchd' | 'systemd' | 'nssm' | 'servy' | 'none';

export function getPlatform(): Platform {
  const platform = os.platform();
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

export function isWSL(): boolean {
  if (os.platform() !== 'linux') return false;
  try {
    const release = fs.readFileSync('/proc/version', 'utf-8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

export function isRoot(): boolean {
  return process.getuid?.() === 0;
}

export function isHeadless(): boolean {
  // No display server available
  if (getPlatform() === 'linux') {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  // macOS is never headless in practice (even SSH sessions can open URLs)
  return false;
}

export function hasSystemd(): boolean {
  if (getPlatform() !== 'linux') return false;
  try {
    // Check if systemd is PID 1
    const init = fs.readFileSync('/proc/1/comm', 'utf-8').trim();
    return init === 'systemd';
  } catch {
    return false;
  }
}

/**
 * Open a URL in the default browser, cross-platform.
 * Returns true if the command was attempted, false if no method available.
 */
export function openBrowser(url: string): boolean {
  try {
    const platform = getPlatform();
    if (platform === 'macos') {
      execSync(`open ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'windows') {
      execSync(`start "" ${JSON.stringify(url)}`, { stdio: 'ignore' });
      return true;
    }
    if (platform === 'linux') {
      // Try xdg-open first, then wslview for WSL
      if (commandExists('xdg-open')) {
        execSync(`xdg-open ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      if (isWSL() && commandExists('wslview')) {
        execSync(`wslview ${JSON.stringify(url)}`, { stdio: 'ignore' });
        return true;
      }
      // WSL without wslview: try cmd.exe
      if (isWSL()) {
        try {
          execSync(`cmd.exe /c start "" ${JSON.stringify(url)}`, {
            stdio: 'ignore',
          });
          return true;
        } catch {
          // cmd.exe not available
        }
      }
    }
  } catch {
    // Command failed
  }
  return false;
}

export function getServiceManager(): ServiceManager {
  const platform = getPlatform();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux') {
    if (hasSystemd()) return 'systemd';
    return 'none';
  }
  if (platform === 'windows') {
    if (commandExists('servy-cli')) return 'servy';
    if (commandExists('nssm')) return 'nssm';
    return 'none';
  }
  return 'none';
}

type RunCommand = (cmd: string) => string;

const defaultRun: RunCommand = (cmd) =>
  execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

// Unit names are interpolated into shell commands; accept only plain ones.
const SAFE_UNIT = /^[A-Za-z0-9@._-]+\.service$/;

/**
 * Name of the systemd unit that runs this checkout. setup installs `deus`,
 * but a host can run several instances under other names (e.g.
 * `deus-newly`), so match on the unit that starts this checkout's
 * `dist/index.js`. Working directory alone is not enough: setup's own
 * oneshot jobs (`deus-maintenance`, ...) share it. Falls back to `deus`.
 */
export function findSystemdUnit(
  projectRoot: string,
  run: RunCommand = defaultRun,
): string {
  const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
  const entry = path.join(projectRoot, 'dist', 'index.js');
  try {
    const names = run(
      `${prefix} list-unit-files --type=service --plain --no-legend 'deus*.service'`,
    )
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => SAFE_UNIT.test(name));
    for (const name of names) {
      const execStart = run(`${prefix} show -p ExecStart ${name}`);
      if (execStart.split(/\s+/).includes(entry)) {
        return name.slice(0, -'.service'.length);
      }
    }
  } catch {
    // systemctl unavailable or failed: keep the default name
  }
  return 'deus';
}

/** Status of this checkout's systemd service. */
export function getSystemdServiceStatus(
  projectRoot: string,
  run: RunCommand = defaultRun,
): 'running' | 'stopped' | 'not_found' {
  const prefix = isRoot() ? 'systemctl' : 'systemctl --user';
  const unit = findSystemdUnit(projectRoot, run);
  try {
    run(`${prefix} is-active ${unit}`);
    return 'running';
  } catch {
    // inactive: installed but stopped, or not installed
  }
  try {
    const files = run(
      `${prefix} list-unit-files --type=service --plain --no-legend`,
    );
    const listed = files
      .split('\n')
      .some((line) => line.trim().split(/\s+/)[0] === `${unit}.service`);
    return listed ? 'stopped' : 'not_found';
  } catch {
    return 'not_found';
  }
}

export function getNodePath(): string {
  try {
    if (os.platform() === 'win32') {
      // `where` returns one path per line; take the first
      return execSync('where node', { encoding: 'utf-8' })
        .trim()
        .split('\n')[0]
        .trim();
    }
    return execSync('command -v node', { encoding: 'utf-8' }).trim();
  } catch {
    return process.execPath;
  }
}

export function commandExists(name: string): boolean {
  try {
    const check =
      os.platform() === 'win32' ? `where ${name}` : `command -v ${name}`;
    execSync(check, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function getNodeVersion(): string | null {
  try {
    const version = execSync('node --version', { encoding: 'utf-8' }).trim();
    return version.replace(/^v/, '');
  } catch {
    return null;
  }
}

export function getNodeMajorVersion(): number | null {
  const version = getNodeVersion();
  if (!version) return null;
  const major = parseInt(version.split('.')[0], 10);
  return isNaN(major) ? null : major;
}
