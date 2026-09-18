// Native OS drag-out: the renderer preventDefault()s the HTML5 dragstart and
// asks us to start a real OS drag session carrying file paths. The OS then
// handles every drop target for free — Finder copies the files, browsers /
// chat apps treat them as uploads. startDrag initiates the OS session but its
// return is not a drag-finished signal; the renderer clears its source marker
// from real input/window lifecycle events. Extracted from main.js (review
// 2026-09-16 §2); the icon math is unit-tested.

const fs = require("node:fs");

// Electron starts one NSDraggingItem per file, every one carrying the same
// icon at the same frame. macOS draws them all, so a 68-file drag stacks 68
// copies of one opaque thumbnail — the pile goes black and grows a heavy
// shadow halo. Pre-fade the icon so the N stacked copies composite back to
// one normal-looking image: per-copy alpha a with 1 − (1 − a)^N ≈ 0.92.
// Bitmap data round-trips premultiplied, so every channel scales together.
// The 192px source is re-wrapped at scaleFactor 2 → a sharp 96pt icon.
function pileAlpha(count) {
  return count > 1 ? 1 - Math.pow(1 - 0.92, 1 / count) : 1;
}

function pileSafeDragIcon(nativeImage, icon, count) {
  const size = icon.getSize();
  if (!size.width || !size.height) return icon;
  const alpha = pileAlpha(count);
  const bitmap = Buffer.from(icon.toBitmap());
  if (alpha < 1) for (let i = 0; i < bitmap.length; i++) bitmap[i] = Math.round(bitmap[i] * alpha);
  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height, scaleFactor: 2 });
}

// 1x1 transparent px — startDrag rejects an empty image on macOS.
const BLANK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function register({ ipcMain, nativeImage }) {
  ipcMain.handle("workspace:native-drag", (event, payload) => {
    const files = (Array.isArray(payload?.files) ? payload.files : [])
      .filter((p) => typeof p === "string" && p && fs.existsSync(p));
    if (!files.length) return { ok: false, reason: "no-files" };

    // macOS requires a drag icon. Prefer the item's preview (RAW originals
    // don't decode via nativeImage); fall back through the files themselves.
    let icon = nativeImage.createEmpty();
    const iconCandidates = [payload?.iconPath, ...files].filter(Boolean);
    for (const candidate of iconCandidates) {
      icon = nativeImage.createFromPath(candidate);
      if (!icon.isEmpty()) break;
    }
    icon = icon.isEmpty()
      ? nativeImage.createFromDataURL(BLANK_PNG)
      : pileSafeDragIcon(nativeImage, icon.resize({ width: 192 }), files.length);

    event.sender.startDrag({ files, icon });
    return { ok: true, count: files.length };
  });
}

module.exports = { register, pileSafeDragIcon, pileAlpha };
