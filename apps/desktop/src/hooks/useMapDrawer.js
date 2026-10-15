// The map drawer above the gallery, extracted from App.jsx (review S2):
// whether it is open and how tall (both remembered, utils/prefs.js), the
// camera requests (fly-to, fit-bounds), the height clamp against the live
// workspace, and what opening, closing and leaving a view do to the
// gallery's geo filter. The gallery's filters are useWorkspace's, read
// through `workspaceRef` in the effects so they react to one change only.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import api from "../api";
import useMapViewportFilter from "../components/map/useMapViewportFilter";
import { usePref } from "./usePref";
import { adoptLegacyPref, bool, intIn } from "../utils/prefs";

export const MAP_MIN_HEIGHT = 220;
export const GALLERY_MIN_HEIGHT = 200;
export const MAP_HANDLE_HEIGHT = 10;

export function defaultMapHeight() {
  return Math.max(MAP_MIN_HEIGHT, Math.min(Math.round(window.innerHeight * 0.42), 420));
}

// Earlier versions kept these under bare localStorage keys; they move once.
adoptLegacyPref("afterframe-map-expanded", "map.expanded", (raw) => raw === "true");
adoptLegacyPref("afterframe-map-height", "map.height", Number);

export default function useMapDrawer({ workspaceRef, filters, activeCollectionId, splitRef, pushToast }) {
  const { t: tNav } = useTranslation("nav");
  const [mapExpanded, setMapExpanded] = usePref("map.expanded", false, bool);
  const [mapHeight, setMapHeightPref] = usePref("map.height", defaultMapHeight(), intIn(MAP_MIN_HEIGHT, 10_000));
  const [mapResizing, setMapResizing] = useState(false);
  // Fly-to request for the map camera; a fresh object per click so repeated
  // jumps to the same place still re-fire the PhotoMap effect.
  const [mapFlyTo, setMapFlyTo] = useState(null);
  const [mapFitBounds, setMapFitBounds] = useState(null);

  // Gallery keeps at least GALLERY_MIN_HEIGHT: clamp the drawer against the
  // live workspace height (measured at interaction time, not render time).
  const clampMapHeight = (height) => {
    const available = splitRef.current?.clientHeight || window.innerHeight;
    const max = Math.max(MAP_MIN_HEIGHT, available - GALLERY_MIN_HEIGHT - MAP_HANDLE_HEIGHT);
    return Math.min(max, Math.max(MAP_MIN_HEIGHT, Math.round(height)));
  };
  const setMapHeight = (height) => setMapHeightPref(clampMapHeight(height));

  // A Discover entry's map: opened (and flown) only for map-shaped entries.
  const showMapFor = (map) => {
    setMapExpanded(!!map);
    if (map?.flyTo) setMapFlyTo({ ...map.flyTo, nonce: Date.now() });
  };

  // Inspector "click a location" → expand the drawer and fly the camera there.
  // Works for GPS and AI-resolved locations alike: both live in
  // asset_locations, fetched RAW-first without the map's precision floor.
  async function jumpToAssetLocation(assetId) {
    if (!assetId) return;
    let loc = null;
    try { loc = await api.getAssetLocation(assetId); } catch { /* treated as no location */ }
    const lat = Number(loc?.latitude);
    const lon = Number(loc?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      pushToast?.({ title: tNav("map.noLocation"), ttl: 4000 });
      return;
    }
    const zoom = { exact: 14, locality: 10, admin1: 6, country: 4 }[loc.precision_level] ?? 12;
    setMapExpanded(true);
    setMapFlyTo({ lat, lon, zoom });
  }

  const { handleViewportChange, geoOnClose } = useMapViewportFilter({
    enabled: mapExpanded,
    filters,
    applyFilters: (next) => workspaceRef.current.setFilters(next),
  });

  // Collapsing the map also drops the viewport filter: with the map hidden the
  // chip is the only trace of it, and a gallery silently pinned to an invisible
  // viewport reads as "my photos disappeared". A labelled geo filter (a
  // Discover place/memory) has its own chip and stays put; one the user moved
  // the map away from comes back (useMapViewportFilter.geoAfterClose).
  useEffect(() => {
    if (mapExpanded) return;
    const current = workspaceRef.current.filters;
    const next = geoOnClose(current?.geo);
    if (next === current?.geo) return;
    const { geo: _geo, ...rest } = current;
    workspaceRef.current.setFilters(next ? { ...rest, geo: next } : rest);
    // Reacts to the drawer closing only; the filters are read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapExpanded]);

  // Opening the map on a gallery filtered to a place (a Discover place or
  // memory) frames that place instead of the world view. The map's own move:
  // the place filter stays until the user moves the map.
  const placeGeo = filters?.geo?.label ? filters.geo : null;
  const placeKey = placeGeo ? [placeGeo.west, placeGeo.south, placeGeo.east, placeGeo.north].join(",") : "";
  useEffect(() => {
    if (!mapExpanded || !placeKey) return;
    const [west, south, east, north] = placeKey.split(",").map(Number);
    setMapFitBounds({ west, south, east, north });
  }, [mapExpanded, placeKey]);

  // Entering a collection drops it too: the viewport belongs to wherever the
  // user was looking before, and a folder opened through it would look empty
  // for no visible reason. Moving the map inside the folder filters it afresh.
  useEffect(() => {
    if (!activeCollectionId) return;
    const current = workspaceRef.current.filters;
    if (!current?.geo) return;
    const { geo: _geo, ...rest } = current;
    workspaceRef.current.setFilters(rest);
  }, [activeCollectionId, workspaceRef]);

  return {
    mapExpanded,
    setMapExpanded,
    toggleMap: () => setMapExpanded((current) => !current),
    mapHeight,
    setMapHeight,
    maxMapHeight: () => clampMapHeight(Number.POSITIVE_INFINITY),
    mapResizing,
    setMapResizing,
    mapFlyTo,
    mapFitBounds,
    showMapFor,
    jumpToAssetLocation,
    handleViewportChange,
  };
}
