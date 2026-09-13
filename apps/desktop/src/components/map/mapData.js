// Lazy loaders for the offline base-map data (~22 MB total). The lightweight
// world outline is separate from the much larger admin/city detail bundle so
// first open can paint a useful map before all zoom-level context is ready.
import { splitLandAtAntimeridian, splitLinesAtAntimeridian } from "./antimeridian.js";

let mapCorePromise = null;

export function loadMapCoreData() {
  if (!mapCorePromise) {
    mapCorePromise = Promise.all([
      import("topojson-client"),
      import("world-atlas/countries-10m.json"),
    ]).then(([topojson, world]) => {
      const worldTopo = world.default;
      return {
        land: splitLandAtAntimeridian(topojson.feature(worldTopo, worldTopo.objects.land)),
        countryBoundaries: splitLinesAtAntimeridian(topojson.mesh(worldTopo, worldTopo.objects.countries)),
      };
    }).catch((error) => {
      mapCorePromise = null; // allow retry after a failed load
      throw error;
    });
  }
  return mapCorePromise;
}

let mapDetailPromise = null;

export function loadMapDetailData() {
  if (!mapDetailPromise) {
    mapDetailPromise = Promise.all([
      import("topojson-client"),
      import("../../data/maps/admin1-lines-10m.topo.json"),
      import("../../data/maps/admin1-labels-10m.json"),
      import("../../data/maps/cities-50m.json"),
    ]).then(([topojson, admin1Topology, admin1Labels, cities]) => ({
      admin1Lines: topojson.feature(admin1Topology.default, admin1Topology.default.objects.lines),
      admin1Labels: admin1Labels.default,
      cities: cities.default,
    })).catch((error) => {
      mapDetailPromise = null;
      throw error;
    });
  }
  return mapDetailPromise;
}

// Backwards-compatible aggregate for callers that need every zoom level at
// once. PhotoMap can still show an honest loading state while this resolves.
export function loadMapData() {
  return Promise.all([loadMapCoreData(), loadMapDetailData()])
    .then(([core, detail]) => ({ ...core, ...detail }));
}

let maplibrePromise = null;

export function loadMaplibre() {
  if (!maplibrePromise) {
    maplibrePromise = Promise.all([
      import("maplibre-gl"),
      import("maplibre-gl/dist/maplibre-gl.css"),
    ]).then(([module]) => {
      const maplibre = module.default || module;
      // The Vite plugin emits/serves a classic self-contained worker. The .cjs
      // suffix is intentional: MapLibre uses it to select classic-worker mode.
      maplibre.setWorkerUrl(new URL("maplibre-worker.cjs", document.baseURI).href);
      return maplibre;
    }).catch((error) => {
      maplibrePromise = null;
      throw error;
    });
  }
  return maplibrePromise;
}
