import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export type RootName = 'vault' | 'groups';

export interface MemoryRoots {
  vault: string | null;
  groups: string;
}

export interface MemoryEntry {
  root: RootName;
  path: string;
  bytes: number;
  mtime: string;
  writable: boolean;
}

export type WritePolicy = 'ok' | 'read_only' | 'use_groups_route';

const MAX_DEPTH = 4;
const MAX_ENTRIES = 2000;
const BACKUPS_KEPT = 10;
const SKIP_DIRS = new Set(['node_modules']);

const posix = (rel: string) => rel.split(path.sep).join('/');

// Vault Persona/ and Atoms/ mirror the memory DB and the root CLAUDE.md is the
// assistant's core memory: none is written from a dashboard. A group's
// CLAUDE.md has its own confirmed route.
export function writePolicy(root: RootName, rel: string): WritePolicy {
  const p = posix(rel);
  if (root === 'vault') {
    if (p === 'CLAUDE.md' || p.startsWith('Persona/') || p.startsWith('Atoms/'))
      return 'read_only';
    return 'ok';
  }
  return path.posix.basename(p) === 'CLAUDE.md' ? 'use_groups_route' : 'ok';
}

function rootDirs(roots: MemoryRoots): [RootName, string][] {
  const out: [RootName, string][] = [['groups', roots.groups]];
  if (roots.vault) out.push(['vault', roots.vault]);
  return out;
}

export function memoryTree(roots: MemoryRoots): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const [root, base] of rootDirs(roots)) {
    const stack: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
    while (stack.length && entries.length < MAX_ENTRIES) {
      const { dir, depth } = stack.pop() as { dir: string; depth: number };
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (
          d.name.startsWith('.') ||
          SKIP_DIRS.has(d.name) ||
          d.isSymbolicLink()
        )
          continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!d.isFile() || !d.name.endsWith('.md')) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const rel = posix(path.relative(base, full));
        entries.push({
          root,
          path: rel,
          bytes: stat.size,
          mtime: stat.mtime.toISOString(),
          writable: writePolicy(root, rel) === 'ok',
        });
        if (entries.length >= MAX_ENTRIES) break;
      }
    }
  }
  // Codepoint order (not locale order) so listings are stable across hosts.
  return entries.sort((a, b) =>
    a.root === b.root
      ? a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : 0
      : a.root < b.root
        ? -1
        : 1,
  );
}

/** Absolute, realpath-resolved file inside its root — or null for anything else. */
export function resolveMemoryFile(
  roots: MemoryRoots,
  root: string,
  rel: string,
): string | null {
  const base =
    root === 'vault' ? roots.vault : root === 'groups' ? roots.groups : null;
  if (
    !base ||
    typeof rel !== 'string' ||
    !rel ||
    rel.includes('\0') ||
    path.isAbsolute(rel)
  )
    return null;
  if (!rel.endsWith('.md')) return null;
  let realRoot: string;
  let realFull: string;
  try {
    realRoot = fs.realpathSync(base);
    realFull = fs.realpathSync(path.resolve(base, rel));
  } catch {
    return null;
  }
  if (!realFull.startsWith(realRoot + path.sep)) return null;
  // The listing skips symlinks; a symlinked file resolves elsewhere and is refused too.
  try {
    if (fs.lstatSync(path.resolve(base, rel)).isSymbolicLink()) return null;
    if (!fs.statSync(realFull).isFile()) return null;
  } catch {
    return null;
  }
  const relResolved = path.relative(realRoot, realFull);
  if (relResolved.startsWith('..')) return null;
  return realFull;
}

export function readMemoryFile(
  roots: MemoryRoots,
  root: string,
  rel: string,
): { content: string; bytes: number; mtime: string } | null {
  const file = resolveMemoryFile(roots, root, rel);
  if (!file) return null;
  const stat = fs.statSync(file);
  return {
    content: fs.readFileSync(file, 'utf-8'),
    bytes: stat.size,
    mtime: stat.mtime.toISOString(),
  };
}

export function writeMemoryFile(
  roots: MemoryRoots,
  root: RootName,
  rel: string,
  content: string,
): {
  bytes_before: number;
  bytes_after: number;
  backup: string;
  index_not_updated: boolean;
} | null {
  const file = resolveMemoryFile(roots, root, rel);
  if (!file) return null;
  const dir = path.dirname(file);
  const name = path.basename(file);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `${name}.bak-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
  const bytesBefore = fs.statSync(file).size;
  fs.copyFileSync(file, path.join(dir, backup));
  fs.writeFileSync(file, content);
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.bak-`))
    .sort()
    .reverse()
    .slice(BACKUPS_KEPT);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return {
    bytes_before: bytesBefore,
    bytes_after: Buffer.byteLength(content),
    backup,
    // A file write never rebuilds the semantic index over the vault.
    index_not_updated: root === 'vault',
  };
}
