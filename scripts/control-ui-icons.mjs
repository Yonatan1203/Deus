#!/usr/bin/env node
// One-off: renders web/control/icons/icon.svg to the PNG sizes the PWA
// manifest needs. The PNGs are committed; re-run only when the SVG changes.
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'web', 'control', 'icons');
for (const size of [192, 512]) {
  const out = path.join(dir, `icon-${size}.png`);
  await sharp(path.join(dir, 'icon.svg')).resize(size, size).png().toFile(out);
  console.log(`wrote ${out}`);
}
