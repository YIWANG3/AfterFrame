import { useEffect, useRef } from "react";
import { loadMapData, loadMaplibre } from "./mapData";
import { createMarkerElement, updateMarkerElement, sortPointsForCover } from "./PhotoClusterMarker";
import "./map.css";

const MAX_DOM_MARKERS = 300;
const MAX_REGION_LABELS = 28;
const MAX_CITY_LABELS = 64;

// Base-map palettes per app theme (documentElement.dataset.theme).
// Dark stays neutral gray/black (matching the app chrome) — no blue/teal cast.
const PALETTES = {
  dark: {
    ocean: "#0c0c0c",
    landStops: ["#161616", "#191919", "#1d1d1d"],
    countryLine: "#4a4a4a",
    admin1Line: "#606060",
    cityDot: "#8c8c8c",
    cityStroke: "#0f0f0f",
  },
  light: {
    ocean: "#dbe4e9",
    landStops: ["#f2f0ea", "#efede6", "#ebe8e0"],
    countryLine: "#a3adb2",
    admin1Line: "#b4bcbe",
    cityDot: "#8b979b",
    cityStroke: "#f4f2ec",
  },
};

function currentPalette() {
  const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  return PALETTES[theme];
}

function pointsToGeoJSON(points) {
  return {
    type: "FeatureCollection",
    features: sortPointsForCover(points).map((point) => ({
      type: "Feature",
      properties: {
        asset_id: point.asset_id,
        preview_path: point.preview_path || "",
        source: point.source,
      },
      geometry: { type: "Point", coordinates: [point.longitude, point.latitude] },
    })),
  };
}

function markerMode(zoom) {
  return zoom < 2.45 ? "compact" : zoom < 5.6 ? "stack" : "detail";
}

// Representative zoom for each detail level (matching the markerMode bands).
const LEVEL_ZOOMS = { world: 1.35, region: 4, city: 7 };

// The interactive offline map. Owns one MapLibre instance for its lifetime —
// MapDrawer keeps this component mounted after the first open, so re-opening
// the drawer never re-parses the 22 MB base-map data.
export default function PhotoMap({ points, onViewportChange, onSelectAsset, visible, levelLabels, flyTo }) {
  const stageRef = useRef(null);
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  // Latest external fly-to request; parked here when the map instance is
  // still constructing (first open triggered by an Inspector location click).
  const pendingFlyToRef = useRef(null);
  const markersRef = useRef(new Map());
  const stateRef = useRef({ points: [], destroyed: false, maplibre: null });
  const callbacksRef = useRef({});
  callbacksRef.current = { onViewportChange, onSelectAsset };
  stateRef.current.points = points;

  // One-time map construction.
  useEffect(() => {
    const state = stateRef.current;
    state.destroyed = false;
    let cancelled = false;

    (async () => {
      const [maplibregl, mapData] = await Promise.all([loadMaplibre(), loadMapData()]);
      if (cancelled || !containerRef.current) return;
      state.maplibre = maplibregl;
      const palette = currentPalette();

      const map = new maplibregl.Map({
        container: containerRef.current,
        center: [8, 18],
        zoom: 1.35,
        minZoom: 0.75,
        maxZoom: 14,
        attributionControl: false,
        renderWorldCopies: false,
        style: {
          version: 8,
          sources: {},
          layers: [{ id: "ocean", type: "background", paint: { "background-color": palette.ocean } }],
        },
      });
      mapRef.current = map;
      if (pendingFlyToRef.current) {
        const request = pendingFlyToRef.current;
        pendingFlyToRef.current = null;
        map.flyTo({ center: [request.lon, request.lat], zoom: request.zoom ?? 12, duration: 900 });
      }
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
        "bottom-right",
      );

      map.on("load", () => {
        if (state.destroyed) return;
        map.addSource("land", { type: "geojson", data: mapData.land });
        map.addSource("country-boundaries", { type: "geojson", data: mapData.countryBoundaries });
        map.addSource("admin1-lines", { type: "geojson", data: mapData.admin1Lines });
        map.addSource("context-cities", { type: "geojson", data: mapData.cities });
        map.addSource("photo-locations", {
          type: "geojson",
          data: pointsToGeoJSON(state.points),
          cluster: true,
          clusterRadius: 52,
          // Must stay below the map's maxZoom (14): points uncluster at
          // clusterMaxZoom+1, so equal values would leave clusters at max zoom
          // that clicking can never expand (dead buttons).
          clusterMaxZoom: 13,
        });
        // A GeoJSON source no layer references never loads its tiles, and
        // querySourceFeatures would stay empty forever. Photos render as DOM
        // markers, so anchor the source with an invisible layer.
        map.addLayer({
          id: "photo-points-anchor",
          type: "circle",
          source: "photo-locations",
          paint: { "circle-radius": 0, "circle-opacity": 0 },
        });

        map.addLayer({
          id: "land-fill",
          type: "fill",
          source: "land",
          paint: {
            "fill-color": [
              "interpolate", ["linear"], ["zoom"],
              0.8, palette.landStops[0],
              4, palette.landStops[1],
              7, palette.landStops[2],
            ],
            "fill-opacity": 0.98,
          },
        });
        map.addLayer({
          id: "country-outline",
          type: "line",
          source: "country-boundaries",
          paint: {
            "line-color": palette.countryLine,
            "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.45, 5, 1.15],
            "line-opacity": ["interpolate", ["linear"], ["zoom"], 1, 0.52, 5, 0.8],
          },
        });
        // Admin-1 boundaries appear progressively: each band's min_zoom property
        // (precomputed in the data) gates when its lines join in.
        const adminBands = [
          ["admin1-major", 2, ["<=", ["get", "min_zoom"], 3]],
          ["admin1-regional", 4.1, ["all", [">", ["get", "min_zoom"], 3], ["<=", ["get", "min_zoom"], 5]]],
          ["admin1-local", 5.5, ["all", [">", ["get", "min_zoom"], 5], ["<=", ["get", "min_zoom"], 7]]],
          ["admin1-fine", 7.4, ["all", [">", ["get", "min_zoom"], 7], ["<=", ["get", "min_zoom"], 8]]],
          ["admin1-z9", 8.35, ["all", [">", ["get", "min_zoom"], 8], ["<=", ["get", "min_zoom"], 9]]],
          ["admin1-z10", 9.35, ["all", [">", ["get", "min_zoom"], 9], ["<=", ["get", "min_zoom"], 10]]],
          ["admin1-z11", 10.35, [">", ["get", "min_zoom"], 10]],
        ];
        for (const [id, minzoom, filter] of adminBands) {
          // Interpolate stops must strictly ascend — for the high-zoom bands
          // the original 8 upper stop would sit below minzoom.
          const upperStop = Math.max(8, minzoom + 1);
          map.addLayer({
            id,
            type: "line",
            source: "admin1-lines",
            minzoom,
            filter,
            paint: {
              "line-color": palette.admin1Line,
              "line-width": ["interpolate", ["linear"], ["zoom"], minzoom, 0.65, upperStop, 1.35],
              "line-opacity": ["interpolate", ["linear"], ["zoom"], minzoom, 0.38, upperStop, 0.78],
            },
          });
        }
        const cityBands = [
          ["major-cities", 2.5, 4.4, [">=", ["get", "population"], 1000000], 2.5],
          ["regional-cities", 4, 6.4, [">=", ["get", "population"], 150000], 2.1],
          ["local-cities", 6, 24, [">=", ["get", "population"], 0], 1.8],
        ];
        for (const [id, minzoom, maxzoom, filter, radius] of cityBands) {
          map.addLayer({
            id,
            type: "circle",
            source: "context-cities",
            minzoom,
            maxzoom,
            filter,
            paint: {
              "circle-radius": ["interpolate", ["linear"], ["zoom"], minzoom, radius, 8, radius + 1.4],
              "circle-color": palette.cityDot,
              "circle-opacity": 0.7,
              "circle-stroke-color": palette.cityStroke,
              "circle-stroke-width": 1,
            },
          });
        }

        state.labelData = {
          regions: [...mapData.admin1Labels.features].sort(
            (a, b) => (a.properties.minZoom || 20) - (b.properties.minZoom || 20),
          ),
          cities: [...mapData.cities.features].sort(
            (a, b) => (b.properties.population || 0) - (a.properties.population || 0),
          ),
        };

        stageRef.current?.setAttribute("data-map-ready", "true");
        updateMarkers();
        updateLabels();
        emitViewport();
      });

      const scheduleLabels = () => {
        if (state.labelFrame) return;
        state.labelFrame = requestAnimationFrame(() => {
          state.labelFrame = 0;
          updateLabels();
        });
      };

      map.on("zoom", () => {
        const stage = stageRef.current;
        const mode = markerMode(map.getZoom());
        if (stage && stage.dataset.markerMode !== mode) stage.dataset.markerMode = mode;
      });
      map.on("move", scheduleLabels);
      map.on("resize", scheduleLabels);
      // moveend can arrive while the style is still loading tiles for the new
      // zoom (updateLabels bails on !isStyleLoaded) — idle redraws them once
      // rendering settles. Coalesced through the same rAF, so it's cheap.
      map.on("idle", scheduleLabels);
      // Viewport filtering engages only after a deliberate user move — opening
      // the drawer must never filter the gallery by the whole-world viewport.
      map.on("movestart", (event) => {
        if (event.originalEvent) state.interacted = true;
      });
      // Marker add/remove and gallery-filter updates wait for moveend — during
      // the move MapLibre keeps existing marker transforms correct on its own.
      map.on("moveend", () => {
        updateMarkers();
        updateLabels();
        emitViewport();
      });
      map.on("sourcedata", (event) => {
        if (event.sourceId === "photo-locations" && event.isSourceLoaded) updateMarkers();
      });

      // Test backdoor (same pattern as window.__afterframeTest): deterministic
      // camera moves for E2E — real pointer drags through the WebGL canvas are
      // timing-sensitive under automation. jumpTo counts as user interaction.
      window.__afterframeMapTest = {
        jumpTo(center, zoom) {
          state.interacted = true;
          map.jumpTo({ center, zoom });
        },
        getState() {
          return {
            interacted: !!state.interacted,
            zoom: map.getZoom(),
            center: map.getCenter().toArray(),
            markerCount: markersRef.current.size,
          };
        },
      };
    })();

    function emitViewport() {
      const map = mapRef.current;
      if (!map || state.destroyed) return;
      const bounds = map.getBounds();
      callbacksRef.current.onViewportChange?.({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
        zoom: map.getZoom(),
        interacted: !!state.interacted,
      });
    }

    function updateMarkers() {
      const map = mapRef.current;
      const maplibregl = state.maplibre;
      if (!map || state.destroyed || !map.getSource("photo-locations")) return;
      const source = map.getSource("photo-locations");
      const features = map.querySourceFeatures("photo-locations");
      const seen = new Set();
      const markers = markersRef.current;
      const next = [];
      for (const feature of features) {
        const props = feature.properties || {};
        const key = props.cluster ? `cluster:${props.cluster_id}` : `asset:${props.asset_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ key, feature, props });
        if (next.length >= MAX_DOM_MARKERS) break;
      }

      for (const [key, marker] of markers) {
        if (!seen.has(key)) {
          marker.remove();
          markers.delete(key);
        }
      }

      for (const { key, feature, props } of next) {
        const coordinates = feature.geometry.coordinates;
        let marker = markers.get(key);
        if (!marker) {
          const element = createMarkerElement({
            onClick: (data) => handleMarkerClick(data),
          });
          marker = new maplibregl.Marker({ element, anchor: "center" })
            .setLngLat(coordinates)
            .addTo(map);
          markers.set(key, marker);
        } else {
          marker.setLngLat(coordinates);
        }
        const element = marker.getElement();
        if (props.cluster) {
          element.__markerData = { type: "cluster", clusterId: props.cluster_id, coordinates };
          updateMarkerElement(element, {
            count: props.point_count,
            previews: ["", "", ""],
            label: `${props.point_count} photos`,
          });
          // Representative covers load async; input features are pre-sorted so
          // the first three leaves are the stable representatives. cluster_ids
          // are reused across setData() generations, so a stale resolve could
          // otherwise paint the previous dataset's covers onto a new cluster.
          const generation = state.pointsGeneration || 0;
          source.getClusterLeaves(props.cluster_id, 3, 0)
            .then((leaves) => {
              if (state.destroyed || !markers.has(key)) return;
              if ((state.pointsGeneration || 0) !== generation) return;
              updateMarkerElement(element, {
                count: props.point_count,
                previews: [
                  leaves[0]?.properties?.preview_path || "",
                  leaves[1]?.properties?.preview_path || "",
                  leaves[2]?.properties?.preview_path || "",
                ],
                label: `${props.point_count} photos`,
              });
            })
            .catch(() => {});
        } else {
          element.__markerData = { type: "asset", assetId: props.asset_id, coordinates };
          updateMarkerElement(element, {
            count: 1,
            previews: [props.preview_path || "", "", ""],
            label: props.asset_id,
          });
        }
      }
    }

    function handleMarkerClick(data) {
      const map = mapRef.current;
      if (!map || !data) return;
      state.interacted = true;
      if (data.type === "cluster") {
        const source = map.getSource("photo-locations");
        source.getClusterExpansionZoom(data.clusterId)
          .then((zoom) => {
            map.easeTo({ center: data.coordinates, zoom: Math.min(zoom, 14), duration: 480 });
          })
          .catch(() => {});
      } else if (data.type === "asset") {
        callbacksRef.current.onSelectAsset?.(data.assetId);
      }
    }

    function updateLabels() {
      const map = mapRef.current;
      const container = containerRef.current;
      if (!map || state.destroyed || !state.labelData || !container) return;
      const regionLayer = stageRef.current?.querySelector("[data-map-region-labels]");
      const cityLayer = stageRef.current?.querySelector("[data-map-city-labels]");
      if (!regionLayer || !cityLayer) return;
      const zoom = map.getZoom();
      if (!map.isStyleLoaded() || zoom < 3.15) {
        regionLayer.replaceChildren();
        cityLayer.replaceChildren();
        return;
      }
      const bounds = map.getBounds();
      const occupied = new Set();
      const regionFragment = document.createDocumentFragment();
      const cityFragment = document.createDocumentFragment();
      let regionCount = 0;
      let cityCount = 0;

      for (const region of state.labelData.regions) {
        if (regionCount >= MAX_REGION_LABELS) break;
        if ((region.properties.minZoom || 20) > zoom + 0.25) continue;
        const [longitude, latitude] = region.geometry.coordinates;
        if (!bounds.contains([longitude, latitude])) continue;
        const point = map.project([longitude, latitude]);
        const cell = `${Math.floor(point.x / 132)}:${Math.floor(point.y / 42)}`;
        if (occupied.has(cell)) continue;
        occupied.add(cell);
        const label = document.createElement("span");
        label.className = "photo-map-label photo-map-label--region";
        label.textContent = region.properties.name;
        label.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
        regionFragment.append(label);
        regionCount += 1;
      }

      for (const city of state.labelData.cities) {
        if (cityCount >= MAX_CITY_LABELS) break;
        if ((city.properties.minZoom || 7) > zoom + 0.45) continue;
        const [longitude, latitude] = city.geometry.coordinates;
        if (!bounds.contains([longitude, latitude])) continue;
        const point = map.project([longitude, latitude]);
        const cell = `${Math.floor(point.x / 104)}:${Math.floor(point.y / 32)}`;
        if (occupied.has(cell)) continue;
        occupied.add(cell);
        const label = document.createElement("span");
        label.className = "photo-map-label photo-map-label--city";
        label.textContent = city.properties.name;
        label.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
        cityFragment.append(label);
        cityCount += 1;
      }

      regionLayer.replaceChildren(regionFragment);
      cityLayer.replaceChildren(cityFragment);
    }

    const markers = markersRef.current;
    return () => {
      cancelled = true;
      state.destroyed = true;
      if (state.labelFrame) cancelAnimationFrame(state.labelFrame);
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      if (window.__afterframeMapTest) delete window.__afterframeMapTest;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  // External fly-to (Inspector location click). App sends a fresh object per
  // click, so repeated jumps to the same place still animate. If the map is
  // still constructing (first open triggered by the click itself), the
  // request parks in pendingFlyToRef and applies right after creation.
  useEffect(() => {
    if (!flyTo || !Number.isFinite(flyTo.lat) || !Number.isFinite(flyTo.lon)) return;
    const map = mapRef.current;
    if (!map) {
      pendingFlyToRef.current = flyTo;
      return;
    }
    map.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? 12, duration: 900 });
  }, [flyTo]);

  // Point data changes → swap the GeoJSON source, keep the camera. The
  // generation bump invalidates in-flight getClusterLeaves resolutions.
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource?.("photo-locations");
    if (!source) return;
    stateRef.current.pointsGeneration = (stateRef.current.pointsGeneration || 0) + 1;
    source.setData(pointsToGeoJSON(points));
  }, [points]);

  // Theme switches restyle the base layers in place.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const map = mapRef.current;
      if (!map || !map.getLayer?.("land-fill")) return;
      const palette = currentPalette();
      map.setPaintProperty("ocean", "background-color", palette.ocean);
      map.setPaintProperty("land-fill", "fill-color", [
        "interpolate", ["linear"], ["zoom"],
        0.8, palette.landStops[0],
        4, palette.landStops[1],
        7, palette.landStops[2],
      ]);
      map.setPaintProperty("country-outline", "line-color", palette.countryLine);
      for (const id of ["admin1-major", "admin1-regional", "admin1-local", "admin1-fine", "admin1-z9", "admin1-z10", "admin1-z11"]) {
        map.setPaintProperty(id, "line-color", palette.admin1Line);
      }
      for (const id of ["major-cities", "regional-cities", "local-cities"]) {
        map.setPaintProperty(id, "circle-color", palette.cityDot);
        map.setPaintProperty(id, "circle-stroke-color", palette.cityStroke);
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // While hidden (drawer collapsed) the map keeps living but skips resizes;
  // MapDrawer calls map.resize() through this ref during the height animation.
  useEffect(() => {
    if (visible) mapRef.current?.resize();
  }, [visible]);

  return (
    <div ref={stageRef} className="photo-map-stage" data-marker-mode="compact">
      <div ref={containerRef} className="photo-map-canvas" data-testid="photo-map" />
      <div data-map-region-labels className="photo-map-label-layer" aria-hidden="true" />
      <div data-map-city-labels className="photo-map-label-layer" aria-hidden="true" />
      {levelLabels ? (
        // Current-detail switcher: highlighting is pure CSS keyed off the
        // stage's data-marker-mode (compact=world / stack=region / detail=city);
        // clicking eases the camera to that level around the current center.
        <div className="photo-map-levels">
          {["world", "region", "city"].map((level) => (
            <button
              key={level}
              type="button"
              className={`photo-map-level photo-map-level--${level}`}
              onClick={() => {
                const map = mapRef.current;
                if (!map) return;
                stateRef.current.interacted = true;
                map.easeTo({ zoom: LEVEL_ZOOMS[level], duration: 600 });
              }}
            >
              {levelLabels[level]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
