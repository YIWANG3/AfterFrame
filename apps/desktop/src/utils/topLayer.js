// Settings opens over any view: the editor, a collage, the lightbox. While it
// is open it owns the keyboard. Keys pressed in it stop at its root, so the
// views' bubbling shortcuts never see them. The few views that listen in the
// capture phase hear a key before Settings can stop it; they check this and
// stand aside.
//
// The confirm and Add Tags dialogs mark themselves the same way: they open
// over the lightbox too (Delete, T), and on macOS a video's picture is a
// native layer above the whole page, which hides while any top layer is open
// (hooks/useNativeVideo.js).
export const TOP_LAYER_ATTR = "data-top-layer";

export function topLayerOpen() {
  return typeof document !== "undefined" && !!document.querySelector(`[${TOP_LAYER_ATTR}]`);
}
