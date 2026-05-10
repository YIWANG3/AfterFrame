import { useEffect, useState } from "react";

// Marquee state for the Sticker tool's "limit detection to this rect" feature.
// Tracks the committed region (normalized 0..1) plus the in-progress drag.
// Resets whenever the editor opens a different image — old rects from previous
// photos shouldn't carry over.
export function useStickerRegion(itemKey) {
  const [region, setRegion] = useState(null);
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    setRegion(null);
    setDrag(null);
  }, [itemKey]);

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
