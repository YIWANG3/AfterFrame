// Compare for two photos picked in the gallery. BeforeAfterCompare draws what
// it is given; this picks what each side can actually show (compareSource),
// making a RAW's HD preview on demand the way the lightbox does.

import { useOnDemandHdPreview } from "../hooks/useOnDemandHdPreviews";
import { fileName } from "../utils/format";
import BeforeAfterCompare from "./editor/BeforeAfterCompare";
import { compareSource } from "./lightboxView";

export default function GalleryCompare({ items, catalogKey, layout, onClose, onLayoutChange }) {
  const [before, after] = items;
  const beforeHd = useOnDemandHdPreview({ current: before, catalogKey });
  const afterHd = useOnDemandHdPreview({ current: after, catalogKey });
  return (
    <BeforeAfterCompare
      beforePath={compareSource(before, { onDemandHd: beforeHd })}
      afterPath={compareSource(after, { onDemandHd: afterHd })}
      labels={[fileName(before.image_path) || before.stem, fileName(after.image_path) || after.stem]}
      resetKey={`${before.asset_id}|${after.asset_id}`}
      layout={layout}
      onClose={onClose}
      onLayoutChange={onLayoutChange}
    />
  );
}
