import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../logger.js';
import {
  ensureControlTmpDir,
  parseEnvText,
  readConfig,
  writeConfig,
} from './config.js';

const SAMPLE = `# comment line
LOG_LEVEL=info
ANTHROPIC_API_KEY="sk-secret"
OPENAI_BASE_URL=http://u:p@host/v1
TIMEZONE='Europe/Rome'

CONTAINER_TIMEOUT=20000
`;

describe('config api', () => {
  let root: string;
  let envPath: string;
  let backupDir: string;
  const deps = () => ({ envPath, backupDir, projectRoot: root });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-cfg-'));
    envPath = path.join(root, '.env');
    backupDir = path.join(root, 'cfg', 'backups');
    fs.writeFileSync(envPath, SAMPLE);
    expect(ensureControlTmpDir(root)).toBe(true);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('parses lines preserving comments and stripping quotes', () => {
    const lines = parseEnvText(SAMPLE);
    expect(lines[0]).toEqual({ raw: '# comment line' });
    expect(lines[2]).toEqual({
      raw: 'ANTHROPIC_API_KEY="sk-secret"',
      key: 'ANTHROPIC_API_KEY',
      value: 'sk-secret',
    });
    expect(lines[4]).toMatchObject({ key: 'TIMEZONE', value: 'Europe/Rome' });
    expect(lines[5]).toEqual({ raw: '' });
  });

  it('omits secret keys, marks sources and editability, redacts values', () => {
    const r = readConfig({
      envPath,
      processEnv: {
        LOG_LEVEL: 'debug',
        SOME_TOKEN: 'ambient',
        HOME: '/h',
        MAX_CONCURRENT_CONTAINERS: '4',
      },
    });
    expect(r.secret_keys_omitted).toBe(2); // file keys only; ambient SOME_TOKEN is not counted
    expect(r.keys.find((k) => k.key === 'ANTHROPIC_API_KEY')).toBeUndefined();
    expect(r.keys.find((k) => k.key === 'HOME')).toBeUndefined(); // process-only, not editable
    expect(r.keys.find((k) => k.key === 'LOG_LEVEL')).toEqual({
      key: 'LOG_LEVEL',
      value: 'info',
      source: 'both',
      editable: true,
    });
    expect(r.keys.find((k) => k.key === 'MAX_CONCURRENT_CONTAINERS')).toEqual({
      key: 'MAX_CONCURRENT_CONTAINERS',
      value: '4',
      source: 'process',
      editable: true,
    });
    expect(r.keys.find((k) => k.key === 'TIMEZONE')).toMatchObject({
      source: 'file',
      editable: true,
    });
    const ro = readConfig({ envPath, processEnv: {}, readOnly: true });
    expect(ro.keys.every((k) => k.editable)).toBe(true);
    fs.writeFileSync(envPath, 'SOME_HOST=http://a:b@c/\n');
    expect(readConfig({ envPath, processEnv: {} }).keys[0].value).toBe(
      'http://[redacted]@c/',
    );
  });

  it('validates per key and rejects injection before validation', async () => {
    const bad = [
      ['LOG_LEVEL', 'verbose'],
      ['TIMEZONE', '../x'],
      ['CONTAINER_TIMEOUT', '20000\nGITHUB_WEBHOOK_SECRET=x'],
      ['ASSISTANT_NAME', 'a$(b)'],
      ['ASSISTANT_NAME', 'x"y'],
      ['CONTAINER_TIMEOUT', '5'],
      ['ANTHROPIC_API_KEY', 'z'],
      ['MAX_CONCURRENT_CONTAINERS', '0'],
    ];
    for (const [k, v] of bad)
      expect(await writeConfig(deps(), k, v)).toMatchObject({ status: 400 });
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(SAMPLE);
    // The character guard answers before the per-key validator: the message
    // proves the ordering, not just the status.
    expect(
      await writeConfig(deps(), 'CONTAINER_TIMEOUT', '20000\nX=1'),
    ).toEqual({
      status: 400,
      error: 'value contains forbidden characters',
    });
    expect(await writeConfig(deps(), 'CONTAINER_TIMEOUT', 'abc')).toEqual({
      status: 400,
      error: 'invalid value for CONTAINER_TIMEOUT',
    });
    expect(await writeConfig(deps(), 'LOG_LEVEL', 42)).toMatchObject({
      status: 400,
    });
  });

  it('rewrites in place with a normalized value, keeps other lines byte-identical, backs up outside the root', async () => {
    const r = await writeConfig(deps(), 'CONTAINER_TIMEOUT', ' 30000 ');
    expect(r).toMatchObject({
      restart_required: true,
      key: 'CONTAINER_TIMEOUT',
      value: '30000',
    });
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(
      SAMPLE.replace('CONTAINER_TIMEOUT=20000', 'CONTAINER_TIMEOUT=30000'),
    );
    const appended = await writeConfig(deps(), 'IDLE_TIMEOUT', '120000');
    expect(appended).toMatchObject({ restart_required: true });
    expect(
      fs
        .readFileSync(envPath, 'utf-8')
        .endsWith('CONTAINER_TIMEOUT=30000\nIDLE_TIMEOUT=120000\n'),
    ).toBe(true);
    const backups = fs.readdirSync(backupDir);
    expect(backups).toHaveLength(2);
    expect(fs.statSync(path.join(backupDir, backups[0])).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.readdirSync(root).filter((f) => f.startsWith('.env'))).toEqual([
      '.env',
    ]);
    expect(fs.readdirSync(path.join(root, '.deus-tmp'))).toEqual([]);
    for (let i = 0; i < 12; i++)
      await writeConfig(deps(), 'LOG_LEVEL', i % 2 ? 'info' : 'warn');
    expect(fs.readdirSync(backupDir)).toHaveLength(10);
  });

  it('refuses symlinks, drift, missing file and missing/symlinked temp dir; serializes; never dangles', async () => {
    fs.renameSync(envPath, path.join(root, 'real.env'));
    fs.symlinkSync(path.join(root, 'real.env'), envPath);
    expect(await writeConfig(deps(), 'LOG_LEVEL', 'info')).toMatchObject({
      status: 409,
    });
    fs.unlinkSync(envPath);
    expect(await writeConfig(deps(), 'LOG_LEVEL', 'info')).toMatchObject({
      status: 404,
    });
    fs.renameSync(path.join(root, 'real.env'), envPath);
    const [a, b] = await Promise.all([
      writeConfig(deps(), 'LOG_LEVEL', 'warn'),
      writeConfig(deps(), 'IDLE_TIMEOUT', '90000'),
    ]);
    expect(a).toMatchObject({ restart_required: true });
    expect(b).toMatchObject({ restart_required: true });
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('LOG_LEVEL=warn');
    expect(fs.readFileSync(envPath, 'utf-8')).toContain('IDLE_TIMEOUT=90000');
    const spy = vi.fn();
    process.on('unhandledRejection', spy);
    void writeConfig(deps(), 'LOG_LEVEL', 'nope'); // 400 path, no follow-up
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', spy);
    expect(spy).not.toHaveBeenCalled();
    fs.rmSync(path.join(root, '.deus-tmp'), { recursive: true });
    expect(await writeConfig(deps(), 'LOG_LEVEL', 'info')).toMatchObject({
      status: 503,
    });
    expect(fs.existsSync(path.join(root, '.deus-tmp'))).toBe(false);
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, '.deus-tmp'));
    expect(await writeConfig(deps(), 'LOG_LEVEL', 'info')).toMatchObject({
      status: 503,
    });
  });

  it('ensureControlTmpDir: 0700, idempotent, degrades on a file in the way', () => {
    const dir = path.join(root, '.deus-tmp');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(ensureControlTmpDir(root)).toBe(true);
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, 'file');
    expect(ensureControlTmpDir(root)).toBe(false);
    expect(logger.error).toHaveBeenCalled();
    expect(ensureControlTmpDir(path.join(root, 'missing-parent'))).toBe(false);
  });
});
