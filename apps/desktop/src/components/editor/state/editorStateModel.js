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
};

export function rectEquals(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function cloneState(state) {
  return {
    ...state,
    cropRect: state.cropRect ? { ...state.cropRect } : null,
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
    rectEquals(a.cropRect, b.cropRect)
  );
}
