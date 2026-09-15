import assert from 'node:assert/strict';
import { readFile, access, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const require = createRequire(new URL('apps/desktop/package.json', root));
const sharp = require('sharp');

test('asset root contains only the shared logo and handwriting artwork', async () => {
  const entries = await readdir(new URL('docs/assets/', root), { withFileTypes: true });
  const images = entries.filter((entry) => entry.isFile() && /\.(png|jpe?g|webp|gif|avif|svg)$/i.test(entry.name));
  assert.deepEqual(images.map((entry) => entry.name).sort(), [
    'editor-handwriting-gallery.jpg', 'logo.png',
  ]);
});

test('UI screenshots preserve their own app corners and full height', async () => {
  const theme = await readFile(new URL('site/theme.css', root), 'utf8');
  const workspace = await readFile(new URL('site/workspace.css', root), 'utf8');
  const rules = [...`${theme}\n${workspace}`.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => /\.screen\b|\.hero-screen\b|\.layout figure/.test(selector));
  assert.ok(rules.length >= 3);
  for (const [, selector, body] of rules) {
    assert.doesNotMatch(body, /overflow\s*:\s*(hidden|clip)/, selector);
    assert.doesNotMatch(body, /max-height\s*:/, selector);
    const radius = body.match(/border-radius\s*:\s*([^;]+)/)?.[1];
    if (radius) assert.equal(radius.trim(), '0', selector);
  }
});

for (const file of ['README.md', 'README.zh-CN.md']) {
  test(`${file}: all documentation images exist`, async () => {
    const text = await readFile(new URL(file, root), 'utf8');
    const images = [...text.matchAll(/docs\/assets\/[^\s)"<>]+/g)].map(([src]) => src);
    assert.ok(images.length > 10);
    for (const src of images) await access(new URL(src, root));
    const legacy = images.filter((src) => !/\/(cn|en)\//.test(src));
    assert.deepEqual([...new Set(legacy)].sort(), [
      'docs/assets/editor-handwriting-gallery.jpg', 'docs/assets/logo.png',
    ]);
  });
}

for (const file of ['index.html', 'workspace-zh.html', 'guide.html', 'guide-zh.html']) {
  test(`${file}: screenshot paths and intrinsic dimensions match`, async () => {
    const html = await readFile(new URL(`site/${file}`, root), 'utf8');
    const images = [...html.matchAll(/<img\b[^>]*>/gs)].map(([tag]) => tag);
    assert.ok(images.length >= 7);
    for (const tag of images) {
      const src = tag.match(/src="([^"]+)"/)?.[1];
      assert.ok(src?.startsWith('assets/'));
      const path = new URL(`docs/${src}`, root);
      await access(path);
      if (!src.endsWith('.webp')) continue;
      const metadata = await sharp(fileURLToPath(path)).metadata();
      assert.equal(Number(tag.match(/width="(\d+)"/)?.[1]), metadata.width, src);
      assert.equal(Number(tag.match(/height="(\d+)"/)?.[1]), metadata.height, src);
      assert.ok(tag.match(/alt="[^"]+"/), src);
    }
  });
}
