import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSkillDir, readSlashCommands } from './claude-commands.js';

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmds-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}
const skill = (name: string, desc: string, extra = '') =>
  `---\nname: ${name}\ndescription: ${desc}\n${extra}---\n\n# body\n`;

describe('readSlashCommands', () => {
  it('reads project and personal skills and commands, project first, plus built-ins', () => {
    const repo = tree({
      '.claude/skills/debug/SKILL.md': skill('debug', 'Debug container issues'),
      '.claude/skills/compress/skill.md': skill('compress', 'Project compress'),
      '.claude/commands/checkpoint.md':
        'Save a mid-session checkpoint.\n\nMore.',
    });
    const home = tree({
      '.claude/skills/compress/skill.md': skill(
        'compress',
        'Personal compress',
      ),
      '.claude/commands/preserve.md': skill('preserve', 'Keep a note'),
    });
    const list = readSlashCommands(repo, home, { fresh: true });
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(by.debug).toEqual({
      name: 'debug',
      description: 'Debug container issues',
      source: 'project',
    });
    expect(by.compress.description).toBe('Project compress');
    expect(by.checkpoint.description).toBe('Save a mid-session checkpoint.');
    expect(by.preserve.source).toBe('personal');
    expect(by.model.source).toBe('built-in');
    expect(by.effort.source).toBe('built-in');
    expect(list.map((c) => c.name)).toEqual(
      [...list.map((c) => c.name)].sort(),
    );
  });

  it('lists remote-control, rename, usage and status with their aliases (#57)', () => {
    const repo = tree({
      '.claude/skills/status/SKILL.md': skill('status', 'Project status'),
      '.claude/commands/name.md': 'A project command called name.',
    });
    const list = readSlashCommands(repo, tree({}), { fresh: true });
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    expect(by['remote-control']).toMatchObject({
      source: 'built-in',
      aliases: ['rc'],
    });
    expect(by.usage.aliases).toEqual(['cost', 'stats']);
    // a real command wins over a built-in of the same name…
    expect(by.status.source).toBe('project');
    // …and over another built-in's alias
    expect(by.rename.aliases).toBeUndefined();
    expect(by.name.source).toBe('project');
  });

  it('skips non-invocable skills, bad names, big files and outside symlinks', () => {
    const outside = tree({ 'x/SKILL.md': skill('escape', 'outside') });
    const repo = tree({
      '.claude/skills/hidden/SKILL.md': skill(
        'hidden',
        'not for users',
        'user-invocable: false\n',
      ),
      '.claude/skills/bad/SKILL.md': skill('-rf', 'bad name'),
      '.claude/skills/huge/SKILL.md':
        skill('huge', 'too big') + 'x'.repeat(70 * 1024),
    });
    fs.symlinkSync(
      path.join(outside, 'x'),
      path.join(repo, '.claude/skills/escape'),
    );
    const names = readSlashCommands(repo, tree({}), { fresh: true }).map(
      (c) => c.name,
    );
    expect(names).not.toContain('hidden');
    expect(names).not.toContain('-rf');
    expect(names).not.toContain('huge');
    expect(names).not.toContain('escape');
  });

  it('redacts and caps descriptions, and survives missing dirs', () => {
    const key = 'sk-ant-api03-' + 'B'.repeat(90);
    const repo = tree({
      '.claude/skills/k/SKILL.md': skill('k', `${key} ${'y'.repeat(300)}`),
    });
    const k = readSlashCommands(repo, '/nonexistent-home', {
      fresh: true,
    }).find((c) => c.name === 'k');
    expect(k?.description).not.toContain(key);
    expect(k?.description.length).toBeLessThanOrEqual(160);
  });
});

describe('readSkillDir', () => {
  it('reads skills directly under a folder, with the same guards, and no built-ins', () => {
    const outside = tree({ 'x/SKILL.md': skill('escape', 'outside') });
    const dir = tree({
      'status/SKILL.md': skill('status', 'Quick health check. More text.'),
      'compress/skill.md': skill('compress', 'Save the session'),
      'hidden/SKILL.md': skill('hidden', 'no', 'user-invocable: false\n'),
      'big/SKILL.md': skill('big', 'too big') + 'x'.repeat(70 * 1024),
      'notes.md': 'not a skill folder',
    });
    fs.symlinkSync(path.join(outside, 'x'), path.join(dir, 'escape'));
    expect(readSkillDir(dir, 'amos')).toEqual([
      { name: 'compress', description: 'Save the session', source: 'amos' },
      { name: 'status', description: 'Quick health check.', source: 'amos' },
    ]);
    expect(readSkillDir('/nonexistent-dir', 'amos')).toEqual([]);
  });
});
