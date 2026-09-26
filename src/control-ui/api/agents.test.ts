import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AGENT_BODY_MAX,
  listAgents,
  parseFrontmatter,
  readAgent,
} from './agents.js';

const SAMPLE = `---
name: code-explorer
description: Fast read-only code exploration. <example>x</example>
model: sonnet
explores_code: true
tools:
  - Bash
  - Read
color: "blue"
---
# body
`;

describe('control-ui agents', () => {
  it('parses scalars, booleans, quoted strings and block lists', () => {
    expect(parseFrontmatter(SAMPLE)).toEqual({
      name: 'code-explorer',
      description: 'Fast read-only code exploration. <example>x</example>',
      model: 'sonnet',
      explores_code: true,
      tools: ['Bash', 'Read'],
      color: 'blue',
    });
    expect(parseFrontmatter('no frontmatter')).toEqual({});
    expect(parseFrontmatter('---\nlist: [a, b]\nn: 3\n---')).toEqual({
      list: ['a', 'b'],
      n: 3,
    });
  });

  it('lists only .md files with a name, sorted, ignoring subdirectories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-agents-'));
    fs.writeFileSync(
      path.join(dir, 'b.md'),
      SAMPLE.replace('code-explorer', 'zeta'),
    );
    fs.writeFileSync(path.join(dir, 'a.md'), SAMPLE);
    fs.writeFileSync(path.join(dir, 'README.md'), '# no frontmatter');
    fs.mkdirSync(path.join(dir, 'wardens'));
    const agents = listAgents(dir);
    expect(agents.map((a) => a.name)).toEqual(['code-explorer', 'zeta']);
    expect(agents[0].file).toBe('a.md');
    expect(agents[0].tools).toEqual(['Bash', 'Read']);
  });
});

describe('readAgent', () => {
  const dir = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
    fs.writeFileSync(
      path.join(d, 'explorer.md'),
      SAMPLE + 'Use it for search.\n',
    );
    return d;
  };
  it('returns one agent with its body, not its frontmatter', () => {
    const a = readAgent(dir(), 'code-explorer');
    expect(a).toMatchObject({
      name: 'code-explorer',
      model: 'sonnet',
      truncated: false,
    });
    expect(a?.body).toBe('# body\nUse it for search.\n');
  });
  it('refuses unknown and malformed names, and symlinks', () => {
    const d = dir();
    expect(readAgent(d, 'nobody')).toBeNull();
    expect(readAgent(d, '../x')).toBeNull();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'out-'));
    fs.writeFileSync(
      path.join(outside, 'o.md'),
      '---\nname: sneaky\n---\nsecret',
    );
    fs.symlinkSync(path.join(outside, 'o.md'), path.join(d, 'sneaky.md'));
    expect(readAgent(d, 'sneaky')).toBeNull();
  });
  it('cuts a huge body at 128 KiB on a character boundary, and redacts keys', () => {
    const d = dir();
    const key = 'sk-ant-api03-' + 'C'.repeat(90);
    fs.writeFileSync(
      path.join(d, 'big.md'),
      `---\nname: big\n---\n${key}\n` + 'é'.repeat(100 * 1024),
    );
    const a = readAgent(d, 'big');
    expect(a?.truncated).toBe(true);
    expect(Buffer.byteLength(a?.body ?? '')).toBeLessThanOrEqual(
      AGENT_BODY_MAX,
    );
    expect(a?.body.endsWith('é')).toBe(true);
    expect(a?.body).not.toContain(key);
  });
});
