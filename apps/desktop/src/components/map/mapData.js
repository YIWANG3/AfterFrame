// Lazy loader for the offline base-map data (~22 MB total). Everything is
// pulled in via dynamic import so the main bundle and app startup stay
// untouched; the first map open pays the one-time load + antimeridian cost.
import { splitLandAtAntimeridian, splitLinesAtAntimeridian } from "./antimeridian.js";

let mapDataPromise = null;

export function loadMapData() {
  if (!mapDataPromise) {
    mapDataPromise = Promise.all([
      import("topojson-client"),
      import("world-atlas/countries-10m.json"),
      import("../../data/maps/admin1-lines-10m.topo.json"),
      import("../../data/maps/admin1-labels-10m.json"),
      import("../../data/maps/cities-50m.json"),
    ]).then(([topojson, world, admin1Topology, admin1Labels, cities]) => {
      const worldTopo = world.default;
      const admin1Topo = admin1Topology.default;
      return {
        land: splitLandAtAntimeridian(topojson.feature(worldTopo, worldTopo.objects.land)),
        countryBoundaries: splitLinesAtAntimeridian(topojson.mesh(worldTopo, worldTopo.objects.countries)),
        admin1Lines: topojson.feature(admin1Topo, admin1Topo.objects.lines),
        admin1Labels: admin1Labels.default,
        cities: cities.default,
      };
    }).catch((error) => {
      mapDataPromise = null; // allow retry after a failed load
      throw error;
    });
  }
  return mapDataPromise;
}

let maplibrePromise = null;

export function loadMaplibre() {
  if (!maplibrePromise) {
    maplibrePromise = Promise.all([
      import("maplibre-gl"),
      import("maplibre-gl/dist/maplibre-gl.css"),
      import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
    ]).then(([module, , worker]) => {
      const maplibre = module.default || module;
      // V6 ships the worker separately. Let Vite bundle its dependencies and
      // resolve it against the page for both file:// and hosted subpaths.
      maplibre.setWorkerUrl(new URL(worker.default, document.baseURI).href);
      return maplibre;
    }).catch((error) => {
      maplibrePromise = null;
      throw error;
    });
  }
  return maplibrePromise;
}
