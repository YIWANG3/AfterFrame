// Rebuild the lightweight documentation/site images from the canonical PNGs (macOS menu bar removed).
// Run from the repository root after installing apps/desktop dependencies:
// node site/scripts/build-screenshots.mjs
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url));
const sharp = require('sharp');
async function rebuild(directory, label) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      await rebuild(new URL(`${entry.name}/`, directory), `${label}/${entry.name}`);
      continue;
    }
    if (!entry.name.endsWith('.png')) continue;
    const input = fileURLToPath(new URL(entry.name, directory));
    const output = input.replace(/\.png$/, '.webp');
    const info = await sharp(input)
      // Keep native resolution for large Retina website figures.
      .webp({ quality: 95, effort: 6 })
      .toFile(output);
    console.log(`${label}/${entry.name}: ${info.width} × ${info.height}, ${Math.round(info.size / 1024)} KB`);
  }
}
for (const language of ['cn', 'en']) {
  await rebuild(new URL(`../../docs/assets/${language}/`, import.meta.url), language);
}
