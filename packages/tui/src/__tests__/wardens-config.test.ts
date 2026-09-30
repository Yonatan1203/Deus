import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadWardensConfig, setWardenEnabled } from '../wardens-config.js';

// The TUI never seeds config.json from the example (whose code-reviewer
// backends would add a codex gate) and a toggle writes one key (#80).

const EXAMPLE = {
  'plan-reviewer': { enabled: true, tools: ['Edit'] },
  'code-reviewer': {
    enabled: true,
    tools: ['Bash'],
    backends: ['claude', 'gpt'],
  },
};

let dir: string;
const cfg = () => join(dir, 'config.json');
const live = () => JSON.parse(readFileSync(cfg(), 'utf-8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deus-tui-wardens-'));
  writeFileSync(join(dir, 'config.json.example'), JSON.stringify(EXAMPLE));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('loading writes nothing and never shows the example backends', () => {
  const view = loadWardensConfig(dir);
  expect(Object.keys(view).sort()).toEqual(['code-reviewer', 'plan-reviewer']);
  expect(view['code-reviewer']!.backends).toBeUndefined();
  expect(readdirSync(dir)).toEqual(['config.json.example']);
});

test('a toggle writes only that key, and toggling back writes the start value', () => {
  setWardenEnabled('plan-reviewer', false, dir);
  expect(live()).toEqual({ 'plan-reviewer': { enabled: false } });
  expect(readFileSync(cfg(), 'utf-8')).not.toContain('gpt');
  const view = setWardenEnabled('plan-reviewer', true, dir);
  expect(live()).toEqual({ 'plan-reviewer': { enabled: true } });
  expect(view['plan-reviewer']!.enabled).toBe(true);
});

test('other wardens and fields are kept; only config.json and backups remain', () => {
  writeFileSync(
    cfg(),
    JSON.stringify({
      'code-reviewer': { backends: ['claude'], custom_instructions: 'x' },
      'admin-merge-gate': { standing_grant: true },
    }),
  );
  setWardenEnabled('code-reviewer', false, dir);
  expect(live()).toEqual({
    'code-reviewer': {
      backends: ['claude'],
      custom_instructions: 'x',
      enabled: false,
    },
    'admin-merge-gate': { standing_grant: true },
  });
  const files = readdirSync(dir).filter((f) => f !== 'config.json.example');
  expect(
    files
      .filter((f) => f !== 'config.json')
      .every((f) => f.startsWith('config.json.bak-')),
  ).toBe(true);
  expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  expect(loadWardensConfig(dir)['code-reviewer']!.backends).toEqual(['claude']);
});

test('a non-object entry is ignored when shown and replaced when written', () => {
  writeFileSync(cfg(), JSON.stringify({ 'plan-reviewer': 'oops' }));
  expect(loadWardensConfig(dir)['plan-reviewer']!.tools).toEqual(['Edit']);
  setWardenEnabled('plan-reviewer', false, dir);
  expect(live()).toEqual({ 'plan-reviewer': { enabled: false } });
});

test.each([['{nope'], ['[1,2]'], ['null']])(
  'a broken config.json (%s) shows nothing and is never overwritten',
  (text) => {
    writeFileSync(cfg(), text);
    expect(loadWardensConfig(dir)).toEqual({});
    expect(() => setWardenEnabled('plan-reviewer', false, dir)).toThrow(
      /config\.json is not/,
    );
    expect(readFileSync(cfg(), 'utf-8')).toBe(text);
  },
);

test('an unknown warden throws and writes nothing', () => {
  expect(() => setWardenEnabled('nobody', false, dir)).toThrow(
    /Unknown warden/,
  );
  expect(readdirSync(dir)).toEqual(['config.json.example']);
});
