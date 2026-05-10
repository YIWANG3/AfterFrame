// File output IPC: native save dialog, raw save-image (canvas blob → disk),
// and the high-resolution process-and-save fast-path (sharp-based rotate +
// flip + crop, with EXIF orientation handling, no canvas in the loop).

const path = require("path");
const fs = require("fs");
const os = require("os");
const sharp = require("sharp");

function register({
  ipcMain,
  dialog,
  rootDir,
  writeImageWithSourceMetadata,
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

  ipcMain.handle("workspace:save-image", async (_event, targetPath, arrayBuffer, sourceMetadataPath) => {
    if (!targetPath) throw new Error("Missing target path");
    const output = Buffer.from(arrayBuffer);
    return await writeImageWithSourceMetadata(targetPath, output, sourceMetadataPath);
  });

  // Sharp-based "fast path" — bypasses canvas entirely and works at the
  // source's native resolution. Used by the editor when there are no overlay
  // layers (just rotate/flip/crop on the original image).
  ipcMain.handle("workspace:process-and-save", async (_event, options) => {
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

    let tmpPath = null;
    try {
      // Single pipeline merges EXIF + user transforms into one .rotate() call.
      let pipeline = sharp(sourcePath, { limitInputPixels: false, sequentialRead: true });

      const combinedDiscreteAngle = (exif.angle + discreteAngle) % 360;
      // XOR: EXIF flop and user flipX are both horizontal mirrors.
      const effectiveFlipX = exif.flop !== flipX;

      const totalAngle = combinedDiscreteAngle + freeAngle;
      if (totalAngle !== 0) {
        if (freeAngle === 0) {
          pipeline = pipeline.rotate(combinedDiscreteAngle);
        } else {
          pipeline = pipeline.rotate(totalAngle, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
        }
      } else {
        // 0° but still need to suppress EXIF auto-orient
        pipeline = pipeline.rotate(0);
      }

      if (effectiveFlipX) pipeline = pipeline.flop();
      if (flipY) pipeline = pipeline.flip();

      // Track post-orient + post-discrete-rotation dimensions
      let w = srcW;
      let h = srcH;
      if (discreteAngle === 90 || discreteAngle === 270) [w, h] = [h, w];

      // Free-angle dimension expansion
      if (freeAngle !== 0) {
        const rad = (freeAngle * Math.PI) / 180;
        const c = Math.abs(Math.cos(rad));
        const s = Math.abs(Math.sin(rad));
        const newW = w * c + h * s;
        const newH = w * s + h * c;
        w = newW;
        h = newH;
      }

      // Normalized crop → pixel rect
      if (crop) {
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
    } finally {
      if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
    }
  });
}

module.exports = { register };
