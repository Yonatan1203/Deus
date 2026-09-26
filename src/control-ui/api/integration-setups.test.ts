import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SETUP_GRACE_MS,
  SETUP_TTL_MS,
  createSetups,
  shadowedBy,
} from './integration-setups.js';

const file = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'setups-')), 's.json');
const rec = (id: string, name = 'add-telegram', started_at = 1000) => ({
  id,
  name,
  started_at,
});

describe('setups file', () => {
  it('adds, lists and prunes by listing, grace and age', () => {
    const s = createSetups(file());
    expect(s.add(rec('aaaaaaaa'))).toBe(true);
    expect(s.add({ ...rec('bbbbbbbb'), name: 'not-add' })).toBe(false);
    s.add(rec('cccccccc', 'add-slack', 100_000));
    s.add(rec('dddddddd', 'add-linear', 5));
    const kept = s.prune({
      listedIds: new Set(['aaaaaaaa']),
      now: 100_000 + SETUP_GRACE_MS - 1,
    });
    expect(kept.map((x) => x.id)).toEqual(['aaaaaaaa', 'cccccccc']);
    expect(
      s.prune({
        listedIds: new Set(['aaaaaaaa']),
        now: 1000 + SETUP_TTL_MS + 1,
      }),
    ).toEqual([]);
  });
});

describe('shadowedBy', () => {
  it('finds a personal skill, a personal command or a plugin skill of the same name', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
    expect(shadowedBy(home, 'add-telegram')).toBeNull();
    fs.mkdirSync(path.join(home, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'commands', 'add-telegram.md'),
      'x',
    );
    expect(shadowedBy(home, 'add-telegram')).toContain('commands');
    const plug = path.join(
      home,
      '.claude',
      'plugins',
      'cache',
      'm',
      'p',
      '1.0',
      'skills',
      'add-slack',
    );
    fs.mkdirSync(plug, { recursive: true });
    fs.writeFileSync(path.join(plug, 'SKILL.md'), 'x');
    expect(shadowedBy(home, 'add-slack')).toBe(plug);
    expect(shadowedBy(home, '../x')).toBeNull();
  });
});
