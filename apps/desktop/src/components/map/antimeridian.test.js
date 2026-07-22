import { describe, expect, it } from "vitest";

import { splitLandAtAntimeridian, splitLinesAtAntimeridian } from "./antimeridian";
import { sortPointsForCover } from "./PhotoClusterMarker";

function polygonFeature(ring) {
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
  };
}

describe("splitLandAtAntimeridian", () => {
  it("passes a polygon that stays inside one longitude window through unchanged in bounds", () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const result = splitLandAtAntimeridian(polygonFeature(ring));
    const polygons = result.features[0].geometry.coordinates;
    expect(polygons).toHaveLength(1);
    const longitudes = polygons[0][0].map(([lon]) => lon);
    expect(Math.min(...longitudes)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...longitudes)).toBeLessThanOrEqual(10);
  });

  it("splits a polygon crossing the antimeridian into clamped parts", () => {
    // A block spanning 170°E → 170°W (i.e. across ±180).
    const ring = [[170, -5], [-170, -5], [-170, 5], [170, 5], [170, -5]];
    const result = splitLandAtAntimeridian(polygonFeature(ring));
    const polygons = result.features[0].geometry.coordinates;
    expect(polygons.length).toBe(2);
    for (const polygon of polygons) {
      for (const [lon] of polygon[0]) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
      }
    }
    // One part hugs +180, the other hugs -180.
    const bounds = polygons.map((polygon) => {
      const lons = polygon[0].map(([lon]) => lon);
      return [Math.min(...lons), Math.max(...lons)];
    });
    expect(bounds.some(([, max]) => max === 180)).toBe(true);
    expect(bounds.some(([min]) => min === -180)).toBe(true);
  });
});

describe("splitLinesAtAntimeridian", () => {
  it("breaks a line that jumps across the antimeridian into two segments", () => {
    const result = splitLinesAtAntimeridian({
      type: "LineString",
      coordinates: [[178, 0], [179, 1], [-179, 2], [-178, 3]],
    });
    expect(result.type).toBe("MultiLineString");
    expect(result.coordinates).toHaveLength(2);
    expect(result.coordinates[0]).toEqual([[178, 0], [179, 1]]);
    expect(result.coordinates[1]).toEqual([[-179, 2], [-178, 3]]);
  });

  it("keeps a continuous line as a single segment", () => {
    const result = splitLinesAtAntimeridian({
      type: "LineString",
      coordinates: [[0, 0], [1, 1], [2, 2]],
    });
    expect(result.coordinates).toHaveLength(1);
  });
});

describe("sortPointsForCover", () => {
  it("orders by rating, then newest capture, then asset_id — stable across calls", () => {
    const points = [
      { asset_id: "c", app_rating: null, capture_time: "2026-01-01" },
      { asset_id: "a", app_rating: 5, capture_time: "2025-01-01" },
      { asset_id: "b", app_rating: 5, capture_time: "2026-01-01" },
      { asset_id: "d", app_rating: null, capture_time: "2026-01-01" },
    ];
    const first = sortPointsForCover(points).map((p) => p.asset_id);
    const second = sortPointsForCover([...points].reverse()).map((p) => p.asset_id);
    expect(first).toEqual(["b", "a", "c", "d"]);
    expect(second).toEqual(first);
  });
});
