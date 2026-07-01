// Export pipeline — turns the editor's current state into a saved file on disk.
// Pure function: every dependency is passed in. Used by both `handleQuickSave`
// and `handleExport` in EditorOverlay.

import {
  getSourceDimensions,
  buildTransformedCanvas,
  buildDepthMaskCanvas,
  canvasToBlob,
  inferMimeType,
  releaseCanvasImage,
} from "./canvasHelpers";

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
    layers,
    depthFieldCanvas,
    depthFeather,
    drawLayersToCtx,
    nativeSaveSourcePath,
    isLayerRenderable,
  } = ctx;

  const hasPad = canvasPad && (canvasPad.top || canvasPad.right || canvasPad.bottom || canvasPad.left);

  // Native sharp fast-path: full source resolution, no canvas overhead. Only
  // valid when there are zero overlay layers AND no canvas margin (sharp can't
  // do the padded-canvas composite).
  if (window.mediaWorkspace?.processAndSave && nativeSaveSourcePath && layers.length === 0 && !hasPad) {
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

  // Two output shapes:
  //  • hasPad → output = photo + margins (bg-filled); layers are already
  //    fractions of that output (matches the live editor's outputRect).
  //  • else   → output = the crop rect; layers are full-photo fractions
  //    remapped into the crop (the pre-unified behavior, byte-identical).
  const outputCanvas = document.createElement("canvas");
  let compW, compH, mapLayer, outCtx;

  if (hasPad) {
    const short = Math.min(fullW, fullH);
    const padL = Math.round(canvasPad.left * short);
    const padR = Math.round(canvasPad.right * short);
    const padT = Math.round(canvasPad.top * short);
    const padB = Math.round(canvasPad.bottom * short);
    compW = fullW + padL + padR;
    compH = fullH + padT + padB;
    outputCanvas.width = compW;
    outputCanvas.height = compH;
    outCtx = outputCanvas.getContext("2d");
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.fillStyle = canvasBg?.color || "#ffffff";
    outCtx.fillRect(0, 0, compW, compH);
    outCtx.drawImage(transformedFull, padL, padT);
    mapLayer = (layer) => layer; // x/y/scale already output-relative
  } else {
    const exportRect = normalizedCrop
      ? {
          x: Math.round(normalizedCrop.x * fullW),
          y: Math.round(normalizedCrop.y * fullH),
          width: Math.max(1, Math.round(normalizedCrop.width * fullW)),
          height: Math.max(1, Math.round(normalizedCrop.height * fullH)),
        }
      : { x: 0, y: 0, width: fullW, height: fullH };
    compW = exportRect.width;
    compH = exportRect.height;
    outputCanvas.width = compW;
    outputCanvas.height = compH;
    outCtx = outputCanvas.getContext("2d");
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = "high";
    outCtx.drawImage(transformedFull, exportRect.x, exportRect.y, compW, compH, 0, 0, compW, compH);
    mapLayer = (layer) => {
      const absX = layer.x * fullW - exportRect.x;
      const absY = layer.y * fullH - exportRect.y;
      const scaleAdjust = isSticker(layer)
        ? { scale: (layer.scale ?? 0.4) * (fullW / exportRect.width) }
        : null;
      return { ...layer, x: absX / exportRect.width, y: absY / exportRect.height, ...(scaleAdjust || {}) };
    };
  }

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
    const mask = buildDepthMaskCanvas(depthFieldCanvas, compW, compH, layer.zPosition, depthFeather);
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
