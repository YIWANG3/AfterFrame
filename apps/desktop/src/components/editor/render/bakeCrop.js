// Apply's crop: the crop box, drawn on screen over the turned photo, cut out
// of the full-resolution source. The screen rects share the basis quarter
// turns and flips give (imageRect / cropRect live in it); the free angle
// turns the photo under the axis-aligned crop box about the box's centre,
// which is exactly what the crop UI shows (CSS rotate about cropCenter).

import { buildTransformedCanvas, cutRotatedCrop, getSourceDimensions, releaseCanvasImage } from "./canvasHelpers";

// The crop box in the transformed photo's pixels. Fractions are taken
// unclamped: with a free angle the box may legitimately reach past the
// unrotated photo's bounding box.
export function cropRectToPixels(cropRect, imageRect, transformedWidth, transformedHeight) {
  const sx = transformedWidth / imageRect.width;
  const sy = transformedHeight / imageRect.height;
  return {
    x: (cropRect.x - imageRect.x) * sx,
    y: (cropRect.y - imageRect.y) * sy,
    width: cropRect.width * sx,
    height: cropRect.height * sy,
  };
}

// The cropped photo as a canvas with naturalWidth/naturalHeight set, ready to
// become the editor's working source.
export function bakeCrop(sourceImage, { cropRect, imageRect, discreteRotationDeg, flipX, flipY, freeAngle }) {
  const { width: sourceWidth, height: sourceHeight } = getSourceDimensions(sourceImage);
  const transformed = buildTransformedCanvas(sourceImage, sourceWidth, sourceHeight, discreteRotationDeg, flipX, flipY);
  const cropPx = cropRectToPixels(cropRect, imageRect, transformed.width, transformed.height);
  const cropped = cutRotatedCrop(transformed, cropPx, freeAngle);
  releaseCanvasImage(transformed);
  cropped.naturalWidth = cropped.width;
  cropped.naturalHeight = cropped.height;
  return cropped;
}
