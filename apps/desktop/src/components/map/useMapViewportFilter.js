import { useEffect, useRef } from "react";

const DEBOUNCE_MS = 250;

const sameBounds = (a, b) => !!a && !!b
  && ["west", "south", "east", "north"].every((key) => a[key] === b[key]);

// What a settled map viewport does to the gallery's filters: the next filters,
// or null for "leave them alone". Pure, so the rules are unit-tested — the map
// itself needs WebGL, which the CI VM does not have.
//   - A labelled geo filter is a place opened from Discover. It is a condition
//     of its own, and only the user moving the map replaces it — never the
//     camera settling as the drawer opens, resizes or frames that place.
//   - Otherwise the filter engages on the user's first deliberate move, and
//     from then on follows the viewport. Programmatic viewports (initial
//     load, resize) never create it.
export function viewportFilters({ viewport, filters, userMove }) {
  const geo = filters?.geo;
  if (geo?.label && !userMove) return null;
  if (!viewport.interacted && !geo) return null;
  return {
    ...filters,
    geo: {
      mode: "bounds",
      west: viewport.west,
      south: viewport.south,
      east: viewport.east,
      north: viewport.north,
      // Matches the map's display floor: admin1/country-level AI guesses
      // aren't drawn as markers, so they must not sneak into the filtered
      // gallery either ("why is this photo in view with no marker?").
      min_precision: "locality",
    },
  };
}

// What becomes of filters.geo when the map closes. The map's own viewport
// filter goes with it; a Discover place stays; a place the user moved the map
// away from comes back — the viewport was a look around, not a new place.
// `replaced` is { place, applied }: the place, and the viewport filter that
// last stood in for it.
export function geoAfterClose(geo, replaced) {
  if (!geo || geo.label) return geo;
  return replaced && sameBounds(geo, replaced.applied) ? replaced.place : undefined;
}

// Turns map viewport moves into the gallery's filters.geo — debounced so a
// pan/zoom flurry commits only the final viewport. Works in a folder too:
// browse-collection takes the same facet filters the library view does.
export default function useMapViewportFilter({ enabled, filters, applyFilters }) {
  const timerRef = useRef(null);
  const stateRef = useRef({});
  stateRef.current = { enabled, filters, applyFilters };
  // A user move inside the debounce window counts even when a programmatic
  // viewport (the drawer still resizing) lands after it.
  const userMoveRef = useRef(false);
  const replacedRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  function handleViewportChange(viewport) {
    const { enabled: isEnabled } = stateRef.current;
    if (!isEnabled || !viewport) return;
    userMoveRef.current ||= !!viewport.userMove;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const userMove = userMoveRef.current;
      userMoveRef.current = false;
      const { filters: currentFilters, applyFilters: apply, enabled: stillEnabled } = stateRef.current;
      if (!stillEnabled) return;
      const next = viewportFilters({ viewport, filters: currentFilters, userMove });
      if (!next) return;
      const geo = currentFilters?.geo;
      if (geo?.label) replacedRef.current = { place: geo, applied: next.geo };
      else if (replacedRef.current && sameBounds(geo, replacedRef.current.applied)) replacedRef.current.applied = next.geo;
      else replacedRef.current = null; // the chip was removed or replaced since
      apply(next);
    }, DEBOUNCE_MS);
  }

  // The map is closing: filters.geo as it should be afterwards.
  function geoOnClose(geo) {
    clearTimeout(timerRef.current);
    userMoveRef.current = false;
    const replaced = replacedRef.current;
    replacedRef.current = null;
    return geoAfterClose(geo, replaced);
  }

  return { handleViewportChange, geoOnClose };
}
