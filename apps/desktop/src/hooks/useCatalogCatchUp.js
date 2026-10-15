// Once per catalog: a background pass that brings an older catalog up to
// what this version records (dominant colours, photo orientation, resolved
// AI locations). `run` starts when `key` (the catalog path, or null while
// the pass must wait — for the grid, for the map to open) is first seen,
// and never again for that catalog in this window; a catalog from this
// version has nothing to do and answers without a job. Best-effort: a
// failure is silent, and the next catalog switch tries its own.

import { useEffect, useEffectEvent, useRef } from "react";

export default function useCatalogCatchUp(key, run) {
  const doneRef = useRef(new Set());
  const start = useEffectEvent(async () => {
    try { await run(); } catch { /* best-effort */ }
  });
  useEffect(() => {
    if (!key || doneRef.current.has(key)) return;
    doneRef.current.add(key);
    void start();
  }, [key]);
}
