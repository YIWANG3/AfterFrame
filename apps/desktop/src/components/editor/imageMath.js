// Pure math for placing the source image inside the editor viewport:
// where the image rect lives, how to fit it to the stage, how to clamp
// pan/zoom so the crop frame stays fully covered.

export const PANEL_WIDTH = 320;
export const PANEL_GAP = 24;
export const CANVAS_SIDE_PADDING = 48;
export const MIN_IMAGE_ZOOM = 0.72;
export const MAX_IMAGE_ZOOM = 20;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getStageBounds(viewportSize) {
  return {
    width: Math.max(200, viewportSize.width - PANEL_WIDTH - PANEL_GAP - CANVAS_SIDE_PADDING * 2),
    height: Math.max(200, viewportSize.height - 140),
  };
}

export function getBasePlacement(viewportSize, transformedPreview) {
  if (!transformedPreview) return null;
  const stage = getStageBounds(viewportSize);
  const fitScale = Math.min(
    stage.width / transformedPreview.width,
    stage.height / transformedPreview.height,
  ) * 0.94;
  const centerX = CANVAS_SIDE_PADDING + stage.width / 2 - 26;
  const centerY = viewportSize.height / 2 - 30;
  return { fitScale, centerX, centerY };
}

export function getMinZoomForCrop(cropRect, transformedPreview, placement) {
  if (!cropRect || !transformedPreview || !placement) return 0;
  return Math.max(
    cropRect.width / (transformedPreview.width * placement.fitScale),
    cropRect.height / (transformedPreview.height * placement.fitScale),
  );
}

export function getImageRect(state, transformedPreview, placement) {
  if (!state || !transformedPreview || !placement) return null;
  const zoom = state.imageZoom;
  const width = transformedPreview.width * placement.fitScale * zoom;
  const height = transformedPreview.height * placement.fitScale * zoom;
  return {
    x: placement.centerX - width / 2 + state.imageOffsetX,
    y: placement.centerY - height / 2 + state.imageOffsetY,
    width,
    height,
  };
}

export function clampImagePlacement(state, transformedPreview, placement) {
  if (!state.cropRect || !transformedPreview || !placement) return state;
  const minZoom = getMinZoomForCrop(state.cropRect, transformedPreview, placement);
  const imageZoom = clamp(state.imageZoom, minZoom, MAX_IMAGE_ZOOM);
  const width = transformedPreview.width * placement.fitScale * imageZoom;
  const height = transformedPreview.height * placement.fitScale * imageZoom;
  const minOffsetX = state.cropRect.x + state.cropRect.width - (placement.centerX + width / 2);
  const maxOffsetX = state.cropRect.x - (placement.centerX - width / 2);
  const minOffsetY = state.cropRect.y + state.cropRect.height - (placement.centerY + height / 2);
  const maxOffsetY = state.cropRect.y - (placement.centerY - height / 2);
  return {
    ...state,
    imageZoom,
    imageOffsetX: clamp(state.imageOffsetX, minOffsetX, maxOffsetX),
    imageOffsetY: clamp(state.imageOffsetY, minOffsetY, maxOffsetY),
  };
}
