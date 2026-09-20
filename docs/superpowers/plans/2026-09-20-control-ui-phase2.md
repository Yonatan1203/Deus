# Control UI — Phase 2 Implementation Plan (Chat, Sessions, Groups)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chat with the assistant from the dashboard with live text and tool calls and an abort; list and kill sessions; list groups and view/edit each group's `CLAUDE.md`.

**Architecture:** The enqueue-and-stream lifecycle inside `src/odysseus-server.ts:handleChatCompletion` moves into a new `src/web-turn.ts` (`startWebTurn`) that both Odysseus and the control UI call; Odysseus keeps only its OpenAI framing and its test suite must pass unchanged. `GroupQueue` gains a read-only `snapshot()`, `db.ts` gains a session-row reader and a reason on `clearSession`. Three new API modules (`chat`, `sessions`, `groups`) plug into the Phase 1 server through an extended, injectable `ControlDeps`; three new views plus a shared `ui.js` (breaking the Phase 1 `app.js` ↔ views import cycle) render them.

**Tech Stack:** unchanged — Node built-ins, vitest, Playwright for the capture.

**Spec:** `docs/superpowers/specs/2026-09-20-control-ui-design.md` (sections Architecture, Auth, API rows Groups/Sessions/Chat, Live updates, Frontend). Phase 1 plan: `docs/superpowers/plans/2026-09-20-control-ui-phase1.md`.

## Global Constraints

- Everything from the Phase 1 plan's Global Constraints still applies (localhost bind, no deps, no inline script, text-node DOM, generic names, X-Deus-Session on every mutation, Prettier-formatted `.ts`).
- `src/odysseus-server.test.ts` is **not edited** and must stay green — it is the oracle for the refactor.
- Chat runs on the **control group's jid**, on a fresh non-persisted session with the history folded into the prompt, exactly as Odysseus does (`LIA-294`); one in-flight web turn per jid across both channels.
- **Read-only mode bounds the actor, not just host files:** `CONTROL_UI_READONLY=1` refuses chat turns, turn aborts, session kills and `CLAUDE.md` writes (every route with `mutation: true`); the `/me` payload and the UI banner say "read-only: the assistant cannot be driven from this dashboard".
- Kill and CLAUDE.md writes require `X-Confirm`; instruction-file writes keep a collision-proof `.bak-<ts>-<rand>` with the newest 10 retained, and are rate-limited per session (6/min).
- The dashboard may abort only turns it started (`source: 'control-ui'`); Odysseus turns are never abortable from the dashboard.
- Container-authored data (`sessions.metadata_json`) is projected to typed numeric fields before it reaches the browser — never forwarded verbatim.
- Only final assistant text is replayed into later prompts; tool-call arguments and activity lines are never stored in the chat history. The history is cleared on logout and on any 401.
- Screenshots use a generic assistant name (notes assumption 11).
- Rollback: unset `CONTROL_UI_ENABLED`; Odysseus behaviour is unchanged by construction (its tests) — the refactor is the only non-additive change.

## Design (patterns and data structures)

- **Extract-and-delegate refactor** — `startWebTurn(deps, opts)` owns admission (control group, shutdown, per-jid in-flight `Set<string>`, injection scan), snapshots, the `RuntimeEventSink` → `onEvent` mapping, the absolute-duration timer, the `_close` wind-down, and once-only completion. Callers own transport framing. A module-level `Map<id, { abort }>` lets a separate HTTP request abort a running turn.
- **Callback contract instead of a stream object** — `onEvent(event)` / `onDone(error?)` keeps the module free of `http` types and makes the unit test a plain function test with fake deps. `turn_complete` is a *semantic* signal and is delivered even after the transport is gone (so LIA-295 consolidation still happens for a client that disconnected); `output_text`/`activity`/`tool_call` are transport events and stop once the turn is done.
- **Owned aborts** — the module-level `Map<id, { source, abort }>` records who started each turn; `abortWebTurn(id, { source })` refuses a mismatched source. The id is not a secret (it surfaces as `runningTaskId` in the `queue` snapshot); ownership is the control.
- **Per-folder kill** — one container serves a jid regardless of backend (`GroupQueue` has one `GroupState` per jid), so kill is keyed by folder: it stops every active container whose `groupFolder` matches (LIA-211 dispatches can map several jids to one folder) and orphans every backend's row for that folder. The confirmation dialog lists the containers it will stop.
- **Projected metadata** — `SessionRow.metadata` is `{ cost_usd?: number; tokens?: number } | null`, taken from the container-written JSON only when the values are finite numbers.
- **Read-only snapshot** — `GroupQueue.snapshot()` copies scalar fields per jid; never exposes the `ChildProcess`.
- **Injected store seam** — `ControlDeps.store` bundles the four host functions the new routes need (`listSessionRows`, `clearSession`, `stopContainer`, `groupFolderPath`); `ControlDeps.runtime` bundles `queue`/`registry`/`registeredGroups`. Both optional: absent → 503 `runtime unavailable`, present in `index.ts`, faked in `server.test.ts`.
- **Poll-and-diff broadcaster** — the server compares `JSON.stringify(snapshot())` every 2 s and broadcasts a `queue` event only on change (O(groups), no hooks into `GroupQueue`).
- **Shared `ui.js`** — `toast`/`banner`/`confirmTyped` move out of `app.js`; views import `ui.js`, `app.js` imports views and `ui.js`; no cycle.

## File map

| Path | Responsibility |
|------|----------------|
| `src/web-turn.ts` (create) | `startWebTurn`, `abortWebTurn`, `_resetWebTurnStateForTest`, `WebTurnDeps`, `WebTurnOptions` |
| `src/web-turn.test.ts` (create) | admission, event forwarding incl. `tool_call`, once-only completion, abort/stop, injection block |
| `src/odysseus-server.ts` (modify: `handleChatCompletion` body, `_resetServerStateForTest`, imports) | framing only; delegates to `startWebTurn` |
| `src/group-queue.ts` (modify: add `snapshot()` + `GroupSnapshot`) | read-only per-jid state |
| `src/group-queue.test.ts` (modify: one new case) | snapshot shape |
| `src/db.ts` (modify: add `listSessionRows`, `SessionRow`; `clearSession` gains `reason = 'cleared'`) | session rows for the tab; attributed clears |
| `src/db.test.ts` (modify: two new cases) | reader + reason |
| `src/control-ui/api/chat.ts` (create) | turn start → SSE frames; abort |
| `src/control-ui/api/sessions.ts` (create) | rows joined with snapshot; kill |
| `src/control-ui/api/groups.ts` (create) | groups joined with snapshot; CLAUDE.md read/write with backup |
| `src/control-ui/api/{chat,sessions,groups}.test.ts` (create) | unit tests on fakes / temp dirs |
| `src/control-ui/server.ts` (modify) | `ControlDeps.runtime`/`store`, per-route `maxBody`, 6 new routes, queue poller |
| `src/control-ui/server.test.ts` (modify) | new routes incl. streaming, abort, 428/403/413 paths |
| `src/index.ts` (modify) | pass `runtime` + `store` |
| `web/control/ui.js` (create), `app.js` (modify), `views/wardens.js` (modify import), `views/chat.js`, `views/sessions.js`, `views/groups.js` (create), `app.css` (modify), `sw.js` (modify shell list) | UI |
| `scripts/control-ui-screenshot.mjs` (modify: default tabs) | capture all six tabs |
| `docs/control-ui-notes.md`, `docs/control-ui-progress.md`, `docs/control-ui/artifacts/phase2-*.png` | verification record |

Consuming call sites (rule `visual-verification-required`): `views/chat.js`, `views/sessions.js`, `views/groups.js` are mounted by `app.js` `VIEWS`; `ui.js` is imported by `app.js` and every view; served by `static.ts` → `server.ts` → `index.ts`. Confirmed by the capture step.

## API surface verified

- `handleChatCompletion(deps, body, res, remoteAddr)` — `src/odysseus-server.ts:398-687` (end of file); module state `activeSse`, `inFlight`, `limiter`; `_resetServerStateForTest` at `:85`; `OdysseusServerDeps { queue, registry, registeredGroups }` at `:91`; `MAX_CONCURRENT_SSE = 5`, `KEEPALIVE_MS = 20_000`, `ABSOLUTE_TURN_MS = 600_000`, `TASK_CLOSE_DELAY_MS = 10_000` at `:54-57`; `extractPrompt`/`buildConversationPrompt` exported at `:176/:200`; `consolidateWebConversation(body)` — `src/webui-consolidation.ts:71`.
- Test pins (`src/odysseus-server.test.ts`): audit event name `odysseus_turn` with `promptLen` and no prompt text (`:853-866`); `closeStdin` fires ~10 s after `turn_complete` under fake timers and `notifyIdle(MAIN_JID)` is called (`:541-573`); slot released at `turn_complete`, at client abort and at the absolute cap (`:575-728`); "Thinking…" `reasoning_content` frame on streaming only (`:754-777`); `activity` → `reasoning_content` (`:779`); mocks `./config.js` (provides only `ODYSSEUS_HTTP_*`, `INJECTION_SCANNER_CONFIG`, `PROJECT_ROOT`), `./container-runner.js`, `./db.js` (`getAllTasks`), `./router-state.js` (`getAvailableGroups`), `./env.js`, injection scanner, logger — `web-turn.ts` may import only those names from those modules.
- `GroupQueue`: `enqueueTask(jid, id, fn)` `:95`, `closeStdin(jid)` `:188`, `notifyIdle(jid)` `:153`, `isShuttingDown()` `:301`, private `groups: Map<string, GroupState>` `:31` with fields at `:17-28`.
- `RuntimeRegistry.resolve(group, task?)` — `src/agent-runtimes/registry.ts:30`; `defaultSession(id, backend)`; `RunContext.stream?` — `types.ts`.
- `RuntimeEvent` union includes `tool_call { name, arguments }` — `src/agent-runtimes/types.ts:59-67`.
- `clearSession(groupFolder, backend?)` — `src/db.ts:862`; its only callers are `src/message-orchestrator.ts:152,258` (2-arg; the new optional third arg is backward compatible). `src/router-state.ts:111` is an unrelated same-named in-memory method on `RouterState`, not a caller. `sessions` columns `:83-94`. `_initTestDatabase` used by `src/db.test.ts:38`.
- `resolveGroupFolderPath(folder)` — `src/group-folder.ts:31` (validates + confines to `GROUPS_DIR`); `isValidGroupFolder` `:8`.
- `stopContainerSync(name)` — `src/container-runtime.ts:48` (`execFileSync(CONTAINER_RUNTIME_BIN, ['stop','-t','1',name])`, 15 s timeout, no shell).
- `AgentRuntimeId = 'claude' | 'openai' | 'llama-cpp'` — `src/agent-runtimes/types.ts:3`.
- `createRateLimiter(max, windowMs)` — `src/rate-limiter.ts:12` (used per session for the CLAUDE.md PUT).
- `sessions.metadata_json` is written from container IPC (`src/ipc-protocol.ts`), i.e. container-authored — the fifth trust boundary named in the spec.
- `RegisteredGroup { name, folder, trigger, added_at, containerConfig?, requiresTrigger?, isControlGroup?, projectId? }` — `src/types.ts:71`.

## Verification strategy (frozen before implementation)

| Check | Command | Expected |
|-------|---------|----------|
| Odysseus oracle | `npx vitest run src/odysseus-server` | **all cases pass, file untouched** (`git diff --stat -- src/odysseus-server.test.ts` empty) |
| New units | `npx vitest run src/web-turn src/control-ui src/group-queue src/db` | all pass |
| Whole suite / tsc / eslint / prettier | as Phase 1 | green / 0 / 0 / clean |
| Chat stream (integration, fake backend) | `POST /api/v1/chat/turns {"message":"hi"}` with cookie+header | `200 text/event-stream`; frames in order: `turn_started {id}`, `output_text`, `tool_call`, `turn_complete`; stream ends |
| Chat admission | second POST while the first is in flight | `429 {"error":"a turn is already in progress"}` |
| Chat abort | `DELETE /api/v1/chat/turns/<id>` during a turn | `204`; fake `closeStdin` called once; stream ends with `error: turn stopped by user`; an id the dashboard did not start (an Odysseus turn) → `404` |
| Chat in read-only | `POST /api/v1/chat/turns` on the read-only server | `403 {"error":"read-only mode"}` |
| Consolidation survives a client abort | unit: abort a turn, then the backend emits `turn_complete` | `onEvent` still receives `turn_complete`; `output_text` after abort is NOT delivered |
| Sessions | `GET /api/v1/sessions` | rows with `group_folder`, `backend`, `active_container` joined from the snapshot |
| Kill | `POST /api/v1/sessions/main/kill` without `X-Confirm` → `428`; with `X-Confirm: main` → `200 {stopped:['deus-main-1'], errors:[], orphaned:true}`; fake `stopContainer` called with the snapshot's container name; fake `clearSession('main', undefined, 'control-ui kill')`; unregistered folder → `404` |
| Groups | `GET /api/v1/groups` → registered groups with `folder_exists`, `claude_md_bytes`, `container`; `GET /api/v1/groups/main/claude-md` → `{content, bytes}`; unknown folder → `404`; `PUT` without `X-Confirm` → `428`; with → `200`, `.bak-<ts>-<rand>` created on second write, two rapid writes keep two distinct backups, the 12th write leaves 10 backups; 7th PUT within a minute → `429`; read-only → `403`; 1.2 MB body → `413` |
| Sessions metadata | row whose `metadata_json` is `{"cost_usd":0.12,"tokens":345,"evil":"<img>"}` | API returns `metadata: {cost_usd:0.12, tokens:345}` only |
| Live | throwaway server with a fake backend that streams canned events; a browser turn shows text, one tool-call row, a Stop button that works | screenshots `phase2-{chat,sessions,groups}-{mobile,desktop}.png`, record with PASS/FAIL |

Not covered here: a real container turn through the dashboard (Phase 5 deploy check does the real round trip, the same path Odysseus uses today).

Taste-pass: skipped (design given: mimic OpenClaw). Oracle: the refactor's oracle is the existing Odysseus suite (independently authored, pre-existing); no new credential surface → no new oracle-author dispatch.

---

### Task 1: `src/web-turn.ts` + refactor Odysseus onto it

**Files:** create `src/web-turn.ts`, `src/web-turn.test.ts`; modify `src/odysseus-server.ts`.

**Interfaces (Produces):**
- `interface WebTurnDeps { queue: GroupQueue; registry: RuntimeRegistry; registeredGroups: () => Record<string, RegisteredGroup> }`
- `interface WebTurnOptions { prompt: string; latest: string; stream: boolean; source: string; remoteAddr: string; onEvent: (event: RuntimeEvent) => void; onDone: (error?: string) => void }`
- `type WebTurnStart = { ok: true; id: string; abort: (opts?: { stop?: boolean }) => void } | { ok: false; status: 400 | 429 | 503; error: string }`
- `startWebTurn(deps, opts): WebTurnStart`; `abortWebTurn(id: string, opts: { stop?: boolean; source: string }): boolean` (refuses when `source` differs from the turn's); `_resetWebTurnStateForTest(): void`; constants `WEB_TURN_ABSOLUTE_MS = 600_000`, `WEB_TURN_CLOSE_DELAY_MS = 10_000`.
- Audit line: `logger.info({ event: \`${source}_turn\`, remoteAddr, turnNonce, promptLen, stream }, 'Web turn accepted')` — `source: 'odysseus'` keeps the pinned `odysseus_turn` name.

- [ ] **Step 1: failing unit test** `src/web-turn.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({ INJECTION_SCANNER_CONFIG: { enabled: false, threshold: 0.7, logOnly: true } }));
vi.mock('./container-runner.js', () => ({ writeTasksSnapshot: vi.fn(), writeGroupsSnapshot: vi.fn() }));
vi.mock('./db.js', () => ({ getAllTasks: vi.fn(() => []) }));
vi.mock('./router-state.js', () => ({ getAvailableGroups: vi.fn(() => []) }));
const { mockScan, mockLogger } = vi.hoisted(() => ({
  mockScan: vi.fn(() => ({ blocked: false, triggered: false, score: 0, matches: [] as string[] })),
  mockLogger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('./guardrails/injection-scanner.js', () => ({ scanForInjection: () => mockScan() }));
vi.mock('./logger.js', () => ({ logger: mockLogger }));

import { _resetWebTurnStateForTest, abortWebTurn, startWebTurn, type WebTurnDeps } from './web-turn.js';
import type { RuntimeEvent, RuntimeEventSink, RunResult } from './agent-runtimes/types.js';
import type { RegisteredGroup } from './types.js';

const JID = 'main@deus.local';
type Turn = (sink: RuntimeEventSink) => Promise<RunResult>;

function deps(opts: { turn?: Turn; controlGroup?: boolean; shuttingDown?: boolean; closeStdin?: ReturnType<typeof vi.fn>; notifyIdle?: ReturnType<typeof vi.fn> } = {}): WebTurnDeps {
  const turn: Turn = opts.turn ?? (async (sink) => { await sink({ type: 'output_text', text: 'Hello' }); await sink({ type: 'turn_complete' }); return { status: 'success', result: 'Hello' }; });
  const backend = { name: () => 'claude' as const, runTurn: (_c: unknown, _s: unknown, sink: RuntimeEventSink) => turn(sink) };
  const groups: Record<string, RegisteredGroup> = opts.controlGroup === false ? {} : { [JID]: { name: 'Main', folder: 'main', isControlGroup: true } as unknown as RegisteredGroup };
  return {
    queue: { enqueueTask: (_j: string, _i: string, fn: () => Promise<void>) => { void fn(); }, closeStdin: opts.closeStdin ?? vi.fn(), notifyIdle: opts.notifyIdle ?? vi.fn(), isShuttingDown: () => opts.shuttingDown ?? false } as unknown as WebTurnDeps['queue'],
    registry: { resolve: () => backend } as unknown as WebTurnDeps['registry'],
    registeredGroups: () => groups,
  };
}

const base = { prompt: 'hi', latest: 'hi', stream: true, source: 'test', remoteAddr: '127.0.0.1' };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { _resetWebTurnStateForTest(); mockScan.mockClear(); mockLogger.info.mockClear(); });

describe('startWebTurn', () => {
  it('rejects empty, missing control group, shutdown, and injection', () => {
    expect(startWebTurn(deps(), { ...base, latest: '  ', onEvent: vi.fn(), onDone: vi.fn() })).toMatchObject({ ok: false, status: 400 });
    expect(startWebTurn(deps({ controlGroup: false }), { ...base, onEvent: vi.fn(), onDone: vi.fn() })).toMatchObject({ ok: false, status: 503 });
    expect(startWebTurn(deps({ shuttingDown: true }), { ...base, onEvent: vi.fn(), onDone: vi.fn() })).toMatchObject({ ok: false, status: 503 });
    mockScan.mockReturnValueOnce({ blocked: true, triggered: true, score: 1, matches: ['x'] });
    expect(startWebTurn(deps(), { ...base, onEvent: vi.fn(), onDone: vi.fn() })).toMatchObject({ ok: false, status: 400, error: 'request blocked' });
  });

  it('forwards text and tool calls, completes once, notifies idle, frees the slot, logs no prompt', async () => {
    const events: RuntimeEvent[] = [];
    const onDone = vi.fn();
    const notifyIdle = vi.fn();
    const turn: Turn = async (sink) => {
      await sink({ type: 'output_text', text: 'a' });
      await sink({ type: 'tool_call', name: 'Read', arguments: { path: 'x' } });
      await sink({ type: 'turn_complete' });
      await sink({ type: 'turn_complete' });
      return { status: 'success', result: 'a' };
    };
    const started = startWebTurn(deps({ turn, notifyIdle }), { ...base, prompt: 'super-secret', latest: 'super-secret', onEvent: (e) => events.push(e), onDone });
    expect(started.ok).toBe(true);
    expect(startWebTurn(deps(), { ...base, onEvent: vi.fn(), onDone: vi.fn() })).toMatchObject({ ok: false, status: 429 });
    await tick();
    expect(events.map((e) => e.type)).toEqual(['output_text', 'tool_call', 'turn_complete']);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(undefined);
    expect(notifyIdle).toHaveBeenCalledWith(JID);
    expect(startWebTurn(deps(), { ...base, onEvent: vi.fn(), onDone: vi.fn() }).ok).toBe(true);
    const audit = mockLogger.info.mock.calls.find((c) => (c[0] as { event?: string })?.event === 'test_turn');
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit![0])).not.toContain('super-secret');
  });

  it('reports an error event and a failed result exactly once', async () => {
    const onDone = vi.fn();
    const turn: Turn = async (sink) => { await sink({ type: 'error', error: 'boom' }); return { status: 'error', result: null, error: 'boom' }; };
    startWebTurn(deps({ turn }), { ...base, onEvent: vi.fn(), onDone });
    await tick();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('boom');
  });

  it('delivers turn_complete after an abort (consolidation) but no further transport events', async () => {
    let emit!: RuntimeEventSink;
    const gate = new Promise<void>((r) => { (globalThis as { __r?: () => void }).__r = r; });
    const turn: Turn = async (sink) => { emit = sink; await gate; return { status: 'success', result: '' }; };
    const events: string[] = [];
    const started = startWebTurn(deps({ turn }), { ...base, onEvent: (e) => events.push(e.type), onDone: vi.fn() });
    if (!started.ok) throw new Error('expected ok');
    await tick();
    started.abort();
    await emit({ type: 'output_text', text: 'late' });
    await emit({ type: 'turn_complete' });
    expect(events).toEqual(['turn_complete']);
    (globalThis as { __r?: () => void }).__r?.();
  });

  it('refuses to abort a turn started by another source', async () => {
    const started = startWebTurn(deps({ turn: async () => new Promise(() => {}) }), { ...base, source: 'odysseus', onEvent: vi.fn(), onDone: vi.fn() });
    if (!started.ok) throw new Error('expected ok');
    expect(abortWebTurn(started.id, { stop: true, source: 'control-ui' })).toBe(false);
    expect(abortWebTurn(started.id, { stop: true, source: 'odysseus' })).toBe(true);
  });

  it('abort with stop closes the container and finishes with a message; plain abort just finishes', async () => {
    const closeStdin = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const turn: Turn = async () => { await gate; return { status: 'success', result: '' }; };
    const onDone = vi.fn();
    const started = startWebTurn(deps({ turn, closeStdin }), { ...base, onEvent: vi.fn(), onDone });
    if (!started.ok) throw new Error('expected ok');
    await tick();
    expect(abortWebTurn(started.id, { stop: true, source: 'test' })).toBe(true);
    expect(closeStdin).toHaveBeenCalledWith(JID);
    expect(onDone).toHaveBeenCalledWith('turn stopped by user');
    expect(abortWebTurn(started.id, { source: 'test' })).toBe(false);
    release();
    await tick();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: run red** — `npx vitest run src/web-turn` → module not found.

- [ ] **Step 3: write `src/web-turn.ts`**

```ts
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
}

export type WebTurnStart =
  | { ok: true; id: string; abort: (opts?: { stop?: boolean }) => void }
  | { ok: false; status: 400 | 429 | 503; error: string };

/** main jid → true while a turn is queued/running (one in-flight per jid). */
const inFlight = new Set<string>();
const turns = new Map<string, { source: string; abort: (opts?: { stop?: boolean }) => void }>();

/** @internal exposed for testing only */
export function _resetWebTurnStateForTest(): void {
  inFlight.clear();
  turns.clear();
}

// The id is not a secret (it is the queue's taskId and shows up in snapshots);
// ownership by source is the control that keeps one channel from aborting another's turn.
export function abortWebTurn(id: string, opts: { stop?: boolean; source: string }): boolean {
  const turn = turns.get(id);
  if (!turn || turn.source !== opts.source) return false;
  turn.abort({ stop: opts.stop });
  return true;
}

export function startWebTurn(deps: WebTurnDeps, opts: WebTurnOptions): WebTurnStart {
  if (!opts.latest.trim()) {
    return { ok: false, status: 400, error: 'no user message in request' };
  }
  // Resolve the control group SERVER-SIDE — no request field influences this.
  const groups = deps.registeredGroups();
  const entry = Object.entries(groups).find(([, g]) => g.isControlGroup === true);
  if (!entry) return { ok: false, status: 503, error: 'no control group registered' };
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
  // Only ever close OUR own container: gating on taskActive at fire time keeps a
  // queued/aborted web turn from writing _close to a WhatsApp turn's container.
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
    writeGroupsSnapshot(mainGroup.folder, true, getAvailableGroups(groups), new Set(Object.keys(groups)));
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

  const sink: RuntimeEventSink = (event) => {
    if (event.type === 'session') return; // stateless web turns never persist
    if (event.type === 'turn_complete') {
      deps.queue.notifyIdle(mainJid);
      scheduleClose();
      // Delivered even after the transport is gone: callers use it for
      // memory consolidation (LIA-295), which must not depend on the client
      // still being connected.
      opts.onEvent(event);
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

  const abort = (o?: { stop?: boolean }) => {
    if (o?.stop && taskActive) deps.queue.closeStdin(mainJid);
    finish(o?.stop ? 'turn stopped by user' : undefined);
  };
  turns.set(id, { source: opts.source, abort });
  return { ok: true, id, abort };
}
```

- [ ] **Step 4: refactor `src/odysseus-server.ts`** — replace the body of `handleChatCompletion` (`:398-687`) with framing that delegates; remove the now-unused imports (`crypto` stays for `timingSafeEqual`/sentinel; drop `RunContext`, `RuntimeEventSink`, `defaultSession`, `INJECTION_SCANNER_CONFIG`, `writeGroupsSnapshot`, `writeTasksSnapshot`, `getAllTasks`, `scanForInjection`, `getAvailableGroups`); delete the module-level `inFlight`; make `_resetServerStateForTest` call `_resetWebTurnStateForTest()`; delete `ABSOLUTE_TURN_MS`/`TASK_CLOSE_DELAY_MS` (now in web-turn). New body:

```ts
function handleChatCompletion(
  deps: OdysseusServerDeps,
  body: unknown,
  res: ServerResponse,
  remoteAddr: string,
): void {
  const latest = extractPrompt(body);
  if (!latest.trim()) {
    writeJson(res, 400, { error: 'no user message in request' });
    return;
  }
  const prompt = buildConversationPrompt(body);
  const stream = (body as { stream?: unknown })?.stream !== false;
  if (stream && activeSse >= MAX_CONCURRENT_SSE) {
    writeJson(res, 503, { error: 'too many concurrent streams' });
    return;
  }

  let finalized = false;
  let firstTokenSeen = false;
  let sseCounted = false;
  let turnNonce = '';
  const buffered: string[] = [];
  let keepalive: ReturnType<typeof setInterval> | null = null;

  // Transport-only teardown; the turn lifecycle (slot, wind-down) is web-turn's.
  const finalize = (errMsg?: string) => {
    if (finalized) return;
    finalized = true;
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (sseCounted) {
      activeSse = Math.max(0, activeSse - 1);
      sseCounted = false;
    }
    if (!res.writable) return; // server-ended OR client-aborted (destroyed)
    if (stream) {
      if (errMsg) writeSse(res, chunkFrame(turnNonce, { content: `\n[error] ${errMsg}` }, null));
      writeSse(res, chunkFrame(turnNonce, {}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const content = buffered.join('');
      if (!content && errMsg) writeJson(res, 502, { error: errMsg });
      else writeJson(res, 200, completionFrame(turnNonce, content));
    }
  };

  const turn = startWebTurn(deps, {
    prompt,
    latest,
    stream,
    source: 'odysseus',
    remoteAddr,
    onEvent: (event) => {
      if (event.type === 'output_text') {
        firstTokenSeen = true;
        if (stream && res.writable) writeSse(res, chunkFrame(turnNonce, { content: event.text }, null));
        else if (!stream) buffered.push(event.text);
      } else if (event.type === 'activity') {
        // Transient thinking/tool-progress → reasoning_content (Open WebUI renders
        // a collapsible block); streaming-only, never buffered into the answer.
        firstTokenSeen = true;
        if (stream && res.writable) writeSse(res, chunkFrame(turnNonce, { reasoning_content: event.text }, null));
      } else if (event.type === 'turn_complete') {
        // Consolidate into vault memory (LIA-295) — fire-and-forget, touches no
        // `res`, and web-turn delivers this even after a client abort, so the
        // pre-refactor behaviour (consolidate whenever the turn completes) holds.
        consolidateWebConversation(body);
      }
    },
    onDone: (error) => finalize(error),
  });
  if (!turn.ok) {
    writeJson(res, turn.status, { error: turn.error });
    return;
  }
  turnNonce = turn.id;

  // Client abort → stop delivering frames and free the admission slot; the
  // running task still closes its own container on completion.
  res.on('close', () => turn.abort());

  if (stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    writeSse(res, chunkFrame(turnNonce, { role: 'assistant' }, null));
    writeSse(res, chunkFrame(turnNonce, { reasoning_content: 'Thinking…' }, null));
    activeSse++;
    sseCounted = true;
    keepalive = setInterval(() => {
      if (res.writable && !firstTokenSeen) res.write(': ping\n\n');
    }, KEEPALIVE_MS);
    keepalive.unref();
  }
}
```
Behaviour preserved by construction: consolidation runs on every completed turn, including one whose client disconnected, exactly as before; the unit test "delivers turn_complete after an abort" pins it.

- [ ] **Step 5: run the oracle + unit** — `npx vitest run src/odysseus-server src/web-turn` → Odysseus all green untouched; web-turn green. `npx tsc --noEmit` → 0.

- [ ] **Step 6: Commit** — `git add src/web-turn.ts src/web-turn.test.ts src/odysseus-server.ts` then `git commit -m "refactor(odysseus): extract the web turn lifecycle into src/web-turn.ts for reuse"`.

---

### Task 2: `GroupQueue.snapshot()` and `db.listSessionRows` / `clearSession` reason

- [ ] **Step 1: failing tests** — add to `src/group-queue.test.ts` (inside its existing `describe`, using its `queue`):

```ts
  it('snapshot exposes per-jid state without the process handle', () => {
    queue.registerProcess('g@x', { pid: 1 } as never, 'deus-g-1', 'g');
    const snap = queue.snapshot();
    expect(snap).toEqual([
      { jid: 'g@x', active: false, idleWaiting: false, isTaskContainer: false, runningTaskId: null, containerName: 'deus-g-1', groupFolder: 'g', pendingTaskCount: 0, retryCount: 0 },
    ]);
    expect(Object.keys(snap[0])).not.toContain('process');
  });
```
and to `src/db.test.ts` (after `_initTestDatabase()`):
```ts
describe('control-ui session rows', () => {
  it('lists rows newest first with orphan info and honours a clear reason', () => {
    setSession('g1', 'sess-aaaaaaaa');
    setSession('g2', { session_id: 'sess-bbbbbbbb', backend: 'claude', metadata_json: JSON.stringify({ cost_usd: 0.12, tokens: 345, evil: '<img>' }) });
    clearSession('g1', undefined, 'control-ui kill');
    const rows = listSessionRows(10);
    expect(rows.map((r) => r.group_folder)).toEqual(['g2', 'g1']);
    expect(rows[1]).toMatchObject({ backend: 'claude', orphan_reason: 'control-ui kill', session_ref: 'sess-aaa' });
    expect(rows[1].orphaned_at).not.toBeNull();
    expect(rows[0].orphaned_at).toBeNull();
    expect(rows[0].metadata).toEqual({ cost_usd: 0.12, tokens: 345 });
  });
});
```
(Import `listSessionRows`, `setSession` in that file's import block.)

- [ ] **Step 2: run red.**

- [ ] **Step 3: implement.** In `src/group-queue.ts` add after the `GroupState` interface:
```ts
export interface GroupSnapshot {
  jid: string;
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  containerName: string | null;
  groupFolder: string | null;
  pendingTaskCount: number;
  retryCount: number;
}
```
and the method (next to `availableSlots`):
```ts
  /** Read-only copy of per-jid state for dashboards; never exposes the process. */
  snapshot(): GroupSnapshot[] {
    return [...this.groups].map(([jid, s]) => ({
      jid,
      active: s.active,
      idleWaiting: s.idleWaiting,
      isTaskContainer: s.isTaskContainer,
      runningTaskId: s.runningTaskId,
      containerName: s.containerName,
      groupFolder: s.groupFolder,
      pendingTaskCount: s.pendingTasks.length,
      retryCount: s.retryCount,
    }));
  }
```
In `src/db.ts`: change `clearSession(groupFolder, backend?)` to `clearSession(groupFolder: string, backend?: AgentRuntimeId, reason = 'cleared')` and use `reason` in both `.run(...)` calls; add:
```ts
export interface SessionRow {
  id: number;
  group_folder: string;
  backend: string;
  session_ref: string;
  last_used_at: string | null;
  orphaned_at: string | null;
  orphan_reason: string | null;
  last_compacted_at: string | null;
  metadata: { cost_usd?: number; tokens?: number } | null;
}

// metadata_json is written by the container (IPC) — a trust boundary. Only
// finite numbers under known keys cross it; everything else is dropped.
function projectMetadata(raw: string | null): SessionRow['metadata'] {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  const num = (k: string) => (typeof o[k] === 'number' && Number.isFinite(o[k]) ? (o[k] as number) : undefined);
  const out: NonNullable<SessionRow['metadata']> = {};
  const cost = num('cost_usd') ?? num('total_cost_usd');
  const tokens = num('tokens') ?? num('total_tokens');
  if (cost !== undefined) out.cost_usd = cost;
  if (tokens !== undefined) out.tokens = tokens;
  return Object.keys(out).length ? out : null;
}

/** Newest-first session rows for the control UI; the session id is truncated to a reference. */
export function listSessionRows(limit = 200): SessionRow[] {
  const rows = db
    .prepare(
      `SELECT id, group_folder, session_id, backend, metadata_json, last_used_at,
              orphaned_at, orphan_reason, last_compacted_at
       FROM sessions
       ORDER BY COALESCE(last_used_at, '') DESC, id DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ id: number; group_folder: string; session_id: string; backend: string | null; metadata_json: string | null; last_used_at: string | null; orphaned_at: string | null; orphan_reason: string | null; last_compacted_at: string | null }>;
  return rows.map((r) => {
    const metadata = projectMetadata(r.metadata_json);
    return {
      id: r.id,
      group_folder: r.group_folder,
      backend: r.backend ?? 'claude',
      session_ref: r.session_id.slice(0, 8),
      last_used_at: r.last_used_at,
      orphaned_at: r.orphaned_at,
      orphan_reason: r.orphan_reason,
      last_compacted_at: r.last_compacted_at,
      metadata,
    };
  });
}
```

- [ ] **Step 4: green + commit** — `npx vitest run src/group-queue src/db`; `git add src/group-queue.ts src/group-queue.test.ts src/db.ts src/db.test.ts`; `git commit -m "feat(host): add GroupQueue.snapshot and session rows for the control UI"`.

---

### Task 3: API modules `chat`, `sessions`, `groups`

**Interfaces (Produces):**
- `src/control-ui/api/chat.ts`: `startChatTurn(runtime: WebTurnDeps, body: unknown, remoteAddr: string, res: ServerResponse): { id: string; promptHash: string } | { status: 400 | 429 | 503; error: string }` — validates `{ message: string, history?: { role: 'user'|'assistant'|'system', content: string }[] }` (message ≤ 32 KB, history ≤ 200 entries), builds the prompt with `buildConversationPrompt({ messages: [...history, { role: 'user', content: message }] })` and `latest = message`, opens `text/event-stream`, writes `event: turn_started\ndata: {"id":…}`, forwards every `RuntimeEvent` as `event: <type>\ndata: <json>`, keepalive `: ping` every 20 s until the first event, ends the stream on done (writing `event: error` first when an error is given); `res.on('close')` → `turn.abort()`. Returns the JSON error for the `!ok` cases, else `{ id, promptHash }` (`sha256(prompt)` first 12 hex, for the audit line). Transport events (`output_text`/`activity`/`tool_call`) are written only while `res.writable`; `turn_complete` ends the stream if it is still writable. `abortChatTurn(id): boolean` → `abortWebTurn(id, { stop: true, source: 'control-ui' })`.
- `src/control-ui/api/sessions.ts`: `listSessions(store, runtime): SessionView[]` where `SessionView = SessionRow & { active_container: { name: string; jid: string } | null }` (join: snapshot entries with `groupFolder === row.group_folder && active && containerName`); `containersForFolder(runtime, folder): { name: string; jid: string; isTaskContainer: boolean; runningTaskId: string | null }[]` (what the confirmation dialog lists); `killSession(store, runtime, folder): { stopped: string[]; errors: string[]; orphaned: true } | null` — `null` when no registered group has that folder; otherwise for every active container for the folder → `store.stopContainer(name)` (errors collected, not thrown), then `store.clearSession(folder, undefined, 'control-ui kill')` (every backend's row).
- `src/control-ui/api/groups.ts`: `listGroups(store, runtime): GroupView[]` with `GroupView = { jid, name, folder, trigger, requires_trigger, is_control_group, project_id, backend, folder_exists, claude_md_bytes, container: GroupSnapshot | null }`; `readClaudeMd(store, runtime, folder): { content, bytes, mtime } | null` (null when not registered or missing); `writeClaudeMd(store, runtime, folder, content): { bytes_before: number; bytes_after: number; backup: string | null } | null` (null when not registered; backup name `CLAUDE.md.bak-<YYYYMMDDHHmmss>-<4 hex>` when the file existed; after writing, backups beyond the newest 10 are deleted).
- `ControlDeps` additions (in `server.ts`): `runtime?: WebTurnDeps`; `store?: { listSessionRows(limit: number): SessionRow[]; clearSession(folder: string, backend: AgentRuntimeId | undefined, reason: string): void; stopContainer(name: string): void; groupFolderPath(folder: string): string }`.

- [ ] **Step 1: failing tests** — `src/control-ui/api/sessions.test.ts` and `groups.test.ts` on fakes/temp dirs (chat is covered in `server.test.ts` because it needs a response object):

```ts
// sessions.test.ts
import { describe, expect, it, vi } from 'vitest';
import { containersForFolder, killSession, listSessions } from './sessions.js';
const snapshot = () => [{ jid: 'a@x', active: true, idleWaiting: false, isTaskContainer: false, runningTaskId: null, containerName: 'deus-a-1', groupFolder: 'a', pendingTaskCount: 0, retryCount: 0 }];
const runtime = { queue: { snapshot }, registeredGroups: () => ({ 'a@x': { folder: 'a' } }) } as never;
const row = (f: string) => ({ id: 1, group_folder: f, backend: 'claude', session_ref: 'abcd1234', last_used_at: null, orphaned_at: null, orphan_reason: null, last_compacted_at: null, metadata: null });
describe('control-ui sessions', () => {
  it('joins rows with the active container', () => {
    const store = { listSessionRows: () => [row('a'), row('b')], clearSession: vi.fn(), stopContainer: vi.fn(), groupFolderPath: (f: string) => f };
    const out = listSessions(store, runtime);
    expect(out[0].active_container).toEqual({ name: 'deus-a-1', jid: 'a@x' });
    expect(out[1].active_container).toBeNull();
  });
  it('kill stops every container for the folder, collects errors, clears all backends, refuses unknown folders', () => {
    const stop = vi.fn((name: string) => { if (name === 'deus-a-1') throw new Error('gone'); });
    const clear = vi.fn();
    const store = { listSessionRows: () => [], clearSession: clear, stopContainer: stop, groupFolderPath: (f: string) => f };
    const rt = { queue: { snapshot: () => [...snapshot(), { ...snapshot()[0], jid: 'a2@x', containerName: 'deus-a-2' }] }, registeredGroups: () => ({ 'a@x': { folder: 'a' }, 'a2@x': { folder: 'a' } }) } as never;
    expect(containersForFolder(rt, 'a').map((c) => c.name)).toEqual(['deus-a-1', 'deus-a-2']);
    expect(killSession(store, rt, 'a')).toEqual({ stopped: ['deus-a-2'], errors: ['deus-a-1: gone'], orphaned: true });
    expect(clear).toHaveBeenCalledWith('a', undefined, 'control-ui kill');
    expect(killSession(store, rt, 'zzz')).toBeNull();
  });
});
```
```ts
// groups.test.ts
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listGroups, readClaudeMd, writeClaudeMd } from './groups.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-groups-'));
fs.mkdirSync(path.join(root, 'main'));
fs.writeFileSync(path.join(root, 'main', 'CLAUDE.md'), '# hi');
const groups = { 'm@x': { name: 'Main', folder: 'main', trigger: '@d', isControlGroup: true, added_at: '' }, 'g@x': { name: 'Ghost', folder: 'ghost', trigger: '@d', added_at: '' } };
const runtime = { queue: { snapshot: () => [{ jid: 'm@x', active: true, containerName: 'c1', groupFolder: 'main', idleWaiting: false, isTaskContainer: false, runningTaskId: null, pendingTaskCount: 0, retryCount: 0 }] }, registeredGroups: () => groups } as never;
const store = { listSessionRows: () => [], clearSession: () => {}, stopContainer: () => {}, groupFolderPath: (f: string) => { if (!/^[a-z]+$/.test(f)) throw new Error('bad'); return path.join(root, f); } };
describe('control-ui groups', () => {
  it('lists registered groups with folder facts and container state', () => {
    const out = listGroups(store, runtime);
    expect(out.map((g) => [g.folder, g.folder_exists, g.claude_md_bytes, g.container?.containerName ?? null])).toEqual([['ghost', false, 0, null], ['main', true, 4, 'c1']]);
    expect(out[1].is_control_group).toBe(true);
  });
  it('reads and writes CLAUDE.md with a backup, refusing unknown folders', () => {
    expect(readClaudeMd(store, runtime, 'nope')).toBeNull();
    expect(readClaudeMd(store, runtime, 'ghost')).toBeNull();
    expect(readClaudeMd(store, runtime, 'main')).toMatchObject({ content: '# hi', bytes: 4 });
    expect(writeClaudeMd(store, runtime, 'nope', 'x')).toBeNull();
    const w = writeClaudeMd(store, runtime, 'main', '# new');
    expect(w).toMatchObject({ bytes_before: 4, bytes_after: 5 });
    expect(w?.backup).toMatch(/CLAUDE\.md\.bak-\d{14}-[0-9a-f]{4}$/);
    const w2 = writeClaudeMd(store, runtime, 'main', '# newer');
    expect(w2?.backup).not.toBe(w?.backup);
    for (let i = 0; i < 12; i++) writeClaudeMd(store, runtime, 'main', `# v${i}`);
    expect(fs.readdirSync(path.join(root, 'main')).filter((f) => f.startsWith('CLAUDE.md.bak-'))).toHaveLength(10);
    expect(fs.readFileSync(path.join(root, 'main', 'CLAUDE.md'), 'utf-8')).toBe('# new');
    expect(writeClaudeMd(store, runtime, 'ghost', 'x')?.backup).toBeNull();
    expect(fs.existsSync(path.join(root, 'ghost', 'CLAUDE.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: run red.**

- [ ] **Step 3: implement** `sessions.ts`, `groups.ts`, `chat.ts` per the interfaces above. `chat.ts` writes SSE with a local `frame(res, type, data)`; body validation returns `{ status: 400, error }` for a non-string/empty/oversized message or a malformed history entry; everything else is delegated to `startWebTurn`. `groups.ts` sorts by folder; `writeClaudeMd` creates the folder if the group is registered but the folder is missing (`mkdirSync recursive`), backup name `CLAUDE.md.bak-<YYYYMMDDHHmmss>-<4 hex>` (4 random hex so two writes in one second keep two backups), and after each write backups beyond the newest 10 are deleted.

- [ ] **Step 4: green + commit** — `git add src/control-ui/api/chat.ts src/control-ui/api/sessions.ts src/control-ui/api/sessions.test.ts src/control-ui/api/groups.ts src/control-ui/api/groups.test.ts`; `git commit -m "feat(control-ui): add chat, sessions, and groups API modules"`.

---

### Task 4: Server routes, poller, wiring

- [ ] **Step 1: failing integration tests** — extend `src/control-ui/server.test.ts` `boot()` to accept `runtime`/`store` fakes (a fake backend whose `runTurn` emits `output_text`, `tool_call`, `turn_complete`, gated by a promise so abort can be tested; `queue` with `enqueueTask` running immediately, `closeStdin`/`notifyIdle` spies, `snapshot()` returning one active container for folder `main`, `isShuttingDown: () => false`; `registeredGroups` with a control group `main`; `store` with `listSessionRows` returning two rows, `clearSession`/`stopContainer` spies, `groupFolderPath` → a temp dir). Cases:
  - `POST /api/v1/chat/turns` → 200 `text/event-stream`; collected frames contain `event: turn_started`, `event: output_text`, `event: tool_call`, `event: turn_complete`, then the socket ends; a second POST while gated → `429`; `DELETE /api/v1/chat/turns/<id>` → `204` and `closeStdin` called; `DELETE` of an unknown id → `404`; a turn started with `source: 'odysseus'` directly via `startWebTurn` → `DELETE` → `404`; `POST` with `{"message":""}` → `400`; without `runtime` → `503`; read-only server → `403` for both POST and DELETE.
  - `GET /api/v1/sessions` → two rows, `active_container` set on `main`, `containers.main` lists `deus-main-1`; `POST /api/v1/sessions/main/kill` without `X-Confirm` → `428`; with `X-Confirm: main` → `200 {stopped:['deus-main-1'],errors:[],orphaned:true}`; `stopContainer` called with `'deus-main-1'`; `clearSession` called with `('main', undefined, 'control-ui kill')`; `/sessions/nope/kill` → `404`.
  - `GET /api/v1/groups` → one group with `container.containerName === 'deus-main-1'`; `GET /api/v1/groups/main/claude-md` → `{content:'# hi'}`; `/groups/nope/claude-md` → `404`; `PUT` without confirm → `428`; with `X-Confirm: main` → `200 {bytes_before:4,bytes_after:…,backup:null}` then second `PUT` → `backup` set; 7th `PUT` within the window → `429`; `PUT` with 1.2 MB content → `413`; read-only server → `403`.
  - SSE `queue` event: after login + ticket, mutate the fake snapshot and advance the poller (inject `now`/interval via `opts.queuePollMs = 10`) → frame `event: queue` arrives.

- [ ] **Step 2: run red.**

- [ ] **Step 3: implement in `server.ts`** — `ControlDeps` gains `runtime?` and `store?`; `ControlServerOptions` gains `queuePollMs?: number` (default 2000); router `add(..., { maxBody })` (default 256 KB; groups PUT 1.5 MB) and `readJsonBody(req, limit)`; routes:
  - `POST /api/v1/chat/turns` → `startChatTurn(runtime, body, remoteAddr, res)`; **mutation (default)** so read-only mode answers 403 — a turn drives an agent with rw vault/project mounts, a superset of every other write here. Audit `control_ui_chat_turn` `{turnId, promptHash, promptLen, actor}`.
  - `DELETE /api/v1/chat/turns/:id` → `abortChatTurn(id)` → 204, or 404 when unknown or not started by the dashboard; mutation (403 in read-only).
  - `GET /api/v1/sessions` (rows + `containers` per folder for the dialog); `POST /api/v1/sessions/:folder/kill` (folder must be a registered group's folder → else 404; `X-Confirm: <folder>` else 428; audit `control_ui_session_kill` `{folder, stopped, errors, actor}`; broadcast `session`).
  - `GET /api/v1/groups`; `GET /api/v1/groups/:folder/claude-md`; `PUT /api/v1/groups/:folder/claude-md` (`X-Confirm: <folder>` else 428; `content` string ≤ 1 MB else 413; per-session limiter `createRateLimiter(6, 60_000)` keyed by `session.shortId` → 429; audit `control_ui_claude_md_write` `{folder, bytes_before, bytes_after, backup, actor}`; broadcast `group`).
  - Poller: `setInterval` (unref) every `queuePollMs`, `if (runtime)` compare `JSON.stringify(runtime.queue.snapshot())` with the last value → `hub.broadcast('queue', snapshot)`; cleared on `close`.
  - Routes that need `runtime`/`store` answer `503 { error: 'runtime unavailable' }` when absent.
- `src/index.ts`: pass `runtime: { queue, registry, registeredGroups: () => state.registeredGroups }` and `store: { listSessionRows, clearSession, stopContainer: stopContainerSync, groupFolderPath: resolveGroupFolderPath }` (imports from `./db.js`, `./container-runtime.js`, `./group-folder.js`).

- [ ] **Step 4: green** — `npx vitest run src/control-ui src/odysseus-server src/web-turn`, tsc, eslint, prettier. **Commit** — `git add src/control-ui/server.ts src/control-ui/server.test.ts src/index.ts`; `git commit -m "feat(control-ui): add chat, sessions, and groups routes with live queue events"`.

---

### Task 5: Frontend — `ui.js`, Chat, Sessions, Groups

- [ ] **Step 1: `web/control/ui.js`** — move `toast`, `banner`, `confirmTyped` verbatim from `app.js`; `app.js` imports them from `./ui.js`; `views/wardens.js` imports from `../ui.js`.
- [ ] **Step 2: `app.js`** — `VIEWS` order: `chat` ('◉'), `agents`, `wardens`, `mcps`, `sessions` ('▤'), `groups` ('▣'); default view `chat`; SSE event types `['warden', 'session', 'group', 'queue']`; on logout and on any 401 clear `localStorage['deus_ctl_chat']` together with the secret; `api.del(p, extra)`; `api.stream(path, body, onFrame, signal)` — `fetch` POST with `X-Deus-Session`, reads `res.body` with a `TextDecoder`, splits on `\n\n`, parses `event:`/`data:` lines, calls `onFrame(type, data)`; resolves when the stream ends.
- [ ] **Step 3: `views/chat.js`** — state in `localStorage['deus_ctl_chat']` (`[{role, content}]`, capped at 100 entries); layout: scrolling transcript (`.msg.user` / `.msg.assistant` bubbles, `.activity` muted lines, `<details class="tool"><summary>tool: <name></summary><pre>args json</pre></details>` per `tool_call`), composer (`textarea` + Send + Stop + New chat). Send → append user message → `api.stream('/api/v1/chat/turns', { message, history })`; on `turn_started` keep `id`; `output_text` appends to the live assistant bubble (text node); `activity` adds a muted line; `tool_call` adds a details row; `turn_complete` finalizes and stores **only the final assistant text** (never tool arguments or activity lines — they are LLM-authored and must not re-enter a later prompt un-scanned); `error` shows a toast and marks the bubble. Stop → `api.del('/api/v1/chat/turns/' + id)`. 429 → toast "a turn is already in progress"; 403 → "read-only mode" and the composer is disabled when `me.read_only`.
- [ ] **Step 4: `views/sessions.js`** — table: group, backend, ref, last used, state (`active container: <name>` badge / `orphaned: <reason>` / `idle`), metadata (`cost`/`tokens` if present else "n/a"), Kill button (hidden in read-only) → dialog text lists every container that will be stopped (name, task/chat, `runningTaskId`) from `containers[folder]` → `confirmTyped('<folder>', …)` → `POST /api/v1/sessions/<folder>/kill` with `X-Confirm`; refresh on `session`/`queue`/`refresh` bus events.
- [ ] **Step 5: `views/groups.js`** — card per group: name, folder, trigger, backend, badges (control group, container active/idle, `CLAUDE.md` size or "missing"); "Open CLAUDE.md" → editor panel (`textarea` monospace, byte count, Save hidden in read-only) → `confirmTyped(folder, …)` → `PUT` with `X-Confirm`; toast with `backup` name; refresh on `group`/`queue`.
- [ ] **Step 6: `app.css`** — `.tabbar` becomes horizontally scrollable (`overflow-x: auto; grid-auto-columns: minmax(72px, 1fr)`), chat layout (transcript `flex: 1; overflow-y: auto`, composer sticky bottom above the tab bar), `.msg` bubbles, `.tool` details, editor `textarea` (min-height 50vh). `sw.js` shell list adds `/ui.js` and the three views.
- [ ] **Step 7: capture** — a throwaway launcher that passes a **fake runtime** (backend streaming canned `output_text` × 3, one `tool_call`, `turn_complete`; queue with an immediate `enqueueTask`; `snapshot()` with one active container named `deus-main-1`) and a fake `store` over a **hand-written synthetic fixture** (placeholder jids like `main@example.invalid`, folders `main`/`ops`, a placeholder `CLAUDE.md` of a few lines, session rows with placeholder refs) — never a copy of the live `groups/` or DB — with `assistantName: 'Deus'`; before staging, each PNG is opened and checked for real jids, phone numbers, host paths and instruction text; extend `scripts/control-ui-screenshot.mjs` so a `chat` tab types "hello" and clicks Send before capturing (wait for `.msg.assistant`). Six PNGs `phase2-{chat,sessions,groups}-{mobile,desktop}.png`; review with Read; record in notes.
- [ ] **Step 8: Commit** — `git add web/control scripts/control-ui-screenshot.mjs docs/control-ui/artifacts docs/control-ui-notes.md docs/control-ui-progress.md`; `git commit -m "feat(control-ui): add Chat, Sessions, and Groups tabs"`.

Each commit passes the repo gates (code-reviewer + verification-gate SHIP marked from inside the worktree). If the gate hashing makes per-task commits impractical again, fold into one Phase 2 commit and record the deviation, as in Phase 1.

## Self-review

- Spec coverage for Phase 2: Chat with streaming text + tool calls + abort ✓ (Tasks 1, 3, 4, 5); Sessions list + kill ✓ (2, 3, 4, 5); Groups list + CLAUDE.md view/edit with confirmation and backup ✓ (3, 4, 5); `web-turn` refactor with Odysseus unchanged ✓ (1); `queue` SSE events ✓ (4); read-only mode respected for writes ✓ (4).
- Placeholders: none — code is given for the refactor, `web-turn.ts`, the queue/db additions and every test; the three API modules and views are specified by exact interfaces, validation limits, event names and selectors.
- Type consistency: `WebTurnDeps` is what `ControlDeps.runtime` and `OdysseusServerDeps` both satisfy (same three fields); `GroupSnapshot` is used by `sessions.ts`/`groups.ts` and the poller; `SessionRow.session_ref` is what the Sessions view shows; the turn's `abort(opts?)` is wrapped by `abortWebTurn(id, { stop?, source })`, whose mandatory `source` is what the ownership test exercises.
