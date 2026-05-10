// Pure canvas / image helpers used by the editor render + export pipeline.
// No React, no closures — all inputs are passed explicitly.

import { fileName } from "../../../utils/format";

const PREVIEW_MAX_EDGE = 2200;

export function hexToRgba(hex, alpha = 1) {
  const h = String(hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function getSourceDimensions(source) {
  return {
    width: Number(source?.naturalWidth || source?.width || 0),
    height: Number(source?.naturalHeight || source?.height || 0),
  };
}

export function releaseCanvasImage(source) {
  if (!source || typeof source.width !== "number") return;
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) return;
  source.width = 0;
  source.height = 0;
}

export function buildPreviewSource(image) {
  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(image);
  const maxEdge = Math.max(sourceWidth, sourceHeight);
  const scale = maxEdge > PREVIEW_MAX_EDGE ? PREVIEW_MAX_EDGE / maxEdge : 1;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.naturalWidth = width;
  canvas.naturalHeight = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

// Build an alpha-only mask canvas at the requested output size.
// White (alpha 255) where the depth field is < zPosition (text shows through);
// black where depth is > zPosition (text is hidden behind nearer pixels).
// `depthCanvas` is the 518×392 grayscale depth field (R=G=B=depth, 0=far, 255=near).
export function buildDepthMaskCanvas(depthCanvas, outW, outH, zPosition, feather) {
  const dW = depthCanvas.width;
  const dH = depthCanvas.height;
  const dCtx = depthCanvas.getContext("2d");
  const data = dCtx.getImageData(0, 0, dW, dH).data;
  const z = Math.max(0, Math.min(1, zPosition));
  const f = Math.max(0, Math.min(0.5, feather));
  const lo = z - f / 2;
  const hi = z + f / 2;
  const small = document.createElement("canvas");
  small.width = dW;
  small.height = dH;
  const sCtx = small.getContext("2d");
  const out = sCtx.createImageData(dW, dH);
  for (let i = 0; i < dW * dH; i++) {
    const d = data[i * 4] / 255;
    let alpha;
    if (d <= lo) alpha = 1;
    else if (d >= hi) alpha = 0;
    else alpha = 1 - (d - lo) / (hi - lo);
    const p = i * 4;
    out.data[p] = 255;
    out.data[p + 1] = 255;
    out.data[p + 2] = 255;
    out.data[p + 3] = Math.round(alpha * 255);
  }
  sCtx.putImageData(out, 0, 0);
  const big = document.createElement("canvas");
  big.width = outW;
  big.height = outH;
  const bCtx = big.getContext("2d");
  bCtx.imageSmoothingEnabled = true;
  bCtx.imageSmoothingQuality = "high";
  bCtx.drawImage(small, 0, 0, outW, outH);
  return big;
}

export function buildTransformedCanvas(source, width, height, rotationDeg, flipX, flipY) {
  const radians = (rotationDeg * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * absCos + height * absSin));
  canvas.height = Math.max(1, Math.round(width * absSin + height * absCos));
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.translate(canvas.width / 2, canvas.height / 2);
  context.rotate(radians);
  context.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  context.drawImage(source, -width / 2, -height / 2, width, height);
  return canvas;
}

export function deriveEditedFileName(sourcePath, preferredExt = null) {
  const originalName = fileName(sourcePath || "image.jpg");
  const dotIndex = originalName.lastIndexOf(".");
  const stem = dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName;
  const originalExt = dotIndex > 0 ? originalName.slice(dotIndex + 1).toLowerCase() : "";
  const ext = preferredExt || (["jpg", "jpeg", "png", "webp"].includes(originalExt) ? originalExt : "jpg");
  return `${stem}_edited.${ext}`;
}

export function replaceFileName(targetPath, nextFileName) {
  if (!targetPath) return nextFileName;
  const slashIndex = Math.max(targetPath.lastIndexOf("/"), targetPath.lastIndexOf("\\"));
  if (slashIndex < 0) return nextFileName;
  return `${targetPath.slice(0, slashIndex + 1)}${nextFileName}`;
}

export function inferMimeType(filePath) {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

export function canvasToBlob(canvas, mimeType) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Failed to encode canvas"));
    }, mimeType, mimeType === "image/png" ? undefined : 0.92);
  });
}
