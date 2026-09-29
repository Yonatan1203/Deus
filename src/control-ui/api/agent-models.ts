import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { listAgents } from './agents.js';

// Changing an agent's model from the dashboard: the one `model:` line of its
// file in the live checkout is rewritten and committed on the checked-out
// branch, so every session and worktree gets it through git (operator's
// choice, 2026-09-29). The commit skips hooks: the message is built here and
// the change is mechanically held to one line of one agent file.

export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export type AgentModel = (typeof MODELS)[number];

/** Review agents that gate commits; Haiku is too small for them. */
export const GATING_AGENTS = new Set([
  'plan-reviewer',
  'code-reviewer',
  'threat-modeler',
  'verification-gate',
  'ai-eng-warden',
]);

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[\w.-]+\.md$/;
const MODEL_LINE_RE = /^model:[ \t]*\S+[ \t]*$/;

export function isModel(v: unknown): v is AgentModel {
  return typeof v === 'string' && (MODELS as readonly string[]).includes(v);
}

/** Why `name` may not run on `model`, or null when it may. */
export function floorError(name: string, model: AgentModel): string | null {
  return model === 'haiku' && GATING_AGENTS.has(name)
    ? `${name} gates commits and needs Sonnet or better`
    : null;
}

/**
 * The file with only the value of its one frontmatter `model:` line replaced,
 * or null when the frontmatter has no such line or more than one.
 */
export function setModelLine(text: string, model: string): string | null {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  const hits: number[] = [];
  for (let i = 1; i < end; i++) if (MODEL_LINE_RE.test(lines[i])) hits.push(i);
  if (hits.length !== 1) return null;
  lines[hits[0]] = `model: ${model}`;
  return lines.join('\n');
}

export function commitMessage(name: string, model: string): string {
  return `chore(agents): ${name} runs on ${model}`;
}

export class AgentModelError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}

export interface ModelChange {
  agent: string;
  from: string;
  to: AgentModel;
  commit: string | null;
}

/** Only what git needs; no GIT_* from the server's own environment. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'PATH' || k === 'HOME' || k === 'LANG' || k.startsWith('LC_'))
      env[k] = v;
  }
  return env;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

function git(
  repoRoot: string,
  args: string[],
  timeout = 10_000,
): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoRoot, ...args],
      { env: gitEnv(), timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          killed: Boolean(e?.killed),
        });
      },
    );
  });
}

const firstLine = (s: string) => s.trim().split('\n')[0] || 'git failed';

async function head(repoRoot: string): Promise<string> {
  const r = await git(repoRoot, ['rev-parse', 'HEAD']);
  if (r.code !== 0)
    throw new AgentModelError(409, 'the checkout has no commit');
  return r.stdout.trim();
}

/** Refuses unless the checkout is on a branch with no merge or rebase under way. */
async function checkRepoState(repoRoot: string): Promise<void> {
  if ((await git(repoRoot, ['symbolic-ref', '-q', 'HEAD'])).code !== 0)
    throw new AgentModelError(409, 'the checkout is not on a branch');
  const gd = await git(repoRoot, ['rev-parse', '--absolute-git-dir']);
  if (gd.code !== 0) throw new AgentModelError(409, 'not a git checkout');
  const gitDir = gd.stdout.trim();
  for (const f of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
  ]) {
    if (fs.existsSync(path.join(gitDir, f)))
      throw new AgentModelError(
        409,
        'the checkout is in the middle of a merge or rebase',
      );
  }
}

/** The agent's file, resolved safely inside the agents folder. */
function agentFile(agentsDir: string, name: string): string {
  const info = listAgents(agentsDir).find((a) => a.name === name);
  if (!info || !FILE_RE.test(info.file))
    throw new AgentModelError(404, 'not found');
  const file = path.join(agentsDir, info.file);
  try {
    const root = fs.realpathSync(agentsDir);
    if (!fs.lstatSync(file).isFile()) throw new Error('not a file');
    if (path.dirname(fs.realpathSync(file)) !== root)
      throw new Error('outside');
  } catch {
    throw new AgentModelError(404, 'not found');
  }
  return file;
}

function writeAtomic(file: string, text: string): void {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.tmp`,
  );
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs changes one at a time. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export function changeAgentModel(
  repoRoot: string,
  name: string,
  model: AgentModel,
): Promise<ModelChange> {
  return serial(() => change(repoRoot, name, model));
}

async function change(
  repoRoot: string,
  name: string,
  model: AgentModel,
): Promise<ModelChange> {
  if (!AGENT_NAME_RE.test(name)) throw new AgentModelError(404, 'not found');
  const floor = floorError(name, model);
  if (floor) throw new AgentModelError(400, floor);
  const agentsDir = path.join(repoRoot, '.claude', 'agents');
  const file = agentFile(agentsDir, name);
  const rel = path.relative(repoRoot, file).split(path.sep).join('/');

  await checkRepoState(repoRoot);
  if ((await git(repoRoot, ['ls-files', '--error-unmatch', '--', rel])).code)
    throw new AgentModelError(409, 'the agent file is not tracked by git');
  if ((await git(repoRoot, ['diff', '--quiet', 'HEAD', '--', rel])).code)
    throw new AgentModelError(
      409,
      'the agent file has uncommitted changes; commit or discard them first',
    );
  const startHead = await head(repoRoot);

  const original = fs.readFileSync(file, 'utf-8');
  const from = /^model:[ \t]*(\S+)/m.exec(
    original.split('\n---')[0] ?? '',
  )?.[1];
  const next = setModelLine(original, model);
  if (next === null || !from)
    throw new AgentModelError(
      409,
      'the agent file does not have exactly one model line',
    );
  if (from === model) return { agent: name, from, to: model, commit: null };

  writeAtomic(file, next);
  // Put the old bytes back only while nothing else has moved: same commit and
  // the file still holds exactly what was written here.
  const putBack = async () => {
    try {
      if (
        (await head(repoRoot)) === startHead &&
        fs.readFileSync(file, 'utf-8') === next
      )
        writeAtomic(file, original);
    } catch {
      /* leave it; `git diff` shows the state */
    }
  };

  const numstat = await git(repoRoot, ['diff', '--numstat', '--', rel]);
  if (numstat.stdout.trim() !== `1\t1\t${rel}`) {
    await putBack();
    throw new AgentModelError(500, 'the change was not exactly one line');
  }
  if ((await head(repoRoot)) !== startHead) {
    await putBack();
    throw new AgentModelError(409, 'the checkout moved; try again');
  }

  const c = await git(
    repoRoot,
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '--only',
      '-m',
      commitMessage(name, model),
      '-m',
      'Changed from Amos Control.',
      '--',
      rel,
    ],
    60_000,
  );
  if (c.code !== 0) {
    await putBack();
    if (/index\.lock/.test(c.stderr))
      throw new AgentModelError(409, 'the checkout is busy; try again');
    throw new AgentModelError(
      500,
      c.killed ? 'git took too long' : firstLine(c.stderr),
    );
  }
  const sha = await head(repoRoot);
  const shown = await git(repoRoot, ['show', '--numstat', '--format=', 'HEAD']);
  if (shown.stdout.trim() !== `1\t1\t${rel}`)
    throw new AgentModelError(
      500,
      `commit ${sha.slice(0, 12)} is not exactly one line of ${rel}`,
    );
  return { agent: name, from, to: model, commit: sha };
}
