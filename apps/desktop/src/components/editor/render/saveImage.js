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
    layers,
    depthFieldCanvas,
    depthFeather,
    drawLayersToCtx,
    nativeSaveSourcePath,
    isLayerRenderable,
  } = ctx;

  // Native sharp fast-path: full source resolution, no canvas overhead. Only
  // valid when there are zero overlay layers (we don't ship layer rendering
  // to sharp).
  if (window.mediaWorkspace?.processAndSave && nativeSaveSourcePath && layers.length === 0) {
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

  const exportRect = normalizedCrop
    ? {
        x: Math.round(normalizedCrop.x * transformedFull.width),
        y: Math.round(normalizedCrop.y * transformedFull.height),
        width: Math.max(1, Math.round(normalizedCrop.width * transformedFull.width)),
        height: Math.max(1, Math.round(normalizedCrop.height * transformedFull.height)),
      }
    : { x: 0, y: 0, width: transformedFull.width, height: transformedFull.height };

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = exportRect.width;
  outputCanvas.height = exportRect.height;
  const outCtx = outputCanvas.getContext("2d");
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  outCtx.drawImage(
    transformedFull,
    exportRect.x, exportRect.y, exportRect.width, exportRect.height,
    0, 0, exportRect.width, exportRect.height,
  );

  // Composite layers in stack order. Each renderable layer is drawn to a temp
  // canvas, optionally masked by the depth field, then blitted to the output.
  const fullW = transformedFull.width;
  const fullH = transformedFull.height;
  const isSticker = (layer) => layer?.type === "sticker";

  for (const layer of layers) {
    if (!isLayerRenderable(layer)) continue;
    const absX = layer.x * fullW - exportRect.x;
    const absY = layer.y * fullH - exportRect.y;
    // Sticker scale is fraction of source image width; rescale when exporting
    // a cropped sub-rect so the visible sticker stays the same physical size.
    const scaleAdjust = isSticker(layer)
      ? { scale: (layer.scale ?? 0.4) * (fullW / exportRect.width) }
      : null;
    const mappedLayer = {
      ...layer,
      x: absX / exportRect.width,
      y: absY / exportRect.height,
      ...(scaleAdjust || {}),
    };
    const useDepth = depthFieldCanvas && layer.zPosition != null && layer.zPosition < 1;
    if (!useDepth) {
      drawLayersToCtx(outCtx, exportRect.width, exportRect.height, [mappedLayer]);
      continue;
    }
    const tmp = document.createElement("canvas");
    tmp.width = exportRect.width;
    tmp.height = exportRect.height;
    drawLayersToCtx(tmp.getContext("2d"), exportRect.width, exportRect.height, [mappedLayer]);
    const mask = buildDepthMaskCanvas(depthFieldCanvas, exportRect.width, exportRect.height, layer.zPosition, depthFeather);
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
