// Settings opens over any view: the editor, a collage, the lightbox. While it
// is open it owns the keyboard. Keys pressed in it stop at its root, so the
// views' bubbling shortcuts never see them. The few views that listen in the
// capture phase hear a key before Settings can stop it; they check this and
// stand aside.
export const TOP_LAYER_ATTR = "data-top-layer";

export function topLayerOpen() {
  return typeof document !== "undefined" && !!document.querySelector(`[${TOP_LAYER_ATTR}]`);
}
