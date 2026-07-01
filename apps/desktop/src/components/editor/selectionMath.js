// Shared interaction math for on-canvas selection handles (text layers + frame
// elements). Kept framework-free so both TextCanvas and FrameEditOverlay use
// ONE implementation of "resize by distance-from-center" and "rotate with snap".

const ROT_SNAPS = [0, 90, 180, 270, -90, -180, -270];

// Snap a rotation (deg) to the nearest cardinal within `thresh` degrees.
export function snapAngle(deg, thresh = 3) {
  for (const s of ROT_SNAPS) if (Math.abs(deg - s) < thresh) return s;
  return deg;
}

// Resize ratio: how far the pointer is from the element center now vs. at the
// drag start. Multiplying the original size by this grows/shrinks symmetrically
// regardless of which handle was grabbed. Returns 1 if the start was at center.
export function resizeRatio(center, start, cur) {
  const sd = Math.hypot(start.x - center.x, start.y - center.y);
  if (!sd) return 1;
  return Math.hypot(cur.x - center.x, cur.y - center.y) / sd;
}
