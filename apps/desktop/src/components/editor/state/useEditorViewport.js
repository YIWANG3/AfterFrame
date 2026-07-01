// Viewport geometry for the editor. Owns the viewport element ref + its measured
// size (ResizeObserver), and derives the base placement (how the transformed
// preview is fitted into the viewport) and the current image rect (placement +
// crop/zoom). Also converts client coords to viewport-relative points for
// pointer handlers. Extracted verbatim from EditorOverlay (Phase 1c).
//
// Inputs are the cross-cutting derived values it reads: `transformedPreview`
// (photo + rotation/flip, owned by EditorOverlay) and `editorState`.

import { useEffect, useMemo, useRef, useState } from "react";
import { getBasePlacement, getImageRect } from "../imageMath";

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

  const placement = useMemo(
    () => getBasePlacement(viewportSize, transformedPreview),
    [viewportSize, transformedPreview],
  );

  const imageRect = useMemo(
    () => getImageRect(editorState, transformedPreview, placement),
    [editorState, transformedPreview, placement],
  );

  function pointFromClient(clientX, clientY) {
    const viewport = viewportRef.current;
    if (!viewport) return { x: 0, y: 0 };
    const rect = viewport.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  return { viewportRef, viewportSize, placement, imageRect, pointFromClient };
}
