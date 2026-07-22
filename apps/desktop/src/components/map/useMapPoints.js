import { useEffect, useRef, useState } from "react";
import api from "../../api";

// Location points for the map, scoped like the gallery (status/collection/
// search/non-geo facets). filters.geo is stripped before the request — and by
// the sidecar again — so panning the map never hides out-of-viewport clusters.
//
// Cache key = everything that changes the point set. Viewport moves don't.
export default function useMapPoints({ enabled, status, collectionId, search, filters, catalogKey, refreshToken }) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const cacheRef = useRef({ key: null, points: null });

  const nonGeoFilters = { ...(filters || {}) };
  delete nonGeoFilters.geo;
  const cacheKey = JSON.stringify({
    catalogKey: catalogKey || null,
    collectionId: collectionId || null,
    status: collectionId ? null : status,
    search: (search || "").trim() || null,
    filters: nonGeoFilters,
    refreshToken: refreshToken || 0,
  });

  useEffect(() => {
    if (!enabled) return undefined;
    if (cacheRef.current.key === cacheKey && cacheRef.current.points) {
      setPoints(cacheRef.current.points);
      return undefined;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await api.browseMapPoints({
          status,
          collectionId: collectionId || undefined,
          search: (search || "").trim() || undefined,
          filters: Object.keys(nonGeoFilters).length ? nonGeoFilters : undefined,
        });
        if (cancelled || requestIdRef.current !== requestId) return;
        const next = rows || [];
        cacheRef.current = { key: cacheKey, points: next };
        setPoints(next);
      } catch {
        if (!cancelled && requestIdRef.current === requestId) setPoints([]);
      } finally {
        if (!cancelled && requestIdRef.current === requestId) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // cacheKey stringifies status/collection/search/filters — listing them
    // separately would double-fire the effect for the same logical key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cacheKey]);

  return { points, loading };
}
