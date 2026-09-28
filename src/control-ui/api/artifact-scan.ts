import fs from 'fs';
import path from 'path';
import { isUnderAny } from './artifacts.js';
import {
  buildConversation,
  TAIL_TRANSCRIPT_BYTES,
  type ArtifactCall,
} from './claude-conversation.js';
import { CLAUDE_SESSION_ID_RE, readTail } from './claude-sessions.js';

// Recent host transcripts, walked for Artifact publishes so a page appears
// in the Artifacts tab without anyone opening its session. Only the operator's
// own Claude Code sessions write under the projects dir (containers keep
// theirs under DATA_DIR/sessions, a container-writable root); everything
// inside a transcript is still untrusted and goes through the capture's checks.
// What the walk trusts is the file name (a session uuid), the folder name and
// file metadata.

export const SCAN_MAX_FILES = 40;
export const SCAN_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const SCAN_BUDGET_BYTES = 64 * 1024 * 1024;
export const SCAN_MEMO_MAX = 200;

export interface ScannedTranscript {
  uuid: string;
  dir: string;
  /** mtime:size — the same form the conversation reader uses. */
  version: string;
  calls: ArtifactCall[];
}

type Reader = (file: string, bytes: number) => Record<string, unknown>[];

export function createArtifactScan(
  projectsDir: string,
  opts: {
    roots: () => string[];
    now?: () => number;
    read?: Reader;
    maxFiles?: number;
    maxAgeMs?: number;
    budgetBytes?: number;
  },
) {
  const now = opts.now ?? Date.now;
  const read: Reader =
    opts.read ?? ((file, bytes) => readTail(file, bytes).rows);
  const maxFiles = opts.maxFiles ?? SCAN_MAX_FILES;
  const maxAge = opts.maxAgeMs ?? SCAN_MAX_AGE_MS;
  const budget = opts.budgetBytes ?? SCAN_BUDGET_BYTES;
  // path → the Artifact calls of that transcript version; nothing else is kept.
  const memo = new Map<string, { version: string; calls: ArtifactCall[] }>();
  const nameRe = new RegExp(
    `^(${CLAUDE_SESSION_ID_RE.source.replace(/^\^|\$$/g, '')})\\.jsonl$`,
  );

  return {
    scan(): ScannedTranscript[] {
      let root: string;
      try {
        root = fs.realpathSync(projectsDir);
      } catch {
        return [];
      }
      // Fail closed if a container could write into (or above) the projects dir.
      const roots = opts.roots();
      if (
        isUnderAny(root, roots) ||
        roots.some((r) => {
          let rr = path.resolve(r);
          try {
            rr = fs.realpathSync(rr);
          } catch {
            /* compared as given */
          }
          return rr === root || rr.startsWith(root + path.sep);
        })
      )
        return [];
      const found: { file: string; uuid: string; dir: string; st: fs.Stats }[] =
        [];
      let dirs: fs.Dirent[];
      try {
        dirs = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }
      const cutoff = now() - maxAge;
      for (const d of dirs) {
        if (!d.isDirectory()) continue; // a symlinked folder is not a directory entry
        let names: fs.Dirent[];
        try {
          names = fs.readdirSync(path.join(root, d.name), {
            withFileTypes: true,
          });
        } catch {
          continue;
        }
        for (const n of names) {
          const m = nameRe.exec(n.name);
          if (!m || !n.isFile()) continue; // symlinks and sub-folders (subagents/) are skipped
          const file = path.join(root, d.name, n.name);
          let st: fs.Stats;
          try {
            st = fs.lstatSync(file);
          } catch {
            continue;
          }
          if (!st.isFile() || st.mtimeMs < cutoff) continue;
          found.push({ file, uuid: m[1], dir: d.name, st });
        }
      }
      found.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
      const out: ScannedTranscript[] = [];
      let spent = 0;
      for (const f of found.slice(0, maxFiles)) {
        const version = `${Math.trunc(f.st.mtimeMs)}:${f.st.size}`;
        const hit = memo.get(f.file);
        let calls: ArtifactCall[];
        if (hit && hit.version === version) calls = hit.calls;
        else {
          const cost = Math.min(f.st.size, TAIL_TRANSCRIPT_BYTES);
          if (spent + cost > budget) continue; // waits for the next call
          let real: string;
          try {
            real = fs.realpathSync(f.file);
          } catch {
            continue;
          }
          if (!real.startsWith(root + path.sep)) continue;
          spent += cost;
          try {
            calls = buildConversation(
              read(real, TAIL_TRANSCRIPT_BYTES),
            ).artifactCalls;
          } catch {
            continue;
          }
          memo.delete(f.file);
          memo.set(f.file, { version, calls });
          if (memo.size > SCAN_MEMO_MAX)
            memo.delete(memo.keys().next().value as string);
        }
        if (calls.length)
          out.push({ uuid: f.uuid, dir: f.dir, version, calls });
      }
      return out;
    },
  };
}

export type ArtifactScan = ReturnType<typeof createArtifactScan>;
