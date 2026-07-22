import { useEffect, useRef } from "react";

const DEBOUNCE_MS = 250;

// Turns map viewport moves into the gallery's filters.geo — debounced so a
// pan/zoom flurry commits only the final viewport, and suspended entirely in
// collection view (browse-collection ignores facet filters; a chip that does
// nothing would just mislead).
export default function useMapViewportFilter({ enabled, filters, applyFilters }) {
  const timerRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { enabled, filters, applyFilters };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleViewportChange(viewport) {
    const { enabled: isEnabled } = stateRef.current;
    if (!isEnabled || !viewport) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const { filters: currentFilters, applyFilters: apply, enabled: stillEnabled } = stateRef.current;
      if (!stillEnabled) return;
      // Engage on the user's first deliberate move; after that keep tracking.
      // Programmatic viewports (initial load, resize) never create the filter.
      if (!viewport.interacted && !currentFilters?.geo) return;
      apply({
        ...currentFilters,
        geo: {
          mode: "bounds",
          west: viewport.west,
          south: viewport.south,
          east: viewport.east,
          north: viewport.north,
        },
      });
    }, DEBOUNCE_MS);
  }

  return { handleViewportChange };
}
