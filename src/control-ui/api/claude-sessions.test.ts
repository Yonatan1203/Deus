import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostCli } from './host-cli.js';
import { IS_WINDOWS } from '../../platform.js';
import {
  CLAUDE_NAME_RE,
  createLedger,
  createPins,
  PINS_MAX,
  createWaitingOnReader,
  listClaudeSessions,
  parsePrintedId,
  readLogs,
  readTail,
  resolveClaudeBin,
  spawnEnv,
  startArgv,
  startClaudeSession,
  stopClaudeSession,
  transcriptPath,
  validatePrompt,
} from './claude-sessions.js';

const SID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SID2 = 'b2c3d4e5-0000-4000-8000-000000000002';

const fake = (stdout: string, ok = true): HostCli & { calls: string[][] } => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return ok
      ? { ok: true as const, stdout, stderr: '' }
      : { ok: false as const, error: 'timeout' };
  };
  return { calls, run, cached: (_k, _t, argv) => run(argv) };
};

describe('claude sessions — validation & argv', () => {
  it('name/prompt/id rules and option-injection-proof argv', () => {
    expect(CLAUDE_NAME_RE.test('Posts pipeline')).toBe(true);
    expect(CLAUDE_NAME_RE.test('-dangerously')).toBe(false);
    expect(CLAUDE_NAME_RE.test('a"b')).toBe(false);
    expect(CLAUDE_NAME_RE.test('Compliance & Testing')).toBe(false);
  });

  it('the dashboard checks names with the same rule as the server', () => {
    const view = fs.readFileSync(
      path.join(
        import.meta.dirname,
        '..',
        '..',
        '..',
        'web',
        'control',
        'views',
        'claude.js',
      ),
      'utf-8',
    );
    const m = /const NAME_RE = \/(.+)\/u;/.exec(view);
    expect(m?.[1]).toBe(CLAUDE_NAME_RE.source);
    expect(validatePrompt('hi')).toBe('hi');
    expect(validatePrompt('')).toBeNull();
    expect(validatePrompt('x'.repeat(8193))).toBeNull();
    expect(validatePrompt('a\0b')).toBeNull();
    expect(startArgv('N', '--not-a-flag')).toEqual([
      '--bg',
      '--name=N',
      '--permission-mode=auto',
      '--',
      '--not-a-flag',
    ]);
    expect(
      parsePrintedId('Started a1b2c3d4 (a1b2c3d4-0000-4000-8000-000000000001)'),
    ).toBe('a1b2c3d4');
    expect(parsePrintedId('ids a1b2c3d4 and b2c3d4e5')).toBeNull();
    expect(parsePrintedId('nothing here')).toBeNull();
  });

  it('resolves the binary by walking PATH with the platform delimiter', () => {
    const isFile = (p: string) => p === path.join('/opt/bin', 'claude');
    expect(
      resolveClaudeBin(['/usr/bin', '/opt/bin'].join(path.delimiter), isFile),
    ).toBe(path.join('/opt/bin', 'claude'));
    expect(resolveClaudeBin('/nowhere', isFile)).toBeNull();
  });

  it('spawn env keeps the allowlist and DEUS_/ANTHROPIC_/CLAUDE_ minus secret-looking names', () => {
    const env = spawnEnv({
      PATH: '/b',
      HOME: '/h',
      DEUS_VAULT_PATH: '/v',
      DEUS_API_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'k',
      CLAUDE_CONFIG_DIR: '/c',
      SOME_OTHER: 'no',
      AWS_SECRET: 'no',
    });
    expect(env).toEqual({
      PATH: '/b',
      HOME: '/h',
      DEUS_VAULT_PATH: '/v',
      CLAUDE_CONFIG_DIR: '/c',
    });
  });
});

describe('claude sessions — list, mutations', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-claude-'));
    fs.mkdirSync(path.join(root, 'wt'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('lists only rows under the root (realpath), projects fields, counts drops', async () => {
    const rows = [
      {
        id: 'a1b2c3d4',
        sessionId: SID,
        name: 'Posts',
        kind: 'background',
        state: 'working',
        status: 'busy',
        cwd: root,
        startedAt: 5,
      },
      {
        id: 'b2c3d4e5',
        sessionId: SID2,
        name: 'Images',
        kind: 'background',
        state: 'blocked',
        cwd: path.join(root, 'wt'),
        startedAt: 6,
      },
      {
        id: 'c3d4e5f6',
        sessionId: null,
        name: 'term',
        kind: 'interactive',
        state: 'working',
        cwd: root,
        startedAt: 7,
      },
      {
        id: 'd4e5f6a7',
        sessionId: SID,
        name: 'foreign',
        kind: 'background',
        state: 'working',
        cwd: os.tmpdir(),
        startedAt: 8,
      },
      { id: 'zz', name: 'bad id', cwd: root },
    ];
    const cli = fake(JSON.stringify(rows));
    const r = await listClaudeSessions(cli, root, {
      waitingOn: (sid) => (sid === SID2 ? 'Approve the hero shot?' : null),
    });
    expect(cli.calls[0]).toEqual([
      'agents',
      '--json',
      '--all',
      `--cwd=${root}`,
    ]);
    expect('sessions' in r && r.sessions.map((s) => s.id)).toEqual([
      'a1b2c3d4',
      'b2c3d4e5',
      'c3d4e5f6',
    ]);
    expect('sessions' in r && r.dropped).toBe(2);
    if (!('sessions' in r)) throw new Error('unreachable');
    expect(r.sessions[1]).toMatchObject({
      cwd_rel: 'wt',
      state: 'blocked',
      waiting_on: 'Approve the hero shot?',
      resumable: true,
    });
    expect(r.sessions[2]).toMatchObject({
      kind: 'interactive',
      resumable: false,
      session_id: null,
      cwd_rel: '.',
    });
    expect(await listClaudeSessions(fake('', false), root)).toEqual({
      error: 'timeout',
    });
    expect(await listClaudeSessions(fake('banner\n[]'), root)).toEqual({
      error: 'unexpected session list output',
    });
    expect(await listClaudeSessions(fake('{"a":1}'), root)).toEqual({
      error: 'unexpected session list output',
    });
  });

  it('start/stop/logs go through the runner with fixed argv', async () => {
    const cli = fake('Started e5f6a7b8');
    expect(await startClaudeSession(cli, 'Posts', 'go')).toEqual({
      id: 'e5f6a7b8',
    });
    expect(cli.calls[0]).toEqual([
      '--bg',
      '--name=Posts',
      '--permission-mode=auto',
      '--',
      'go',
    ]);
    expect(await startClaudeSession(cli, '-x', 'go')).toEqual({
      error: 'invalid name',
    });
    expect(await startClaudeSession(cli, 'ok', '')).toEqual({
      error: 'invalid prompt',
    });
    expect(
      await startClaudeSession(fake('no id printed token=abc'), 'ok', 'go'),
    ).toEqual({ unparsed: true, stdout: 'no id printed token=[redacted]' });
    expect(await stopClaudeSession(cli, 'e5f6a7b8')).toEqual({ stopped: true });
    expect(cli.calls.at(-1)).toEqual(['stop', 'e5f6a7b8']);
    expect(await stopClaudeSession(cli, 'nope')).toEqual({
      error: 'invalid id',
    });
    const logs = fake('line\napi_key=abc\n');
    expect(await readLogs(logs, 'e5f6a7b8')).toEqual({
      lines: ['line', 'api_key=[redacted]'],
    });
  });
});

describe('claude sessions — transcripts', () => {
  let projects: string;
  const row = (
    type: string,
    content: unknown,
    extra: Record<string, unknown> = {},
  ) => JSON.stringify({ type, message: { role: type, content }, ...extra });
  beforeEach(() => {
    projects = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-projects-'));
    fs.mkdirSync(path.join(projects, 'dir-one'));
    fs.mkdirSync(path.join(projects, 'dir-two', `${SID}`, 'subagents'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projects, 'dir-two', `${SID}`, 'subagents', 'agent-x.jsonl'),
      row('assistant', [{ type: 'text', text: 'SUBAGENT SECRET' }]),
    );
    fs.writeFileSync(
      path.join(projects, 'dir-two', `${SID}.jsonl`),
      [
        row('user', 'Plain string opening prompt'),
        row('attachment', 'ignored'),
        row('assistant', [
          { type: 'thinking' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'x.md' } },
        ]),
        row('user', [{ type: 'tool_result' }]),
        row('assistant', [{ type: 'text', text: 'side' }], {
          isSidechain: true,
        }),
        row('assistant', [
          { type: 'text', text: 'Approve the hero shot? token=abc' },
        ]),
        'not json at all',
      ].join('\n') + '\n',
    );
  });
  afterEach(() => fs.rmSync(projects, { recursive: true, force: true }));

  it('locates by session id, confines under projects, never opens subagent files', () => {
    expect(transcriptPath(projects, SID)).toBe(
      fs.realpathSync(path.join(projects, 'dir-two', `${SID}.jsonl`)),
    );
    expect(transcriptPath(projects, SID2)).toBeNull();
    expect(transcriptPath(projects, '../x')).toBeNull();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-outside-'));
    fs.writeFileSync(
      path.join(outside, 'x.jsonl'),
      row('assistant', [{ type: 'text', text: 'OUT' }]),
    );
    fs.symlinkSync(
      path.join(outside, 'x.jsonl'),
      path.join(projects, 'dir-one', `${SID2}.jsonl`),
    );
    expect(transcriptPath(projects, SID2)).toBeNull();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('readTail discards the partial first line and skips bad lines; waiting_on is memoized', () => {
    const file = path.join(projects, 'big.jsonl');
    const lines = Array.from({ length: 3000 }, (_, i) =>
      row('assistant', [{ type: 'text', text: `msg ${i} ${'x'.repeat(200)}` }]),
    );
    fs.writeFileSync(file, lines.join('\n') + '\nbroken{\n');
    const tail = readTail(file, 256 * 1024);
    expect(tail.truncated).toBe(true);
    expect(tail.rows.length).toBeGreaterThan(100);
    expect(tail.rows.length).toBeLessThan(3000);
    expect(JSON.stringify(tail.rows[0])).toContain('"type":"assistant"');
    // A non-JSONL first line whose suffix parses: only the partial-line
    // discard keeps it out (the bad-line skip alone would accept the suffix).
    const adv = path.join(projects, 'adv.jsonl');
    fs.writeFileSync(
      adv,
      'Z' +
        row('assistant', [{ type: 'text', text: 'INJECTED' }]) +
        '\n' +
        row('assistant', [{ type: 'text', text: 'real' }]) +
        '\n',
    );
    const advTail = readTail(adv, fs.statSync(adv).size - 1);
    expect(JSON.stringify(advTail.rows)).not.toContain('INJECTED');
    expect(advTail.rows).toHaveLength(1);
    const waiting = createWaitingOnReader(projects);
    expect(waiting(SID)).toBe('Approve the hero shot? token=[redacted]');
    let opens = 0;
    const orig = fs.openSync;
    (fs as unknown as { openSync: typeof fs.openSync }).openSync = ((
      ...a: Parameters<typeof fs.openSync>
    ) => {
      opens++;
      return orig(...a);
    }) as typeof fs.openSync;
    try {
      waiting(SID);
      expect(opens).toBe(0);
      fs.appendFileSync(
        path.join(projects, 'dir-two', `${SID}.jsonl`),
        row('assistant', [{ type: 'text', text: 'Newer question' }]) + '\n',
      );
      expect(waiting(SID)).toBe('Newer question');
      expect(opens).toBe(1);
    } finally {
      (fs as unknown as { openSync: typeof fs.openSync }).openSync = orig;
    }
  });
});

describe('claude sessions — ledger', () => {
  it('adds from confirmed rows, prunes, and fails closed on corruption', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-ledger-'));
    const file = path.join(dir, 'claude-started.json');
    const l = createLedger(file);
    expect(l.read()).toEqual([]);
    expect(l.add({ id: 'a1b2c3d4', started_at: 1 })).toBe(true);
    expect(l.add({ id: 'b2c3d4e5', started_at: 2 })).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    l.prune(new Set(['b2c3d4e5']));
    expect(l.read()).toEqual([{ id: 'b2c3d4e5', started_at: 2 }]);
    fs.writeFileSync(file, '{not json');
    expect(l.read()).toBeNull();
    expect(l.add({ id: 'c3d4e5f6', started_at: 3 })).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('claude sessions — pins', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pins-'));
    file = path.join(dir, 'control-ui', 'claude-pins.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('pins and unpins, writes 0600 atomically, and ignores junk ids', () => {
    const pins = createPins(file);
    expect(pins.read()).toEqual([]); // missing file = no pins
    expect(pins.set('a1b2c3d4', true)).toBe(true);
    expect(pins.set('b2c3d4e5', true)).toBe(true);
    expect(pins.set('a1b2c3d4', true)).toBe(true); // idempotent
    expect(pins.read()).toEqual(['b2c3d4e5', 'a1b2c3d4']);
    expect(pins.set('b2c3d4e5', false)).toBe(true);
    expect(pins.read()).toEqual(['a1b2c3d4']);
    expect(pins.set('not-an-id', true)).toBe(false);
    if (!IS_WINDOWS) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['claude-pins.json']); // no temp left
  });

  it('never overwrites a file it cannot read', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const pins = createPins(file);
    expect(pins.read()).toBeNull();
    expect(pins.set('a1b2c3d4', true)).toBe(false);
    pins.prune(new Set());
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json');
  });

  it('caps at PINS_MAX and prunes ids no longer listed', () => {
    const pins = createPins(file);
    for (let i = 0; i < PINS_MAX; i++)
      expect(pins.set(i.toString(16).padStart(8, '0'), true)).toBe(true);
    expect(pins.set('ffffffff', true)).toBe(false);
    pins.prune(new Set(['00000001', '00000002']));
    expect(pins.read()).toEqual(['00000001', '00000002']);
  });
});
