const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");
const { processLogo, MAX_INPUT_BYTES } = require("./personalLogos");

const MONO_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">'
  + '<script>alert(1)</script><image href="file:///etc/passwd" width="10" height="10"/>'
  + '<rect x="20" y="10" width="160" height="40" rx="8" fill="#222"/></svg>',
);

async function twoColourPng() {
  const art = Buffer.from('<svg width="300" height="100"><rect x="10" y="10" width="100" height="80" fill="red"/><rect x="150" y="10" width="100" height="80" fill="blue"/></svg>');
  return sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art }]).png().toBuffer();
}

test("an SVG becomes a trimmed PNG; one colour on transparent is recolourable", async () => {
  const logo = await processLogo(sharp, MONO_SVG, "Mark.SVG");
  const meta = await sharp(logo.png).metadata();
  assert.equal(meta.format, "png");
  // The 160×40 rect, not the 200×60 canvas: the margin is trimmed.
  assert.equal(logo.width / logo.height, 4);
  assert.equal(logo.height, 1200);
  assert.equal(logo.tintable, true);
  assert.equal(logo.color, "#222222");
});

test("a mark that reaches the top-left corner is kept whole", async () => {
  // Two white bars, the first at the very corner: the corner pixel is the
  // mark, not the background, so only transparency may be trimmed.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100">'
    + '<rect width="180" height="100" fill="#fff"/><rect x="220" width="180" height="100" fill="#fff"/></svg>');
  const logo = await processLogo(sharp, svg, "Bars.svg");
  assert.equal(logo.width / logo.height, 4);
  assert.equal(logo.tintable, true);
  assert.equal(logo.color, "#ffffff");
});

test("several colours keep their own; a small PNG is not enlarged", async () => {
  const logo = await processLogo(sharp, await twoColourPng(), "two.png");
  assert.equal(logo.tintable, false);
  assert.equal(logo.height, 80);
});

test("an opaque background is not recolourable, even in one colour", async () => {
  const flat = await sharp({ create: { width: 120, height: 40, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg width="120" height="40"><rect x="10" y="10" width="100" height="20" fill="#ffffff"/></svg>') }])
    .png().toBuffer();
  await assert.rejects(processLogo(sharp, flat, "white.png"), { code: "empty_image" });
  const boxed = await sharp({ create: { width: 120, height: 40, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg width="120" height="40"><rect x="10" y="10" width="100" height="20" fill="#000000"/></svg>') }])
    .png().toBuffer();
  // Trimmed to the black bar, which is then all one colour but has no
  // transparency: keep it as it is.
  assert.equal((await processLogo(sharp, boxed, "boxed.png")).tintable, false);
});

test("anything else is refused with a reason", async () => {
  await assert.rejects(processLogo(sharp, MONO_SVG, "mark.gif"), { code: "unsupported_type" });
  await assert.rejects(processLogo(sharp, Buffer.from("not an image"), "x.png"), { code: "invalid_image" });
  await assert.rejects(processLogo(sharp, Buffer.from("<svg/>"), "x.svg"), { code: "invalid_image" });
  await assert.rejects(processLogo(sharp, Buffer.alloc(MAX_INPUT_BYTES.svg + 1, 32), "big.svg"), { code: "too_large" });
});
