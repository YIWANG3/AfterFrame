import { useEffect, useRef } from "react";
import { clampImagePlacement, MAX_IMAGE_ZOOM } from "../imageMath";

const MIN_CROP_SIZE = 48;

// Wires native wheel events on the editor viewport. Two behaviors based on
// gesture intent:
//   - Vertical wheel (or trackpad pinch) → workspace zoom anchored to crop center
//   - Horizontal trackpad scroll → image pan
//
// Wheel events from the side panel and tool rail are excluded (they handle
// their own scrolling).
export function useViewportWheel({
  viewportRef,
  open,
  transformedPreview,
  placement,
  editorStateRef,
  applyState,
  commitState,
}) {
  // Hold the latest preview+placement in a ref so the wheel handler closes
  // over fresh values without us having to re-attach on every render.
  const ctxRef = useRef(null);
  ctxRef.current = { transformedPreview, placement };
  const commitTimerRef = useRef(null);

  function scheduleCommit() {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      commitState?.();
    }, 160);
  }

  // Run any pending debounced commit NOW — undo/redo call this first so the
  // pending wheel edit becomes a real history entry before the index moves,
  // instead of being swallowed or over-rewinding (review F8).
  function flushCommit() {
    if (!commitTimerRef.current) return;
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitState?.();
  }

  // Drop a pending commit without recording it — drag starts call this so the
  // debounce timer can't fire mid-drag and insert an intermediate history entry.
  function cancelCommit() {
    if (!commitTimerRef.current) return;
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  }

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    function onWheel(event) {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-editor-wheel-scope='panel'], [data-editor-wheel-scope='toolbar']")
      ) {
        return;
      }
      const { transformedPreview: tp, placement: pl } = ctxRef.current || {};
      if (!tp || !pl) return;
      event.preventDefault();
      const current = editorStateRef.current;
      if (!current.cropRect) return;

      const isZoom = event.ctrlKey || event.metaKey || Math.abs(event.deltaY) > Math.abs(event.deltaX);

      if (isZoom) {
        // Workspace zoom anchored to crop box center.
        const factor = event.deltaY > 0 ? 0.94 : 1.06;
        const proposedCropW = current.cropRect.width * factor;
        const proposedCropH = current.cropRect.height * factor;
        if (proposedCropW < MIN_CROP_SIZE || proposedCropH < MIN_CROP_SIZE) return;

        const pt = {
          x: current.cropRect.x + current.cropRect.width / 2,
          y: current.cropRect.y + current.cropRect.height / 2,
        };

        let nextZoom = current.imageZoom * factor;
        if (nextZoom > MAX_IMAGE_ZOOM) {
          const adjFactor = MAX_IMAGE_ZOOM / current.imageZoom;
          nextZoom = MAX_IMAGE_ZOOM;
          if (adjFactor <= 1) return;
        }

        const nextCrop = {
          x: pt.x + (current.cropRect.x - pt.x) * factor,
          y: pt.y + (current.cropRect.y - pt.y) * factor,
          width: proposedCropW,
          height: proposedCropH,
        };

        const oldCenterX = pl.centerX + current.imageOffsetX;
        const oldCenterY = pl.centerY + current.imageOffsetY;
        const newCenterX = pt.x + (oldCenterX - pt.x) * factor;
        const newCenterY = pt.y + (oldCenterY - pt.y) * factor;

        const next = clampImagePlacement(
          {
            ...current,
            imageZoom: nextZoom,
            cropRect: nextCrop,
            imageOffsetX: newCenterX - pl.centerX,
            imageOffsetY: newCenterY - pl.centerY,
          },
          tp,
          pl,
        );
        applyState(next);
        scheduleCommit();
      } else {
        // Horizontal trackpad scroll = pan image inside crop.
        const dx = -event.deltaX;
        const dy = -event.deltaY;
        const next = clampImagePlacement(
          {
            ...current,
            imageOffsetX: current.imageOffsetX + dx,
            imageOffsetY: current.imageOffsetY + dy,
          },
          tp,
          pl,
        );
        applyState(next);
        scheduleCommit();
      }
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return { flushCommit, cancelCommit };
}
