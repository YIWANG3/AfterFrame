// Seamless split tool (docs/split-carousel-plan.md). Owns the region-drag
// interactions (corner resize with the aspect locked, move) and the commit
// operations (panel aspect, panel count, reset), all recorded into the shared
// editor history through the `split` slot of the transform state.
//
// The region is STORED normalized to the transformed photo and displayed on a
// zoom-free photo rect (`splitImageRect`): the crop tool's zoom/pan never
// affects where the split region lands, and a viewport resize needs no remap.

import { useEffect, useMemo, useRef, useState } from "react";
import { getImageRect } from "../imageMath";
import {
  createDefaultSplitRect, denormalizeSplitRect, fitSplitRect, getSplitPanelAspect,
  moveSplitRect, normalizeSplitRect, reshapeSplitRect, resizeSplitRect, resolveSplitCount,
} from "../splitMath";
import { BASE_STATE, cloneState, rectEquals } from "./editorStateModel";

const ZOOM_FREE = { imageZoom: 1, imageOffsetX: 0, imageOffsetY: 0 };

function nearlyEqualRect(a, b, epsilon = 0.5) {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon
    && Math.abs(a.width - b.width) < epsilon && Math.abs(a.height - b.height) < epsilon;
}

export function useSplitTool({
  active, transformedPreview, placement, sourceDims,
  editorState, editorStateRef, pointFromClient,
  apply, record, commitCurrent,
}) {
  const pointerStateRef = useRef(null);
  const [activeInteraction, setActiveInteraction] = useState(null);

  // Photo rect on screen with zoom 1 / no pan — the split region's frame.
  const splitImageRect = useMemo(
    () => (transformedPreview && placement ? getImageRect(ZOOM_FREE, transformedPreview, placement) : null),
    [transformedPreview, placement],
  );

  // The region's frame: the on-screen photo rect, but with the FULL-RES photo's
  // exact aspect. The preview is downsampled to whole pixels (2200×733 for a
  // 2400×800 photo), so locking the aspect against the preview rect would
  // export panels a pixel short; against this frame the fractions are exact.
  // The visual difference is well under a pixel.
  const bounds = useMemo(() => {
    if (!splitImageRect) return null;
    if (!sourceDims?.width || !sourceDims?.height) return splitImageRect;
    const height = (splitImageRect.width * sourceDims.height) / sourceDims.width;
    return { ...splitImageRect, y: splitImageRect.y + (splitImageRect.height - height) / 2, height };
  }, [splitImageRect, sourceDims?.width, sourceDims?.height]);

  const split = editorState.split || BASE_STATE.split;
  const freeAngle = editorState.freeAngle || 0;
  const panelAspect = getSplitPanelAspect(split.aspectKey, split.custom);
  const count = resolveSplitCount(sourceDims?.width || transformedPreview?.width, sourceDims?.height || transformedPreview?.height, panelAspect, split.count);
  const regionAspect = panelAspect * count;
  const rectPx = useMemo(
    () => (split.rect && bounds ? denormalizeSplitRect(split.rect, bounds) : null),
    [split.rect, bounds],
  );

  // Seed the default region the first time the tool is used on this photo
  // basis, regenerate it after a quarter turn (basis changed), and re-fit it
  // when a straighten angle set in the crop tool pushed its extent outside.
  // Live `apply`: the default region is not an undoable edit.
  useEffect(() => {
    if (!active || !bounds || !transformedPreview) return;
    const s = editorStateRef.current;
    const current = s.split || BASE_STATE.split;
    const basis = { width: transformedPreview.width, height: transformedPreview.height };
    const basisOk = current.rect && current.basis
      && current.basis.width === basis.width && current.basis.height === basis.height;
    if (!basisOk) {
      const px = createDefaultSplitRect(bounds, regionAspect, s.freeAngle || 0);
      apply({ ...s, split: { ...current, rect: normalizeSplitRect(px, bounds), basis } });
      return;
    }
    const px = denormalizeSplitRect(current.rect, bounds);
    const fitted = fitSplitRect(px, bounds, s.freeAngle || 0);
    if (!nearlyEqualRect(px, fitted)) {
      apply({ ...s, split: { ...current, rect: normalizeSplitRect(fitted, bounds) } });
    }
  }, [active, bounds, transformedPreview, regionAspect, freeAngle]); // eslint-disable-line react-hooks/exhaustive-deps

  const countFor = (aspect, requested) => resolveSplitCount(
    sourceDims?.width || transformedPreview?.width, sourceDims?.height || transformedPreview?.height, aspect, requested,
  );

  function withRegion(nextSplit, nextPx) {
    const s = editorStateRef.current;
    const basis = transformedPreview ? { width: transformedPreview.width, height: transformedPreview.height } : null;
    return { ...s, split: { ...(s.split || BASE_STATE.split), ...nextSplit, rect: normalizeSplitRect(nextPx, bounds), basis } };
  }

  // `custom` (optional { width, height }) is stored alongside; passing it with
  // aspectKey "custom" is how the panel's W:H inputs commit.
  function commitAspect(aspectKey, custom) {
    if (!bounds) return;
    const s = editorStateRef.current;
    const nextCustom = custom || s.split?.custom || BASE_STATE.split.custom;
    const nextAspect = getSplitPanelAspect(aspectKey, nextCustom);
    const nextCount = countFor(nextAspect, s.split?.count);
    const px = reshapeSplitRect(rectPx, bounds, nextAspect * nextCount, s.freeAngle || 0);
    record(withRegion({ aspectKey, custom: nextCustom }, px));
  }

  // `nextCount` null = back to automatic.
  function commitCount(nextCount) {
    if (!bounds) return;
    const s = editorStateRef.current;
    const resolved = countFor(panelAspect, nextCount);
    const px = reshapeSplitRect(rectPx, bounds, panelAspect * resolved, s.freeAngle || 0);
    record(withRegion({ count: nextCount == null ? null : resolved }, px));
  }

  function resetRegion() {
    if (!bounds) return;
    const s = editorStateRef.current;
    const px = createDefaultSplitRect(bounds, regionAspect, s.freeAngle || 0);
    record(withRegion({}, px));
  }

  function beginResize(handle, event) {
    event.preventDefault();
    event.stopPropagation();
    if (!rectPx) return;
    pointerStateRef.current = {
      mode: "split-resize",
      handle,
      pointerId: event.pointerId,
      startState: cloneState(editorStateRef.current),
      startRect: rectPx,
    };
    setActiveInteraction("split-resize");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginMove(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!rectPx) return;
    pointerStateRef.current = {
      mode: "split-move",
      pointerId: event.pointerId,
      startPoint: pointFromClient(event.clientX, event.clientY),
      startState: cloneState(editorStateRef.current),
      startRect: rectPx,
    };
    setActiveInteraction("split-move");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const drag = pointerStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !bounds) return;
    const point = pointFromClient(event.clientX, event.clientY);
    const angle = drag.startState.freeAngle || 0;
    const nextPx = drag.mode === "split-move"
      ? moveSplitRect(drag.startRect, bounds, point.x - drag.startPoint.x, point.y - drag.startPoint.y, angle)
      : resizeSplitRect(drag.startRect, drag.handle, point, bounds, regionAspect, angle);
    const nextRect = normalizeSplitRect(nextPx, bounds);
    if (rectEquals(nextRect, editorStateRef.current.split?.rect)) return;
    apply({ ...drag.startState, split: { ...drag.startState.split, rect: nextRect } });
  }

  function handlePointerEnd(event) {
    const drag = pointerStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerStateRef.current = null;
    setActiveInteraction(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (rectEquals(drag.startState.split?.rect, editorStateRef.current.split?.rect)) {
      apply(drag.startState);
    } else {
      commitCurrent();
    }
  }

  return {
    splitImageRect,
    rect: split.rect,
    rectPx,
    aspectKey: split.aspectKey,
    custom: split.custom || BASE_STATE.split.custom,
    panelAspect,
    count,
    isAutoCount: split.count == null,
    activeInteraction,
    commitAspect, commitCount, resetRegion,
    beginResize, beginMove,
    handlePointerMove, handlePointerEnd,
  };
}
