import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  INJECTION_SCANNER_CONFIG: { enabled: false, threshold: 0.7, logOnly: true },
}));
vi.mock('./container-runner.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));
vi.mock('./db.js', () => ({ getAllTasks: vi.fn(() => []) }));
vi.mock('./router-state.js', () => ({ getAvailableGroups: vi.fn(() => []) }));
const { mockScan, mockLogger } = vi.hoisted(() => ({
  mockScan: vi.fn(() => ({
    blocked: false,
    triggered: false,
    score: 0,
    matches: [] as string[],
  })),
  mockLogger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('./guardrails/injection-scanner.js', () => ({
  scanForInjection: () => mockScan(),
}));
vi.mock('./logger.js', () => ({ logger: mockLogger }));

import {
  _resetWebTurnStateForTest,
  abortWebTurn,
  startWebTurn,
  type WebTurnDeps,
} from './web-turn.js';
import type {
  RuntimeEvent,
  RuntimeEventSink,
  RunResult,
} from './agent-runtimes/types.js';
import type { RegisteredGroup } from './types.js';

const JID = 'main@deus.local';
type Turn = (sink: RuntimeEventSink) => Promise<RunResult>;

function deps(
  opts: {
    turn?: Turn;
    controlGroup?: boolean;
    shuttingDown?: boolean;
    closeStdin?: ReturnType<typeof vi.fn>;
    notifyIdle?: ReturnType<typeof vi.fn>;
  } = {},
): WebTurnDeps {
  const turn: Turn =
    opts.turn ??
    (async (sink) => {
      await sink({ type: 'output_text', text: 'Hello' });
      await sink({ type: 'turn_complete' });
      return { status: 'success', result: 'Hello' };
    });
  const backend = {
    name: () => 'claude' as const,
    runTurn: (_c: unknown, _s: unknown, sink: RuntimeEventSink) => turn(sink),
  };
  const groups: Record<string, RegisteredGroup> =
    opts.controlGroup === false
      ? {}
      : {
          [JID]: {
            name: 'Main',
            folder: 'main',
            isControlGroup: true,
          } as unknown as RegisteredGroup,
        };
  return {
    queue: {
      enqueueTask: (_j: string, _i: string, fn: () => Promise<void>) => {
        void fn();
      },
      closeStdin: opts.closeStdin ?? vi.fn(),
      notifyIdle: opts.notifyIdle ?? vi.fn(),
      isShuttingDown: () => opts.shuttingDown ?? false,
    } as unknown as WebTurnDeps['queue'],
    registry: { resolve: () => backend } as unknown as WebTurnDeps['registry'],
    registeredGroups: () => groups,
  };
}

const base = {
  prompt: 'hi',
  latest: 'hi',
  stream: true,
  source: 'test',
  remoteAddr: '127.0.0.1',
};
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  _resetWebTurnStateForTest();
  mockScan.mockClear();
  mockLogger.info.mockClear();
});

describe('startWebTurn', () => {
  it('rejects empty, missing control group, shutdown, and injection', () => {
    expect(
      startWebTurn(deps(), {
        ...base,
        latest: '  ',
        onEvent: vi.fn(),
        onDone: vi.fn(),
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      startWebTurn(deps({ controlGroup: false }), {
        ...base,
        onEvent: vi.fn(),
        onDone: vi.fn(),
      }),
    ).toMatchObject({ ok: false, status: 503 });
    expect(
      startWebTurn(deps({ shuttingDown: true }), {
        ...base,
        onEvent: vi.fn(),
        onDone: vi.fn(),
      }),
    ).toMatchObject({ ok: false, status: 503 });
    mockScan.mockReturnValueOnce({
      blocked: true,
      triggered: true,
      score: 1,
      matches: ['x'],
    });
    expect(
      startWebTurn(deps(), { ...base, onEvent: vi.fn(), onDone: vi.fn() }),
    ).toMatchObject({
      ok: false,
      status: 400,
      error: 'request blocked',
    });
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
    const started = startWebTurn(deps({ turn, notifyIdle }), {
      ...base,
      prompt: 'super-secret',
      latest: 'super-secret',
      onEvent: (e) => events.push(e),
      onDone,
    });
    expect(started.ok).toBe(true);
    expect(
      startWebTurn(deps(), { ...base, onEvent: vi.fn(), onDone: vi.fn() }),
    ).toMatchObject({
      ok: false,
      status: 429,
    });
    await tick();
    expect(events.map((e) => e.type)).toEqual([
      'output_text',
      'tool_call',
      'turn_complete',
    ]);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(undefined);
    expect(notifyIdle).toHaveBeenCalledWith(JID);
    expect(
      startWebTurn(deps(), { ...base, onEvent: vi.fn(), onDone: vi.fn() }).ok,
    ).toBe(true);
    const audit = mockLogger.info.mock.calls.find(
      (c) => (c[0] as { event?: string })?.event === 'test_turn',
    );
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit![0])).not.toContain('super-secret');
  });

  it('reports an error event and a failed result exactly once', async () => {
    const onDone = vi.fn();
    const turn: Turn = async (sink) => {
      await sink({ type: 'error', error: 'boom' });
      return { status: 'error', result: null, error: 'boom' };
    };
    startWebTurn(deps({ turn }), { ...base, onEvent: vi.fn(), onDone });
    await tick();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('boom');
  });

  it('delivers turn_complete after an abort (consolidation) but no further transport events', async () => {
    let emit!: RuntimeEventSink;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const turn: Turn = async (sink) => {
      emit = sink;
      await gate;
      return { status: 'success', result: '' };
    };
    const events: string[] = [];
    const started = startWebTurn(deps({ turn }), {
      ...base,
      onEvent: (e) => events.push(e.type),
      onDone: vi.fn(),
    });
    if (!started.ok) throw new Error('expected ok');
    await tick();
    started.abort();
    await emit({ type: 'output_text', text: 'late' });
    await emit({ type: 'turn_complete' });
    expect(events).toEqual(['turn_complete']);
    release();
  });

  it('refuses to abort a turn started by another source', async () => {
    const started = startWebTurn(
      deps({ turn: async () => new Promise(() => {}) }),
      {
        ...base,
        source: 'odysseus',
        onEvent: vi.fn(),
        onDone: vi.fn(),
      },
    );
    if (!started.ok) throw new Error('expected ok');
    expect(abortWebTurn(started.id, { stop: true, source: 'control-ui' })).toBe(
      false,
    );
    expect(abortWebTurn(started.id, { stop: true, source: 'odysseus' })).toBe(
      true,
    );
  });

  it('abort with stop closes the container and finishes with a message; plain abort just finishes', async () => {
    const closeStdin = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const turn: Turn = async () => {
      await gate;
      return { status: 'success', result: '' };
    };
    const onDone = vi.fn();
    const started = startWebTurn(deps({ turn, closeStdin }), {
      ...base,
      onEvent: vi.fn(),
      onDone,
    });
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
