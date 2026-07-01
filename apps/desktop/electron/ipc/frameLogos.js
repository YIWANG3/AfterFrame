// Frame logos IPC — serves the external-resource brand-logo set to the
// renderer. logos live in `frame-logos/` (extraResources, see package.json),
// resolved dev-vs-packaged exactly like `native/`. Returns the manifest plus
// every variant's raw SVG text, so the renderer can rasterize + tint them.

const fs = require("node:fs");
const path = require("node:path");
const { app } = require("electron");

function logosDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "frame-logos")
    : path.join(__dirname, "..", "..", "frame-logos");
}

function register({ ipcMain }) {
  ipcMain.handle("app:frame-logos", () => {
    const dir = logosDir();
    const manifestPath = path.join(dir, "logos.json");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return { manifest: { logos: [], match: {} }, svgs: {}, error: String(err?.message || err) };
    }
    const svgs = {};
    for (const brand of manifest.logos || []) {
      for (const variant of brand.variants || []) {
        if (!variant.file || svgs[variant.file]) continue;
        try {
          svgs[variant.file] = fs.readFileSync(path.join(dir, variant.file), "utf8");
        } catch {
          // skip a missing/unreadable variant; the renderer just won't show it
        }
      }
    }
    return { manifest, svgs };
  });
}

module.exports = { register };
