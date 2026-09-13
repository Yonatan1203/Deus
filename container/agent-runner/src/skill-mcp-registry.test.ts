import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadSkillMcpTools, defaultSkillsDir } from './skill-mcp-registry.js';

const tmpDirs: string[] = [];
function mkSkillsDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-mcp-'));
  tmpDirs.push(d);
  return d;
}
function writeSkill(root: string, name: string, body: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'agent.js'), body);
}

const ctx = {
  groupFolder: 'g',
  chatJid: 'j@g.us',
  isMain: true,
  ipcDir: '/workspace/ipc',
};
const server = { tool: vi.fn() } as unknown as Parameters<
  typeof loadSkillMcpTools
>[0];

afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadSkillMcpTools', () => {
  it('resolves the default scan root next to the compiled module, not /app/skills', () => {
    const dir = defaultSkillsDir();
    expect(path.basename(dir)).toBe('skills');
    expect(path.dirname(dir)).toBe(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    expect(dir).not.toBe('/app/skills');
  });

  it('returns quietly when the scan root does not exist', async () => {
    await expect(
      loadSkillMcpTools(
        server,
        ctx,
        path.join(os.tmpdir(), 'does-not-exist-' + Date.now()),
      ),
    ).resolves.toBeUndefined();
  });

  it('calls registerTools(server, ctx) for every skill dir with an agent.js', async () => {
    const root = mkSkillsDir();
    writeSkill(
      root,
      'alpha',
      'export function registerTools(server, ctx) { globalThis.__alpha = { server, ctx }; }',
    );
    writeSkill(
      root,
      'beta',
      'export function registerTools() { globalThis.__beta = true; }',
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadSkillMcpTools(server, ctx, root);

    const g = globalThis as Record<string, unknown>;
    expect((g.__alpha as { server: unknown; ctx: unknown }).server).toBe(
      server,
    );
    expect((g.__alpha as { server: unknown; ctx: unknown }).ctx).toBe(ctx);
    expect(g.__beta).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(
      '[skill-mcp] Loaded tools from skill: alpha',
    );
    expect(errSpy).toHaveBeenCalledWith(
      '[skill-mcp] Loaded tools from skill: beta',
    );
  });

  it('skips entries without agent.js and modules without registerTools', async () => {
    const root = mkSkillsDir();
    fs.mkdirSync(path.join(root, 'no-agent'));
    fs.writeFileSync(path.join(root, 'stray-file.js'), 'export const x = 1;');
    writeSkill(root, 'no-register', 'export const createTools = () => [];');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadSkillMcpTools(server, ctx, root);

    expect(errSpy).not.toHaveBeenCalled();
  });

  it('logs and continues when one skill throws at import time', async () => {
    const root = mkSkillsDir();
    writeSkill(root, 'broken', 'throw new Error("boom");');
    writeSkill(
      root,
      'ok',
      'export function registerTools() { globalThis.__ok = true; }',
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await loadSkillMcpTools(server, ctx, root);

    expect((globalThis as Record<string, unknown>).__ok).toBe(true);
    expect(
      errSpy.mock.calls.some((c) =>
        String(c[0]).startsWith('[skill-mcp] Failed to load skill broken'),
      ),
    ).toBe(true);
  });
});
