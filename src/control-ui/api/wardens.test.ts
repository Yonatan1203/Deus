import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listWardens, setWardenEnabled } from './wardens.js';

const EXAMPLE = {
  'plan-reviewer': {
    enabled: true,
    tools: ['Edit'],
    custom_instructions: null,
  },
  'code-reviewer': {
    enabled: true,
    tools: ['Bash'],
    backends: ['claude', 'gpt'],
    custom_instructions: null,
  },
  'session-retrospective': {
    enabled: false,
    auto_threshold: 20,
    custom_instructions: 'x',
  },
};

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-wardens-'));
  fs.writeFileSync(
    path.join(dir, 'config.json.example'),
    JSON.stringify(EXAMPLE),
  );
  fs.writeFileSync(path.join(dir, 'plan-review-rules.md'), '#');
  fs.writeFileSync(path.join(dir, 'code-review-rules.md'), '#');
  fs.writeFileSync(path.join(dir, 'retrospective-schema.md'), '#');
  return dir;
}

describe('control-ui wardens', () => {
  it('falls back to the example and resolves rules files', () => {
    const list = listWardens(fixture());
    expect(list.map((w) => w.name)).toEqual([
      'code-reviewer',
      'plan-reviewer',
      'session-retrospective',
    ]);
    expect(list[1]).toEqual({
      name: 'plan-reviewer',
      enabled: true,
      tools: ['Edit'],
      custom_instructions: null,
      rules_file: 'plan-review-rules.md',
    });
    expect(list[2].rules_file).toBe('retrospective-schema.md');
    expect(list[2].auto_threshold).toBe(20);
  });

  it('toggles into config.json, backs up on rewrite, rejects unknown names', () => {
    const dir = fixture();
    expect(setWardenEnabled(dir, 'nope', false)).toBeNull();
    expect(setWardenEnabled(dir, 'plan-reviewer', false)?.enabled).toBe(false);
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(true);
    const baks = () =>
      fs.readdirSync(dir).filter((f) => f.startsWith('config.json.bak-'));
    expect(baks()).toHaveLength(0);
    setWardenEnabled(dir, 'plan-reviewer', true);
    expect(baks()).toHaveLength(1);
    const written = JSON.parse(
      fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'),
    );
    expect(written).toEqual({ 'plan-reviewer': { enabled: true } });
  });

  it('never copies the example into config.json, so no gate appears from it', () => {
    const dir = fixture();
    setWardenEnabled(dir, 'session-retrospective', true);
    const text = fs.readFileSync(path.join(dir, 'config.json'), 'utf-8');
    expect(JSON.parse(text)).toEqual({
      'session-retrospective': { enabled: true },
    });
    expect(text).not.toContain('gpt');
    // Every example warden is still listed and can still be toggled.
    expect(listWardens(dir).map((w) => w.name)).toEqual([
      'code-reviewer',
      'plan-reviewer',
      'session-retrospective',
    ]);
    expect(setWardenEnabled(dir, 'code-reviewer', false)?.enabled).toBe(false);
  });

  it("shows only config.json's backends, and keeps other fields on a write", () => {
    const dir = fixture();
    expect(listWardens(dir)[0].backends).toBeUndefined();
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        'code-reviewer': { backends: ['claude'], custom_instructions: 'y' },
        extra: { enabled: true },
      }),
    );
    const cr = listWardens(dir).find((w) => w.name === 'code-reviewer');
    expect(cr?.backends).toEqual(['claude']);
    expect(cr?.tools).toEqual(['Bash']);
    expect(listWardens(dir).map((w) => w.name)).toContain('extra');
    setWardenEnabled(dir, 'code-reviewer', false);
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8')),
    ).toEqual({
      'code-reviewer': {
        backends: ['claude'],
        custom_instructions: 'y',
        enabled: false,
      },
      extra: { enabled: true },
    });
  });
});
