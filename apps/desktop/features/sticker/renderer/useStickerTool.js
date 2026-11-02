import { useEffect, useState } from "react";

// The Sticker tool's state (EditorOverlay calls it like the core tools'
// hooks): the marquee that limits detection to a rect of the image — the
// committed region (normalized 0..1) plus the in-progress drag. Resets
// whenever the editor opens a different image — old rects from previous
// photos shouldn't carry over. The decoded sticker images the layer renderer
// needs are the editor core's (useStickerImageCache): layers carry stickers
// whether or not this feature is present.
export function useStickerTool({ assetId }) {
  const [region, setRegion] = useState(null);
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    setRegion(null);
    setDrag(null);
  }, [assetId]);

  function commit(rect) {
    setDrag(null);
    if (rect && rect.w > 0.02 && rect.h > 0.02) setRegion(rect);
    else setRegion(null);
  }
  function clear() {
    setRegion(null);
  }

  return { region, drag, setDrag, commit, clear };
}
