import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The script's refusals are what stand between a typo and a silently replaced
// password, so they are tested here. Every case points the script at a temp
// credential file through an explicit, minimal environment: the operator's
// real `~/.config/deus/control-ui.json` is never reachable from these tests.
// The hidden-prompt path itself needs a real terminal and is driven by hand
// through a pty; spawnSync's piped stdio is exactly the non-terminal case.
const CLI = path.join(import.meta.dirname, '..', 'control-ui-credential.mjs');
const KNOWN =
  '{"scrypt":{"salt":"00","hash":"00"},"created_at":"2026-01-01T00:00:00.000Z"}\n';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-cli-'));
  file = path.join(dir, 'control-ui.json');
  fs.writeFileSync(file, KNOWN, { mode: 0o600 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf-8',
    input: 'a-password-someone-piped-in\na-password-someone-piped-in\n',
    env: { PATH: process.env.PATH ?? '', CONTROL_UI_CREDENTIAL_FILE: file },
  });

const untouched = () => {
  expect(fs.readFileSync(file, 'utf-8')).toBe(KNOWN);
  expect(fs.existsSync(`${file}.first-password`)).toBe(false);
};

describe('control-ui-credential.mjs refusals', () => {
  it('refuses --choose without an interactive terminal and changes nothing', () => {
    const r = run(['--choose']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('interactive terminal');
    expect(r.stdout).not.toContain('a-password-someone-piped-in');
    untouched();
  });

  it('refuses a mistyped flag instead of rotating to a random password', () => {
    for (const bad of [
      ['--chose'],
      ['-choose'],
      ['--choose', 'extra'],
      ['--help'],
    ]) {
      const r = run(bad);
      expect(r.status, bad.join(' ')).toBe(2);
      expect(r.stderr).toContain('Nothing was changed');
      untouched();
    }
  });
});
