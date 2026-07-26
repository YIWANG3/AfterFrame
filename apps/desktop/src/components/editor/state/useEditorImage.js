// Image loading for the editor. Owns the full-res `sourceImage` + the
// ≤PREVIEW_MAX_EDGE `previewSource` derived from it, plus the load lifecycle
// (decode → downscale-on-decode-failure → error). Extracted verbatim from
// EditorOverlay as the first step of the god-component decomposition (Phase 1a);
// behavior is unchanged.
//
// `sourceImageRef` mirrors `sourceImage` synchronously — pointer/save code reads
// the latest source without waiting for a React re-render. The Apply/Text flows
// promote a freshly-baked canvas by calling the exposed setters + ref directly.

import { useEffect, useRef, useState } from "react";
import { localFileUrl } from "../../../utils/format";
import { buildPreviewSource, releaseCanvasImage } from "../render/canvasHelpers";

// Editing happens on a preview capped at this long edge (perf); the untouched
// full-res `sourceImage` is kept for save/export.
export const PREVIEW_MAX_EDGE = 2200;

export function useEditorImage({ open, sourcePath, decodeErrorLabel = "Failed to load image" }) {
  const sourceImageRef = useRef(null);
  const [sourceImage, setSourceImage] = useState(null);
  const [previewSource, setPreviewSource] = useState(null);
  const [loadState, setLoadState] = useState("idle");
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!open || !sourcePath) return undefined;
    let active = true;
    setLoadState("loading");
    setLoadError(null);
    setSourceImage(null);
    setPreviewSource(null);

    // Release the previous source's canvas memory.
    releaseCanvasImage(sourceImageRef.current);
    sourceImageRef.current = null;

    async function load() {
      try {
        const url = localFileUrl(sourcePath);
        let image;
        let alreadyDownsampled = false;

        try {
          image = new Image();
          // CORS-mode load, like the sticker/depth caches: a no-cors media://
          // image taints every canvas it's drawn into on Chromium ≥ Electron 43,
          // which silently breaks the frame/pad compose save (toDataURL throws).
          image.crossOrigin = "anonymous";
          image.decoding = "async";
          image.src = url;
          await image.decode();
        } catch {
          // Image.decode() failed — likely too large for full decode.
          // Fall back to createImageBitmap which can decode+resize in one pass.
          image = null;
          const response = await fetch(url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();

          let bitmap;
          try {
            bitmap = await createImageBitmap(blob);
          } catch {
            // Full-size bitmap also fails — force a capped decode
            bitmap = await createImageBitmap(blob, {
              resizeWidth: PREVIEW_MAX_EDGE,
              resizeQuality: "high",
            });
          }

          // Downscale if still larger than preview max
          const maxEdge = Math.max(bitmap.width, bitmap.height);
          if (maxEdge > PREVIEW_MAX_EDGE) {
            const scale = PREVIEW_MAX_EDGE / maxEdge;
            const small = await createImageBitmap(blob, {
              resizeWidth: Math.round(bitmap.width * scale),
              resizeHeight: Math.round(bitmap.height * scale),
              resizeQuality: "high",
            });
            bitmap.close();
            bitmap = small;
          }

          // Bail early if component unmounted during async work
          if (!active) {
            bitmap.close();
            return;
          }

          // Transfer bitmap → canvas (canvas is a valid CanvasImageSource everywhere)
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.naturalWidth = bitmap.width;
          canvas.naturalHeight = bitmap.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          image = canvas;
          alreadyDownsampled = true;
        }

        if (!active) return;
        sourceImageRef.current = image;
        setSourceImage(image);
        setPreviewSource(alreadyDownsampled ? image : buildPreviewSource(image));
        setLoadState("ready");
      } catch (error) {
        if (!active) return;
        setLoadState("error");
        setLoadError(error instanceof Error ? error.message : decodeErrorLabel);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [open, sourcePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Release canvas memory when the editor unmounts.
  useEffect(() => () => {
    releaseCanvasImage(sourceImageRef.current);
    sourceImageRef.current = null;
  }, []);

  return {
    sourceImage, previewSource, loadState, loadError, sourceImageRef,
    // Exposed so the Apply / Text-apply flows can promote a freshly baked canvas.
    setSourceImage, setPreviewSource,
  };
}
