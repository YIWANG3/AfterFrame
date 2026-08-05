import { useEffect, useRef } from "react";
import { stickerSrc } from "../../../utils/format";

// Pre-decoded sticker images, keyed by absolute PNG path. The export pipeline
// (drawLayersOnCanvas) needs the HTMLImageElement to be `.complete` before it
// can draw, so we kick off loads as soon as a layer references a new sticker.
//
// Returns the underlying Map directly so callers can `cache.get(path)` from
// inside a render function without re-running this hook's setup.
export function useStickerImageCache(layers) {
  const cache = useRef(new Map()).current;
  useEffect(() => {
    const referenced = new Set();
    for (const layer of layers) {
      if (layer.type === "sticker" && layer.stickerPath) {
        referenced.add(layer.stickerPath);
        if (!cache.has(layer.stickerPath)) {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.src = stickerSrc(layer.stickerPath);
          cache.set(layer.stickerPath, img);
        }
      }
    }
    // data: URLs are multi-MB (handwriting recolors mint a new one per edit) —
    // drop entries no layer references anymore, or the map retains every
    // intermediate recolor for the session. File-path keys are cheap and shared
    // across layers, so those stay.
    for (const key of cache.keys()) {
      if (key.startsWith("data:") && !referenced.has(key)) cache.delete(key);
    }
  }, [layers, cache]);
  return cache;
}
