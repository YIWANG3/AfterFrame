const MIN_CROP_SIZE = 48;

export const ASPECT_PRESETS = [
  { key: "free", label: "Free", aspect: null },
  { key: "original", label: "Original", aspect: "original" },
  { key: "1:1", label: "1:1", aspect: 1 },
  { key: "3:2", label: "3:2", aspect: 3 / 2 },
  { key: "2:3", label: "2:3", aspect: 2 / 3 },
  { key: "4:3", label: "4:3", aspect: 4 / 3 },
  { key: "3:4", label: "3:4", aspect: 3 / 4 },
  { key: "5:4", label: "5:4", aspect: 5 / 4 },
  { key: "4:5", label: "4:5", aspect: 4 / 5 },
  { key: "16:9", label: "16:9", aspect: 16 / 9 },
  { key: "9:16", label: "9:16", aspect: 9 / 16 },
  { key: "2.35:1", label: "2.35:1", aspect: 2.35 },
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function minDimensionsForAspect(aspect) {
  if (!aspect) {
    return { width: MIN_CROP_SIZE, height: MIN_CROP_SIZE };
  }
  if (aspect >= 1) {
    return {
      width: MIN_CROP_SIZE * aspect,
      height: MIN_CROP_SIZE,
    };
  }
  return {
    width: MIN_CROP_SIZE,
    height: MIN_CROP_SIZE / aspect,
  };
}

function normalizeRect(rect, bounds) {
  const width = clamp(rect.width, Math.min(MIN_CROP_SIZE, bounds.width), bounds.width);
  const height = clamp(rect.height, Math.min(MIN_CROP_SIZE, bounds.height), bounds.height);
  return {
    x: clamp(rect.x, 0, bounds.width - width),
    y: clamp(rect.y, 0, bounds.height - height),
    width,
    height,
  };
}

export function getAspectRatio(aspectKey, originalAspect) {
  const preset = ASPECT_PRESETS.find((entry) => entry.key === aspectKey);
  if (!preset) return null;
  if (preset.aspect === "original") {
    return originalAspect || null;
  }
  return preset.aspect;
}

export function createDefaultCropRect(bounds, aspect) {
  if (!aspect) {
    return normalizeRect(
      {
        x: 0,
        y: 0,
        width: bounds.width,
        height: bounds.height,
      },
      bounds,
    );
  }

  let width = bounds.width;
  let height = width / aspect;
  if (height > bounds.height) {
    height = bounds.height;
    width = height * aspect;
  }

  return normalizeRect(
    {
      x: (bounds.width - width) / 2,
      y: (bounds.height - height) / 2,
      width,
      height,
    },
    bounds,
  );
}

export function moveCropRect(rect, bounds, deltaX, deltaY) {
  return normalizeRect(
    {
      ...rect,
      x: rect.x + deltaX,
      y: rect.y + deltaY,
    },
    bounds,
  );
}

function resizeFreeCropRect(rect, handle, point, bounds) {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;

  if (handle.includes("w")) {
    left = clamp(point.x, 0, right - MIN_CROP_SIZE);
  }
  if (handle.includes("e")) {
    right = clamp(point.x, left + MIN_CROP_SIZE, bounds.width);
  }
  if (handle.includes("n")) {
    top = clamp(point.y, 0, bottom - MIN_CROP_SIZE);
  }
  if (handle.includes("s")) {
    bottom = clamp(point.y, top + MIN_CROP_SIZE, bounds.height);
  }

  if (handle === "n") top = clamp(point.y, 0, bottom - MIN_CROP_SIZE);
  if (handle === "s") bottom = clamp(point.y, top + MIN_CROP_SIZE, bounds.height);
  if (handle === "w") left = clamp(point.x, 0, right - MIN_CROP_SIZE);
  if (handle === "e") right = clamp(point.x, left + MIN_CROP_SIZE, bounds.width);

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function fitCornerRect(anchor, point, bounds, aspect, directionX, directionY) {
  const minSize = minDimensionsForAspect(aspect);
  const maxWidth = directionX > 0 ? bounds.width - anchor.x : anchor.x;
  const maxHeight = directionY > 0 ? bounds.height - anchor.y : anchor.y;

  let width = Math.max(minSize.width, directionX > 0 ? point.x - anchor.x : anchor.x - point.x);
  let height = width / aspect;
  const pointerHeight = Math.max(minSize.height, directionY > 0 ? point.y - anchor.y : anchor.y - point.y);
  if (height > pointerHeight) {
    height = pointerHeight;
    width = height * aspect;
  }

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }

  width = Math.max(minSize.width, width);
  height = Math.max(minSize.height, height);

  const x = directionX > 0 ? anchor.x : anchor.x - width;
  const y = directionY > 0 ? anchor.y : anchor.y - height;

  return normalizeRect({ x, y, width, height }, bounds);
}

function fitVerticalEdgeRect(rect, point, bounds, aspect, edge) {
  const minSize = minDimensionsForAspect(aspect);
  const centerX = rect.x + rect.width / 2;
  const anchorY = edge === "n" ? rect.y + rect.height : rect.y;
  const maxHalfWidth = Math.min(centerX, bounds.width - centerX);
  const maxWidth = maxHalfWidth * 2;
  const maxHeight = edge === "n" ? anchorY : bounds.height - anchorY;

  let height = Math.max(minSize.height, edge === "n" ? anchorY - point.y : point.y - anchorY);
  let width = height * aspect;

  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }

  width = Math.max(minSize.width, width);
  height = Math.max(minSize.height, height);

  return normalizeRect(
    {
      x: centerX - width / 2,
      y: edge === "n" ? anchorY - height : anchorY,
      width,
      height,
    },
    bounds,
  );
}

function fitHorizontalEdgeRect(rect, point, bounds, aspect, edge) {
  const minSize = minDimensionsForAspect(aspect);
  const centerY = rect.y + rect.height / 2;
  const anchorX = edge === "w" ? rect.x + rect.width : rect.x;
  const maxHalfHeight = Math.min(centerY, bounds.height - centerY);
  const maxHeight = maxHalfHeight * 2;
  const maxWidth = edge === "w" ? anchorX : bounds.width - anchorX;

  let width = Math.max(minSize.width, edge === "w" ? anchorX - point.x : point.x - anchorX);
  let height = width / aspect;

  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  if (width > maxWidth) {
    width = maxWidth;
    height = width / aspect;
  }

  width = Math.max(minSize.width, width);
  height = Math.max(minSize.height, height);

  return normalizeRect(
    {
      x: edge === "w" ? anchorX - width : anchorX,
      y: centerY - height / 2,
      width,
      height,
    },
    bounds,
  );
}

function resizeFixedCropRect(rect, handle, point, bounds, aspect) {
  if (handle === "n" || handle === "s") {
    return fitVerticalEdgeRect(rect, point, bounds, aspect, handle);
  }
  if (handle === "w" || handle === "e") {
    return fitHorizontalEdgeRect(rect, point, bounds, aspect, handle);
  }

  const anchors = {
    nw: { x: rect.x + rect.width, y: rect.y + rect.height, dx: -1, dy: -1 },
    ne: { x: rect.x, y: rect.y + rect.height, dx: 1, dy: -1 },
    sw: { x: rect.x + rect.width, y: rect.y, dx: -1, dy: 1 },
    se: { x: rect.x, y: rect.y, dx: 1, dy: 1 },
  };

  const anchor = anchors[handle];
  if (!anchor) return rect;
  return fitCornerRect(
    { x: anchor.x, y: anchor.y },
    point,
    bounds,
    aspect,
    anchor.dx,
    anchor.dy,
  );
}

export function resizeCropRect(rect, handle, point, bounds, aspect) {
  if (!aspect) {
    return resizeFreeCropRect(rect, handle, point, bounds);
  }
  return resizeFixedCropRect(rect, handle, point, bounds, aspect);
}

// Free-rotation clamp (degrees) — the straighten ruler's range.
export const MIN_FREE_ANGLE = -45;
export const MAX_FREE_ANGLE = 45;

// A crop of `aspect` (or the full box if null) centered at (cx, cy), fitted
// within maxWidth × maxHeight.
export function createCenteredCrop(maxWidth, maxHeight, aspect, cx, cy) {
  let width = maxWidth;
  let height = maxHeight;
  if (aspect) {
    height = width / aspect;
    if (height > maxHeight) {
      height = maxHeight;
      width = height * aspect;
    }
  }
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

// Resize a crop rect from its center by dragging `handle` toward `point`,
// honoring an optional aspect ratio and the minimum crop size.
export function symmetricResize(cropRect, handle, point, aspect) {
  if (!cropRect) return cropRect;
  const cx = cropRect.x + cropRect.width / 2;
  const cy = cropRect.y + cropRect.height / 2;
  let halfW = cropRect.width / 2;
  let halfH = cropRect.height / 2;

  if (handle.includes("e") || handle.includes("w")) {
    halfW = Math.max(MIN_CROP_SIZE / 2, Math.abs(point.x - cx));
  }
  if (handle.includes("s") || handle.includes("n")) {
    halfH = Math.max(MIN_CROP_SIZE / 2, Math.abs(point.y - cy));
  }
  if (handle === "n" || handle === "s") halfW = cropRect.width / 2;
  if (handle === "e" || handle === "w") halfH = cropRect.height / 2;

  if (aspect) {
    if (handle === "n" || handle === "s") {
      halfW = halfH * aspect;
    } else if (handle === "e" || handle === "w") {
      halfH = halfW / aspect;
    } else {
      const candidateH = halfW / aspect;
      if (candidateH > halfH) {
        halfW = halfH * aspect;
      } else {
        halfH = candidateH;
      }
    }
  }

  halfW = Math.max(MIN_CROP_SIZE / 2, halfW);
  halfH = Math.max(MIN_CROP_SIZE / 2, halfH);

  return { x: cx - halfW, y: cy - halfH, width: halfW * 2, height: halfH * 2 };
}
