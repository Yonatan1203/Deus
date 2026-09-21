import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logger.js';
import { redactSecrets } from './logs.js';

export interface EnvLine {
  raw: string;
  key?: string;
  value?: string;
}

export interface ConfigRow {
  key: string;
  value: string;
  source: 'file' | 'process' | 'both';
  editable: boolean;
}

// Absent, not masked. Broad on purpose: a key that merely looks like it could
// hold a credential is left out of the dashboard entirely.
export const SECRET_KEY_RE =
  /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|_URL|_DSN|_WEBHOOK|_SID|_PAT|_PASSPHRASE|_PIN|_COOKIE|_SESSION|_SALT|_HASH|_PRIVATE/i;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const INT_RE = /^\d{1,9}$/;
const int = (min: number, max: number) => (v: string) => {
  if (!INT_RE.test(v)) return null;
  const n = Number(v);
  return n >= min && n <= max ? String(n) : null;
};

/** Editable keys and their validators: return the normalized value or null. */
export const EDITABLE: Record<string, (v: string) => string | null> = {
  LOG_LEVEL: (v) =>
    LOG_LEVELS.includes(v.toLowerCase()) ? v.toLowerCase() : null,
  CONTAINER_TIMEOUT: int(10_000, 3_600_000),
  IDLE_TIMEOUT: int(60_000, 86_400_000),
  MAX_CONCURRENT_CONTAINERS: int(1, 32),
  TIMEZONE: (v) => {
    if (!/^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(v)) return null;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: v });
      return v;
    } catch {
      return null;
    }
  },
  ASSISTANT_NAME: (v) => (/^[\p{L}\p{N} ._-]{1,40}$/u.test(v) ? v : null),
};

// Rejected before any per-key validation: anything that could end the line
// or the value early lands as a second key in the credential store.
const FORBIDDEN_CHARS = /[\n\r\0"'`$]/;
export const BACKUPS_KEPT = 10;
export const TMP_DIR_NAME = '.deus-tmp';

export function parseEnvText(text: string): EnvLine[] {
  return text.split('\n').map((raw) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    if (!m) return { raw };
    let value = m[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    return { raw, key: m[1], value };
  });
}

export function readConfig(deps: {
  envPath: string;
  processEnv: NodeJS.ProcessEnv;
  readOnly?: boolean;
}): {
  keys: ConfigRow[];
  secret_keys_omitted: number;
  env_file_exists: boolean;
} {
  let lines: EnvLine[] = [];
  let exists = false;
  try {
    lines = parseEnvText(fs.readFileSync(deps.envPath, 'utf-8'));
    exists = true;
  } catch {
    /* no .env: process env only */
  }
  const fileVals = new Map<string, string>();
  for (const l of lines)
    if (l.key !== undefined) fileVals.set(l.key, l.value ?? '');
  const keys = new Set<string>([
    ...fileVals.keys(),
    ...Object.keys(deps.processEnv),
  ]);
  let omitted = 0;
  const rows: ConfigRow[] = [];
  for (const key of [...keys].sort()) {
    if (SECRET_KEY_RE.test(key)) {
      // Count only what the dashboard would otherwise have listed: keys in
      // the file. Ambient process variables are never shown either way.
      if (fileVals.has(key)) omitted++;
      continue;
    }
    const editable = key in EDITABLE;
    if (deps.readOnly && !editable) continue;
    const inFile = fileVals.has(key);
    const inProc = deps.processEnv[key] !== undefined;
    if (!inFile && !inProc) continue;
    // A key present in the process but not the file is only shown when it is
    // one of ours (editable): the full process environment is not a config view.
    if (!inFile && !editable) continue;
    const value = inFile ? fileVals.get(key)! : String(deps.processEnv[key]);
    rows.push({
      key,
      value: redactSecrets(value),
      source: inFile && inProc ? 'both' : inFile ? 'file' : 'process',
      editable,
    });
  }
  return { keys: rows, secret_keys_omitted: omitted, env_file_exists: exists };
}

/** Creates the shadowed temp dir; degrades (logs, returns false) — never throws. */
export function ensureControlTmpDir(root: string): boolean {
  const dir = path.join(root, TMP_DIR_NAME);
  try {
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (st) {
      if (st.isDirectory() && !st.isSymbolicLink()) return true;
      throw new Error('path exists and is not a directory');
    }
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (err) {
    logger.error(
      { event: 'control_ui_tmp_dir_unavailable', err: (err as Error).message },
      'Control UI temp dir unavailable; config writes will answer 503',
    );
    return false;
  }
}

function tmpDirReady(root: string): boolean {
  try {
    const st = fs.lstatSync(path.join(root, TMP_DIR_NAME));
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

export type WriteResult =
  | { restart_required: true; backup: string; key: string; value: string }
  | { status: 400 | 404 | 409 | 503; error: string };

let chain: Promise<unknown> = Promise.resolve();
const noop = () => {};

export function writeConfig(
  deps: { envPath: string; backupDir: string; projectRoot: string },
  key: string,
  value: unknown,
): Promise<WriteResult> {
  const run = () => writeConfigNow(deps, key, value);
  const p = chain.then(run, run);
  chain = p.then(noop, noop);
  return p;
}

function writeConfigNow(
  deps: { envPath: string; backupDir: string; projectRoot: string },
  key: string,
  value: unknown,
): WriteResult {
  const validate = EDITABLE[key];
  if (!validate) return { status: 400, error: 'key is not editable' };
  if (typeof value !== 'string')
    return { status: 400, error: 'value must be a string' };
  if (FORBIDDEN_CHARS.test(value))
    return { status: 400, error: 'value contains forbidden characters' };
  const normalized = validate(value.trim());
  if (normalized === null)
    return { status: 400, error: `invalid value for ${key}` };
  if (!tmpDirReady(deps.projectRoot))
    return { status: 503, error: 'temp dir unavailable' };

  let st: fs.Stats;
  try {
    st = fs.lstatSync(deps.envPath);
  } catch {
    return { status: 404, error: 'no .env file' };
  }
  if (st.isSymbolicLink()) return { status: 409, error: '.env is a symlink' };
  const before = { mtimeMs: st.mtimeMs, size: st.size };
  const text = fs.readFileSync(deps.envPath, 'utf-8');
  const lines = parseEnvText(text);
  const idx = lines.map((l) => l.key).lastIndexOf(key);
  const newLine = `${key}=${normalized}`;
  if (idx >= 0) lines[idx] = { raw: newLine, key, value: normalized };
  else {
    if (lines.length && lines[lines.length - 1].raw === '') lines.pop();
    lines.push({ raw: newLine, key, value: normalized }, { raw: '' });
  }
  const next = lines.map((l) => l.raw).join('\n');

  fs.mkdirSync(deps.backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backup = `env.bak-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
  fs.writeFileSync(path.join(deps.backupDir, backup), text, { mode: 0o600 });
  const old = fs
    .readdirSync(deps.backupDir)
    .filter((f) => f.startsWith('env.bak-'))
    .sort()
    .slice(0, -BACKUPS_KEPT);
  for (const f of old) fs.rmSync(path.join(deps.backupDir, f), { force: true });

  const tmp = path.join(
    deps.projectRoot,
    TMP_DIR_NAME,
    `env.${crypto.randomBytes(6).toString('hex')}`,
  );
  // After a successful rename the temp path no longer exists; `force` makes
  // the cleanup a no-op then, and a real unlink on the 409/throw paths.
  try {
    fs.writeFileSync(tmp, next, { mode: 0o600, flag: 'wx' });
    const again = fs.lstatSync(deps.envPath);
    if (again.mtimeMs !== before.mtimeMs || again.size !== before.size)
      return { status: 409, error: '.env changed during the write' };
    fs.renameSync(tmp, deps.envPath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { restart_required: true, backup, key, value: normalized };
}
