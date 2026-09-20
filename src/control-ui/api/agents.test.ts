import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listAgents, parseFrontmatter } from './agents.js';

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
