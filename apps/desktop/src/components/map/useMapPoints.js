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

// Module-level, so a remount (the Discover page is unmounted on every view
// switch, the drawer is created lazily) reuses the last point sets instead of
// re-running a 100k-row query. A handful of keys is plenty: whole-catalog,
// current gallery scope, a collection or two.
const POINT_CACHE_MAX = 6;
const pointCache = new Map();
function cachePut(key, points) {
  pointCache.delete(key);
  pointCache.set(key, points);
  while (pointCache.size > POINT_CACHE_MAX) pointCache.delete(pointCache.keys().next().value);
}

export default function useMapPoints({ enabled, status, collectionId, search, filters, catalogKey, refreshToken }) {
  const requestIdRef = useRef(0);

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

  const [points, setPoints] = useState(() => (enabled && pointCache.get(cacheKey)) || []);

  useEffect(() => {
    if (!enabled) return undefined;
    const cached = pointCache.get(cacheKey);
    if (cached) {
      setPoints(cached);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
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
          cachePut(cacheKey, next);
          setPoints(next);
        } catch {
          if (!cancelled && requestIdRef.current === requestId) setPoints([]);
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

  return { points };
}
