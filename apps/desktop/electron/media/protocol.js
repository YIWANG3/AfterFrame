// The media:// scheme: images (and anything that is not video) come to the
// renderer through here, gated by the allowlist. HEIC/HEIF originals are
// transcoded to JPEG with macOS `sips` on first request and cached on disk,
// keyed by path + mtime + size, because Chromium cannot decode them. Video
// goes through ./httpServer.js instead (see there). Extracted from main.js
// (review 2026-09-16 §2).

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const HEIC_RE = /\.(heic|heif)$/i;

function createHeicTranscoder({ cacheDir }) {
  return function transcodeHeicToJpeg(srcPath) {
    try {
      const stat = fs.statSync(srcPath);
      const key = crypto
        .createHash("md5")
        .update(`${srcPath}:${stat.mtimeMs}:${stat.size}`)
        .digest("hex");
      const outPath = path.join(cacheDir, `${key}.jpg`);
      if (fs.existsSync(outPath)) return outPath;
      fs.mkdirSync(cacheDir, { recursive: true });
      const result = spawnSync("sips", ["-s", "format", "jpeg", srcPath, "--out", outPath], {
        timeout: 30000,
      });
      if (result.status === 0 && fs.existsSync(outPath)) return outPath;
      console.error("[media] sips HEIC transcode failed:", result.stderr?.toString());
    } catch (err) {
      console.error("[media] HEIC transcode error:", err);
    }
    return null;
  };
}

// Must run after app.whenReady(). `allowlist` is ./allowlist.js.
function registerMediaProtocol({ protocol, net, allowlist, heicCacheDir }) {
  const transcodeHeicToJpeg = createHeicTranscoder({ cacheDir: heicCacheDir });
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
    if (existsOnDisk && HEIC_RE.test(resolved)) {
      const jpeg = transcodeHeicToJpeg(resolved);
      if (jpeg) return net.fetch(pathToFileURL(jpeg).toString());
      // Fall through to original on failure (will surface the load error).
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

module.exports = { registerMediaProtocol, createHeicTranscoder, HEIC_RE };
