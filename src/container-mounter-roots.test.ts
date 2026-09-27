import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// containerWritableRoots(): the union of every host path a container can be
// given read-write — what the dashboard's artifact auto-capture refuses.
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('./config.js', async () => {
  const p = await import('path');
  const base = p.default.join(p.default.sep, 'tmp', 'roots-test');
  return {
    DATA_DIR: p.default.join(base, 'data'),
    GROUPS_DIR: p.default.join(base, 'groups'),
    HOME_DIR: p.default.join(base, 'home'),
    CONFIG_DIR: p.default.join(base, 'home', '.config', 'deus'),
  };
});
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(),
  resolveGroupIpcPath: vi.fn(),
  assertValidGroupFolder: vi.fn(),
  isValidGroupFolder: vi.fn(() => true),
}));
const projects = vi.fn(() => [] as { path: string; readonly: boolean }[]);
vi.mock('./db.js', () => ({
  getProjectById: vi.fn(),
  getAllProjects: () => projects(),
}));
vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));
vi.mock('./project-registry.js', () => ({
  SENSITIVE_FILE_PATTERNS: [],
  SENSITIVE_DIR_PATTERNS: [],
}));
const allowlist = vi.fn(
  () =>
    null as null | {
      allowedRoots: { path: string; allowReadWrite: boolean }[];
    },
);
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
  loadMountAllowlist: () => allowlist(),
}));

import { containerWritableRoots } from './container-mounter.js';

const base = path.join(path.sep, 'tmp', 'roots-test');
describe('containerWritableRoots', () => {
  const env = process.env.DEUS_VAULT_PATH;
  beforeEach(() => {
    projects.mockReset();
    projects.mockReturnValue([]);
    allowlist.mockReset();
    allowlist.mockReturnValue(null);
    delete process.env.DEUS_VAULT_PATH;
  });
  afterEach(() => {
    if (env === undefined) delete process.env.DEUS_VAULT_PATH;
    else process.env.DEUS_VAULT_PATH = env;
  });
  it('always covers the group folders, the group sessions, ipc and task worktrees', () => {
    const roots = containerWritableRoots();
    expect(roots).toEqual(
      expect.arrayContaining([
        path.join(base, 'groups'),
        path.join(base, 'data', 'sessions'),
        path.join(base, 'data', 'ipc'),
        path.join(base, 'data', 'worktrees'),
      ]),
    );
  });
  it('adds the vault root (which covers vault/groups), writable registered projects, and rw allow-listed roots; a read-only project is not refused', () => {
    process.env.DEUS_VAULT_PATH = '~/vault';
    projects.mockReturnValue([
      { path: path.join(base, 'proj', 'rw'), readonly: false },
      { path: path.join(base, 'proj', 'ro'), readonly: true },
    ]);
    allowlist.mockReturnValue({
      allowedRoots: [
        { path: '~/shared', allowReadWrite: true },
        { path: path.join(base, 'readonly-root'), allowReadWrite: false },
      ],
    });
    const roots = containerWritableRoots();
    expect(roots).toContain(path.join(base, 'home', 'vault'));
    expect(roots).toContain(path.join(base, 'proj', 'rw'));
    expect(roots).not.toContain(path.join(base, 'proj', 'ro'));
    expect(roots).toContain(path.join(base, 'home', 'shared'));
    expect(roots).not.toContain(path.join(base, 'readonly-root'));
  });
});
