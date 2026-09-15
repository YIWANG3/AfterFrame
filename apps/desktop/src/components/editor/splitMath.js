// Geometry for the seamless split tool (docs/split-carousel-plan.md). Pure
// functions over plain rects so the interaction hook and the export path share
// one definition of "the region" and "the panels".
//
// Two coordinate frames appear here:
//  • VIEWPORT px rects — `bounds` is the photo rect on screen (zoom-free), and
//    the region rect is dragged/resized in that frame.
//  • NORMALIZED rects — fractions of the transformed photo; what the editor
//    state stores and what the export sends to the main process.

import { getAspectRatio, resizeCropRect } from "./cropMath";
import { cropExtentForAngle } from "./imageMath";

export const DEFAULT_SPLIT_ASPECT_KEY = "3:4";
export const MIN_SPLIT_COUNT = 2;
export const MAX_SPLIT_COUNT = 10;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// The panel ratio uses the crop tool's preset list verbatim: null = Free (the
// region keeps whatever shape it is dragged to), "original" = the photo's own
// aspect (`sourceAspect`), else the preset's ratio.
export function getSplitPanelAspect(aspectKey, sourceAspect) {
  return getAspectRatio(aspectKey, sourceAspect || null);
}

// Automatic panel count: as many panels of `panelAspect` as fit across the
// photo at full height, clamped to the supported range. A user-chosen count is
// clamped the same way. Free panels count as the default preset.
export function resolveSplitCount(imageWidth, imageHeight, panelAspect, count) {
  if (Number.isInteger(count)) return clamp(count, MIN_SPLIT_COUNT, MAX_SPLIT_COUNT);
  if (!imageWidth || !imageHeight) return MIN_SPLIT_COUNT;
  const aspect = panelAspect || getAspectRatio(DEFAULT_SPLIT_ASPECT_KEY, 1);
  return clamp(Math.floor(imageWidth / (imageHeight * aspect)), MIN_SPLIT_COUNT, MAX_SPLIT_COUNT);
}

function scaleAboutCenter(rect, factor) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const width = rect.width * factor;
  const height = rect.height * factor;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

// Keep the region inside the photo. With a free angle the photo turns under
// the axis-aligned region about the region's centre, so what must fit is the
// region's ROTATED extent — shrink about the centre first, then shift.
export function fitSplitRect(rect, bounds, freeAngle = 0) {
  if (!rect || !bounds) return rect;
  let next = { ...rect };
  let extent = cropExtentForAngle(next, freeAngle);
  const factor = Math.min(1, bounds.width / extent.width, bounds.height / extent.height);
  if (factor < 1) {
    next = scaleAboutCenter(next, factor);
    extent = cropExtentForAngle(next, freeAngle);
  }
  let dx = 0;
  let dy = 0;
  if (extent.x < bounds.x) dx = bounds.x - extent.x;
  else if (extent.x + extent.width > bounds.x + bounds.width) dx = bounds.x + bounds.width - (extent.x + extent.width);
  if (extent.y < bounds.y) dy = bounds.y - extent.y;
  else if (extent.y + extent.height > bounds.y + bounds.height) dy = bounds.y + bounds.height - (extent.y + extent.height);
  return { x: next.x + dx, y: next.y + dy, width: next.width, height: next.height };
}

// Default region: full photo height, N panels wide, centred. When that is
// wider than the photo the width wins and the height shrinks to match. A free
// (null) aspect covers the whole photo.
export function createDefaultSplitRect(bounds, regionAspect, freeAngle = 0) {
  let height = bounds.height;
  let width = regionAspect ? height * regionAspect : bounds.width;
  if (width > bounds.width) {
    width = bounds.width;
    height = width / regionAspect;
  }
  const rect = {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
  return fitSplitRect(rect, bounds, freeAngle);
}

// Re-aim an existing region at a new aspect (panel ratio or count changed):
// keep its centre, take the largest size that fits the photo (like the crop
// tool's aspect change), then fit.
export function reshapeSplitRect(rect, bounds, regionAspect, freeAngle = 0) {
  if (!rect) return createDefaultSplitRect(bounds, regionAspect, freeAngle);
  if (!regionAspect) return fitSplitRect(rect, bounds, freeAngle); // free: keep the shape
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  let height = bounds.height;
  let width = height * regionAspect;
  if (width > bounds.width) {
    width = bounds.width;
    height = width / regionAspect;
  }
  return fitSplitRect({ x: cx - width / 2, y: cy - height / 2, width, height }, bounds, freeAngle);
}

export function moveSplitRect(rect, bounds, deltaX, deltaY, freeAngle = 0) {
  return fitSplitRect({ ...rect, x: rect.x + deltaX, y: rect.y + deltaY }, bounds, freeAngle);
}

// Handle drag. cropMath's resize (free with a null aspect, locked otherwise)
// already anchors the opposite side and clamps to a {width,height} box, so run
// it in bounds-local coordinates and translate back.
export function resizeSplitRect(rect, handle, point, bounds, regionAspect, freeAngle = 0) {
  const local = { x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height };
  const localPoint = { x: point.x - bounds.x, y: point.y - bounds.y };
  const resized = resizeCropRect(local, handle, localPoint, { width: bounds.width, height: bounds.height }, regionAspect);
  return fitSplitRect(
    { x: resized.x + bounds.x, y: resized.y + bounds.y, width: resized.width, height: resized.height },
    bounds,
    freeAngle,
  );
}

export function normalizeSplitRect(rect, bounds) {
  if (!rect || !bounds || !bounds.width || !bounds.height) return null;
  return {
    x: clamp((rect.x - bounds.x) / bounds.width, 0, 1),
    y: clamp((rect.y - bounds.y) / bounds.height, 0, 1),
    width: clamp(rect.width / bounds.width, 0, 1),
    height: clamp(rect.height / bounds.height, 0, 1),
  };
}

export function denormalizeSplitRect(normalized, bounds) {
  if (!normalized || !bounds) return null;
  return {
    x: bounds.x + normalized.x * bounds.width,
    y: bounds.y + normalized.y * bounds.height,
    width: normalized.width * bounds.width,
    height: normalized.height * bounds.height,
  };
}

// Seamless boundaries: cumulative rounding, so adjacent panels share an edge
// pixel-exactly (no gap, no overlap); widths differ by at most 1px. The main
// process (electron/ipc/saveFile.js) uses the identical formula.
export function panelBoundaries(width, count) {
  const bounds = [];
  for (let i = 0; i <= count; i++) bounds.push(Math.round((i * width) / count));
  return bounds;
}

// The region as a pixel rect of a W×H raster, rounded like the sharp path.
export function regionToPixels(normalized, sourceWidth, sourceHeight) {
  const left = Math.max(0, Math.round(normalized.x * sourceWidth));
  const top = Math.max(0, Math.round(normalized.y * sourceHeight));
  const width = Math.min(Math.round(sourceWidth) - left, Math.max(1, Math.round(normalized.width * sourceWidth)));
  const height = Math.min(Math.round(sourceHeight) - top, Math.max(1, Math.round(normalized.height * sourceHeight)));
  return { x: left, y: top, width, height };
}

// The N panel rects, in pixels of a W×H raster (source or preview).
export function splitRectToPanels(normalized, count, sourceWidth, sourceHeight) {
  if (!normalized || !count) return [];
  const region = regionToPixels(normalized, sourceWidth, sourceHeight);
  const bounds = panelBoundaries(region.width, count);
  const panels = [];
  for (let i = 0; i < count; i++) {
    panels.push({
      x: region.x + bounds[i],
      y: region.y,
      width: bounds[i + 1] - bounds[i],
      height: region.height,
    });
  }
  return panels;
}
