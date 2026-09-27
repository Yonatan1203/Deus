import { describe, it, expect } from 'vitest';

import {
  getPlatform,
  isWSL,
  isRoot,
  isHeadless,
  hasSystemd,
  getServiceManager,
  commandExists,
  getNodeVersion,
  getNodeMajorVersion,
  findSystemdUnit,
  getSystemdServiceStatus,
} from './platform.js';

// --- getPlatform ---

describe('getPlatform', () => {
  it('returns a valid platform string', () => {
    const result = getPlatform();
    expect(['macos', 'linux', 'windows', 'unknown']).toContain(result);
  });
});

// --- isWSL ---

describe('isWSL', () => {
  it('returns a boolean', () => {
    expect(typeof isWSL()).toBe('boolean');
  });

  it('checks /proc/version for WSL markers', () => {
    // On non-WSL Linux, should return false
    // On WSL, should return true
    // Just verify it doesn't throw
    const result = isWSL();
    expect(typeof result).toBe('boolean');
  });
});

// --- isRoot ---

describe('isRoot', () => {
  it('returns a boolean', () => {
    expect(typeof isRoot()).toBe('boolean');
  });
});

// --- isHeadless ---

describe('isHeadless', () => {
  it('returns a boolean', () => {
    expect(typeof isHeadless()).toBe('boolean');
  });
});

// --- hasSystemd ---

describe('hasSystemd', () => {
  it('returns a boolean', () => {
    expect(typeof hasSystemd()).toBe('boolean');
  });

  it('checks /proc/1/comm', () => {
    // On systemd systems, should return true
    // Just verify it doesn't throw
    const result = hasSystemd();
    expect(typeof result).toBe('boolean');
  });
});

// --- getServiceManager ---

describe('getServiceManager', () => {
  it('returns a valid service manager', () => {
    const result = getServiceManager();
    expect(['launchd', 'systemd', 'nssm', 'servy', 'none']).toContain(result);
  });

  it('matches the detected platform', () => {
    const platform = getPlatform();
    const result = getServiceManager();
    if (platform === 'macos') {
      expect(result).toBe('launchd');
    } else {
      expect(['systemd', 'nssm', 'servy', 'none']).toContain(result);
    }
  });
});

// --- commandExists ---

describe('commandExists', () => {
  it('returns true for node', () => {
    expect(commandExists('node')).toBe(true);
  });

  it('returns false for nonexistent command', () => {
    expect(commandExists('this_command_does_not_exist_xyz_123')).toBe(false);
  });
});

// --- getNodeVersion ---

describe('getNodeVersion', () => {
  it('returns a version string', () => {
    const version = getNodeVersion();
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// --- getNodeMajorVersion ---

describe('getNodeMajorVersion', () => {
  it('returns at least 20', () => {
    const major = getNodeMajorVersion();
    expect(major).not.toBeNull();
    expect(major!).toBeGreaterThanOrEqual(20);
  });
});

// --- findSystemdUnit / getSystemdServiceStatus ---

const ROOT = '/srv/deus-b';

/** Fake systemctl: unit name -> `show` output; `active` lists running units. */
function fakeSystemctl(
  units: Record<string, string>,
  active: string[] = [],
): { run: (cmd: string) => string; calls: string[] } {
  const calls: string[] = [];
  const run = (cmd: string): string => {
    calls.push(cmd);
    if (cmd.includes(' list-unit-files')) {
      return Object.keys(units)
        .map((u) => `${u} enabled enabled`)
        .join('\n');
    }
    const show = cmd.match(/ show -p ExecStart (\S+)$/);
    if (show) return units[show[1]] ?? '';
    const isActive = cmd.match(/ is-active (\S+)$/);
    if (isActive) {
      if (active.includes(isActive[1])) return 'active';
      throw new Error('inactive');
    }
    throw new Error(`unexpected command: ${cmd}`);
  };
  return { run, calls };
}

/** `systemctl show -p ExecStart` output for a node service at `root`. */
const nodeExec = (root: string) =>
  `ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${root}/dist/index.js ; ignore_errors=no }`;
/** ... for one of setup's python oneshot jobs at `root`. */
const pythonExec = (root: string) =>
  `ExecStart={ path=/usr/bin/python3 ; argv[]=/usr/bin/python3 ${root}/scripts/maintenance.py ; ignore_errors=no }`;

describe('findSystemdUnit', () => {
  it('matches the unit that starts this checkout, not the first deus unit', () => {
    const { run } = fakeSystemctl({
      'deus.service': nodeExec('/srv/deus-a'),
      'deus-b.service': nodeExec(ROOT),
    });
    expect(findSystemdUnit(ROOT, run)).toBe('deus-b');
  });

  it("skips setup's own oneshot jobs that share the working directory", () => {
    // Standard install: deus-* sorts before deus.service in list-unit-files.
    const { run } = fakeSystemctl(
      {
        'deus-cockpit-healthcheck.service': pythonExec(ROOT),
        'deus-maintenance.service': pythonExec(ROOT),
        'deus.service': nodeExec(ROOT),
      },
      ['deus'],
    );
    expect(findSystemdUnit(ROOT, run)).toBe('deus');
    expect(getSystemdServiceStatus(ROOT, run)).toBe('running');
  });

  it('does not match a checkout whose path merely ends with this one', () => {
    const { run } = fakeSystemctl({
      'deus-x.service': nodeExec(`/x${ROOT}`),
    });
    expect(findSystemdUnit(ROOT, run)).toBe('deus');
  });

  it('falls back to deus when no unit matches', () => {
    const { run } = fakeSystemctl({
      'deus-other.service': nodeExec('/elsewhere'),
    });
    expect(findSystemdUnit(ROOT, run)).toBe('deus');
  });

  it('falls back to deus when systemctl fails', () => {
    const run = () => {
      throw new Error('systemctl: command not found');
    };
    expect(findSystemdUnit(ROOT, run)).toBe('deus');
  });

  it('never passes a unit name with shell metacharacters to systemctl', () => {
    const { run, calls } = fakeSystemctl({
      'deus;rm-x.service': nodeExec(ROOT),
      'deus$(id).service': nodeExec(ROOT),
    });
    expect(findSystemdUnit(ROOT, run)).toBe('deus');
    expect(calls.some((c) => c.includes(' show '))).toBe(false);
  });
});

describe('getSystemdServiceStatus', () => {
  it('checks the resolved unit, not a literal deus', () => {
    const { run, calls } = fakeSystemctl(
      {
        'deus.service': nodeExec('/srv/deus-a'),
        'deus-b.service': nodeExec(ROOT),
      },
      ['deus-b'],
    );
    expect(getSystemdServiceStatus(ROOT, run)).toBe('running');
    const isActive = calls.filter((c) => c.includes(' is-active '));
    expect(isActive).toHaveLength(1);
    expect(isActive[0]).toMatch(/ is-active deus-b$/);
  });

  it('reports stopped when the unit is installed but inactive', () => {
    const { run } = fakeSystemctl({
      'deus-b.service': nodeExec(ROOT),
    });
    expect(getSystemdServiceStatus(ROOT, run)).toBe('stopped');
  });

  it('reports not_found when no unit is installed', () => {
    const { run } = fakeSystemctl({});
    expect(getSystemdServiceStatus(ROOT, run)).toBe('not_found');
  });
});
