import { describe, expect, it } from "vitest";
import {
  calendarYear,
  calendarYears,
  filtersFor,
  keepRate,
  monthSeries,
  monthsSince,
  rangeEntry,
  rangeFilters,
  shadeSteps,
  weekdayCounts,
} from "./statsPage";

const NOW = new Date(2026, 10, 15, 12, 0, 0); // 15 Nov 2026, local

describe("rangeFilters", () => {
  it("is the gallery's date filter", () => {
    expect(rangeFilters("all", NOW)).toEqual({});
    expect(rangeFilters("year", NOW)).toEqual({ date_from: "2026-01-01" });
    expect(rangeFilters("12m", NOW)).toEqual({ date_from: "2025-12-01" });
  });
});

describe("keepRate", () => {
  it("is picks among the flagged, null before any flag", () => {
    expect(keepRate(1, 3)).toBe(0.25);
    expect(keepRate(0, 0)).toBeNull();
  });
});

describe("monthsSince", () => {
  it("counts whole months to now", () => {
    expect(monthsSince("2026-11-01T10:00:00", NOW)).toBe(0);
    expect(monthsSince("2026-04-30T10:00:00", NOW)).toBe(7);
    expect(monthsSince(null, NOW)).toBeNull();
  });
});

describe("calendarYear", () => {
  const days = [["2026-01-01", 3], ["2026-01-02", 5], ["2026-01-03", 1], ["2026-01-10", 9], ["2025-12-31", 4]];

  it("lays the year out in Monday-first weeks", () => {
    const year = calendarYear(days, 2026);
    expect(year.cells).toHaveLength(365);
    // 1 Jan 2026 is a Thursday.
    expect(year.cells[0]).toEqual({ day: "2026-01-01", count: 3, week: 0, weekday: 3 });
    expect(year.cells[4]).toMatchObject({ day: "2026-01-05", week: 1, weekday: 0 });
    expect(year.weeks).toBe(53);
  });

  it("sums the year, its longest run and busiest day", () => {
    const year = calendarYear(days, 2026);
    expect(year.total).toBe(18);
    expect(year.shotDays).toBe(4);
    expect(year.longest).toBe(3);
    expect(year.best).toEqual({ day: "2026-01-10", count: 9 });
  });

  it("lists the years newest first", () => {
    expect(calendarYears(days)).toEqual([2026, 2025]);
  });
});

describe("shadeSteps", () => {
  it("spreads the shooting days over four log steps up to the busiest", () => {
    const shade = shadeSteps([1, 20, 800].map((count) => ({ count })));
    expect(shade(0)).toBe(0);
    expect(shade(1)).toBe(1);
    expect(shade(20)).toBe(2);
    expect(shade(800)).toBe(4);
    // Every day alike: all of them are the busiest.
    expect(shadeSteps([{ count: 1 }, { count: 1 }])(1)).toBe(4);
  });
});

describe("monthSeries and weekdayCounts", () => {
  const days = [["2026-03-02", 2], ["2026-03-07", 1], ["2026-01-15", 4]];

  it("sums months back from the newest one", () => {
    const months = monthSeries(days, "2026-03", 4);
    expect(months.map((m) => [m.month, m.count])).toEqual([["2025-12", 0], ["2026-01", 4], ["2026-02", 0], ["2026-03", 3]]);
  });

  it("sums weekdays Monday first", () => {
    // 2 Mar 2026 is a Monday, 7 Mar a Saturday, 15 Jan a Thursday.
    expect(weekdayCounts(days)).toEqual([2, 0, 0, 4, 0, 1, 0]);
  });
});

describe("filtersFor", () => {
  const base = { date_from: "2026-01-01" };

  it("adds the number's facet to the page's range", () => {
    expect(filtersFor("camera", { model: "X-T5" }, base)).toEqual({ date_from: "2026-01-01", camera: "X-T5" });
    expect(filtersFor("combo", { model: "X-T5", lens: "XF33" })).toEqual({ camera: "X-T5", lens: "XF33" });
    expect(filtersFor("aperture", { min: 1.7, max: 1.8 })).toEqual({ aperture_min: 1.7, aperture_max: 1.8 });
    expect(filtersFor("unreviewed", {})).toEqual({ flag: "none", rating_max: 0 });
    expect(filtersFor("month", { month: "2026-02" })).toEqual({ date_from: "2026-02-01", date_to: "2026-02-28" });
    expect(filtersFor("day", { day: "2026-03-14" }, base)).toEqual({ date_from: "2026-03-14", date_to: "2026-03-14" });
    expect(filtersFor("missing", {}, base)).toEqual({ date_from: "2026-01-01", missing: true });
  });

  it("keeps a year or month inside the page's range", () => {
    const last12 = { date_from: "2025-12-01" };
    expect(filtersFor("year", { year: "2025" }, last12)).toEqual({ date_from: "2025-12-01", date_to: "2025-12-31" });
    expect(filtersFor("year", { year: "2026" }, last12)).toEqual({ date_from: "2026-01-01", date_to: "2026-12-31" });
    expect(filtersFor("month", { month: "2025-12" }, { date_from: "2025-12-15" })).toEqual({ date_from: "2025-12-15", date_to: "2025-12-31" });
  });

  it("opens a city in its country", () => {
    expect(filtersFor("city", { city_en: "Portland", country: "US" }, base)).toEqual({ date_from: "2026-01-01", city: "Portland", country: "US" });
    expect(filtersFor("city", { city_en: "Portland", country: null })).toEqual({ city: "Portland" });
    expect(filtersFor("city", { city_en: null, city_key: "x" })).toBeNull();
  });

  it("opens nothing for what the filter bar cannot show", () => {
    expect(filtersFor("format", { format: "video" })).toBeNull();
    expect(filtersFor("format", { format: "raw" })).toBeNull();
    expect(filtersFor("shutter", {})).toBeNull();
  });

  it("widens a range bin to its stored values", () => {
    expect(rangeEntry({ min: 1.7, max: 1.8 })).toEqual({ min: 1.7, max: 1.8 });
    expect(rangeEntry({ min: 0.004, max: 0.0167 })).toEqual({ min: 0, max: 0.02 });
    expect(rangeEntry({ min: null, max: null })).toBeNull();
  });
});
