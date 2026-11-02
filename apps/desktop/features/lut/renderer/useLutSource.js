// What the LUT tool grades when the photo is a RAW (docs/lut-plan.md, RAW):
// Apple's rendering of it, never the camera's embedded JPEG. Once the tool is
// opened on a RAW, the picture swaps to that render for the rest of the
// session — edits, layers and history stay. Not after an Apply: the baked
// picture would be lost, so the LUT grades what Apply made.
//
// Returns:
//   sourceOverride  the render's path once made, for the editor to show in
//                   place of the RAW's preview; null until then and for
//                   anything that is not a RAW
//   rendering       the render asked for and not back yet (a couple of
//                   seconds): the picture on screen is still the camera's
//                   JPEG, about to be replaced
//   base            what the LUT is grading, for the panel and the tests:
//                   "apple" | "libraw" | "rendering" | "embedded" | "baked",
//                   null when the LUT tool does not apply to this photo

import { useEffect, useState } from "react";
import { useNeutralRawRender } from "../../../src/hooks/useRawEditSource";

export function useLutSource({ open, active, item, isRaw, available, sourceBaked }) {
  const itemKey = item?.asset_id ?? item?.image_path ?? null;
  // Per photo (keyed, so the first render of the next photo is already clean).
  const [neutralItem, setNeutralItem] = useState(null);
  const neutralWanted = open && neutralItem === itemKey;
  const neutralRaw = useNeutralRawRender({ item, enabled: open && isRaw && available && neutralWanted });
  const sourceOverride = isRaw ? neutralRaw?.path || null : null;
  const rendering = isRaw && available && !sourceBaked && neutralWanted && neutralRaw === undefined;
  useEffect(() => {
    if (!open) {
      setNeutralItem(null);
    } else if (active && isRaw && available && !sourceBaked) {
      setNeutralItem(itemKey);
    }
  }, [open, active, isRaw, available, sourceBaked, itemKey]);
  const base = !isRaw || !available ? null
    : sourceBaked ? "baked"
    : neutralRaw?.path ? (neutralRaw.renderer === "libraw" ? "libraw" : "apple")
    : rendering ? "rendering"
    : "embedded";
  return { sourceOverride, rendering, base };
}
