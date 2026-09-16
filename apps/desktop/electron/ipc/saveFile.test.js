// EXIF orientation regression tests for the sharp "fast path" export.
//
// The editor previews a photo on a canvas fed by a browser-decoded <img>, which
// is already EXIF-oriented. processAndSave must land on the same pixels, so the
// ground truth here is sharp's own auto-orient (`.rotate()` with no argument) —
// the identical transform every viewer applies.
//
// Orientations 5 and 7 used to come out 180° off because EXIF_MAP negated the
// angle for mirrored orientations, on the assumption that sharp rotates before
// it flops. It does not: within one pipeline flip/flop always runs BEFORE
// rotate, whatever order the calls appear in.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { register } = require("./saveFile");

// register() only needs ipcMain.handle to exist; we call the returned functions
// directly rather than going through IPC.
const { processAndSave } = register({
  ipcMain: { handle() {} },
  dialog: {},
  rootDir: os.tmpdir(),
  writeImageWithSourceMetadata: async () => {},
  addAllowedMediaDir: () => {},
});

// 2x3 grayscale ramp — asymmetric on both axes, so every one of the eight
// orientations produces a distinct result.
const RAW_PIXELS = Buffer.from([1, 2, 3, 4, 5, 6]);

async function writeOriented(dir, orientation) {
  const file = path.join(dir, `o${orientation}.jpg`);
  const buffer = await sharp(RAW_PIXELS, { raw: { width: 2, height: 3, channels: 1 } })
    .withMetadata({ orientation })
    .jpeg({ quality: 100 })
    .toBuffer();
  await fs.promises.writeFile(file, buffer);
  return file;
}

async function grayGrid(source) {
  const { data, info } = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < info.height; y += 1) {
    const row = [];
    for (let x = 0; x < info.width; x += 1) row.push(data[(y * info.width + x) * info.channels]);
    rows.push(row);
  }
  return { width: info.width, height: info.height, rows };
}

test("processAndSave matches EXIF auto-orient for every orientation", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "afterframe-savefile-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const source = await writeOriented(dir, orientation);
    const savePath = path.join(dir, `out${orientation}.png`);
    await processAndSave({ sourcePath: source, savePath });

    // What every viewer shows: sharp applying the file's own EXIF orientation.
    const expected = await grayGrid(await sharp(source).rotate().png().toBuffer());
    const actual = await grayGrid(savePath);

    assert.deepEqual(
      actual,
      expected,
      `orientation ${orientation}: export does not match EXIF auto-orient`,
    );
  }
});

// The canvas preview (canvasHelpers.buildTransformedCanvas) does
// `translate → rotate → scale → drawImage` on a browser-EXIF-oriented <img>,
// so the flips apply BEFORE the quarter turns. Reproduce that with explicit,
// separate sharp pipelines — one operation each, so nothing can be reordered.
async function previewReference(source, { quarterTurns, flipX, flipY }) {
  let buffer = await sharp(source).rotate().png().toBuffer(); // EXIF auto-orient
  if (flipX || flipY) {
    let mirrored = sharp(buffer);
    if (flipX) mirrored = mirrored.flop();
    if (flipY) mirrored = mirrored.flip();
    buffer = await mirrored.png().toBuffer();
  }
  if (quarterTurns % 4 !== 0) {
    buffer = await sharp(buffer).rotate(((quarterTurns % 4) + 4) % 4 * 90).png().toBuffer();
  }
  return grayGrid(buffer);
}

test("processAndSave matches the canvas preview for every orientation × turn × flip", async (t) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "afterframe-savefile-combo-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));

  for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const source = await writeOriented(dir, orientation);
    for (const quarterTurns of [0, 1, 2, 3]) {
      for (const flipX of [false, true]) {
        for (const flipY of [false, true]) {
          const label = `o${orientation}_q${quarterTurns}_x${flipX ? 1 : 0}_y${flipY ? 1 : 0}`;
          const savePath = path.join(dir, `${label}.png`);
          await processAndSave({ sourcePath: source, savePath, quarterTurns, flipX, flipY });

          assert.deepEqual(
            await grayGrid(savePath),
            await previewReference(source, { quarterTurns, flipX, flipY }),
            `${label}: export does not match the canvas preview`,
          );
        }
      }
    }
  }
});
