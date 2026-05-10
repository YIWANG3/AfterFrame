// AfterFrame layer stack — text-only layers.
// Scene depth is image-level metadata managed separately in EditorOverlay,
// not a layer.

export const LAYER_TYPES = {
  TEXT: "text",
  STICKER: "sticker",
};

export function isTextLayer(layer) {
  return layer && (!layer.type || layer.type === LAYER_TYPES.TEXT);
}

export function isStickerLayer(layer) {
  return layer && layer.type === LAYER_TYPES.STICKER;
}

export function getTextLayers(layers) {
  return (layers || []).filter(isTextLayer);
}

export function moveLayerBy(layers, id, direction) {
  const idx = layers.findIndex((l) => l.id === id);
  if (idx < 0) return layers;
  const target = idx + direction;
  if (target < 0 || target >= layers.length) return layers;
  const next = layers.slice();
  const [moved] = next.splice(idx, 1);
  next.splice(target, 0, moved);
  return next;
}

export function removeLayerById(layers, id) {
  return (layers || []).filter((l) => l.id !== id);
}

export function replaceLayerById(layers, id, patch) {
  return (layers || []).map((l) => (l.id === id ? { ...l, ...patch } : l));
}

export function cloneLayerStack(layers) {
  return (layers || []).map((l) => ({ ...l }));
}

export function layerLabel(layer) {
  if (isTextLayer(layer)) return layer.text?.trim() || "Empty";
  if (isStickerLayer(layer)) return layer.sourceLabel || "Sticker";
  return "Layer";
}
