// The media:// scheme: images (and anything that is not video) come to the
// renderer through here, gated by the allowlist. Originals Chromium cannot
// decode but the format registry marks `transcode_for_browser` (HEIF, PSD,
// TIFF) are rendered to a full-size JPEG on first request — with macOS `sips`,
// or elsewhere with the `convert` main.js passes (the sidecar's Pillow) — and
// cached under userData, keyed by path + mtime + size, the most recently used
// kept within a byte budget. The render is what the lightbox's detail layer,
// Compare and the editor's canvas get in the original's place, so it keeps
// what the original had: JPEG 95, the ICC profile, the EXIF. Video goes
// through ./httpServer.js instead (see there). Extracted from main.js
// (review 2026-09-16 §2).

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

// The originals media:// renders to a JPEG first, from the format registry.
const { TRANSCODE_RE } = require("../../shared/formats.mjs");

// Near-lossless, as the render stands in for the original in the editor too;
// about a quarter bigger than sips' default.
const TRANSCODE_JPEG_QUALITY = 95;
// Renders kept: a 48-megapixel HEIF makes a 25 MB JPEG, so this is some forty
// recent photos, not a second library.
const CACHE_BUDGET_BYTES = 1024 ** 3;

// macOS: Image I/O through sips, which carries the ICC profile and the EXIF over.
async function sipsToJpeg(srcPath, outPath, { quality = TRANSCODE_JPEG_QUALITY } = {}) {
  const result = spawnSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), srcPath, "--out", outPath], {
    timeout: 30000,
  });
  if (result.status !== 0) throw new Error(`sips failed: ${result.stderr?.toString() || result.error?.message}`);
}

// Deletes the least recently used renders until the rest fit the budget.
// Returns what it deleted.
function pruneTranscodeCache(cacheDir, budgetBytes = CACHE_BUDGET_BYTES) {
  let entries;
  try {
    entries = fs.readdirSync(cacheDir)
      .filter((name) => name.endsWith(".jpg") && !name.startsWith("."))
      .map((name) => {
        const file = path.join(cacheDir, name);
        const stat = fs.statSync(file);
        return { file, size: stat.size, mtime: stat.mtimeMs };
      });
  } catch {
    return [];
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  const stale = [];
  for (const entry of entries) {
    total += entry.size;
    if (total > budgetBytes) stale.push(entry.file);
  }
  for (const file of stale) fs.rmSync(file, { force: true });
  return stale;
}

// convert(srcPath, outPath, { quality }) writes the JPEG. Requests for the
// same file while it converts share one conversion; the JPEG is written beside
// its final name and renamed in, so a reader never sees half of it.
function createTranscoder({ cacheDir, convert = sipsToJpeg, quality = TRANSCODE_JPEG_QUALITY, budgetBytes = CACHE_BUDGET_BYTES }) {
  const converting = new Map();
  return async function transcodeToJpeg(srcPath) {
    try {
      const stat = fs.statSync(srcPath);
      const key = crypto
        .createHash("md5")
        .update(`${srcPath}:${stat.mtimeMs}:${stat.size}`)
        .digest("hex");
      const outPath = path.join(cacheDir, `${key}.jpg`);
      if (fs.existsSync(outPath)) {
        const now = new Date();
        fs.utimesSync(outPath, now, now); // most recently used
        return outPath;
      }
      fs.mkdirSync(cacheDir, { recursive: true });
      if (!converting.has(outPath)) {
        const partial = path.join(cacheDir, `.${key}.${process.pid}.partial.jpg`);
        const job = Promise.resolve(convert(srcPath, partial, { quality }))
          .then(() => {
            fs.renameSync(partial, outPath);
            pruneTranscodeCache(cacheDir, budgetBytes);
          })
          .finally(() => {
            fs.rmSync(partial, { force: true });
            converting.delete(outPath);
          });
        converting.set(outPath, job);
      }
      await converting.get(outPath);
      if (fs.existsSync(outPath)) return outPath;
    } catch (err) {
      console.error("[media] transcode failed:", err?.message || err);
    }
    return null;
  };
}

// Must run after app.whenReady(). `allowlist` is ./allowlist.js; `cacheDir`
// must be under it.
function registerMediaProtocol({ protocol, net, allowlist, cacheDir, convert }) {
  const transcodeToJpeg = createTranscoder({ cacheDir, convert });
  protocol.handle("media", async (request) => {
    // Strip any ?query — the renderer appends a cache-bust token (?r=…) to force
    // an <img> reload after a preview file is regenerated in place; it's not part
    // of the file path.
    const raw = request.url.slice("media://".length).split("?")[0];
    const filePath = raw.split("/").map((seg) => decodeURIComponent(seg)).join(path.sep);
    const resolved = path.resolve(filePath);
    if (!(await allowlist.isAllowedMediaPathLoaded(resolved))) {
      console.warn("[media] blocked path outside allowlist:", resolved);
      return new Response("forbidden", { status: 403 });
    }
    const existsOnDisk = fs.existsSync(resolved);
    if (existsOnDisk && TRANSCODE_RE.test(resolved)) {
      const jpeg = await transcodeToJpeg(resolved);
      if (jpeg) return net.fetch(pathToFileURL(jpeg).toString());
      // Fall through to original on failure (will surface the load error).
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

module.exports = { registerMediaProtocol, createTranscoder, pruneTranscodeCache, TRANSCODE_JPEG_QUALITY };
