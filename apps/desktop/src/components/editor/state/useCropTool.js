// Crop / transform tool. Owns the pointer-interaction state (resize / rotate /
// pan handles, straighten-ruler drag) and the commit operations (aspect ratio,
// quarter-turn / flip, free angle). Extracted from EditorOverlay (Phase 3a).
//
// Reads the viewport geometry + transform history it operates on, and returns
// the pointer/commit handlers the crop UI wires up. It owns `activeInteraction`
// (drives cursor), `pointerStateRef` (in-flight drag), and `angleDragStartRef`.

import { useEffect, useRef, useState } from "react";
import {
  getAspectRatio, createCenteredCrop, symmetricResize, MIN_FREE_ANGLE, MAX_FREE_ANGLE,
} from "../cropMath";
import {
  clampImagePlacement, getBasePlacement, getImageRect, getMinZoomForCrop,
  MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM,
} from "../imageMath";
import { buildTransformedCanvas } from "../render/canvasHelpers";
import { cloneState, stateEquals } from "./editorStateModel";
import { useViewportWheel } from "./useViewportWheel";

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function useCropTool({
  open, previewSource, transformedPreview, viewportSize, placement, imageRect,
  viewportRef, editorState, editorStateRef, pointFromClient,
  apply, record, commitCurrent,
}) {
  const pointerStateRef = useRef(null);
  const angleDragStartRef = useRef(null);
  const [activeInteraction, setActiveInteraction] = useState(null);
  const cropRect = editorState.cropRect;

  function commitAspect(nextAspectKey) {
    if (!transformedPreview || !imageRect || !editorStateRef.current.cropRect) return;
    const aspect = getAspectRatio(nextAspectKey, imageRect.width / imageRect.height);
    const cx = editorStateRef.current.cropRect.x + editorStateRef.current.cropRect.width / 2;
    const cy = editorStateRef.current.cropRect.y + editorStateRef.current.cropRect.height / 2;
    const nextCrop = createCenteredCrop(imageRect.width, imageRect.height, aspect, cx, cy);
    const next = clampImagePlacement(
      { ...editorStateRef.current, aspectKey: nextAspectKey, cropRect: nextCrop },
      transformedPreview,
      placement,
    );
    record(next);
  }

  function commitTransform(patch) {
    if (!previewSource) return;
    const candidate = {
      ...editorStateRef.current,
      ...patch,
      imageZoom: 1,
      imageOffsetX: 0,
      imageOffsetY: 0,
    };
    const nextPreview = buildTransformedCanvas(
      previewSource,
      previewSource.width,
      previewSource.height,
      candidate.quarterTurns * 90 + candidate.freeAngle,
      candidate.flipX,
      candidate.flipY,
    );
    const nextPlacement = getBasePlacement(viewportSize, nextPreview);
    const nextImageRect = getImageRect(candidate, nextPreview, nextPlacement);
    const aspect = getAspectRatio(candidate.aspectKey, nextImageRect.width / nextImageRect.height);
    const nextCrop = createCenteredCrop(nextImageRect.width, nextImageRect.height, aspect, nextPlacement.centerX, nextPlacement.centerY);
    record({ ...candidate, cropRect: nextCrop });
  }

  function beginCropResize(handle, event) {
    event.preventDefault();
    event.stopPropagation();
    if (!cropRect) return;
    pointerStateRef.current = {
      mode: "crop-resize",
      handle,
      pointerId: event.pointerId,
      startState: cloneState(editorStateRef.current),
    };
    setActiveInteraction("crop-resize");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginRotate(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!cropRect) return;
    const point = pointFromClient(event.clientX, event.clientY);
    const center = { x: cropRect.x + cropRect.width / 2, y: cropRect.y + cropRect.height / 2 };
    pointerStateRef.current = {
      mode: "rotate",
      pointerId: event.pointerId,
      startState: cloneState(editorStateRef.current),
      startAngle: Math.atan2(point.y - center.y, point.x - center.x),
    };
    setActiveInteraction("rotate");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function beginImagePan(event) {
    event.preventDefault();
    if (!imageRect || !cropRect) return;
    const point = pointFromClient(event.clientX, event.clientY);
    pointerStateRef.current = {
      mode: "image-pan",
      pointerId: event.pointerId,
      startPoint: point,
      startState: cloneState(editorStateRef.current),
    };
    setActiveInteraction("image-pan");
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    const active = pointerStateRef.current;
    if (!active || active.pointerId !== event.pointerId || !transformedPreview || !placement) return;
    const point = pointFromClient(event.clientX, event.clientY);

    if (active.mode === "image-pan") {
      const next = clampImagePlacement(
        {
          ...active.startState,
          imageOffsetX: active.startState.imageOffsetX + (point.x - active.startPoint.x),
          imageOffsetY: active.startState.imageOffsetY + (point.y - active.startPoint.y),
        },
        transformedPreview,
        placement,
      );
      apply(next);
      return;
    }

    if (active.mode === "rotate") {
      const center = {
        x: active.startState.cropRect.x + active.startState.cropRect.width / 2,
        y: active.startState.cropRect.y + active.startState.cropRect.height / 2,
      };
      const currentAngle = Math.atan2(point.y - center.y, point.x - center.x);
      const deltaDegrees = ((currentAngle - active.startAngle) * 180) / Math.PI;
      apply({
        ...active.startState,
        freeAngle: clamp(active.startState.freeAngle + deltaDegrees, MIN_FREE_ANGLE, MAX_FREE_ANGLE),
      });
      return;
    }

    const nextCrop = symmetricResize(
      active.startState.cropRect,
      active.handle,
      point,
      getAspectRatio(active.startState.aspectKey, active.startState.cropRect.width / active.startState.cropRect.height),
    );

    const w = nextCrop.width;
    const h = nextCrop.height;
    const w0 = active.startState.cropRect.width;
    const h0 = active.startState.cropRect.height;

    // Check if the new crop forces the image to zoom in
    const minZ = getMinZoomForCrop(nextCrop, transformedPreview, placement);
    const nextZ = clamp(Math.max(active.startState.imageZoom, minZ), MIN_IMAGE_ZOOM, MAX_IMAGE_ZOOM);
    const factor = nextZ / active.startState.imageZoom;

    // Keep the anchored corner/edge glued to the image pixel
    let dx = 0;
    let dy = 0;
    if (active.handle.includes("w")) dx = (w - factor * w0) / 2;
    if (active.handle.includes("e")) dx = (factor * w0 - w) / 2;
    if (active.handle.includes("n")) dy = (h - factor * h0) / 2;
    if (active.handle.includes("s")) dy = (factor * h0 - h) / 2;

    const next = clampImagePlacement(
      {
        ...active.startState,
        imageZoom: nextZ,
        cropRect: nextCrop,
        imageOffsetX: active.startState.imageOffsetX * factor + dx,
        imageOffsetY: active.startState.imageOffsetY * factor + dy,
      },
      transformedPreview,
      placement,
    );
    apply(next);
  }

  function handlePointerEnd(event) {
    const active = pointerStateRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    pointerStateRef.current = null;
    setActiveInteraction(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (JSON.stringify(active.startState) !== JSON.stringify(editorStateRef.current)) {
      commitCurrent();
    } else {
      apply(active.startState);
    }
  }

  useViewportWheel({
    viewportRef,
    open,
    transformedPreview,
    placement,
    editorStateRef,
    recordState: record,
  });

  // Re-clamp image placement whenever the geometry changes so the crop never
  // drifts off the image. Skipped while a canvas margin (border) is active — the
  // border wraps the whole photo (crop is ignored), and the stale crop rect
  // would otherwise force the image to zoom in to "cover" it → overflow.
  useEffect(() => {
    const pad = editorStateRef.current.canvas?.pad;
    const hasPad = pad && (pad.top || pad.right || pad.bottom || pad.left);
    if (hasPad || !transformedPreview || !placement || !editorStateRef.current.cropRect) return;
    const clamped = clampImagePlacement(editorStateRef.current, transformedPreview, placement);
    if (!stateEquals(clamped, editorStateRef.current)) {
      apply(clamped);
    }
  }, [transformedPreview, placement]); // eslint-disable-line react-hooks/exhaustive-deps

  function beginAngleDrag() {
    angleDragStartRef.current = cloneState(editorStateRef.current);
  }

  function updateAngle(nextAngle) {
    apply({
      ...editorStateRef.current,
      freeAngle: clamp(nextAngle, MIN_FREE_ANGLE, MAX_FREE_ANGLE),
    });
  }

  function endAngleDrag() {
    if (!angleDragStartRef.current) return;
    if (!stateEquals(angleDragStartRef.current, editorStateRef.current)) {
      commitCurrent();
    }
    angleDragStartRef.current = null;
  }

  return {
    activeInteraction,
    commitAspect, commitTransform,
    beginCropResize, beginRotate, beginImagePan,
    handlePointerMove, handlePointerEnd,
    beginAngleDrag, updateAngle, endAngleDrag,
  };
}
