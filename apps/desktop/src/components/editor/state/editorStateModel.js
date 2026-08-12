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
  // Canvas expansion: the (cropped) photo becomes a sub-rect of an output
  // canvas padded by `pad` (fractions of the content short edge), filled with
  // `bg`, with an optional `scrim` gradient over the photo (overlay presets).
  // All zero / null by default → output === photo, i.e. today's behavior
  // exactly. Consumed by the unified canvas/layer model
  // (docs/unified-canvas-plan.md).
  canvas: { pad: { top: 0, right: 0, bottom: 0, left: 0 }, bg: null, scrim: null },
};

export function rectEquals(a, b) {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function padEquals(a, b) {
  if (!a || !b) return a === b;
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

// Field-wise (no JSON.stringify: stateEquals runs in per-frame drag paths).
function gradientEquals(a, b) {
  if (!a || !b) return a === b;
  return a.from === b.from && a.to === b.to && a.fromOpacity === b.fromOpacity &&
    a.toOpacity === b.toOpacity && a.angle === b.angle;
}

function bgEquals(a, b) {
  if (!a || !b) return (a ?? null) === (b ?? null);
  return a.mode === b.mode && a.color === b.color && gradientEquals(a.gradient ?? null, b.gradient ?? null);
}

// canvas.scrim is a LEGACY slot: since overlay layers landed, frame presets
// emit their wash as an overlay layer and set scrim to null, so nothing in the
// current app produces a non-null scrim. The plumbing (equals/clone/save) is
// kept deliberately so any state that still carries one keeps rendering.
function scrimEquals(a, b) {
  if (!a || !b) return (a ?? null) === (b ?? null);
  if ((a.kind ?? "edge") !== (b.kind ?? "edge")) return false;
  if (a.kind === "fill") {
    return a.mode === b.mode && a.color === b.color && a.opacity === b.opacity &&
      gradientEquals(a.gradient ?? null, b.gradient ?? null);
  }
  return a.edge === b.edge && a.height === b.height && a.from === b.from && a.to === b.to;
}

export function canvasEquals(a, b) {
  if (!a || !b) return a === b;
  return bgEquals(a.bg ?? null, b.bg ?? null) && padEquals(a.pad, b.pad) &&
    scrimEquals(a.scrim ?? null, b.scrim ?? null);
}

function cloneCanvas(canvas) {
  if (!canvas) return { pad: { top: 0, right: 0, bottom: 0, left: 0 }, bg: null, scrim: null };
  const bg = canvas.bg
    ? { ...canvas.bg, ...(canvas.bg.gradient ? { gradient: { ...canvas.bg.gradient } } : {}) }
    : null;
  const scrim = canvas.scrim
    ? { ...canvas.scrim, ...(canvas.scrim.gradient ? { gradient: { ...canvas.scrim.gradient } } : {}) }
    : null;
  return { pad: { ...canvas.pad }, bg, scrim };
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
