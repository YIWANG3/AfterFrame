// Export for the seamless split tool: N panel files into a subfolder next to
// the original, each registered as a derived version of the source asset.
//
// Two paths, chosen like saveImage.js:
//  • native — the untouched source file is still on disk (no Apply yet): the
//    main process cuts the region once and slices it (processAndSavePanels),
//    full source resolution, EXIF carried over.
//  • canvas — the working source is a baked canvas (after Apply): slice a
//    transformed full-resolution canvas here and save each panel blob.
// Text/sticker/border layers are not supported (P1): the caller blocks export.

import { useRef, useState } from "react";
import api from "../../../api";
import {
  buildTransformedCanvas, canvasToBlob, cutRotatedCrop, getSourceDimensions,
  inferMimeType, releaseCanvasImage,
} from "../render/canvasHelpers";
import { panelBoundaries, regionToPixels } from "../splitMath";

const pad2 = (n) => String(n).padStart(2, "0");

function splitPath(filePath) {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dir = slash >= 0 ? filePath.slice(0, slash) : "";
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return { dir, stem, ext: ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "jpg" };
}

export function defaultSplitOutputDir(saveBasePath) {
  if (!saveBasePath) return null;
  const { dir, stem } = splitPath(saveBasePath);
  return `${dir}/${stem}_split`;
}

export function splitPanelPaths(saveBasePath, outputDir, count) {
  const { stem, ext } = splitPath(saveBasePath);
  const dir = outputDir || defaultSplitOutputDir(saveBasePath);
  return Array.from({ length: count }, (_, i) => `${dir}/${stem}_split_${pad2(i + 1)}.${ext}`);
}

export function useSplitExport({
  saveBasePath, sourcePath, sourceImageRef, nativeSaveSourcePathRef, editorStateRef,
  getCount, pushToast, t, onSaveComplete,
}) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(null);
  const exportingRef = useRef(false);

  async function exportCanvasPanels({ region, count, savePaths }) {
    const source = sourceImageRef.current;
    if (!source) throw new Error("Image not loaded");
    const s = editorStateRef.current;
    const { width: sw, height: sh } = getSourceDimensions(source);
    const transformed = buildTransformedCanvas(source, sw, sh, s.quarterTurns * 90, s.flipX, s.flipY);
    const regionPx = regionToPixels(region, transformed.width, transformed.height);
    const cut = cutRotatedCrop(transformed, regionPx, s.freeAngle || 0);
    releaseCanvasImage(transformed);
    const bounds = panelBoundaries(cut.width, count);
    const results = [];
    try {
      for (let i = 0; i < count; i++) {
        const left = bounds[i];
        const width = bounds[i + 1] - left;
        const panel = document.createElement("canvas");
        panel.width = width;
        panel.height = cut.height;
        const ctx = panel.getContext("2d");
        ctx.drawImage(cut, left, 0, width, cut.height, 0, 0, width, cut.height);
        const blob = await canvasToBlob(panel, inferMimeType(savePaths[i]));
        await api.saveImage(savePaths[i], await blob.arrayBuffer(), sourcePath);
        releaseCanvasImage(panel);
        results.push({ path: savePaths[i], width, height: cut.height, index: i });
        setProgress({ done: i + 1, total: count });
      }
    } finally {
      releaseCanvasImage(cut);
    }
    return results;
  }

  // Resolves to the saved panel descriptors, or null when nothing was exported.
  async function exportSplit({ outputDir } = {}) {
    if (exportingRef.current) return null;
    const s = editorStateRef.current;
    const region = s.split?.rect;
    const count = getCount();
    if (!region || !count || !saveBasePath) return null;
    const savePaths = splitPanelPaths(saveBasePath, outputDir, count);
    exportingRef.current = true;
    setExporting(true);
    setProgress({ done: 0, total: count });
    try {
      let results;
      const nativeSource = nativeSaveSourcePathRef.current;
      if (nativeSource && api.has("processAndSavePanels")) {
        results = await api.processAndSavePanels({
          sourcePath: nativeSource,
          savePaths,
          region,
          quarterTurns: s.quarterTurns,
          freeAngle: s.freeAngle,
          flipX: s.flipX,
          flipY: s.flipY,
          quality: 92,
        });
        setProgress({ done: count, total: count });
      } else {
        results = await exportCanvasPanels({ region, count, savePaths });
      }
      // Catalog registration is best-effort, like the single-image save.
      for (const panel of results) {
        try { await api.quickRegister(panel.path, sourcePath); }
        catch (e) { console.warn("[split] quickRegister skipped:", e?.message || e); }
      }
      const dir = savePaths[0].slice(0, Math.max(savePaths[0].lastIndexOf("/"), savePaths[0].lastIndexOf("\\")));
      pushToast?.({
        title: t("split.done", { count: results.length }),
        message: dir,
        ttl: 20_000,
        actions: api.has("revealPath") ? [{
          label: t("split.reveal"),
          primary: true,
          onClick: () => api.revealPath(results[0].path),
        }] : [],
      });
      await onSaveComplete?.();
      return results;
    } catch (error) {
      pushToast?.({
        title: t("split.failed"),
        message: error instanceof Error ? error.message : String(error),
        ttl: 20_000,
      });
      return null;
    } finally {
      exportingRef.current = false;
      setExporting(false);
      setProgress(null);
    }
  }

  return { exporting, progress, exportSplit };
}
