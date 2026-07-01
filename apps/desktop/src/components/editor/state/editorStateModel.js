// The editor's transform state — the snapshot that crop/rotate/flip/zoom edits
// mutate and that the undo/redo history stores. Kept as a plain, cloneable
// object with value-equality helpers. Extracted from EditorOverlay (Phase 1b).

export const BASE_STATE = {
  aspectKey: "free",
  freeAngle: 0,
  quarterTurns: 0,
  flipX: false,
  flipY: false,
  cropRect: null,
  imageZoom: 1,
  imageOffsetX: 0,
  imageOffsetY: 0,
  // Canvas expansion: the photo becomes a sub-rect of an output canvas padded by
  // `pad` (fractions of the photo short edge) and filled with `bg`. All zero /
  // null by default → output === photo, i.e. today's behavior exactly. Consumed
  // by the unified canvas/layer model (docs/unified-canvas-plan.md).
  canvas: { pad: { top: 0, right: 0, bottom: 0, left: 0 }, bg: null },
};

export function rectEquals(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function padEquals(a, b) {
  if (!a || !b) return a === b;
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

export function canvasEquals(a, b) {
  if (!a || !b) return a === b;
  return (a.bg?.color ?? null) === (b.bg?.color ?? null) && padEquals(a.pad, b.pad);
}

function cloneCanvas(canvas) {
  if (!canvas) return { pad: { top: 0, right: 0, bottom: 0, left: 0 }, bg: null };
  return { pad: { ...canvas.pad }, bg: canvas.bg ? { ...canvas.bg } : null };
}

export function cloneState(state) {
  return {
    ...state,
    cropRect: state.cropRect ? { ...state.cropRect } : null,
    canvas: cloneCanvas(state.canvas),
  };
}

export function stateEquals(a, b) {
  return (
    a.aspectKey === b.aspectKey &&
    a.freeAngle === b.freeAngle &&
    a.quarterTurns === b.quarterTurns &&
    a.flipX === b.flipX &&
    a.flipY === b.flipY &&
    a.imageZoom === b.imageZoom &&
    a.imageOffsetX === b.imageOffsetX &&
    a.imageOffsetY === b.imageOffsetY &&
    rectEquals(a.cropRect, b.cropRect) &&
    canvasEquals(a.canvas, b.canvas)
  );
}
