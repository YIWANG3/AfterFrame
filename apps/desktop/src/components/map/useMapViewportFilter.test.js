import { describe, expect, it } from "vitest";
import { geoAfterClose, viewportFilters } from "./useMapViewportFilter";

const world = { west: -180, south: -60, east: 180, north: 80 };
const honolulu = { mode: "bounds", west: -158.3, south: 21.2, east: -157.6, north: 21.7, min_precision: "locality", label: "Honolulu" };
const memory = { date_from: "2024-01-02", date_to: "2024-01-06", geo: honolulu };

describe("viewportFilters", () => {
  it("never lets the camera settling on open replace a Discover place", () => {
    // The 0.5.8 bug: the drawer's first viewport (the world) replaced Honolulu.
    expect(viewportFilters({ viewport: { ...world, interacted: false }, filters: memory, userMove: false })).toBeNull();
    // Nor does it once the map has been moved before, in an earlier view.
    expect(viewportFilters({ viewport: { ...world, interacted: true }, filters: memory, userMove: false })).toBeNull();
  });

  it("lets the user's own move replace the place, keeping the dates", () => {
    const next = viewportFilters({ viewport: { ...world, interacted: true }, filters: memory, userMove: true });
    expect(next.date_from).toBe("2024-01-02");
    expect(next.date_to).toBe("2024-01-06");
    expect(next.geo).toEqual({ mode: "bounds", ...world, min_precision: "locality" });
    expect(next.geo.label).toBeUndefined();
  });

  it("engages on the first deliberate move and then follows the viewport", () => {
    expect(viewportFilters({ viewport: { ...world, interacted: false }, filters: {}, userMove: false })).toBeNull();
    expect(viewportFilters({ viewport: { ...world, interacted: true }, filters: {}, userMove: true }).geo.west).toBe(-180);
    const tracking = { geo: { mode: "bounds", west: 0, south: 0, east: 1, north: 1, min_precision: "locality" } };
    expect(viewportFilters({ viewport: { ...world, interacted: true }, filters: tracking, userMove: false }).geo.east).toBe(180);
  });
});

describe("geoAfterClose", () => {
  const viewport = { mode: "bounds", ...world, min_precision: "locality" };

  it("keeps a place, drops the map's own viewport filter", () => {
    expect(geoAfterClose(honolulu, null)).toBe(honolulu);
    expect(geoAfterClose(viewport, null)).toBeUndefined();
    expect(geoAfterClose(undefined, null)).toBeUndefined();
  });

  it("puts back the place the user moved the map away from", () => {
    expect(geoAfterClose(viewport, { place: honolulu, applied: viewport })).toBe(honolulu);
  });

  it("does not resurrect it once the viewport filter has changed hands", () => {
    const elsewhere = { ...viewport, west: 10 };
    expect(geoAfterClose(elsewhere, { place: honolulu, applied: viewport })).toBeUndefined();
  });
});
