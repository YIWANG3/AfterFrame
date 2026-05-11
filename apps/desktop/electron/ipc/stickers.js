// Sticker extraction & library — IPC handlers for the Sticker tool.
// Manifest-based storage at ~/Library/Application Support/AfterFrame/stickers/
// with a library.json index. Swift CLI (extract-sticker.swift) does the
// VisionKit segmentation; renderer bakes outline into the PNG before save.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const sharp = require("sharp");

const THUMB_MAX_EDGE = 512;

function register({ app, ipcMain, isPackaged, findSwiftRuntime }) {
  const stickerExtractScriptPath = isPackaged
    ? path.join(process.resourcesPath, "native", "extract-sticker.swift")
    : path.join(__dirname, "..", "..", "native", "extract-sticker.swift");

  const stickerLibraryDir = path.join(app.getPath("userData"), "stickers");
  try { fs.mkdirSync(stickerLibraryDir, { recursive: true }); } catch (_) {}

  function manifestPath() {
    return path.join(stickerLibraryDir, "library.json");
  }
  function thumbFilenameFor(sha) { return `${sha}_thumb.png`; }
  function thumbPathFor(sha) { return path.join(stickerLibraryDir, thumbFilenameFor(sha)); }

  // Generate a 512px-max-edge thumbnail next to the full sticker. Stickers
  // smaller than the cap are copied as-is so the renderer never has to fall
  // back to the full file for grid views.
  async function generateThumb(fullPath, sha) {
    const outPath = thumbPathFor(sha);
    const meta = await sharp(fullPath, { limitInputPixels: false }).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w <= THUMB_MAX_EDGE && h <= THUMB_MAX_EDGE) {
      await fs.promises.copyFile(fullPath, outPath);
    } else {
      await sharp(fullPath, { limitInputPixels: false })
        .resize({ width: THUMB_MAX_EDGE, height: THUMB_MAX_EDGE, fit: "inside", withoutEnlargement: true })
        .png({ compressionLevel: 8 })
        .toFile(outPath);
    }
    return { filename: thumbFilenameFor(sha), path: outPath };
  }
  function readLibrary() {
    try {
      return JSON.parse(fs.readFileSync(manifestPath(), "utf-8"));
    } catch {
      return { stickers: [] };
    }
  }
  // Serialize manifest writes so concurrent saves can't trash the JSON.
  let writeQueue = Promise.resolve();
  async function writeLibrary(data) {
    await fs.promises.mkdir(stickerLibraryDir, { recursive: true });
    await fs.promises.writeFile(manifestPath(), `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }
  function updateLibrary(mutate) {
    writeQueue = writeQueue.then(async () => {
      const lib = readLibrary();
      const next = mutate(lib) || lib;
      await writeLibrary(next);
      return next;
    });
    return writeQueue;
  }

  // Lazy backfill: any entry missing a thumb (or whose thumb file vanished)
  // gets one generated and the manifest is rewritten once at the end.
  ipcMain.handle("workspace:sticker-list", async () => {
    const lib = readLibrary();
    const stickers = Array.isArray(lib.stickers) ? lib.stickers : [];
    let dirty = false;
    for (const s of stickers) {
      const expected = thumbPathFor(s.id);
      const has = s.thumbPath && fs.existsSync(s.thumbPath);
      if (has) continue;
      if (!s.path || !fs.existsSync(s.path)) continue; // orphan entry — skip
      try {
        const thumb = await generateThumb(s.path, s.id);
        s.thumbFilename = thumb.filename;
        s.thumbPath = thumb.path;
        dirty = true;
      } catch (err) {
        console.warn("[stickers] thumb backfill failed for", s.id, err?.message || err);
      }
    }
    if (dirty) {
      await updateLibrary(() => ({ ...lib, stickers }));
    }
    return stickers;
  });

  // Run swift segmentation, return manifest + extracted instance PNG paths.
  // Caller cleans up the scratch dir via sticker-cleanup-scratch.
  //
  // Optional `region` (normalized 0..1 {x,y,w,h}) constrains detection to a
  // sub-rect — useful when VisionKit can't find a small subject in the
  // full frame but succeeds when the subject fills more of it.
  ipcMain.handle("workspace:sticker-detect", async (_event, options) => {
    if (process.platform !== "darwin") {
      throw new Error("Sticker extraction requires macOS.");
    }
    const sourcePath = String(options?.sourcePath || "");
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw new Error(`Source not found: ${sourcePath}`);
    }
    if (!fs.existsSync(stickerExtractScriptPath)) {
      throw new Error(`Sticker script missing at ${stickerExtractScriptPath}`);
    }

    const scratchDir = path.join(
      app.getPath("temp"),
      `afterframe-sticker-${crypto.randomBytes(6).toString("hex")}`,
    );
    fs.mkdirSync(scratchDir, { recursive: true });

    // Region pre-crop: feed swift a cropped image instead of the full source.
    let inputForSwift = sourcePath;
    const region = options?.region;
    if (region && Number.isFinite(region.x) && Number.isFinite(region.w) && region.w > 0 && region.h > 0) {
      const croppedPath = path.join(scratchDir, "cropped.png");
      const meta = await sharp(sourcePath, { limitInputPixels: false }).metadata();
      const sw = meta.width || 0;
      const sh = meta.height || 0;
      const cropX = Math.max(0, Math.round(region.x * sw));
      const cropY = Math.max(0, Math.round(region.y * sh));
      const cropW = Math.min(sw - cropX, Math.round(region.w * sw));
      const cropH = Math.min(sh - cropY, Math.round(region.h * sh));
      if (cropW < 32 || cropH < 32) {
        throw new Error("Selection is too small.");
      }
      await sharp(sourcePath, { limitInputPixels: false })
        .extract({ left: cropX, top: cropY, width: cropW, height: cropH })
        .png()
        .toFile(croppedPath);
      inputForSwift = croppedPath;
    }

    const runtime = findSwiftRuntime();
    const env = { ...process.env };
    if (runtime.developerDir) env.DEVELOPER_DIR = runtime.developerDir;

    await new Promise((resolve, reject) => {
      const child = spawn(runtime.binary, [stickerExtractScriptPath, inputForSwift, scratchDir], { env });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(stderr.trim() || `Extraction failed (exit ${code}).`));
        else resolve();
      });
    });

    const swiftManifestPath = path.join(scratchDir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(swiftManifestPath, "utf-8"));
    } catch {
      throw new Error("Extraction produced no manifest");
    }
    const instances = (manifest.instances || []).map((entry) => ({
      ...entry,
      absolutePath: path.join(scratchDir, entry.filename),
    }));
    return {
      scratchDir,
      sourcePath,
      sourceWidth: manifest.sourceWidth,
      sourceHeight: manifest.sourceHeight,
      instances,
    };
  });

  // Promote finished PNG bytes (outline already baked) into the permanent
  // library and return the catalog entry.
  ipcMain.handle("workspace:sticker-save", async (_event, options) => {
    const buffer = options?.bytes;
    if (!buffer) throw new Error("Missing sticker bytes");
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const sha = crypto.createHash("sha1").update(bytes).digest("hex");
    const filename = `${sha}.png`;
    const fullPath = path.join(stickerLibraryDir, filename);
    await fs.promises.writeFile(fullPath, bytes);

    let thumbFilename = null;
    let thumbPath = null;
    try {
      const thumb = await generateThumb(fullPath, sha);
      thumbFilename = thumb.filename;
      thumbPath = thumb.path;
    } catch (err) {
      console.warn("[stickers] thumb generation failed for", sha, err?.message || err);
    }

    const entry = {
      id: sha,
      filename,
      path: fullPath,
      thumbFilename,
      thumbPath,
      name: options?.name || null,
      width: Number(options?.width) || null,
      height: Number(options?.height) || null,
      sourcePath: options?.sourcePath || null,
      sourceLabel: options?.sourceLabel || null,
      instanceIndex: Number.isFinite(options?.instanceIndex) ? options.instanceIndex : 0,
      outlineWidth: Number(options?.outlineWidth) || 0,
      outlineColor: options?.outlineColor || "#ffffff",
      starred: false,
      createdAt: new Date().toISOString(),
    };
    await updateLibrary((lib) => {
      const stickers = Array.isArray(lib.stickers) ? lib.stickers : [];
      // Dedupe by id (same content). Move to front if already present.
      const filtered = stickers.filter((s) => s.id !== sha);
      return { ...lib, stickers: [entry, ...filtered] };
    });
    return entry;
  });

  ipcMain.handle("workspace:sticker-delete", async (_event, stickerId) => {
    if (!stickerId) return false;
    let removed = null;
    await updateLibrary((lib) => {
      const stickers = Array.isArray(lib.stickers) ? lib.stickers : [];
      removed = stickers.find((s) => s.id === stickerId) || null;
      return { ...lib, stickers: stickers.filter((s) => s.id !== stickerId) };
    });
    if (removed?.path) {
      try { await fs.promises.unlink(removed.path); } catch (_) {}
    }
    if (removed?.thumbPath) {
      try { await fs.promises.unlink(removed.thumbPath); } catch (_) {}
    } else if (removed?.id) {
      try { await fs.promises.unlink(thumbPathFor(removed.id)); } catch (_) {}
    }
    return !!removed;
  });

  ipcMain.handle("workspace:sticker-toggle-star", async (_event, stickerId) => {
    let next = null;
    await updateLibrary((lib) => {
      const stickers = Array.isArray(lib.stickers) ? lib.stickers : [];
      const updated = stickers.map((s) => {
        if (s.id !== stickerId) return s;
        next = { ...s, starred: !s.starred };
        return next;
      });
      return { ...lib, stickers: updated };
    });
    return next;
  });

  ipcMain.handle("workspace:sticker-cleanup-scratch", async (_event, scratchDir) => {
    if (!scratchDir) return false;
    if (!scratchDir.includes("afterframe-sticker-")) return false; // safety
    try {
      await fs.promises.rm(scratchDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  });
}

module.exports = { register };
