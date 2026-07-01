// Sticker tool — thin composition of the two pre-existing sticker hooks so the
// editor wires up one call, consistent with useCropTool / useTextTool. Extracted
// from EditorOverlay (Phase 3c).
//
// - `imageCache`: decoded sticker images keyed off the current layer stack
//   (useStickerImageCache), consumed by the layer renderer.
// - `region`: the drag-to-draw marquee that limits subject detection, scoped to
//   the current asset (useStickerRegion) — exposes { region, drag, setDrag,
//   commit, clear }.

import { useStickerImageCache } from "./useStickerImageCache";
import { useStickerRegion } from "./useStickerRegion";

export function useStickerTool({ layers, assetId }) {
  const imageCache = useStickerImageCache(layers);
  const region = useStickerRegion(assetId);
  return { imageCache, region };
}
