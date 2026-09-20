import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import type { GroupSnapshot } from '../../group-queue.js';
import type { WebTurnDeps } from '../../web-turn.js';
import { isRegisteredFolder, type ControlStore } from '../store.js';

export interface GroupView {
  jid: string;
  name: string;
  folder: string;
  trigger: string;
  requires_trigger: boolean;
  is_control_group: boolean;
  project_id: string | null;
  backend: string | null;
  folder_exists: boolean;
  claude_md_bytes: number;
  container: GroupSnapshot | null;
}

const CLAUDE_MD = 'CLAUDE.md';
const BACKUPS_KEPT = 10;

function folderPath(store: ControlStore, folder: string): string | null {
  try {
    return store.groupFolderPath(folder);
  } catch {
    return null;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export function listGroups(
  store: ControlStore,
  runtime: WebTurnDeps,
): GroupView[] {
  const snapshot = runtime.queue.snapshot();
  return Object.entries(runtime.registeredGroups())
    .map(([jid, g]) => {
      const dir = folderPath(store, g.folder);
      let exists = false;
      if (dir) {
        try {
          exists = fs.statSync(dir).isDirectory();
        } catch {
          exists = false;
        }
      }
      return {
        jid,
        name: g.name,
        folder: g.folder,
        trigger: g.trigger,
        requires_trigger: g.requiresTrigger !== false,
        is_control_group: g.isControlGroup === true,
        project_id: g.projectId ?? null,
        backend: g.containerConfig?.agentBackend ?? null,
        folder_exists: exists,
        claude_md_bytes: dir ? sizeOf(path.join(dir, CLAUDE_MD)) : 0,
        container: snapshot.find((s) => s.jid === jid) ?? null,
      };
    })
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

export function readClaudeMd(
  store: ControlStore,
  runtime: WebTurnDeps,
  folder: string,
): { content: string; bytes: number; mtime: string } | null {
  if (!isRegisteredFolder(runtime, folder)) return null;
  const dir = folderPath(store, folder);
  if (!dir) return null;
  const file = path.join(dir, CLAUDE_MD);
  try {
    const stat = fs.statSync(file);
    return {
      content: fs.readFileSync(file, 'utf-8'),
      bytes: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

export function writeClaudeMd(
  store: ControlStore,
  runtime: WebTurnDeps,
  folder: string,
  content: string,
): { bytes_before: number; bytes_after: number; backup: string | null } | null {
  if (!isRegisteredFolder(runtime, folder)) return null;
  const dir = folderPath(store, folder);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CLAUDE_MD);
  const bytesBefore = sizeOf(file);
  let backup: string | null = null;
  if (fs.existsSync(file)) {
    // Timestamp plus random suffix: two writes within one second keep both backups.
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = `${CLAUDE_MD}.bak-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
    fs.copyFileSync(file, path.join(dir, backup));
  }
  fs.writeFileSync(file, content);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${CLAUDE_MD}.bak-`))
    .sort()
    .reverse();
  for (const old of backups.slice(BACKUPS_KEPT))
    fs.rmSync(path.join(dir, old), { force: true });
  return {
    bytes_before: bytesBefore,
    bytes_after: Buffer.byteLength(content),
    backup,
  };
}
