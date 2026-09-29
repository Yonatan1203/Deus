import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const WEB = path.resolve(__dirname, '../../web/control');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');

describe('dashboard shell', () => {
  it('lists every script in the offline shell, so an installed app never pairs new code with a missing file', () => {
    const shell = JSON.parse(
      read('sw.js')
        .match(/const SHELL = (\[[^\]]*\]);/)![1]
        .replace(/'/g, '"'),
    ) as string[];
    const scripts = [
      ...fs
        .readdirSync(WEB)
        .filter((f) => f.endsWith('.js') && f !== 'sw.js')
        .map((f) => `/${f}`),
      ...fs
        .readdirSync(path.join(WEB, 'views'))
        .filter((f) => f.endsWith('.js'))
        .map((f) => `/views/${f}`),
    ];
    expect(scripts.filter((s) => !shell.includes(s))).toEqual([]);
  });

  it('keeps the chosen-Light colours identical to the device-Light colours', () => {
    const css = read('app.css');
    const props = (block: string) =>
      Object.fromEntries(
        [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
          m[1],
          m[2].trim(),
        ]),
      );
    const media = css.match(
      /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([^}]*)\}/,
    )![1];
    const forced = css.match(/:root\[data-theme="light"\] \{([^}]*)\}/)![1];
    expect(Object.keys(props(media)).length).toBeGreaterThan(10);
    expect(props(forced)).toEqual(props(media));
  });

  it('loads the theme before the page draws (a classic script in <head>, not the module)', () => {
    const html = read('index.html');
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).toMatch(/<script src="\/theme-init\.js"><\/script>/);
    expect(read('theme-init.js')).toContain("'deus-control.theme'");
  });
});
