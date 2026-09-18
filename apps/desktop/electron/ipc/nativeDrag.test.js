const test = require("node:test");
const assert = require("node:assert/strict");
const { pileAlpha, pileSafeDragIcon } = require("./nativeDrag");

test("pileAlpha: one file is opaque; N stacked copies composite back to ~0.92", () => {
  assert.equal(pileAlpha(1), 1);
  for (const n of [2, 10, 68]) {
    const a = pileAlpha(n);
    assert.ok(a > 0 && a < 1, `${n}: per-copy alpha in (0,1)`);
    assert.ok(Math.abs((1 - Math.pow(1 - a, n)) - 0.92) < 1e-9, `${n}: stack sums to 0.92`);
  }
});

test("pileSafeDragIcon: scales every premultiplied channel, keeps size, re-wraps at 2x", () => {
  const calls = [];
  const nativeImage = { createFromBitmap: (buf, opts) => { calls.push({ buf, opts }); return "wrapped"; } };
  const icon = { getSize: () => ({ width: 2, height: 1 }), toBitmap: () => Buffer.from([200, 100, 50, 255, 0, 0, 0, 0]) };
  assert.equal(pileSafeDragIcon(nativeImage, icon, 1), "wrapped");
  assert.deepEqual([...calls[0].buf], [200, 100, 50, 255, 0, 0, 0, 0], "a single file is untouched");
  pileSafeDragIcon(nativeImage, icon, 4);
  const a = pileAlpha(4);
  assert.deepEqual([...calls[1].buf], [200, 100, 50, 255, 0, 0, 0, 0].map((v) => Math.round(v * a)));
  assert.deepEqual(calls[1].opts, { width: 2, height: 1, scaleFactor: 2 });
  const empty = { getSize: () => ({ width: 0, height: 0 }) };
  assert.equal(pileSafeDragIcon(nativeImage, empty, 3), empty, "an empty image passes through");
});
