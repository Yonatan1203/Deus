import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  memoryTree,
  readMemoryFile,
  resolveMemoryFile,
  writeMemoryFile,
  writePolicy,
} from './memory.js';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-memory-'));
const vault = path.join(base, 'vault');
const groups = path.join(base, 'groups');
for (const p of ['memory', 'Persona', 'Atoms', '.git', 'node_modules'])
  fs.mkdirSync(path.join(vault, p), { recursive: true });
fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '# core');
fs.writeFileSync(path.join(vault, 'memory', 'a.md'), '# a');
fs.writeFileSync(path.join(vault, 'memory', 'notes.txt'), 'txt');
fs.writeFileSync(path.join(vault, 'Persona', 'p.md'), '# p');
fs.writeFileSync(path.join(vault, 'Atoms', 'x.md'), '# x');
fs.writeFileSync(path.join(vault, '.git', 'h.md'), 'hidden');
fs.writeFileSync(path.join(base, 'outside.md'), 'secret');
fs.symlinkSync(
  path.join(base, 'outside.md'),
  path.join(vault, 'memory', 'link.md'),
);
fs.mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
fs.writeFileSync(path.join(base, 'elsewhere', 'e.md'), 'e');
fs.symlinkSync(
  path.join(base, 'elsewhere'),
  path.join(vault, 'memory', 'linkdir'),
);
fs.mkdirSync(path.join(groups, 'main'), { recursive: true });
fs.writeFileSync(path.join(groups, 'main', 'CLAUDE.md'), '# g');
fs.writeFileSync(path.join(groups, 'main', 'brand.md'), '# b');
const roots = { vault, groups };

describe('control-ui memory', () => {
  it('lists .md files under both roots, skipping dot-dirs, node_modules, non-md and symlinks', () => {
    const tree = memoryTree(roots);
    const paths = tree.map((e) => `${e.root}:${e.path}`);
    expect(paths).toEqual([
      'groups:main/CLAUDE.md',
      'groups:main/brand.md',
      'vault:Atoms/x.md',
      'vault:CLAUDE.md',
      'vault:Persona/p.md',
      'vault:memory/a.md',
    ]);
    expect(
      tree.find((e) => e.path === 'CLAUDE.md' && e.root === 'vault')!.writable,
    ).toBe(false);
    expect(tree.find((e) => e.path === 'memory/a.md')!.writable).toBe(true);
    expect(tree.find((e) => e.path === 'main/CLAUDE.md')!.writable).toBe(false);
    expect(
      memoryTree({ vault: null, groups }).every((e) => e.root === 'groups'),
    ).toBe(true);
  });

  it('confines reads to the roots', () => {
    expect(readMemoryFile(roots, 'vault', 'memory/a.md')).toMatchObject({
      content: '# a',
      bytes: 3,
    });
    expect(resolveMemoryFile(roots, 'vault', '../outside.md')).toBeNull();
    expect(
      resolveMemoryFile(roots, 'vault', path.join(base, 'outside.md')),
    ).toBeNull();
    expect(resolveMemoryFile(roots, 'vault', 'memory/link.md')).toBeNull();
    expect(resolveMemoryFile(roots, 'vault', 'memory/linkdir/e.md')).toBeNull();
    expect(resolveMemoryFile(roots, 'vault', 'memory/notes.txt')).toBeNull();
    expect(resolveMemoryFile(roots, 'vault', 'memory/missing.md')).toBeNull();
    expect(
      resolveMemoryFile({ vault: null, groups }, 'vault', 'memory/a.md'),
    ).toBeNull();
  });

  it('applies the write policy and writes existing files with pruned backups', () => {
    expect(writePolicy('vault', 'CLAUDE.md')).toBe('read_only');
    expect(writePolicy('vault', 'Persona/p.md')).toBe('read_only');
    expect(writePolicy('vault', 'Atoms/x.md')).toBe('read_only');
    expect(writePolicy('vault', 'memory/a.md')).toBe('ok');
    expect(writePolicy('groups', 'main/CLAUDE.md')).toBe('use_groups_route');
    expect(writePolicy('groups', 'main/brand.md')).toBe('ok');
    expect(
      writeMemoryFile(roots, 'vault', 'memory/missing.md', 'x'),
    ).toBeNull();
    const w = writeMemoryFile(roots, 'vault', 'memory/a.md', '# a2');
    expect(w).toMatchObject({
      bytes_before: 3,
      bytes_after: 4,
      index_not_updated: true,
    });
    expect(w?.backup).toMatch(/^a\.md\.bak-\d{14}-[0-9a-f]{4}$/);
    const w2 = writeMemoryFile(roots, 'groups', 'main/brand.md', '# b2');
    expect(w2).toMatchObject({ index_not_updated: false });
    for (let i = 0; i < 12; i++)
      writeMemoryFile(roots, 'vault', 'memory/a.md', `# v${i}`);
    expect(
      fs
        .readdirSync(path.join(vault, 'memory'))
        .filter((f) => f.startsWith('a.md.bak-')),
    ).toHaveLength(10);
    expect(fs.readFileSync(path.join(vault, 'memory', 'a.md'), 'utf-8')).toBe(
      '# v11',
    );
  });
});
