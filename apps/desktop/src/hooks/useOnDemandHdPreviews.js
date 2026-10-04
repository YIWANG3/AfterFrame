import { useEffect, useState, useSyncExternalStore } from "react";
import api from "../api";
import { createHdPreviewStore, hdPreviewIn } from "./hdPreviewStore";

// A RAW's HD preview (the JPEG its camera embedded, at full size) isn't made at
// import, where a drive holds tens of thousands of RAWs; it is made the first
// time something shows the RAW large. Images keep their original for that.
export function needsOnDemandHd(item) {
  return item?.asset_type === "raw"
    && Boolean(item.asset_id && item.image_path)
    && item.exists_on_disk !== false
    && !item.preview_hd_path
    && !item.image_preview_hd_path;
}

// The one store the lightbox, editor and collage share (see hdPreviewStore.js).
export const hdPreviews = createHdPreviewStore({
  ensure: (paths) => api.ensureHdPreviews(paths),
  readDetail: (assetId) => api.getAssetDetailById(assetId),
});

// The HD preview made on demand for `current`: its path, null once making one
// failed, undefined while it is being made (or needn't be). `prefetch`: photos
// to make ahead once the view has held still on `current` (the lightbox's
// neighbours). `catalogKey` is the open catalog's path; results belong to it.
export function useOnDemandHdPreview({
  current,
  prefetch = [],
  enabled = true,
  catalogKey = null,
  store = hdPreviews,
}) {
  // This view's identity in the store; what it wants replaces what it wanted.
  const [consumer] = useState(() => ({}));
  const key = enabled ? current?.asset_id || null : null;
  const wantedCurrent = enabled && needsOnDemandHd(current) ? current : null;
  const wantedPrefetch = enabled ? (prefetch || []).filter(needsOnDemandHd) : [];
  const currentId = wantedCurrent?.asset_id || "";
  const prefetchKey = wantedPrefetch.map((item) => item.asset_id).join("|");
  const catalog = catalogKey || null;

  // Only this photo's value is read, so a view re-renders when its own HD
  // changes, not on every request the store sends or answers. Until the store
  // has caught up with a catalog switch, what it holds is the previous one's.
  const hd = useSyncExternalStore(store.subscribe, () => {
    const snapshot = store.getSnapshot();
    if (!currentId || snapshot.catalog !== catalog) return undefined;
    return hdPreviewIn(snapshot, currentId);
  });

  useEffect(() => {
    store.setCatalog(catalog);
    store.want(consumer, { key, current: wantedCurrent, prefetch: wantedPrefetch });
    // The items are rebuilt every render; their ids are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, consumer, catalog, key, currentId, prefetchKey]);

  useEffect(() => () => store.release(consumer), [store, consumer]);

  return hd;
}
