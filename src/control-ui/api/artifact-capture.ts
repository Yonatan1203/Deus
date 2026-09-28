import {
  addCapturedArtifact,
  captureSource,
  createRemovedUrls,
  isUnderAny,
  readRegistry,
  type ArtifactSession,
} from './artifacts.js';
import type { ArtifactCall } from './claude-conversation.js';

// The auto-capture: a page a session published (an `Artifact` tool call
// whose result carried the link) is registered with a local copy, so it
// shows beside the conversation without a command from anyone. The
// transcript names the file; the model chose that path, so every check the
// CLI's `add --file` makes is repeated here, plus a refusal for anything a
// container could have written (the mounter's writable roots) and a check
// against the removals log, so an operator's delete holds.

export type CaptureOutcome =
  | { url: string; result: 'added'; id: string }
  | { url: string; result: 'exists'; id: string }
  | { url: string; result: 'skipped'; reason: string; retry: boolean };

export interface CaptureLogger {
  warn: (o: Record<string, unknown>, msg: string) => void;
}

export function createArtifactCapture(
  dir: string,
  opts: {
    hosts: string[];
    /** Container-writable roots, built at capture time. */
    roots: () => string[];
    now?: () => number;
    log?: CaptureLogger;
  },
) {
  const now = opts.now ?? Date.now;
  const removed = createRemovedUrls(dir);
  // URLs whose file failed the checks for good: no retry on every poll.
  // Transient failures (registry busy) are not recorded.
  const failed = new Set<string>();
  // Per session: the transcript version the calls were last taken from.
  const seen = new Map<string, string>();

  function captureOne(
    call: ArtifactCall,
    session: ArtifactSession,
    sid: string | null,
  ): CaptureOutcome {
    const { url } = call;
    if (failed.has(url))
      return { url, result: 'skipped', reason: 'failed before', retry: false };
    if (removed().has(url))
      return {
        url,
        result: 'skipped',
        reason: 'removed by the operator',
        retry: false,
      };
    const src = captureSource(call.file_path);
    if (!src.ok) {
      failed.add(url);
      opts.log?.warn(
        {
          event: 'control_ui_artifact_capture_skip',
          reason: src.reason,
          session: session.id,
        },
        'Control UI did not capture a published page',
      );
      return { url, result: 'skipped', reason: src.reason, retry: false };
    }
    if (isUnderAny(src.source, opts.roots())) {
      failed.add(url);
      opts.log?.warn(
        {
          event: 'control_ui_artifact_capture_skip',
          reason: 'container-writable path',
          session: session.id,
        },
        'Control UI did not capture a page from a container-writable folder',
      );
      return {
        url,
        result: 'skipped',
        reason: 'container-writable path',
        retry: false,
      };
    }
    const r = addCapturedArtifact(
      dir,
      { title: src.title, url, kind: 'app', source: src, session },
      { hosts: opts.hosts, now },
    );
    if (r.status === 201) {
      // warn, like control_ui_artifact_add/_remove: the audit trail survives LOG_LEVEL=warn
      opts.log?.warn(
        {
          event: 'control_ui_artifact_capture',
          id: r.id,
          hostname: hostOf(url),
          source: src.source,
          session: session.id,
          sid,
          evicted: r.evicted.map((e) => e.id),
          ...(r.adopted ? { adopted_from: r.adopted } : {}),
        },
        'Control UI captured a page a session published',
      );
      return { url, result: 'added', id: r.id };
    }
    if (r.status === 200) return { url, result: 'exists', id: r.id };
    if (!r.transient) failed.add(url);
    return { url, result: 'skipped', reason: r.error, retry: r.transient };
  }

  return {
    /**
     * Runs once per transcript version per session (`key`): the same rows
     * are not re-walked on every poll. `readOnly` never writes.
     */
    capture(o: {
      key: string;
      version: string;
      calls: ArtifactCall[];
      session: ArtifactSession;
      readOnly: boolean;
      sid?: string | null;
    }): CaptureOutcome[] {
      if (o.readOnly || !o.calls.length) return [];
      if (seen.get(o.key) === o.version) return [];
      const out: CaptureOutcome[] = [];
      let retry = false;
      for (const call of o.calls) {
        const r = captureOne(call, o.session, o.sid ?? null);
        if (r.result === 'skipped' && r.retry) retry = true;
        out.push(r);
      }
      // A transient failure leaves the version unrecorded, so the next poll tries again.
      if (!retry) seen.set(o.key, o.version);
      if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
      return out;
    },
    /** What the registry holds for each call's URL — the reply's `artifacts`. */
    lookup(
      calls: ArtifactCall[],
    ): { url: string; id: string | null; local: boolean }[] {
      const reg = readRegistry(dir);
      const entries = reg.ok ? reg.registry.artifacts : [];
      return calls.map((c) => {
        const e = entries.find((a) => a.url === c.url);
        return { url: c.url, id: e?.id ?? null, local: Boolean(e?.local) };
      });
    },
  };
}
const SEEN_MAX = 64;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export type ArtifactCapture = ReturnType<typeof createArtifactCapture>;
