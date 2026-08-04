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

// Canvas fillStyle for an angled linear gradient across a WxH box — one home
// for the angle→vector math (0deg = up, CSS convention) shared by text fills,
// the border background and the save path.
export function angledLinearGradient(ctx, { angle = 180, from, to, fromOpacity = 1, toOpacity = 1 }, W, H) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
  const grad = ctx.createLinearGradient(W / 2 - dx * half, H / 2 - dy * half, W / 2 + dx * half, H / 2 + dy * half);
  grad.addColorStop(0, hexToRgba(from || "#ffffff", fromOpacity));
  grad.addColorStop(1, hexToRgba(to || "#000000", toOpacity));
  return grad;
}

// Canvas background (the border area) → a CSS value. Solid color or a linear
// gradient (same angle convention as text gradients: 0deg = up). Shared by the
// live preview and the border-controls swatch so they can't diverge.
export function bgToCss(bg) {
  if (bg?.mode === "gradient" && bg.gradient) {
    const g = bg.gradient;
    return `linear-gradient(${g.angle ?? 180}deg, ${hexToRgba(g.from || "#fff", g.fromOpacity ?? 1)}, ${hexToRgba(g.to || "#000", g.toOpacity ?? 1)})`;
  }
  return bg?.color || "#ffffff";
}

// Optional edge scrim over the photo — keeps on-photo (overlay preset) text
// legible regardless of how bright the photo is at the edge. `rect` is the
// photo's rect on the target canvas; heights are fractions of it. Shared by
// the frame engine, the unified save path and preset generation.
export function drawScrim(ctx, scrim, rect) {
  if (!scrim) return;
  // Fill scrim — full-photo wash (solid or angled gradient) used to dim the
  // image behind text. `opacity` is the overall 0-100 slider; gradient stops
  // carry their own 0-1 alphas. Must stay pixel-identical to the live-preview
  // CSS in EditorOverlay (scrimToCss + element opacity).
  if (scrim.kind === "fill") {
    ctx.save();
    ctx.globalAlpha = (scrim.opacity ?? 100) / 100;
    ctx.translate(rect.x, rect.y);
    if (scrim.mode === "gradient" && scrim.gradient) {
      const g = scrim.gradient;
      ctx.fillStyle = angledLinearGradient(
        ctx,
        {
          angle: g.angle ?? 180,
          from: g.from ?? "#000000",
          fromOpacity: g.fromOpacity ?? 0,
          to: g.to ?? "#000000",
          toOpacity: g.toOpacity ?? 0.7,
        },
        rect.width,
        rect.height
      );
    } else {
      ctx.fillStyle = scrim.color ?? "#000000";
    }
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.restore();
    return;
  }
  const sh = (scrim.height ?? 0.3) * rect.height;
  const top = scrim.edge === "top";
  const y0 = top ? rect.y : rect.y + rect.height - sh;
  const grad = ctx.createLinearGradient(0, y0, 0, y0 + sh);
  // gradient runs dark→transparent away from the edge it hugs
  grad.addColorStop(0, top ? (scrim.to ?? "rgba(0,0,0,0.5)") : (scrim.from ?? "rgba(0,0,0,0)"));
  grad.addColorStop(1, top ? (scrim.from ?? "rgba(0,0,0,0)") : (scrim.to ?? "rgba(0,0,0,0.5)"));
  ctx.fillStyle = grad;
  ctx.fillRect(rect.x, y0, rect.width, sh);
}

// Scrim → CSS for the live preview (must match drawScrim's canvas output).
// Fill scrims: pair this background with `opacity: (scrim.opacity ?? 100)/100`
// on the element (mirrors drawScrim's globalAlpha).
export function scrimToCss(scrim) {
  if (scrim?.kind === "fill") {
    if (scrim.mode === "gradient" && scrim.gradient) {
      const g = scrim.gradient;
      return `linear-gradient(${g.angle ?? 180}deg, ${hexToRgba(g.from ?? "#000000", g.fromOpacity ?? 0)}, ${hexToRgba(g.to ?? "#000000", g.toOpacity ?? 0.7)})`;
    }
    return scrim.color ?? "#000000";
  }
  const top = scrim?.edge === "top";
  const from = scrim?.from ?? "rgba(0,0,0,0)";
  const to = scrim?.to ?? "rgba(0,0,0,0.5)";
  return top
    ? `linear-gradient(180deg, ${to}, ${from})`
    : `linear-gradient(180deg, ${from}, ${to})`;
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

// Field-resolution alpha mask off the depth field.
// White (alpha 255) where the depth field is < zPosition (text shows through);
// transparent where depth is > zPosition (text is hidden behind nearer pixels).
// `depthCanvas` is the 518×392 grayscale depth field (R=G=B=depth, 0=far, 255=near).
export function buildDepthAlphaMask(depthCanvas, zPosition, feather) {
  const dW = depthCanvas.width;
  const dH = depthCanvas.height;
  const data = depthCanvas.getContext("2d").getImageData(0, 0, dW, dH).data;
  const z = Math.max(0, Math.min(1, zPosition));
  const f = Math.max(0, Math.min(0.5, feather));
  // Clamp the feather window to [0,1] so the ramp doesn't extend past the
  // valid depth range — otherwise pixels at depth 0 (or 1) land in the middle
  // of the ramp and get partial alpha. Must match TextCanvas.getMaskUrl.
  const lo = Math.max(0, z - f / 2);
  const hi = Math.min(1, z + f / 2);
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
  return small;
}

// Full-output depth mask: the photo's depth field is stretched over the given
// canvas size. Valid when the output IS the photo (pad=0, no crop) — padded /
// cropped outputs must map the field onto the photo sub-rect instead (see
// saveImage's composed mask).
export function buildDepthMaskCanvas(depthCanvas, outW, outH, zPosition, feather) {
  const small = buildDepthAlphaMask(depthCanvas, zPosition, feather);
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
