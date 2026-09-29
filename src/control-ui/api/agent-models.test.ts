import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AgentModelError,
  changeAgentModel,
  commitMessage,
  floorError,
  MODELS,
  setModelLine,
} from './agent-models.js';
import { listAgents } from './agents.js';

const agentText = (name: string, model = 'sonnet', body = '# body\n') =>
  `---\nname: ${name}\ndescription: >\n  Does things.\nmodel: ${model}\ntools:\n  - Read\n---\n${body}`;

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: repo },
  }).trim();
const agentsDir = () => path.join(repo, '.claude', 'agents');
const write = (file: string, text: string) =>
  fs.writeFileSync(path.join(agentsDir(), file), text);
const read = (file: string) =>
  fs.readFileSync(path.join(agentsDir(), file), 'utf-8');

async function refused(p: Promise<unknown>, status: number, re?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AgentModelError);
  expect((err as AgentModelError).status).toBe(status);
  if (re) expect((err as AgentModelError).message).toMatch(re);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-models-'));
  fs.mkdirSync(agentsDir(), { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  // A hook that would fail proves the commit skips hooks.
  fs.mkdirSync(path.join(repo, 'hooks'));
  fs.writeFileSync(
    path.join(repo, 'hooks', 'pre-commit'),
    '#!/bin/sh\nexit 1\n',
    {
      mode: 0o755,
    },
  );
  git('config', 'core.hooksPath', path.join(repo, 'hooks'));
  write(
    'copy-writer.md',
    agentText('copy-writer', 'sonnet', '# body\nmodel: keep-me\n'),
  );
  write('code-reviewer.md', agentText('code-reviewer', 'opus'));
  write('odd-file.md', agentText('renamed-agent'));
  fs.writeFileSync(path.join(repo, 'other.ts'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '--no-verify', '-m', 'init');
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('setModelLine', () => {
  it('replaces only the frontmatter model value', () => {
    const t = agentText('a', 'sonnet', 'model: body\n');
    const out = setModelLine(t, 'haiku');
    expect(out).toBe(t.replace('model: sonnet', 'model: haiku'));
  });
  it('refuses no model line, two model lines, or no frontmatter', () => {
    expect(setModelLine('---\nname: a\n---\n', 'opus')).toBeNull();
    expect(setModelLine('---\nmodel: a\nmodel: b\n---\n', 'opus')).toBeNull();
    expect(setModelLine('model: a\n', 'opus')).toBeNull();
    expect(setModelLine('---\nmodel: a\n', 'opus')).toBeNull();
  });
});

describe('floorError', () => {
  it('keeps gating agents off Haiku only', () => {
    expect(floorError('code-reviewer', 'haiku')).toMatch(/gates commits/);
    expect(floorError('code-reviewer', 'sonnet')).toBeNull();
    expect(floorError('copy-writer', 'haiku')).toBeNull();
  });
});

describe('commitMessage', () => {
  it('passes the repo commitlint for every model and every real agent name', () => {
    const root = path.resolve(__dirname, '../../..');
    const names = listAgents(path.join(root, '.claude', 'agents')).map(
      (a) => a.name,
    );
    expect(names.length).toBeGreaterThan(0);
    const longest = names.reduce((a, b) => (b.length > a.length ? b : a));
    for (const m of MODELS) {
      const msg = `${commitMessage(longest, m)}\n\nChanged from Amos Control.\n`;
      execFileSync(path.join(root, 'node_modules', '.bin', 'commitlint'), [], {
        cwd: root,
        input: msg,
      });
    }
  }, 30_000);
});

describe('changeAgentModel', () => {
  it('commits exactly one line of one file, skipping hooks', async () => {
    const before = git('rev-parse', 'HEAD');
    const r = await changeAgentModel(repo, 'copy-writer', 'haiku');
    expect(r).toMatchObject({
      agent: 'copy-writer',
      from: 'sonnet',
      to: 'haiku',
    });
    expect(r.commit).toBe(git('rev-parse', 'HEAD'));
    expect(git('rev-parse', 'HEAD~1')).toBe(before);
    expect(git('show', '--numstat', '--format=', 'HEAD')).toBe(
      '1\t1\t.claude/agents/copy-writer.md',
    );
    expect(git('log', '-1', '--format=%s%n%b')).toBe(
      'chore(agents): copy-writer runs on haiku\nChanged from Amos Control.',
    );
    expect(read('copy-writer.md')).toContain('model: haiku');
    expect(read('copy-writer.md')).toContain('model: keep-me');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('finds the file by frontmatter name, not file name', async () => {
    await changeAgentModel(repo, 'renamed-agent', 'opus');
    expect(read('odd-file.md')).toContain('model: opus');
    await refused(changeAgentModel(repo, 'odd-file', 'opus'), 404);
  });

  it('does nothing when the model is already set', async () => {
    const before = git('rev-parse', 'HEAD');
    const r = await changeAgentModel(repo, 'copy-writer', 'sonnet');
    expect(r.commit).toBeNull();
    expect(git('rev-parse', 'HEAD')).toBe(before);
  });

  it('leaves other staged work staged and out of the commit', async () => {
    fs.writeFileSync(path.join(repo, 'other.ts'), 'y\n');
    git('add', 'other.ts');
    await changeAgentModel(repo, 'copy-writer', 'opus');
    expect(git('show', '--name-only', '--format=', 'HEAD')).toBe(
      '.claude/agents/copy-writer.md',
    );
    expect(git('diff', '--cached', '--name-only')).toBe('other.ts');
  });

  it('refuses a file with local edits and leaves it untouched', async () => {
    const edited = read('copy-writer.md') + 'more\n';
    write('copy-writer.md', edited);
    await refused(
      changeAgentModel(repo, 'copy-writer', 'opus'),
      409,
      /uncommitted/,
    );
    expect(read('copy-writer.md')).toBe(edited);
  });

  it('refuses a staged edit to the file', async () => {
    write('copy-writer.md', read('copy-writer.md') + 'more\n');
    git('add', '.claude/agents/copy-writer.md');
    await refused(changeAgentModel(repo, 'copy-writer', 'opus'), 409);
  });

  it('refuses a detached HEAD and a merge in progress', async () => {
    git('checkout', '-q', '--detach');
    await refused(changeAgentModel(repo, 'copy-writer', 'opus'), 409, /branch/);
    git('checkout', '-q', 'main');
    fs.writeFileSync(
      path.join(repo, '.git', 'MERGE_HEAD'),
      git('rev-parse', 'HEAD') + '\n',
    );
    await refused(changeAgentModel(repo, 'copy-writer', 'opus'), 409, /merge/);
  });

  it('refuses the floor, unknown agents and odd names', async () => {
    await refused(changeAgentModel(repo, 'code-reviewer', 'haiku'), 400);
    await refused(changeAgentModel(repo, 'nobody', 'opus'), 404);
    await refused(changeAgentModel(repo, '../x', 'opus'), 404);
  });

  it('refuses two model lines without writing', async () => {
    const t = agentText('copy-writer').replace('tools:', 'model: opus\ntools:');
    write('copy-writer.md', t);
    git('commit', '-q', '--no-verify', '-am', 'two');
    await refused(
      changeAgentModel(repo, 'copy-writer', 'haiku'),
      409,
      /exactly one/,
    );
    expect(read('copy-writer.md')).toBe(t);
  });

  it('refuses a symlinked agent file', async () => {
    const outside = path.join(repo, 'outside.md');
    fs.writeFileSync(outside, agentText('linked'));
    fs.symlinkSync(outside, path.join(agentsDir(), 'linked.md'));
    await refused(changeAgentModel(repo, 'linked', 'opus'), 404);
    expect(fs.readFileSync(outside, 'utf-8')).toContain('model: sonnet');
  });

  it('refuses an untracked agent file', async () => {
    write('fresh.md', agentText('fresh'));
    await refused(changeAgentModel(repo, 'fresh', 'opus'), 409, /not tracked/);
    expect(read('fresh.md')).toContain('model: sonnet');
  });

  it('puts the file back when the commit fails', async () => {
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
    const before = read('copy-writer.md');
    await refused(changeAgentModel(repo, 'copy-writer', 'opus'), 409, /busy/);
    expect(read('copy-writer.md')).toBe(before);
    fs.rmSync(path.join(repo, '.git', 'index.lock'));
  });

  it('runs concurrent changes one after another', async () => {
    const [a, b] = await Promise.all([
      changeAgentModel(repo, 'copy-writer', 'opus'),
      changeAgentModel(repo, 'renamed-agent', 'fable'),
    ]);
    expect(a.commit).not.toBeNull();
    expect(b.commit).not.toBeNull();
    expect(git('rev-list', '--count', 'HEAD')).toBe('3');
    expect(git('status', '--porcelain')).toBe('');
  });
});
