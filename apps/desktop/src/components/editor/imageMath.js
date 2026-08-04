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

// Single source of truth for "is a canvas margin active" — save, crop and
// viewport code all key off the same predicate.
export function hasPad(pad) {
  return !!(pad && (pad.top || pad.right || pad.bottom || pad.left));
}

// The crop rect as fractions of the photo. Derived from the PAD-FREE geometry
// (cropRect / zoom / offsets all live in crop space), so it stays stable when a
// canvas margin is added or removed.
export function getNormalizedCrop(state, imageRect) {
  const cropRect = state?.cropRect;
  if (!cropRect || !imageRect) return null;
  return {
    x: clamp((cropRect.x - imageRect.x) / imageRect.width, 0, 1),
    y: clamp((cropRect.y - imageRect.y) / imageRect.height, 0, 1),
    width: clamp(cropRect.width / imageRect.width, 0, 1),
    height: clamp(cropRect.height / imageRect.height, 0, 1),
  };
}

// The CONTENT the border wraps: the crop sub-rect when a crop is active, else
// the full photo. Rounded the same way the save path rounds its export rect so
// preview fractions and saved pixels share one basis.
function getContentDims(transformedPreview, crop) {
  const w = transformedPreview.width;
  const h = transformedPreview.height;
  if (!crop) return { width: w, height: h };
  return {
    width: Math.max(1, Math.round(crop.width * w)),
    height: Math.max(1, Math.round(crop.height * h)),
  };
}

// Output canvas = the content (cropped photo) expanded by `pad` margins
// (fractions of the content's SHORT edge). Zero / null pad returns the photo's
// dimensions verbatim — the pad=0 identity the unified-canvas refactor rests on.
export function getOutputDimensions(transformedPreview, pad, crop) {
  if (!hasPad(pad)) return { width: transformedPreview.width, height: transformedPreview.height };
  const p = { top: 0, right: 0, bottom: 0, left: 0, ...(pad || {}) };
  const c = getContentDims(transformedPreview, crop);
  const short = Math.min(c.width, c.height);
  return {
    width: Math.round(c.width + (p.left + p.right) * short),
    height: Math.round(c.height + (p.top + p.bottom) * short),
  };
}

export function getBasePlacement(viewportSize, transformedPreview, pad, crop) {
  if (!transformedPreview) return null;
  const stage = getStageBounds(viewportSize);
  const out = getOutputDimensions(transformedPreview, pad, crop);
  const fitScale = Math.min(
    stage.width / out.width,
    stage.height / out.height,
  ) * 0.94;
  const centerX = CANVAS_SIDE_PADDING + stage.width / 2 - 26;
  const centerY = viewportSize.height / 2 - 30;
  return { fitScale, centerX, centerY };
}

// The composed OUTPUT view for the text tool: where the output canvas (content
// + margins), the content window (crop region) and the full photo land on
// screen. In pad mode the content window is the live cropRect, while photoRect
// is the live imageRect; therefore wheel zoom/pan remains visible inside the
// framed output.
export function getOutputView(state, transformedPreview, crop, imageRect) {
  if (!state || !transformedPreview || !imageRect) return null;
  const pad = state.canvas?.pad;
  if (!hasPad(pad)) {
    // Output = photo (identity). The content window is still the crop region —
    // pad-less consumers (the scrim) hug the area that actually gets saved.
    const contentRect = crop && (crop.x || crop.y || crop.width !== 1 || crop.height !== 1)
      ? {
          x: imageRect.x + crop.x * imageRect.width,
          y: imageRect.y + crop.y * imageRect.height,
          width: crop.width * imageRect.width,
          height: crop.height * imageRect.height,
        }
      : imageRect;
    return { rect: imageRect, contentRect, photoRect: imageRect };
  }
  const contentRect = state.cropRect || (
    crop
      ? {
          x: imageRect.x + crop.x * imageRect.width,
          y: imageRect.y + crop.y * imageRect.height,
          width: crop.width * imageRect.width,
          height: crop.height * imageRect.height,
        }
      : imageRect
  );
  const short = Math.min(contentRect.width, contentRect.height);
  const rect = {
    x: contentRect.x - (pad.left || 0) * short,
    y: contentRect.y - (pad.top || 0) * short,
    width: contentRect.width + ((pad.left || 0) + (pad.right || 0)) * short,
    height: contentRect.height + ((pad.top || 0) + (pad.bottom || 0)) * short,
  };
  return { rect, contentRect, photoRect: imageRect };
}

export const IDENTITY_VIEW_TRANSFORM = { scale: 1, x: 0, y: 0 };

function transformRect(rect, transform) {
  const t = transform || IDENTITY_VIEW_TRANSFORM;
  return {
    x: rect.x * t.scale + t.x,
    y: rect.y * t.scale + t.y,
    width: rect.width * t.scale,
    height: rect.height * t.scale,
  };
}

export function transformOutputView(outputView, transform) {
  if (!outputView) return null;
  return {
    rect: transformRect(outputView.rect, transform),
    contentRect: transformRect(outputView.contentRect, transform),
    photoRect: transformRect(outputView.photoRect, transform),
  };
}

// Fit and center the composed output canvas in the editor stage. This is a
// SCREEN-ONLY transform: it deliberately does not mutate crop/image geometry,
// so dragging or fitting the canvas cannot affect save/export semantics.
export function fitViewTransformToStage(outputRect, viewportSize, placement) {
  if (!outputRect || !viewportSize || !placement) return IDENTITY_VIEW_TRANSFORM;
  const stage = getStageBounds(viewportSize);
  const maxW = stage.width * 0.94;
  const maxH = stage.height * 0.94;
  const scale = Math.min(1, maxW / outputRect.width, maxH / outputRect.height);
  return {
    scale,
    x: placement.centerX - (outputRect.x + outputRect.width / 2) * scale,
    y: placement.centerY - (outputRect.y + outputRect.height / 2) * scale,
  };
}

export function getMinZoomForCrop(cropRect, transformedPreview, placement) {
  if (!cropRect || !transformedPreview || !placement) return 0;
  return Math.max(
    cropRect.width / (transformedPreview.width * placement.fitScale),
    cropRect.height / (transformedPreview.height * placement.fitScale),
  );
}

// A text/sticker layer's stored x/y is a fraction of whatever the CURRENT
// output basis is: the full photo when pad=0, or the composed output (cropped
// content + margins) when pad>0. When the pad changes, that basis moves — so a
// layer pinned at "photo center" would visually jump. These two converters go
// through a stable full-photo-fraction space so we can re-express a layer's
// position in the new basis while keeping it fixed relative to the photo.
function contentGeom(transformedPreview, crop, pad) {
  const p = { top: 0, right: 0, bottom: 0, left: 0, ...(pad || {}) };
  const fullW = transformedPreview.width;
  const fullH = transformedPreview.height;
  const contentW = crop ? crop.width * fullW : fullW;
  const contentH = crop ? crop.height * fullH : fullH;
  const cropX = crop ? crop.x * fullW : 0;
  const cropY = crop ? crop.y * fullH : 0;
  const short = Math.min(contentW, contentH);
  const outW = contentW + (p.left + p.right) * short;
  const outH = contentH + (p.top + p.bottom) * short;
  return { fullW, fullH, cropX, cropY, ox: p.left * short, oy: p.top * short, outW, outH };
}

// Layer output-fraction → full-photo fraction.
function layerFractionToPhoto(fx, fy, transformedPreview, crop, pad) {
  if (!hasPad(pad)) return { px: fx, py: fy }; // pad=0 basis IS the full photo
  const g = contentGeom(transformedPreview, crop, pad);
  return { px: (g.cropX + fx * g.outW - g.ox) / g.fullW, py: (g.cropY + fy * g.outH - g.oy) / g.fullH };
}

// Full-photo fraction → layer output-fraction.
function photoToLayerFraction(px, py, transformedPreview, crop, pad) {
  if (!hasPad(pad)) return { fx: px, fy: py };
  const g = contentGeom(transformedPreview, crop, pad);
  return { fx: (px * g.fullW - g.cropX + g.ox) / g.outW, fy: (py * g.fullH - g.cropY + g.oy) / g.outH };
}

// The pixel width a layer's size fields are relative to. Text fontSize / stroke /
// shadow (rendered at width/1920) and sticker scale (a width fraction) are all
// expressed against the CURRENT output basis: the full photo when pad=0, or the
// composed output (cropped content + margins) when pad>0. So when the basis
// changes, sizes must be rescaled by oldBasisW/newBasisW to stay visually fixed.
function basisWidth(transformedPreview, crop, pad) {
  if (!hasPad(pad)) return transformedPreview.width;
  return contentGeom(transformedPreview, crop, pad).outW;
}

// The size fields that are basis-width relative (mirror saveImage's `k` rescale).
function rescaleLayerSize(layer, k) {
  if (k === 1) return layer;
  if (layer.type === "overlay") return layer;
  if (layer.type === "sticker") return { ...layer, scale: (layer.scale ?? 0.4) * k };
  return {
    ...layer,
    fontSize: (layer.fontSize ?? 0) * k,
    shadowBlur: (layer.shadowBlur ?? 0) * k,
    shadowX: (layer.shadowX ?? 0) * k,
    shadowY: (layer.shadowY ?? 0) * k,
    strokeWidth: (layer.strokeWidth ?? 0) * k,
  };
}

// Re-express each layer from one output basis into another, keeping it visually
// fixed relative to the (cropped) photo. `from`/`to` are { crop, pad } — position
// goes through full-photo-fraction space and size fields are rescaled by the
// basis-width ratio. Handles pad changes AND crop changes (both move the basis
// once a margin is active). No-op when the basis is unchanged.
export function convertLayersBasis(layers, transformedPreview, from, to) {
  if (!transformedPreview || !layers?.length) return layers;
  const fromW = basisWidth(transformedPreview, from.crop, from.pad || {});
  const toW = basisWidth(transformedPreview, to.crop, to.pad || {});
  const k = fromW > 0 ? fromW / toW : 1;
  return layers.map((l) => {
    // Overlays always resolve against the current photo content rect. They do
    // not own a positional basis and therefore need no crop/pad conversion.
    if (l.type === "overlay") return { ...l };
    const p = layerFractionToPhoto(l.x, l.y, transformedPreview, from.crop, from.pad || {});
    const n = photoToLayerFraction(p.px, p.py, transformedPreview, to.crop, to.pad || {});
    return { ...rescaleLayerSize(l, k), x: n.fx, y: n.fy };
  });
}

// Layers are STORED in a basis-independent coordinate system: positions as
// full-photo fractions, sizes as full-photo-relative values (i.e. the pad=0,
// no-crop basis). Nothing in storage moves when the pad or crop changes, so
// undo/redo just restore data and rendering derives the on-screen coordinates
// fresh — no imperative remap, no drift. These two converters are that
// derivation boundary; STORAGE ⇄ the current output/display basis.
const STORAGE_BASIS = { crop: null, pad: null };

// STORAGE (full-photo) → the live display basis (composed output when pad>0,
// full photo when pad=0). For TextCanvas / TextPanel.
export function layersToDisplay(layers, transformedPreview, crop, pad) {
  return convertLayersBasis(layers, transformedPreview, STORAGE_BASIS, { crop, pad });
}

// The display basis → STORAGE, to fold edits back into the stored layers.
export function layersFromDisplay(layers, transformedPreview, crop, pad) {
  return convertLayersBasis(layers, transformedPreview, { crop, pad }, STORAGE_BASIS);
}

// Re-express layers when the current (crop, pad) output is BAKED into a fresh
// full-photo source (the crop tool's Apply): the cropped content becomes the new
// whole photo and the margins are discarded. Positions are pulled from the old
// output basis into the crop sub-rect (→ new pad=0 photo fractions) and sizes are
// rescaled from the old basis width to the new full-photo (== content) width.
export function bakeLayersIntoCrop(layers, transformedPreview, crop, pad) {
  if (!transformedPreview || !layers?.length) return layers;
  const oldW = basisWidth(transformedPreview, crop, pad || {});
  const newW = crop ? crop.width * transformedPreview.width : transformedPreview.width;
  const k = newW > 0 ? oldW / newW : 1;
  return layers.map((l) => {
    if (l.type === "overlay") return { ...l };
    const p = layerFractionToPhoto(l.x, l.y, transformedPreview, crop, pad || {});
    const x = crop ? (p.px - crop.x) / crop.width : p.px;
    const y = crop ? (p.py - crop.y) / crop.height : p.py;
    return { ...rescaleLayerSize(l, k), x, y };
  });
}

// The photo rect in CROP SPACE (pad-free): the basis for the crop overlay,
// pan/zoom clamping and normalized-crop derivation. Canvas margins never move
// this rect — the composed border view is getOutputView's job.
export function getImageRect(state, transformedPreview, placement) {
  if (!state || !transformedPreview || !placement) return null;
  const zoom = state.imageZoom;
  const s = placement.fitScale * zoom;
  const width = transformedPreview.width * s;
  const height = transformedPreview.height * s;
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
