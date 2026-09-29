import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  backendWarning,
  codexOnPath,
  listWardens,
  secondOpinionStatus,
  setWardenEnabled,
  setWardenSecondOpinion,
} from './wardens.js';

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
  'ai-eng-warden': { enabled: true, tools: ['Bash'] },
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
      'ai-eng-warden',
      'code-reviewer',
      'plan-reviewer',
      'session-retrospective',
    ]);
    expect(list[2]).toEqual({
      name: 'plan-reviewer',
      enabled: true,
      tools: ['Edit'],
      custom_instructions: null,
      rules_file: 'plan-review-rules.md',
    });
    expect(list[3].rules_file).toBe('retrospective-schema.md');
    expect(list[3].auto_threshold).toBe(20);
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
      'ai-eng-warden',
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
    expect(cr?.second_opinion).toBe(false);
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

  it('adds and removes the GPT second opinion, keeping claude first', () => {
    const dir = fixture();
    const read = () =>
      JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
    expect(setWardenSecondOpinion(dir, 'code-reviewer', true)).toMatchObject({
      second_opinion: true,
      backends: ['claude', 'openai_compat'],
    });
    expect(read()).toEqual({
      'code-reviewer': { backends: ['claude', 'openai_compat'] },
    });
    setWardenSecondOpinion(dir, 'code-reviewer', false);
    expect(read()['code-reviewer'].backends).toEqual(['claude']);
    // Other backends already listed are kept; claude is put back first.
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ 'ai-eng-warden': { backends: ['gpt'] } }),
    );
    setWardenSecondOpinion(dir, 'ai-eng-warden', true);
    expect(read()['ai-eng-warden'].backends).toEqual([
      'claude',
      'gpt',
      'openai_compat',
    ]);
  });

  it('offers the second opinion only on the two diff reviewers', () => {
    const dir = fixture();
    expect(setWardenSecondOpinion(dir, 'plan-reviewer', true)).toBeNull();
    expect(setWardenSecondOpinion(dir, 'nope', true)).toBeNull();
    expect(fs.existsSync(path.join(dir, 'config.json'))).toBe(false);
    const names = listWardens(dir)
      .filter((w) => w.second_opinion !== undefined)
      .map((w) => w.name);
    expect(names).toEqual(['ai-eng-warden', 'code-reviewer']);
  });

  it('reports whether .env is set up, never a value', () => {
    const dir = fixture();
    const env = path.join(dir, '.env');
    const status = (text: string) => {
      fs.writeFileSync(env, text);
      return secondOpinionStatus(env);
    };
    const ok =
      'OPENAI_API_KEY=sk-test-value\n' +
      'WARDEN_OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1/\n' +
      'WARDEN_OPENAI_COMPAT_MODEL="gpt-4.1-nano"\n';
    expect(status(ok)).toEqual({ available: true, model: 'gpt-4.1-nano' });
    expect(JSON.stringify(status(ok))).not.toContain('sk-test');
    expect(status(ok.replace('sk-test-value', '')).available).toBe(false);
    expect(
      status(ok.replace('https://api.openai.com', 'https://openrouter.ai'))
        .available,
    ).toBe(false);
    expect(status('OPENAI_API_KEY=x\n').available).toBe(false);
    expect(secondOpinionStatus(undefined)).toEqual({
      available: false,
      model: null,
    });
    expect(secondOpinionStatus(path.join(dir, 'missing'))).toEqual({
      available: false,
      model: null,
    });
  });

  it('warns when a role also lists gpt and codex is missing', () => {
    const dir = fixture();
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ 'code-reviewer': { backends: ['claude', 'gpt'] } }),
    );
    const info = setWardenSecondOpinion(dir, 'code-reviewer', true);
    expect(info?.backends).toEqual(['claude', 'gpt', 'openai_compat']);
    expect(backendWarning(info!, false)).toMatch(/codex CLI/);
    expect(backendWarning(info!, true)).toBeNull();
    const clean = setWardenSecondOpinion(dir, 'ai-eng-warden', true);
    expect(backendWarning(clean!, false)).toBeNull();
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-bin-'));
    expect(codexOnPath(bin)).toBe(false);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
    expect(codexOnPath(`/nonexistent${path.delimiter}${bin}`)).toBe(true);
  });
});
