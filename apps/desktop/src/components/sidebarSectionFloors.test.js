import { describe, expect, it } from "vitest";
import { sectionFloors } from "./sidebarSectionFloors";

describe("sidebar section floors", () => {
  it("gives each open section its first rows when they fit", () => {
    expect(sectionFloors(600, [120, 190, 150])).toEqual([120, 190, 150]);
  });

  it("holds each to an even split when the window is short, so they all fit", () => {
    expect(sectionFloors(300, [190, 190, 190])).toEqual([100, 100, 100]);
    expect(sectionFloors(300, [190, 190, 90]).reduce((sum, floor) => sum + floor, 0)).toBeLessThanOrEqual(300);
  });

  it("leaves what a short section doesn't need to the others", () => {
    // The folders want 55 of a 145 split: the other two share the rest.
    expect(sectionFloors(436, [184, 400, 55])).toEqual([184, 197, 55]);
    expect(sectionFloors(300, [190, 190, 90])).toEqual([105, 105, 90]);
  });

  it("has nothing to give when nothing is open or there is no room", () => {
    expect(sectionFloors(400, [])).toEqual([]);
    expect(sectionFloors(-20, [120])).toEqual([0]);
  });
});
