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

test('UI screenshot frames preserve full height', async () => {
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
      const src = tag.match(/src="([^"]+)"/)?.[1]?.split('?')[0];
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

for (const file of ['index.html', 'workspace-zh.html', 'guide.html', 'guide-zh.html']) {
  test(`${file}: every UI screenshot has a light source with matching dimensions`, async () => {
    const html = await readFile(new URL(`site/${file}`, root), 'utf8');
    const pictures = [...html.matchAll(/<picture class="themed-shot">(.*?)<\/picture>/gs)];
    const uiImages = [...html.matchAll(/src="assets\/(cn|en)\/[^/]+\.webp(?:\?[^"]*)?"/g)];
    assert.equal(pictures.length, uiImages.length);
    for (const [, picture] of pictures) {
      const source = picture.match(/<source\b[^>]*>/s)?.[0];
      assert.ok(source?.includes('data-theme-light'));
      const src = source.match(/srcset="([^"]+)"/)?.[1]?.split('?')[0];
      assert.match(src, /^assets\/(cn|en)\/light\/[^/]+\.webp$/);
      const metadata = await sharp(fileURLToPath(new URL(`docs/${src}`, root))).metadata();
      assert.equal(Number(source.match(/width="(\d+)"/)?.[1]), metadata.width, src);
      assert.equal(Number(source.match(/height="(\d+)"/)?.[1]), metadata.height, src);
    }
  });
}

// High-density UI captures must retain native pixels in the served WebP.
test('all screenshot variants retain native PNG resolution', async () => {
  for (const language of ['cn', 'en']) {
    for (const variant of ['', '/light']) {
      const folder = new URL(`docs/assets/${language}${variant}/`, root);
      for (const name of (await readdir(folder)).filter(name => name.endsWith('.png'))) {
        const png = await sharp(fileURLToPath(new URL(name, folder))).metadata();
        const webp = await sharp(fileURLToPath(new URL(name.replace(/\.png$/, '.webp'), folder))).metadata();
        assert.deepEqual([webp.width, webp.height], [png.width, png.height], name);
        assert.ok(png.width >= 2640, `${language}${variant}/${name} must be a native HD capture`);
      }
    }
  }
});

test('home pages have a separate white-ground logo for light mode', async () => {
  for (const file of ['index.html', 'workspace-zh.html']) {
    const html = await readFile(new URL(`site/${file}`, root), 'utf8');
    assert.match(html, /data-theme-light[^>]+logo-backdrop-white\.webp/);
    assert.match(html, /src="assets\/brand\/logo-backdrop-black\.webp(?:\?[^"]*)?"/);
  }
});
