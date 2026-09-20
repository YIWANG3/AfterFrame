// File output IPC: native save dialog, raw save-image (canvas blob → disk),
// and the high-resolution process-and-save fast-path (sharp-based rotate +
// flip + crop, with EXIF orientation handling, no canvas in the loop).

const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
// Same boundaries the renderer previews with — one copy for both processes.
const { panelBoundaries } = require("../../shared/splitGeometry.mjs");

// ── Orientation algebra ──────────────────────────────────────────────────────
// Every combination of quarter turns and mirrors is an element of the dihedral
// group D4, and each one has exactly one normal form `rotate(angle) ∘ flop^n`
// — mirror FIRST, then rotate. That is precisely what sharp does: inside a
// single pipeline flip/flop always runs before rotate, whatever order the calls
// appear in (`.rotate(90).flop()` and `.flop().rotate(90)` produce the same
// image). Canvas agrees: translate → rotate → scale → drawImage applies the
// scale (the mirror) first.
//
// Composing by hand does NOT work, because rotations and mirrors don't commute
// (R_θ ∘ F = F ∘ R_−θ). Merging the EXIF mirror with the user's flip via XOR
// and adding the angles — which this file used to do — silently drops that
// sign flip and lands 180° off for mirrored EXIF orientations. Compose here
// instead, once, with the real group law.
const IDENTITY_ORIENT = { angle: 0, flop: false };
const FLIP_X = { angle: 0, flop: true };
const FLIP_Y = { angle: 180, flop: true }; // vertical mirror = flop, then 180°

// EXIF orientation → the transform a viewer applies, in normal form.
// savePath itself when nothing is there, else <stem>_2.<ext>, _3, …
function freePath(savePath) {
  if (!fs.existsSync(savePath)) return savePath;
  const { dir, name, ext } = path.parse(savePath);
  for (let n = 2; ; n += 1) {
    const candidate = path.join(dir, `${name}_${n}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

const EXIF_ORIENTATION = {
  1: { angle: 0, flop: false },
  2: { angle: 0, flop: true },
  3: { angle: 180, flop: false },
  4: { angle: 180, flop: true },
  5: { angle: 270, flop: true },
  6: { angle: 90, flop: false },
  7: { angle: 90, flop: true },
  8: { angle: 270, flop: false },
};

// `after ∘ before`: apply `before` first. With both in normal form
// (R_a ∘ F^m) ∘ (R_b ∘ F^n) = R_(a ± b) ∘ F^(m xor n), the sign coming from
// F ∘ R_b = R_−b ∘ F.
function composeOrientation(after, before) {
  const angle = after.angle + (after.flop ? -before.angle : before.angle);
  return { angle: ((angle % 360) + 360) % 360, flop: after.flop !== before.flop };
}

// Left-to-right = first-applied to last-applied.
function composeOrientations(steps) {
  return steps.reduce((acc, step) => composeOrientation(step, acc), IDENTITY_ORIENT);
}

function register({
  ipcMain,
  dialog,
  rootDir,
  writeImageWithSourceMetadata,
  addAllowedMediaDir,
}) {
  ipcMain.handle("workspace:pick-save-path", async (_event, options) => {
    const result = await dialog.showSaveDialog({
      title: "Save edited image",
      defaultPath: options?.defaultPath || path.join(rootDir, "data", "edited-image.jpg"),
      buttonLabel: "Save Image",
      filters: Array.isArray(options?.filters) ? options.filters : undefined,
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  // Directory picker for batch export (e.g. batch collage → N files).
  ipcMain.handle("workspace:pick-directory", async (_event, options) => {
    const result = await dialog.showOpenDialog({
      title: options?.title || "Choose export folder",
      defaultPath: options?.defaultPath || undefined,
      buttonLabel: options?.buttonLabel || "Export Here",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths?.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("workspace:save-image", async (_event, targetPath, arrayBuffer, sourceMetadataPath) => {
    if (!targetPath) throw new Error("Missing target path");
    addAllowedMediaDir?.(require("node:path").dirname(targetPath));
    const output = Buffer.from(arrayBuffer);
    return await writeImageWithSourceMetadata(targetPath, output, sourceMetadataPath);
  });

  // Orientation + user transforms + crop, as one sharp pipeline positioned at
  // the requested region (the whole photo when `crop` is absent). Shared by the
  // single-image fast path and the split-panel export so both cut pixels from
  // exactly the same basis. Returns the pipeline plus the region's pixel size.
  async function buildRegionPipeline(options) {
    const {
      sourcePath,
      quarterTurns = 0,
      freeAngle = 0,
      flipX = false,
      flipY = false,
      crop,
    } = options || {};

    // Read metadata (fast — no pixel decode)
    const meta = await sharp(sourcePath, { limitInputPixels: false }).metadata();

    const discreteAngle = ((quarterTurns * 90) % 360 + 360) % 360;
    // Order matters and is dictated by the canvas preview
    // (canvasHelpers.buildTransformedCanvas): translate → rotate → scale →
    // drawImage means the browser applies the flips FIRST and the quarter turns
    // last, on top of an <img> the browser already EXIF-oriented.
    const orient = composeOrientations([
      EXIF_ORIENTATION[meta.orientation] || IDENTITY_ORIENT,
      flipX ? FLIP_X : IDENTITY_ORIENT,
      flipY ? FLIP_Y : IDENTITY_ORIENT,
      { angle: discreteAngle, flop: false },
    ]);

    // Stage 1 — orientation + user quarter turns + flips, merged into ONE
    // rotate + at most one flop. This is the basis the editor's crop rect and
    // free angle are expressed in (transformedPreview).
    // 0° still needs an explicit rotate(0) to suppress sharp's EXIF auto-orient.
    let pipeline = sharp(sourcePath, { limitInputPixels: false, sequentialRead: true });
    pipeline = pipeline.rotate(orient.angle);
    if (orient.flop) pipeline = pipeline.flop();

    // Output dimensions: the source's, swapped when the composed rotation is a
    // quarter turn. (Mirrors never change the bounding box.)
    let w = meta.width;
    let h = meta.height;
    if (orient.angle === 90 || orient.angle === 270) [w, h] = [h, w];

    if (freeAngle !== 0) {
      // Stage 2 — the free angle. The editor turns the photo under an
      // axis-aligned crop box about the box's centre; rotating about the
      // photo centre instead only shifts the box, so: rotate about the centre
      // into the bounding box, then extract the box at its rotated centre.
      // sharp allows one rotate per pipeline, hence the raw round-trip.
      const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
      const w0 = info.width;
      const h0 = info.height;
      const rad = (freeAngle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      pipeline = sharp(data, { raw: { width: w0, height: h0, channels: info.channels }, limitInputPixels: false })
        .rotate(freeAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
      const rotMeta = await pipeline.clone().metadata();
      const bw = rotMeta.width;
      const bh = rotMeta.height;
      // Crop box in the stage-1 basis (default: the whole photo, corners cut).
      const box = crop
        ? { x: crop.x * w0, y: crop.y * h0, width: crop.width * w0, height: crop.height * h0 }
        : { x: 0, y: 0, width: w0, height: h0 };
      const dx = box.x + box.width / 2 - w0 / 2;
      const dy = box.y + box.height / 2 - h0 / 2;
      const cx = bw / 2 + dx * cos - dy * sin;
      const cy = bh / 2 + dx * sin + dy * cos;
      const cw = Math.max(1, Math.round(box.width));
      const ch = Math.max(1, Math.round(box.height));
      const left = Math.max(0, Math.min(bw - cw, Math.round(cx - cw / 2)));
      const top = Math.max(0, Math.min(bh - ch, Math.round(cy - ch / 2)));
      const width = Math.min(cw, bw - left);
      const height = Math.min(ch, bh - top);
      pipeline = pipeline.extract({ left, top, width, height });
      return { pipeline, width, height };
    }
    if (crop) {
      // Normalized crop → pixel rect
      const left = Math.max(0, Math.round(crop.x * w));
      const top = Math.max(0, Math.round(crop.y * h));
      const cw = Math.min(Math.round(w) - left, Math.max(1, Math.round(crop.width * w)));
      const ch = Math.min(Math.round(h) - top, Math.max(1, Math.round(crop.height * h)));
      pipeline = pipeline.extract({ left, top, width: cw, height: ch });
      return { pipeline, width: cw, height: ch };
    }
    return { pipeline, width: Math.round(w), height: Math.round(h) };
  }

  // Sharp-based "fast path" — bypasses canvas entirely and works at the
  // source's native resolution. Used by the editor when there are no overlay
  // layers (just rotate/flip/crop on the original image), and by the MCP
  // crop_assets tool's rect/rotate mode (hence the named function).
  async function processAndSave(options) {
    const { sourcePath, savePath, quality = 92 } = options || {};
    if (!sourcePath || !savePath) throw new Error("Missing source or save path");

    const t0 = Date.now();
    console.log("[process-and-save] source:", sourcePath);

    let { pipeline } = await buildRegionPipeline(options);
    // Keep EXIF/XMP/ICC, but the pixels are upright now: a surviving
    // orientation tag (6 on every portrait phone shot) makes each viewer turn
    // the saved file a second time.
    pipeline = pipeline.keepMetadata().withMetadata({ orientation: 1 });

    const ext = path.extname(savePath).toLowerCase();
    if (ext === ".png") pipeline = pipeline.png();
    else if (ext === ".webp") pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.jpeg({ quality });

    await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
    // Pasting edits onto many photos must never replace a file the user
    // already has (an earlier <name>_edited.jpg); the editor's own save keeps
    // overwriting, which is what saving twice is expected to do.
    const targetPath = options.avoidOverwrite ? freePath(savePath) : savePath;
    const result = await pipeline.toFile(targetPath);

    console.log(`[process-and-save] ${result.width}×${result.height} in ${Date.now() - t0}ms → ${targetPath}`);
    return { path: targetPath, width: result.width, height: result.height };
  }

  // Size as displayed (EXIF orientation applied), from the header alone. The
  // catalog stores raw pixel dimensions, so a portrait shot with an
  // orientation tag reads as landscape there.
  async function imageDisplaySize(sourcePath) {
    if (!sourcePath) throw new Error("Missing source path");
    const meta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
    const turned = (EXIF_ORIENTATION[meta.orientation] || IDENTITY_ORIENT).angle % 180 !== 0;
    return turned ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
  }

  // Split export: cut `region` (normalized, stage-1 basis) out of the oriented
  // photo ONCE, then slice that single raster into savePaths.length vertical
  // panels. Decoding once and slicing one buffer is what keeps the panels
  // seamless even with a free angle — per-panel crops would each rotate about
  // their own centre and drift apart.
  async function processAndSavePanels(options) {
    const { sourcePath, savePaths, region, quality = 92 } = options || {};
    if (!sourcePath) throw new Error("Missing source path");
    if (!Array.isArray(savePaths) || savePaths.length < 1) throw new Error("Missing panel save paths");
    if (!region) throw new Error("Missing split region");

    const t0 = Date.now();
    const count = savePaths.length;
    const { pipeline } = await buildRegionPipeline({ ...options, crop: region });
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    if (W < count) throw new Error(`Region is only ${W}px wide; cannot split into ${count} panels`);
    const bounds = panelBoundaries(W, count);

    const results = [];
    for (let i = 0; i < count; i++) {
      const left = bounds[i];
      const width = bounds[i + 1] - left;
      const savePath = savePaths[i];
      const panel = await sharp(data, { raw: { width: W, height: H, channels: info.channels }, limitInputPixels: false })
        .extract({ left, top: 0, width, height: H })
        .png()
        .toBuffer();
      addAllowedMediaDir?.(path.dirname(savePath));
      await writeImageWithSourceMetadata(savePath, panel, sourcePath, { quality });
      results.push({ path: savePath, width, height: H, index: i });
    }

    console.log(`[process-and-save-panels] ${count} × ~${Math.round(W / count)}×${H} from ${W}×${H} in ${Date.now() - t0}ms`);
    return results;
  }

  ipcMain.handle("workspace:process-and-save", (_event, options) => processAndSave(options));
  ipcMain.handle("workspace:image-display-size", (_event, sourcePath) => imageDisplaySize(sourcePath));
  ipcMain.handle("workspace:process-and-save-panels", (_event, options) => processAndSavePanels(options));

  return { processAndSave, processAndSavePanels, panelBoundaries, imageDisplaySize, freePath };
}

module.exports = { register };
