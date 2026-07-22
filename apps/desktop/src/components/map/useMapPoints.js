import { useEffect, useRef, useState } from "react";
import api from "../../api";

// Location points for the map, scoped like the gallery (status/collection/
// search/non-geo facets). filters.geo is stripped before the request — and by
// the sidecar again — so panning the map never hides out-of-viewport clusters.
//
// Cache key = everything that changes the point set. Viewport moves don't.
// Fetches are debounced 250ms (matching the gallery's search debounce) so a
// keystroke burst issues one query, not one per character; cache hits apply
// immediately. `enabled` should be false while the drawer is collapsed — the
// map isn't visible, so scope changes shouldn't cost 100k-row queries; the
// next expand re-runs the effect with the then-current key.
const FETCH_DEBOUNCE_MS = 250;

export default function useMapPoints({ enabled, status, collectionId, search, filters, catalogKey, refreshToken }) {
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);
  const cacheRef = useRef({ key: null, points: null });

  const nonGeoFilters = { ...(filters || {}) };
  delete nonGeoFilters.geo;
  // Collection scope: the sidecar ignores search/facets there (to mirror
  // browse_collection) — key on what the query actually uses.
  const cacheKey = JSON.stringify({
    catalogKey: catalogKey || null,
    collectionId: collectionId || null,
    status: collectionId ? null : status,
    search: collectionId ? null : (search || "").trim() || null,
    filters: collectionId ? null : nonGeoFilters,
    refreshToken: refreshToken || 0,
  });

  useEffect(() => {
    if (!enabled) return undefined;
    if (cacheRef.current.key === cacheKey && cacheRef.current.points) {
      setPoints(cacheRef.current.points);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
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
    }, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // cacheKey stringifies status/collection/search/filters — listing them
    // separately would double-fire the effect for the same logical key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, cacheKey]);

  return { points, loading };
}
