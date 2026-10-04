import { useEffect, useRef, useState } from "react";
import api from "../api";

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

// asset_id → the HD preview made for it, or null once making one failed. An
// item the map doesn't have yet is still being made (or needn't be).
export function useOnDemandHdPreviews(items, enabled = true) {
  const [hdById, setHdById] = useState({});
  const requestedRef = useRef(new Set());
  const wanted = enabled ? (items || []).filter(needsOnDemandHd) : [];
  const wantedKey = wanted.map((item) => item.asset_id).join("|");

  useEffect(() => {
    const fresh = wanted.filter((item) => !requestedRef.current.has(item.asset_id));
    if (!fresh.length) return;
    for (const item of fresh) requestedRef.current.add(item.asset_id);
    (async () => {
      const found = Object.fromEntries(fresh.map((item) => [item.asset_id, null]));
      try {
        await api.ensureHdPreviews(fresh.map((item) => item.image_path));
        const details = await Promise.all(
          fresh.map((item) => Promise.resolve(api.getAssetDetailById(item.asset_id)).catch(() => null)),
        );
        for (const detail of details) {
          const hd = detail?.image_preview_hd_path || detail?.preview_hd_path;
          if (detail?.asset_id && hd) found[detail.asset_id] = hd;
        }
      } catch (err) {
        console.warn("[hd] on-demand HD preview failed:", err);
      }
      setHdById((prev) => ({ ...prev, ...found }));
    })();
    // `wanted` is derived from items each render; its ids are the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey]);

  return hdById;
}
