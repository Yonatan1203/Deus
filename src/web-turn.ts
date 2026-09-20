import crypto from 'crypto';

import { RuntimeRegistry } from './agent-runtimes/registry.js';
import {
  RunContext,
  RuntimeEvent,
  RuntimeEventSink,
  defaultSession,
} from './agent-runtimes/types.js';
import { INJECTION_SCANNER_CONFIG } from './config.js';
import { writeGroupsSnapshot, writeTasksSnapshot } from './container-runner.js';
import { getAllTasks } from './db.js';
import { GroupQueue } from './group-queue.js';
import { scanForInjection } from './guardrails/injection-scanner.js';
import { logger } from './logger.js';
import { getAvailableGroups } from './router-state.js';
import { RegisteredGroup } from './types.js';

/**
 * One web-originated agent turn on the control group's jid, shared by the
 * Odysseus /v1 channel and the control UI. Runs on a FRESH, non-persisted
 * session with the conversation history folded into the prompt (LIA-294) and
 * serializes through GroupQueue like a scheduled task. Callers own transport
 * framing; this module owns admission, the event sink, the wind-down and
 * once-only completion.
 */
export const WEB_TURN_ABSOLUTE_MS = 10 * 60_000; // hard total-duration cap (DoS bound)
export const WEB_TURN_CLOSE_DELAY_MS = 10_000; // mirror task-scheduler's prompt wind-down

export interface WebTurnDeps {
  queue: GroupQueue;
  registry: RuntimeRegistry;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface WebTurnOptions {
  prompt: string;
  latest: string;
  stream: boolean;
  source: string;
  remoteAddr: string;
  onEvent: (event: RuntimeEvent) => void;
  onDone: (error?: string) => void;
  /** Runs after admission, before the turn is enqueued — write transport preambles here. */
  onAccepted?: (id: string) => void;
}

export type WebTurnStart =
  | { ok: true; id: string; abort: (opts?: { stop?: boolean }) => void }
  | { ok: false; status: 400 | 429 | 503; error: string };

/** main jid → true while a turn is queued/running (one in-flight per jid). */
const inFlight = new Set<string>();
const turns = new Map<
  string,
  { source: string; abort: (opts?: { stop?: boolean }) => void }
>();

/** @internal exposed for testing only */
export function _resetWebTurnStateForTest(): void {
  inFlight.clear();
  turns.clear();
}

// The id is not a secret (it is the queue's taskId and shows up in snapshots);
// ownership by source is the control that keeps one channel from aborting
// another's turn.
export function abortWebTurn(
  id: string,
  opts: { stop?: boolean; source: string },
): boolean {
  const turn = turns.get(id);
  if (!turn || turn.source !== opts.source) return false;
  turn.abort({ stop: opts.stop });
  return true;
}

export function startWebTurn(
  deps: WebTurnDeps,
  opts: WebTurnOptions,
): WebTurnStart {
  if (!opts.latest.trim()) {
    return { ok: false, status: 400, error: 'no user message in request' };
  }
  // Resolve the control group SERVER-SIDE — no request field influences this.
  const groups = deps.registeredGroups();
  const entry = Object.entries(groups).find(
    ([, g]) => g.isControlGroup === true,
  );
  if (!entry)
    return { ok: false, status: 503, error: 'no control group registered' };
  const [mainJid, mainGroup] = entry;
  // enqueueTask silently drops tasks during shutdown; refuse early so the
  // in-flight marker is never leaked.
  if (deps.queue.isShuttingDown()) {
    return { ok: false, status: 503, error: 'server shutting down' };
  }
  if (inFlight.has(mainJid)) {
    return { ok: false, status: 429, error: 'a turn is already in progress' };
  }
  // Scan only the new user message — replayed history is not fresh input.
  const scan = scanForInjection(opts.latest, INJECTION_SCANNER_CONFIG);
  if (scan.blocked) {
    logger.warn(
      { source: opts.source, remoteAddr: opts.remoteAddr, score: scan.score },
      'Web turn blocked by injection scanner',
    );
    return { ok: false, status: 400, error: 'request blocked' };
  }

  const id = crypto.randomBytes(8).toString('hex');
  // Audit — no raw prompt content.
  logger.info(
    {
      event: `${opts.source}_turn`,
      remoteAddr: opts.remoteAddr,
      turnNonce: id,
      promptLen: opts.prompt.length,
      stream: opts.stream,
    },
    'Web turn accepted',
  );

  inFlight.add(mainJid);
  let done = false;
  let taskActive = false; // true only while OUR task owns the active container
  let slotReleased = false;
  let absTimer: ReturnType<typeof setTimeout> | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  // The in-flight marker is per jid, so it must be released exactly once by the
  // turn that set it — a late release would delete a later turn's marker.
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    inFlight.delete(mainJid);
    turns.delete(id);
  };
  // Only ever close OUR own container: gating on taskActive at fire time keeps
  // a queued/aborted web turn from writing _close to a WhatsApp turn's container.
  const scheduleClose = () => {
    if (closeTimer) return;
    const t = setTimeout(() => {
      closeTimer = null;
      if (taskActive) deps.queue.closeStdin(mainJid);
    }, WEB_TURN_CLOSE_DELAY_MS);
    t.unref();
    closeTimer = t;
  };
  const finish = (error?: string) => {
    if (done) return;
    done = true;
    if (absTimer) {
      clearTimeout(absTimer);
      absTimer = null;
    }
    releaseSlot();
    opts.onDone(error);
  };

  absTimer = setTimeout(() => {
    if (taskActive) scheduleClose();
    finish('turn exceeded maximum duration');
  }, WEB_TURN_ABSOLUTE_MS);
  absTimer.unref();

  const backend = deps.registry.resolve(mainGroup);
  const sessionRef = defaultSession('', backend.name());

  try {
    writeTasksSnapshot(
      mainGroup.folder,
      true,
      getAllTasks().map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );
    writeGroupsSnapshot(
      mainGroup.folder,
      true,
      getAvailableGroups(groups),
      new Set(Object.keys(groups)),
    );
  } catch (err) {
    logger.warn({ err }, 'Web turn snapshot write failed (non-fatal)');
  }

  const runContext: RunContext = {
    prompt: opts.prompt,
    groupFolder: mainGroup.folder,
    chatJid: mainJid,
    isControlGroup: true,
    ...(opts.stream && { stream: true }),
  };

  let completed = false;
  const sink: RuntimeEventSink = (event) => {
    if (event.type === 'session') return; // stateless web turns never persist
    if (event.type === 'turn_complete') {
      deps.queue.notifyIdle(mainJid);
      scheduleClose();
      // Delivered exactly once, even after the transport is gone: callers use
      // it for memory consolidation (LIA-295), which must not depend on the
      // client still being connected.
      if (!completed) {
        completed = true;
        opts.onEvent(event);
      }
      finish();
      return;
    }
    if (event.type === 'error') {
      finish(event.error);
      return;
    }
    if (!done) opts.onEvent(event);
    scheduleClose();
  };

  const abort = (o?: { stop?: boolean }) => {
    if (o?.stop && taskActive) deps.queue.closeStdin(mainJid);
    finish(o?.stop ? 'turn stopped by user' : undefined);
  };
  turns.set(id, { source: opts.source, abort });
  opts.onAccepted?.(id);

  deps.queue.enqueueTask(mainJid, id, async () => {
    taskActive = true;
    try {
      const result = await backend.runTurn(runContext, sessionRef, sink);
      if (result.status === 'error') finish(result.error || 'unknown error');
      finish();
    } catch (err) {
      finish(err instanceof Error ? err.message : String(err));
    } finally {
      taskActive = false;
      finish();
      releaseSlot();
    }
  });

  return { ok: true, id, abort };
}
