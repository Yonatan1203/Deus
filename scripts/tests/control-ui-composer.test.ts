import { describe, expect, it } from 'vitest';
// The pure helpers of a browser module; the DOM parts are driven in a browser.
// @ts-expect-error — plain JS module without type declarations
import { cleanInput, filterCommands } from '../../web/control/composer.js';

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
});
