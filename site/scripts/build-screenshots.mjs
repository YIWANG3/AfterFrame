// Rebuild the lightweight documentation/site images from the untouched PNGs.
// Run from the repository root after installing apps/desktop dependencies:
// node site/scripts/build-screenshots.mjs
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const sharp = require('sharp');
for (const language of ['cn', 'en']) {
  const directory = new URL(`../../docs/assets/${language}/`, import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => name.endsWith('.png')).sort()) {
    const input = fileURLToPath(new URL(name, directory));
    const output = input.replace(/\.png$/, '.webp');
    const info = await sharp(input)
      .resize({ width: 2000, withoutEnlargement: true })
      .webp({ quality: 88, effort: 6 })
      .toFile(output);
    console.log(`${language}/${name}: ${info.width} × ${info.height}, ${Math.round(info.size / 1024)} KB`);
  }
}
