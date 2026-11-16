// The statistics page's arithmetic (StatsView): the time ranges, the shooting
// calendar, keep rates, and the gallery filter each number opens. The counts
// themselves come from the sidecar (db/stats.py catalog_stats); everything
// here is pure so it can be tested without a catalog.

export const STATS_RANGES = ["all", "year", "12m"];
const pad2 = (n) => String(n).padStart(2, "0");
export const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// The page's time range as gallery facet filters (date_from, as the date
// filter stores it).
export function rangeFilters(range, now = new Date()) {
  if (range === "year") return { date_from: `${now.getFullYear()}-01-01` };
  if (range === "12m") {
    const from = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    return { date_from: isoDay(from) };
  }
  return {};
}

// Picks among the flagged: how much of what was judged was kept. null
// without a single flag (no judgement yet, not 0%).
export function keepRate(picks, rejects) {
  const judged = (picks || 0) + (rejects || 0);
  return judged ? picks / judged : null;
}

// Not used for this long: the camera / lens table marks it idle.
export const IDLE_MONTHS = 6;
export function monthsSince(captured, now = new Date()) {
  if (!captured) return null;
  const year = Number(captured.slice(0, 4));
  const month = Number(captured.slice(5, 7));
  if (!year || !month) return null;
  return (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
}

// The years the calendar can show, newest first.
export function calendarYears(days) {
  return [...new Set((days || []).map(([day]) => Number(day.slice(0, 4))).filter(Boolean))].sort((a, b) => b - a);
}

// One year as GitHub-style columns of weeks, Monday on top: each cell is a
// day with its count; and the year's totals, longest run of shooting days
// and busiest day.
export function calendarYear(days, year) {
  const counts = new Map((days || []).filter(([day]) => day.startsWith(`${year}-`)));
  const first = new Date(year, 0, 1);
  const lead = (first.getDay() + 6) % 7; // Monday = 0
  const cells = [];
  let total = 0;
  let shotDays = 0;
  let run = 0;
  let longest = 0;
  let best = null;
  for (let d = new Date(first); d.getFullYear() === year; d.setDate(d.getDate() + 1)) {
    const day = isoDay(d);
    const count = counts.get(day) || 0;
    const index = lead + cells.length;
    cells.push({ day, count, week: Math.floor(index / 7), weekday: index % 7 });
    if (count) {
      total += count;
      shotDays += 1;
      run += 1;
      longest = Math.max(longest, run);
      if (!best || count > best.count) best = { day, count };
    } else {
      run = 0;
    }
  }
  return { cells, weeks: Math.ceil((lead + cells.length) / 7), total, shotDays, longest, best };
}

// A count's shade on the calendar: 0 = none, then four steps on a log scale
// up to the year's busiest day, so a day of 20 shows next to a day of 800
// and the busiest day is always the darkest.
export function shadeSteps(cells) {
  const max = Math.max(0, ...cells.map((c) => c.count));
  if (!max) return () => 0;
  return (count) => (!count ? 0 : Math.max(1, Math.ceil((4 * Math.log1p(count)) / Math.log1p(max))));
}

// Photos per month for the `count` months ending at `lastMonth` ("2026-03").
export function monthSeries(days, lastMonth, count = 24) {
  if (!lastMonth) return [];
  const totals = new Map();
  for (const [day, n] of days || []) totals.set(day.slice(0, 7), (totals.get(day.slice(0, 7)) || 0) + n);
  let year = Number(lastMonth.slice(0, 4));
  let month = Number(lastMonth.slice(5, 7));
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const key = `${year}-${pad2(month)}`;
    out.push({ month: key, year, monthNumber: month, count: totals.get(key) || 0 });
    month -= 1;
    if (month === 0) { year -= 1; month = 12; }
  }
  return out.reverse();
}

// Photos per weekday, Monday first.
export function weekdayCounts(days) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const [day, n] of days || []) {
    const [y, m, d] = day.split("-").map(Number);
    out[(new Date(y, m - 1, d).getDay() + 6) % 7] += n;
  }
  return out;
}

export function lastDayOfMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return isoDay(new Date(y, m, 0));
}

// A day, month or year inside the page's time range: the stretch both
// cover, so a bar for a year the range starts in the middle of opens only
// the part of it that bar counted.
function within(base, from, to) {
  return {
    ...base,
    date_from: base.date_from && base.date_from > from ? base.date_from : from,
    date_to: base.date_to && base.date_to < to ? base.date_to : to,
  };
}

// The gallery filters one number on the page stands for, added to the
// page's own (its time range). Only facets the filter bar can show: a
// filter the bar cannot draw would narrow the grid without saying so.
export function filtersFor(kind, entry, base = {}) {
  switch (kind) {
    case "range": return { ...base };
    case "camera": return { ...base, camera: entry.model };
    case "lens": return { ...base, lens: entry.lens };
    case "combo": return { ...base, camera: entry.model, lens: entry.lens };
    case "aperture": return { ...base, aperture_min: entry.min, aperture_max: entry.max };
    case "iso": return { ...base, iso_min: entry.min, iso_max: entry.max };
    case "rating": return { ...base, rating_min: entry.stars, rating_max: entry.stars };
    case "rated4": return { ...base, rating_min: 4 };
    case "flag": return { ...base, flag: entry.flag };
    case "unreviewed": return { ...base, flag: "none", rating_max: 0 };
    case "orientation": return { ...base, orientation: entry.shape };
    // The sidecar groups cities by country and English name, what these two
    // facets can ask for, so same-named cities elsewhere stay out.
    case "city": return entry.city_en ? { ...base, city: entry.city_en, ...(entry.country ? { country: entry.country } : {}) } : null;
    case "day": return within(base, entry.day, entry.day);
    case "month": return within(base, `${entry.month}-01`, lastDayOfMonth(entry.month));
    case "year": return within(base, `${entry.year}-01-01`, `${entry.year}-12-31`);
    case "format": {
      // RAW-only and video have no facet on the bar (asset_type is not
      // one), so they open nothing.
      const byFormat = {
        raw_pair: { has_raw: true },
        jpeg: { extension: "jpeg", has_raw: false },
        heif: { extension: "heif", has_raw: false },
      };
      return byFormat[entry.format] ? { ...base, ...byFormat[entry.format] } : null;
    }
    default: return null;
  }
}

// A range filter's bounds can be rounded by the bar; widen by a hair so the
// stored values at the edges stay inside.
export function rangeEntry(bin) {
  if (bin?.min == null || bin?.max == null) return null;
  return { min: Math.floor(bin.min * 100) / 100, max: Math.ceil(bin.max * 100) / 100 };
}
