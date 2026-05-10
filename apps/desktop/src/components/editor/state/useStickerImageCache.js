import { useEffect, useRef } from "react";
import { localFileUrl } from "../../../utils/format";

// Pre-decoded sticker images, keyed by absolute PNG path. The export pipeline
// (drawLayersOnCanvas) needs the HTMLImageElement to be `.complete` before it
// can draw, so we kick off loads as soon as a layer references a new sticker.
//
// Returns the underlying Map directly so callers can `cache.get(path)` from
// inside a render function without re-running this hook's setup.
export function useStickerImageCache(layers) {
  const cache = useRef(new Map()).current;
  useEffect(() => {
    for (const layer of layers) {
      if (layer.type === "sticker" && layer.stickerPath && !cache.has(layer.stickerPath)) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = localFileUrl(layer.stickerPath);
        cache.set(layer.stickerPath, img);
      }
    }
  }, [layers, cache]);
  return cache;
}
