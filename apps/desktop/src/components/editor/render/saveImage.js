// Export pipeline — turns the editor's current state into a saved file on disk.
// Pure function: every dependency is passed in. Used by both `handleQuickSave`
// and `handleExport` in EditorOverlay.

import {
  getSourceDimensions,
  buildTransformedCanvas,
  buildDepthAlphaMask,
  angledLinearGradient,
  drawScrim,
  canvasToBlob,
  inferMimeType,
  releaseCanvasImage,
} from "./canvasHelpers";
import { hasPad, getOutputDimensions } from "../imageMath";

// Canvas fillStyle for the border background — solid color or a linear gradient
// across the WxH output (same angle convention as the live preview / text).
function bgFillStyle(ctx, bg, W, H) {
  if (bg?.mode === "gradient" && bg.gradient) {
    const g = bg.gradient;
    return angledLinearGradient(ctx, {
      angle: g.angle ?? 180, from: g.from, to: g.to,
      fromOpacity: g.fromOpacity ?? 1, toOpacity: g.toOpacity ?? 1,
    }, W, H);
  }
  return bg?.color || "#ffffff";
}

/**
 * Save the current editor composition to `savePath`. Tries native sharp first
 * (no overlay layers), falls back to canvas-based composition when text/sticker
 * layers exist.
 *
 * @param {object} ctx - all the editor state needed to render
 * @returns {Promise<void>} resolves on success; throws on failure
 */
export async function saveEditedImage(ctx) {
  const {
    savePath,
    sourcePath,
    sourceImage,
    transformedPreview,
    rotationDeg,
    quarterTurns,
    freeAngle,
    flipX,
    flipY,
    normalizedCrop,
    canvasPad,
    canvasBg,
    canvasScrim,
    layers,
    depthFieldCanvas,
    depthFeather,
    drawLayersToCtx,
    nativeSaveSourcePath,
    isLayerRenderable,
  } = ctx;

  const padActive = hasPad(canvasPad);

  // Native sharp fast-path: full source resolution, no canvas overhead. Only
  // valid when there are zero overlay layers AND no canvas margin/scrim (sharp
  // can't do the padded-canvas composite).
  if (window.mediaWorkspace?.processAndSave && nativeSaveSourcePath && layers.length === 0 && !padActive && !canvasScrim) {
    try {
      await window.mediaWorkspace.processAndSave({
        sourcePath: nativeSaveSourcePath,
        savePath,
        quarterTurns,
        freeAngle,
        flipX,
        flipY,
        crop: normalizedCrop,
        quality: 92,
      });
      // Catalog registration is a nice-to-have — if it fails (no catalog
      // loaded, sidecar down) we still consider the save successful.
      try { await window.mediaWorkspace.quickRegister?.(savePath, sourcePath); }
      catch (e) { console.warn("[saveImage] quickRegister skipped:", e?.message || e); }
      return;
    } catch (nativeError) {
      console.error("[saveImage] Native sharp save failed, falling back to canvas:", nativeError);
    }
  }

  // Canvas fallback — limited to `sourceImage` resolution (which may have been
  // downsampled for preview), but supports overlay layers.
  if (!sourceImage || !transformedPreview) {
    throw new Error("Image not loaded");
  }

  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
  const transformedFull = buildTransformedCanvas(
    sourceImage, sourceWidth, sourceHeight, rotationDeg, flipX, flipY,
  );

  const fullW = transformedFull.width;
  const fullH = transformedFull.height;
  const isSticker = (layer) => layer?.type === "sticker";

  // The photo region cut out of `transformedFull` — the crop when one is
  // active, else the whole photo. Rounded exactly like the preview basis
  // (getOutputDimensions/getContentDims) so both pipelines share pixels.
  const contentSrc = normalizedCrop
    ? {
        x: Math.round(normalizedCrop.x * fullW),
        y: Math.round(normalizedCrop.y * fullH),
        width: Math.max(1, Math.round(normalizedCrop.width * fullW)),
        height: Math.max(1, Math.round(normalizedCrop.height * fullH)),
      }
    : { x: 0, y: 0, width: fullW, height: fullH };

  // Two output shapes:
  //  • pad active → output = cropped photo + margins (bg-filled)
  //  • else       → output = the crop rect
  // Layers are STORED in full-photo coords; a single mapLayer (below) projects
  // them into whichever output shape this is — no per-shape branching.
  const outputCanvas = document.createElement("canvas");
  let compW, compH, outCtx, contentRect;

  if (padActive) {
    const short = Math.min(contentSrc.width, contentSrc.height);
    const dims = getOutputDimensions({ width: fullW, height: fullH }, canvasPad, normalizedCrop);
    compW = dims.width;
    compH = dims.height;
    contentRect = {
      x: canvasPad.left * short,
      y: canvasPad.top * short,
      width: contentSrc.width,
      height: contentSrc.height,
    };
    outputCanvas.width = compW;
    outputCanvas.height = compH;
    outCtx = outputCanvas.getContext("2d");
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.fillStyle = bgFillStyle(outCtx, canvasBg, compW, compH);
    outCtx.fillRect(0, 0, compW, compH);
    outCtx.drawImage(
      transformedFull,
      contentSrc.x, contentSrc.y, contentSrc.width, contentSrc.height,
      contentRect.x, contentRect.y, contentRect.width, contentRect.height,
    );
  } else {
    compW = contentSrc.width;
    compH = contentSrc.height;
    contentRect = { x: 0, y: 0, width: compW, height: compH };
    outputCanvas.width = compW;
    outputCanvas.height = compH;
    outCtx = outputCanvas.getContext("2d");
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(transformedFull, contentSrc.x, contentSrc.y, compW, compH, 0, 0, compW, compH);
  }

  // Project a full-photo-coord layer into the output canvas: the photo content
  // is drawn at native scale inside contentRect, so a photo pixel (X,Y) lands at
  // contentRect + (photo pixel − crop origin). Sizes are photo-width-relative,
  // rescaled to the output's 1920-ref (k = fullW / compW) so the saved layer
  // keeps the size shown relative to the photo. One mapping for both shapes.
  const mapLayer = (layer) => {
    if (layer.type === "overlay") {
      return {
        ...layer,
        overlayRect: {
          x: contentRect.x / compW,
          y: contentRect.y / compH,
          width: contentRect.width / compW,
          height: contentRect.height / compH,
        },
      };
    }
    const X = layer.x * fullW;
    const Y = layer.y * fullH;
    const k = fullW / compW;
    const resize = isSticker(layer)
      ? { scale: (layer.scale ?? 0.4) * k }
      : {
          fontSize: (layer.fontSize ?? 0) * k,
          shadowBlur: (layer.shadowBlur ?? 0) * k,
          shadowX: (layer.shadowX ?? 0) * k,
          shadowY: (layer.shadowY ?? 0) * k,
          strokeWidth: (layer.strokeWidth ?? 0) * k,
        };
    return {
      ...layer,
      x: (contentRect.x + X - contentSrc.x) / compW,
      y: (contentRect.y + Y - contentSrc.y) / compH,
      ...resize,
    };
  };

  // Overlay presets darken the photo edge so on-photo text stays legible.
  drawScrim(outCtx, canvasScrim, contentRect);

  // Depth mask on the OUTPUT canvas: the field maps onto the photo content
  // sub-rect; everything outside the photo (the margins) stays fully visible.
  const buildOutputDepthMask = (zPosition) => {
    const alpha = buildDepthAlphaMask(depthFieldCanvas, zPosition, depthFeather);
    const mask = document.createElement("canvas");
    mask.width = compW;
    mask.height = compH;
    const mCtx = mask.getContext("2d");
    mCtx.fillStyle = "#ffffff";
    mCtx.fillRect(0, 0, compW, compH);
    mCtx.clearRect(contentRect.x, contentRect.y, contentRect.width, contentRect.height);
    mCtx.imageSmoothingEnabled = true;
    mCtx.imageSmoothingQuality = "high";
    const kx = alpha.width / fullW;
    const ky = alpha.height / fullH;
    mCtx.drawImage(
      alpha,
      contentSrc.x * kx, contentSrc.y * ky, contentSrc.width * kx, contentSrc.height * ky,
      contentRect.x, contentRect.y, contentRect.width, contentRect.height,
    );
    releaseCanvasImage(alpha);
    return mask;
  };

  // Composite layers in stack order. Each renderable layer is drawn to a temp
  // canvas, optionally masked by the depth field, then blitted to the output.
  for (const layer of layers) {
    if (!isLayerRenderable(layer)) continue;
    const mappedLayer = mapLayer(layer);
    const useDepth = depthFieldCanvas && layer.zPosition != null && layer.zPosition < 1;
    if (!useDepth) {
      drawLayersToCtx(outCtx, compW, compH, [mappedLayer]);
      continue;
    }
    const tmp = document.createElement("canvas");
    tmp.width = compW;
    tmp.height = compH;
    drawLayersToCtx(tmp.getContext("2d"), compW, compH, [mappedLayer]);
    const mask = buildOutputDepthMask(layer.zPosition);
    const t = tmp.getContext("2d");
    t.globalCompositeOperation = "destination-in";
    t.drawImage(mask, 0, 0);
    outCtx.drawImage(tmp, 0, 0);
    releaseCanvasImage(mask);
    releaseCanvasImage(tmp);
  }

  const blob = await canvasToBlob(outputCanvas, inferMimeType(savePath));
  await window.mediaWorkspace?.saveImage?.(savePath, await blob.arrayBuffer(), sourcePath);
  releaseCanvasImage(transformedFull);
  releaseCanvasImage(outputCanvas);

  try { await window.mediaWorkspace.quickRegister?.(savePath, sourcePath); }
  catch (e) { console.warn("[saveImage] quickRegister skipped:", e?.message || e); }
}
