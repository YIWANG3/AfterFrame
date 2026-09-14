import { getBasePlacement } from "../imageMath";

// History stores crop/pan in stage pixels. Reproject each snapshot using its
// OWN orientation: landscape and portrait do not share the same fit scale.
export function rebaseViewport(state, sourceSize, from, to) {
  if (!state.cropRect || !sourceSize) return state;
  const rotated = Math.abs(state.quarterTurns % 2) === 1;
  const size = rotated
    ? { width: sourceSize.height, height: sourceSize.width }
    : sourceSize;
  const prev = getBasePlacement(from, size);
  const next = getBasePlacement(to, size);
  const scale = next.fitScale / prev.fitScale;
  const r = state.cropRect;
  return {
    ...state,
    cropRect: {
      x: next.centerX + (r.x - prev.centerX) * scale,
      y: next.centerY + (r.y - prev.centerY) * scale,
      width: r.width * scale,
      height: r.height * scale,
    },
    imageOffsetX: state.imageOffsetX * scale,
    imageOffsetY: state.imageOffsetY * scale,
  };
}
