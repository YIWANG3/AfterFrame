// File output IPC: native save dialog, raw save-image (canvas blob → disk),
// and the high-resolution process-and-save fast-path (sharp-based rotate +
// flip + crop, with EXIF orientation handling, no canvas in the loop).

const path = require("path");
const fs = require("fs");
const sharp = require("sharp");

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

  // Sharp-based "fast path" — bypasses canvas entirely and works at the
  // source's native resolution. Used by the editor when there are no overlay
  // layers (just rotate/flip/crop on the original image), and by the MCP
  // crop_assets tool's rect/rotate mode (hence the named function).
  async function processAndSave(options) {
    const {
      sourcePath,
      savePath,
      quarterTurns = 0,
      freeAngle = 0,
      flipX = false,
      flipY = false,
      crop,
      quality = 92,
    } = options || {};

    if (!sourcePath || !savePath) throw new Error("Missing source or save path");

    const t0 = Date.now();
    console.log("[process-and-save] source:", sourcePath);

    // Read metadata (fast — no pixel decode)
    const meta = await sharp(sourcePath, { limitInputPixels: false }).metadata();

    // EXIF orientation decomposition: rotation angle + optional horizontal mirror.
    // Sharp pipeline order is rotate → flop → flip, but EXIF semantics apply
    // mirror BEFORE rotation. Flop then Rotate(θ) ≡ Rotate(−θ) then Flop, so we
    // negate the EXIF angle when mirror is present.
    const EXIF_MAP = {
      1: { angle: 0, flop: false },
      2: { angle: 0, flop: true },
      3: { angle: 180, flop: false },
      4: { angle: 180, flop: true },
      5: { angle: 90, flop: true },   // want: flop→rotate(270) ≡ rotate(−270=90)→flop
      6: { angle: 90, flop: false },
      7: { angle: 270, flop: true },  // want: flop→rotate(90) ≡ rotate(−90=270)→flop
      8: { angle: 270, flop: false },
    };
    const exif = EXIF_MAP[meta.orientation] || { angle: 0, flop: false };

    // Oriented source dimensions (post-EXIF)
    const orientSwaps = [5, 6, 7, 8].includes(meta.orientation);
    const srcW = orientSwaps ? meta.height : meta.width;
    const srcH = orientSwaps ? meta.width : meta.height;

    const discreteAngle = ((quarterTurns * 90) % 360 + 360) % 360;

    // Single pipeline merges EXIF + user transforms into one .rotate() call.
    let pipeline = sharp(sourcePath, { limitInputPixels: false, sequentialRead: true });

    const combinedDiscreteAngle = (exif.angle + discreteAngle) % 360;
    // XOR: EXIF flop and user flipX are both horizontal mirrors.
    const effectiveFlipX = exif.flop !== flipX;

    // Stage 1 — orientation + user quarter turns + flips. This is the basis the
    // editor's crop rect and free angle are expressed in (transformedPreview).
    // 0° still needs an explicit rotate(0) to suppress sharp's EXIF auto-orient.
    pipeline = pipeline.rotate(combinedDiscreteAngle);
    if (effectiveFlipX) pipeline = pipeline.flop();
    if (flipY) pipeline = pipeline.flip();

    // Post-orient + post-discrete-rotation dimensions
    let w = srcW;
    let h = srcH;
    if (discreteAngle === 90 || discreteAngle === 270) [w, h] = [h, w];

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
      pipeline = pipeline.extract({ left, top, width: Math.min(cw, bw - left), height: Math.min(ch, bh - top) });
    } else if (crop) {
      // Normalized crop → pixel rect
      const left = Math.max(0, Math.round(crop.x * w));
      const top = Math.max(0, Math.round(crop.y * h));
      const cw = Math.min(Math.round(w) - left, Math.max(1, Math.round(crop.width * w)));
      const ch = Math.min(Math.round(h) - top, Math.max(1, Math.round(crop.height * h)));
      pipeline = pipeline.extract({ left, top, width: cw, height: ch });
    }

    pipeline = pipeline.keepMetadata();

    const ext = path.extname(savePath).toLowerCase();
    if (ext === ".png") pipeline = pipeline.png();
    else if (ext === ".webp") pipeline = pipeline.webp({ quality });
    else pipeline = pipeline.jpeg({ quality });

    await fs.promises.mkdir(path.dirname(savePath), { recursive: true });
    const result = await pipeline.toFile(savePath);

    console.log(`[process-and-save] ${result.width}×${result.height} in ${Date.now() - t0}ms → ${savePath}`);
    return { path: savePath, width: result.width, height: result.height };
  }

  ipcMain.handle("workspace:process-and-save", (_event, options) => processAndSave(options));

  return { processAndSave };
}

module.exports = { register };
