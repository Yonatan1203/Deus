import { describe, expect, it } from 'vitest';
// The pure helpers of a browser module; the DOM parts are driven in a browser.
// @ts-expect-error — plain JS module without type declarations
import {
  cleanInput,
  commandFor,
  filterCommands,
} from '../../web/control/composer.js';

const cmds = [
  { name: 'add-slack', description: '', source: 'project' },
  { name: 'compress', description: '', source: 'personal' },
  { name: 'effort', description: '', source: 'built-in' },
  { name: 'preferences', description: '', source: 'personal' },
];

describe('composer helpers', () => {
  it('strips control characters that could end a paste or send keys', () => {
    expect(cleanInput('hi\x1b[201~\r there\x07\n\tok  ')).toBe(
      'hi[201~ there\n\tok',
    );
  });

  it('filters commands: prefix first, then contains, closed after a space', () => {
    expect(
      filterCommands(cmds, '/ef').map((c: { name: string }) => c.name),
    ).toEqual(['effort', 'preferences']);
    expect(filterCommands(cmds, '/effort high')).toBeNull();
    expect(filterCommands(cmds, 'hello')).toBeNull();
    expect(filterCommands([], '/')).toBeNull();
  });

  it('orders by source when nothing is typed yet', () => {
    const rank = { personal: 0, 'built-in': 1, project: 2 };
    expect(
      filterCommands(cmds, '/', rank).map((c: { name: string }) => c.name),
    ).toEqual(['compress', 'preferences', 'effort', 'add-slack']);
  });

  it('an exact alias leads, and the pick keeps what was typed (#57)', () => {
    const list = [
      { name: 'deep-research', description: '', source: 'personal' },
      { name: 'rcfile', description: '', source: 'project' },
      {
        name: 'remote-control',
        description: '',
        source: 'built-in',
        aliases: ['rc'],
      },
      {
        name: 'rename',
        description: '',
        source: 'built-in',
        aliases: ['name'],
      },
    ];
    const got = filterCommands(list, '/rc');
    expect(got.map((c: { name: string }) => c.name)).toEqual([
      'remote-control',
      'rcfile',
      'deep-research',
    ]);
    expect(got[0].alias).toBe('rc');
    expect(got[1].alias).toBeUndefined();
    // exact name beats a prefix of a longer name
    expect(
      filterCommands(list, '/rename').map((c: { name: string }) => c.name)[0],
    ).toBe('rename');
    // alias prefix counts as a prefix match, each command listed once
    expect(
      filterCommands(list, '/na').map((c: { name: string }) => c.name),
    ).toEqual(['rename']);
  });

  it('commandFor recognises a typed name or alias', () => {
    const list = [
      {
        name: 'remote-control',
        description: 'x',
        source: 'built-in',
        aliases: ['rc'],
      },
    ];
    expect(commandFor(list, '/rc ')?.name).toBe('remote-control');
    expect(commandFor(list, '/remote-control')?.name).toBe('remote-control');
    expect(commandFor(list, '/r')).toBeUndefined();
    expect(commandFor(null, '/rc')).toBeUndefined();
  });
});
