// Viewport geometry for the editor. Owns the viewport element ref + its measured
// size (ResizeObserver), and derives the base placement (how the transformed
// preview is fitted into the viewport) and the current image rect (placement +
// crop/zoom). Also converts client coords to viewport-relative points for
// pointer handlers. Extracted verbatim from EditorOverlay (Phase 1c).
//
// Inputs are the cross-cutting derived values it reads: `transformedPreview`
// (photo + rotation/flip, owned by EditorOverlay) and `editorState`.

import { useEffect, useMemo, useRef, useState } from "react";
import { getBasePlacement, getImageRect, getNormalizedCrop, getOutputView } from "../imageMath";

export function useEditorViewport({ open, transformedPreview, editorState }) {
  const viewportRef = useRef(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!open || typeof ResizeObserver === "undefined") return undefined;
    const element = viewportRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setViewportSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);

  // Crop-space placement — deliberately pad-free so its identity is stable
  // across border edits and pointer-drag applies (canvas margins never reflow
  // the crop workspace).
  const placement = useMemo(
    () => getBasePlacement(viewportSize, transformedPreview),
    [viewportSize, transformedPreview],
  );

  // Photo rect in crop space (crop overlay / image pan-zoom basis).
  const imageRect = useMemo(
    () => getImageRect(editorState, transformedPreview, placement),
    [editorState, transformedPreview, placement],
  );

  // Crop as photo fractions, derived from the pad-free geometry above.
  const normalizedCrop = useMemo(
    () => getNormalizedCrop(editorState, imageRect),
    [editorState, imageRect],
  );

  // Composed output view (cropped content + margins) — the basis for LAYER
  // positioning and the text tool's border rendering. rect === imageRect while
  // pad=0.
  const outputView = useMemo(
    () => getOutputView(editorState, transformedPreview, normalizedCrop, imageRect),
    [editorState, transformedPreview, normalizedCrop, imageRect],
  );
  const outputRect = outputView?.rect ?? null;

  function pointFromClient(clientX, clientY) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  return { viewportRef, viewportSize, placement, imageRect, normalizedCrop, outputView, outputRect, pointFromClient };
}
