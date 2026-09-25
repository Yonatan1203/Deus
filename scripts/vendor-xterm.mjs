#!/usr/bin/env node
// Copies the pinned xterm.js build into web/control/vendor/xterm/ so the
// dashboard serves it same-origin (its CSP allows only 'self'; no CDN).
// Runs as part of `npm run build`; the output directory is gitignored.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'web', 'control', 'vendor', 'xterm');
const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/addon-webgl/lib/addon-webgl.js', 'addon-webgl.js'],
];
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const src = path.join(root, 'node_modules', from);
  if (!fs.existsSync(src)) {
    console.error(`vendor-xterm: ${from} missing — run npm install`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(out, to));
}
console.log(`vendor-xterm: ${files.length} files → ${path.relative(root, out)}`);
