// The picture the editor edits and saves from, for a RAW (workspace:raw-edit-source).
//
// A RAW's HD preview is the camera's embedded JPEG whenever that is 2000 px or
// more (#149). Most cameras embed it at full size, but a Fuji GFX embeds
// 4000×3000 of an 11648×8735 sensor and a Hasselblad X2D 3888×2918, so an
// untouched save from the editor came out at a tenth of the pixels. When the
// HD falls short of the RAW's own size, the sidecar renders the RAW at full
// size (Image I/O on macOS, LibRaw otherwise), once, into a small cache in
// userData. The camera's own look (film simulations and the like) is not kept:
// a deliberate trade, since editing RAWs here is meant to be occasional.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Renders kept: enough to go back to the last few RAWs, not a second library.
const CACHE_KEEP = 6;

// Does the HD preview fall short of the RAW? Long edges are compared, so the
// orientation doesn't matter, with a little slack for the cropped borders
// renderers disagree on (11648×8736 from Image I/O, 11648×8735 from LibRaw).
function fullRenderNeeded(hdSize, rawSize) {
  const rawLong = Math.max(Number(rawSize?.width) || 0, Number(rawSize?.height) || 0);
  const hdLong = Math.max(Number(hdSize?.width) || 0, Number(hdSize?.height) || 0);
  if (!rawLong) return false; // nothing to compare against: keep the HD
  return hdLong < rawLong * 0.98;
}

// A render belongs to one version of one file.
function cacheName(rawPath, stat) {
  const key = crypto.createHash("sha1").update(`${rawPath}|${stat.size}|${stat.mtimeMs}`).digest("hex");
  return `${key.slice(0, 24)}.jpg`;
}

// Keeps the most recently used renders and deletes the rest.
function pruneCache(dir, keep = CACHE_KEEP) {
  let entries;
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".jpg") && !name.startsWith("."))
      .map((name) => ({ file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }));
  } catch {
    return [];
  }
  const stale = entries.sort((a, b) => b.mtime - a.mtime).slice(keep);
  for (const { file } of stale) fs.rmSync(file, { force: true });
  return stale.map(({ file }) => file);
}

module.exports = { CACHE_KEEP, cacheName, fullRenderNeeded, pruneCache };
