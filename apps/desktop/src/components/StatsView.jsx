// The statistics page (docs/prototypes/stats-page.html): what the library was
// shot with, how, and what was kept. Gear first, as photographers ask about
// it first; the calendar and storage further down. One sidecar call
// (catalog-stats) answers the page for the chosen time range; a number opens
// the gallery filtered to the photos it counts (statsPage.filtersFor).
// Same header shell as the Tags and People pages.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3 } from "lucide-react";
import api from "../api";
import { cx, Spinner } from "../ui";
import { formatBytes } from "../utils/format";
import LibraryToolbar from "./LibraryToolbar";
import { BarRows, CalendarGrid, Columns, Meter, Sparkline, TipProvider, useTip } from "./stats/StatsCharts";
import {
  IDLE_MONTHS,
  STATS_RANGES,
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

const RANGE_KEY = "stats.range";
const readRange = () => { try { const v = localStorage.getItem(RANGE_KEY); return STATS_RANGES.includes(v) ? v : "all"; } catch { return "all"; } };

function Section({ id, title, subtitle, children }) {
  return (
    <section data-stats-section={id} className="mt-9 first:mt-2">
      <div className="mb-3 flex items-baseline gap-3 px-1">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
        {subtitle ? <span className="text-[12px] text-muted2">{subtitle}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Card({ title, subtitle, className, children, testId }) {
  return (
    <div data-testid={testId} className={cx("min-w-0 rounded-lg bg-panel px-4 pb-4 pt-3.5", className)}>
      {title ? <h3 className="text-[13px] font-semibold text-text">{title}</h3> : null}
      {subtitle ? <div className="mt-0.5 text-[11px] text-muted2">{subtitle}</div> : null}
      <div className={title || subtitle ? "mt-3" : undefined}>{children}</div>
    </div>
  );
}

function Note({ children }) {
  return <div className="mt-3 text-[11px] leading-snug text-muted2">{children}</div>;
}

function Tile({ label, value, detail, testId }) {
  return (
    <div data-testid={testId} className="min-w-0 rounded-lg bg-panel px-4 py-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-1 truncate text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-text">{value}</div>
      {detail ? <div className="mt-0.5 truncate text-[11px] text-muted2">{detail}</div> : null}
    </div>
  );
}

const TH = "pb-1.5 text-left text-[11px] font-normal text-muted2";
const TD = "border-t border-[var(--edge)] py-2 pr-3 align-middle";

export default function StatsView({ catalogRevision, onOpenGallery }) {
  const { t, i18n } = useTranslation("nav");
  const [range, setRangeState] = useState(readRange);
  const setRange = (value) => { setRangeState(value); try { localStorage.setItem(RANGE_KEY, value); } catch { /* private mode */ } };
  const [stats, setStats] = useState(null);
  const [failed, setFailed] = useState(false);
  const base = useMemo(() => rangeFilters(range), [range]);

  useEffect(() => {
    let live = true;
    setFailed(false);
    api.catalogStats({ filters: base })
      .then((result) => { if (!live) return; if (result) setStats(result); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [base, catalogRevision]);

  const open = (kind, entry, status) => {
    const filters = filtersFor(kind, entry, base);
    if (filters) onOpenGallery?.({ status: status || "all", filters });
  };

  const count = stats?.overview?.photos ?? 0;
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="stats-view">
      <LibraryToolbar
        icon={BarChart3}
        title={t("stats.title")}
        count={t("stats.photoCount", { count, formatted: count.toLocaleString(i18n.language) })}
        actions={(
          <div className="mr-1 flex h-8 shrink-0 items-center gap-0.5 rounded-full border border-border/70 bg-app p-0.5" role="radiogroup" aria-label={t("stats.range.label")}>
            {STATS_RANGES.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={range === value}
                data-stats-range={value}
                onClick={() => setRange(value)}
                className={cx(
                  "h-[26px] rounded-full px-3 text-[12px] transition-colors",
                  range === value ? "bg-[var(--fill-2)] text-text" : "text-muted hover:text-text",
                )}
              >
                {t(`stats.range.${value}`)}
              </button>
            ))}
          </div>
        )}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-12 pt-3" data-testid="stats-scroll">
        {failed && !stats ? (
          <div className="py-16 text-center text-[13px] text-muted2">{t("stats.loadFailed")}</div>
        ) : !stats ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : stats.overview.total === 0 ? (
          <div className="py-16 text-center text-[13px] text-muted2" data-testid="stats-empty">{t("stats.empty")}</div>
        ) : (
          <TipProvider>
            <StatsBody stats={stats} open={open} />
          </TipProvider>
        )}
      </div>
    </div>
  );
}

function StatsBody({ stats, open }) {
  const { t, i18n } = useTranslation("nav");
  const tip = useTip();
  const n = (value) => (value ?? 0).toLocaleString(i18n.language);
  const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
  const rate = (picks, rejects) => {
    const value = keepRate(picks, rejects);
    return value == null ? "—" : `${Math.round(value * 100)}%`;
  };
  const { overview, gear, exposure, culling, places, rhythm, storage, formats, orientation } = stats;
  const photos = overview.photos;
  const year = (stamp) => (stamp ? stamp.slice(0, 4) : null);
  const month = (stamp) => (stamp ? stamp.slice(0, 7) : "—");
  const now = new Date();
  // "unused for 8 months", or in years once it has been two.
  const idle = (last) => {
    const months = monthsSince(last, now);
    if (months == null || months < IDLE_MONTHS) return null;
    return months >= 24 ? t("stats.gear.idleYears", { count: Math.floor(months / 12) }) : t("stats.gear.idle", { count: months });
  };
  const photosDetail = (value, whole = photos) => t("stats.share", { share: pct(value, whole) });
  const bytes = (value) => formatBytes(value) || "0 B";

  // ── rhythm ──
  const years = calendarYears(rhythm.days);
  const [calendarYearValue, setCalendarYear] = useState(null);
  const shownYear = years.includes(calendarYearValue) ? calendarYearValue : years[0];
  const calendar = shownYear ? calendarYear(rhythm.days, shownYear) : null;
  const shade = calendar ? shadeSteps(calendar.cells) : () => 0;
  const monthNames = t("stats.monthsShort", { returnObjects: true });
  const weekdayNames = t("stats.weekdaysShort", { returnObjects: true });
  const lastMonth = overview.last ? overview.last.slice(0, 7) : null;
  const months = monthSeries(rhythm.days, lastMonth, 24);
  const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(i18n.language, { year: "numeric", month: "short", day: "numeric" });
  const monthLabel = (m) => new Date(`${m}-15T12:00:00`).toLocaleDateString(i18n.language, { year: "numeric", month: "long" });

  const span = year(overview.first) && year(overview.last)
    ? (year(overview.first) === year(overview.last) ? year(overview.first) : `${year(overview.first)}–${year(overview.last)}`)
    : "—";
  const cities = (city) => (i18n.language.startsWith("zh") ? city.city_zh || city.city_en : city.city_en || city.city_zh) || city.city_key;

  const funnel = [
    { key: "all", label: t("stats.funnel.all"), value: culling.total },
    { key: "reviewed", label: t("stats.funnel.reviewed"), value: culling.reviewed },
    { key: "picks", label: t("stats.funnel.picks"), value: culling.picks, pick: () => open("flag", { flag: "pick" }) },
    { key: "rated4", label: t("stats.funnel.rated4"), value: culling.rated4, pick: () => open("rated4", {}) },
    { key: "versions", label: t("stats.funnel.versions"), value: culling.versions },
  ];

  const formatRows = ["raw_pair", "jpeg", "heif", "raw", "other", "video"]
    .filter((key) => formats[key])
    .map((key) => {
      const target = filtersFor("format", { format: key });
      return {
        key, label: t(`stats.formats.${key}`), value: formats[key],
        detail: target ? photosDetail(formats[key], overview.total) : t("stats.share", { share: pct(formats[key], overview.total) }),
        onPick: target ? () => open("format", { format: key }) : undefined,
      };
    });

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6" data-testid="stats-overview">
        <Tile testId="stats-tile-photos" label={t("stats.overview.photos")} value={n(photos)} detail={overview.videos ? t("stats.overview.videos", { count: overview.videos, formatted: n(overview.videos) }) : null} />
        <Tile label={t("stats.overview.days")} value={n(overview.days)} detail={overview.days ? t("stats.overview.perDay", { count: Math.round(overview.total / overview.days) }) : null} />
        <Tile label={t("stats.overview.span")} value={span} />
        <Tile label={t("stats.overview.keepRate")} value={rate(overview.picks, overview.rejects)} detail={t("stats.overview.keepRateDetail", { picks: n(overview.picks), rejects: n(overview.rejects) })} />
        <Tile label={t("stats.overview.places")} value={`${n(overview.countries)} · ${n(overview.cities)}`} detail={t("stats.overview.placesDetail")} />
        <Tile label={t("stats.overview.storage")} value={bytes(overview.bytes)} detail={storage.by_kind.raw ? t("stats.overview.rawShare", { share: pct(storage.by_kind.raw, overview.bytes) }) : null} />
      </div>

      <Section id="gear" title={t("stats.gear.title")} subtitle={t("stats.gear.subtitle")}>
        <Card title={t("stats.gear.cameras")} testId="stats-cameras">
          {gear.cameras.length ? (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className={TH}>{t("stats.gear.camera")}</th>
                    <th className={cx(TH, "pr-3 text-right")}>{t("stats.gear.photos")}</th>
                    <th className={cx(TH, "w-[18%]")}>{t("stats.gear.share")}</th>
                    <th className={cx(TH, "pr-3 text-right")}>{t("stats.gear.keepRate")}</th>
                    <th className={TH}>{t("stats.gear.topLens")}</th>
                    <th className={TH}>{t("stats.gear.used")}</th>
                    <th className={TH}>{t("stats.gear.timeline")}</th>
                  </tr>
                </thead>
                <tbody>
                  {gear.cameras.map((camera) => {
                    const idleLabel = idle(camera.last);
                    return (
                      <tr
                        key={camera.model}
                        data-camera={camera.model}
                        className="group cursor-pointer hover:bg-hover/60"
                        {...tip(camera.label, t("stats.openInGallery", { count: camera.count, formatted: n(camera.count) }), () => open("camera", camera))}
                      >
                        <td className={cx(TD, "text-text")}>
                          {camera.label}
                          {idleLabel ? <span className="ml-2 whitespace-nowrap rounded border border-border px-1.5 py-px text-[10px] text-muted">{idleLabel}</span> : null}
                        </td>
                        <td className={cx(TD, "text-right tabular-nums")}>{n(camera.count)}</td>
                        <td className={TD}><Meter value={camera.count / gear.cameras[0].count} /></td>
                        <td className={cx(TD, "text-right tabular-nums text-muted")}>{rate(camera.picks, camera.rejects)}</td>
                        <td className={cx(TD, "max-w-[220px] truncate text-muted")}>{camera.top_lens || "—"}</td>
                        <td className={cx(TD, "whitespace-nowrap text-muted")}>{`${month(camera.first)} — ${month(camera.last)}`}</td>
                        <td className={TD}><Sparkline values={camera.monthly} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div className="text-[12px] text-muted2">{t("stats.gear.noCameras")}</div>}
          <Note>
            {gear.other_cameras.count ? `${t("stats.gear.otherCameras", { count: gear.other_cameras.models, photos: n(gear.other_cameras.count) })} ` : ""}
            {gear.without_camera ? t("stats.gear.withoutCamera", { count: gear.without_camera, formatted: n(gear.without_camera) }) : ""}
          </Note>
        </Card>
        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card title={t("stats.gear.lenses")} testId="stats-lenses">
            {gear.lenses.length ? (
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className={TH}>{t("stats.gear.lens")}</th>
                    <th className={TH}>{t("stats.gear.body")}</th>
                    <th className={cx(TH, "pr-3 text-right")}>{t("stats.gear.photos")}</th>
                    <th className={cx(TH, "w-[22%]")}>{t("stats.gear.share")}</th>
                    <th className={cx(TH, "pr-3 text-right")}>{t("stats.gear.keepRate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {gear.lenses.map((lens) => {
                    const idleLabel = idle(lens.last);
                    return (
                      <tr
                        key={lens.lens}
                        data-lens={lens.lens}
                        className="group cursor-pointer hover:bg-hover/60"
                        {...tip(lens.lens, t("stats.openInGallery", { count: lens.count, formatted: n(lens.count) }), () => open("lens", lens))}
                      >
                        <td className={cx(TD, "max-w-[320px] text-text")}>
                          <div className="flex min-w-0 items-center">
                            <span className="truncate">{lens.lens}</span>
                            {idleLabel ? <span className="ml-2 shrink-0 whitespace-nowrap rounded border border-border px-1.5 py-px text-[10px] text-muted">{idleLabel}</span> : null}
                          </div>
                        </td>
                        <td className={cx(TD, "max-w-[160px] truncate text-muted")}>{lens.camera || "—"}</td>
                        <td className={cx(TD, "text-right tabular-nums")}>{n(lens.count)}</td>
                        <td className={TD}><Meter value={lens.count / gear.lenses[0].count} /></td>
                        <td className={cx(TD, "text-right tabular-nums text-muted")}>{rate(lens.picks, lens.rejects)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : <div className="text-[12px] text-muted2">{t("stats.gear.noLenses")}</div>}
            {gear.without_lens ? <Note>{t("stats.gear.withoutLens", { count: gear.without_lens, formatted: n(gear.without_lens) })}</Note> : null}
          </Card>
          <Card title={t("stats.gear.combos")} testId="stats-combos">
            <BarRows
              labelWidth={200}
              rows={gear.combos.map((combo) => ({
                key: `${combo.model}|${combo.lens}`,
                label: `${combo.camera} · ${combo.lens}`,
                value: combo.count,
                valueLabel: n(combo.count),
                detail: photosDetail(combo.count),
                onPick: () => open("combo", combo),
              }))}
            />
          </Card>
        </div>
      </Section>

      <Section id="habits" title={t("stats.habits.title")} subtitle={t("stats.habits.subtitle")}>
        <div className="grid gap-3 lg:grid-cols-2">
          <Card title={t("stats.habits.focal")} subtitle={t("stats.habits.focalSubtitle")} testId="stats-focal">
            <Columns
              data={exposure.focal.bins.map((bin) => ({ key: bin.label, label: bin.label, value: bin.count, title: `≈ ${bin.label} mm · ${n(bin.count)}`, detail: photosDetail(bin.count) }))}
              height={110}
            />
            {exposure.focal.unknown ? <Note>{t("stats.habits.focalUnknown", { count: exposure.focal.unknown, formatted: n(exposure.focal.unknown) })}</Note> : null}
          </Card>
          <Card title={t("stats.habits.aperture")} testId="stats-aperture">
            <Columns
              data={exposure.aperture.map((bin) => {
                const entry = rangeEntry(bin);
                return {
                  key: bin.label, label: `f/${bin.label}`, value: bin.count,
                  title: `f/${bin.label} · ${n(bin.count)}`, detail: photosDetail(bin.count),
                  onPick: entry ? () => open("aperture", entry) : undefined,
                };
              })}
              height={110}
            />
          </Card>
          <Card title={t("stats.habits.shutter")} subtitle={t("stats.habits.shutterSubtitle")} testId="stats-shutter">
            <Columns
              data={exposure.shutter.map((bin) => ({
                key: bin.label, label: bin.label, value: bin.count,
                title: `${bin.label} · ${n(bin.count)}`,
                detail: bin.count ? t("stats.habits.rejectRate", { share: pct(bin.rejects, bin.count) }) : null,
              }))}
              height={110}
              labelEvery={exposure.shutter.length > 10 ? 2 : 1}
            />
          </Card>
          <Card title={t("stats.habits.iso")} testId="stats-iso">
            <Columns
              data={exposure.iso.map((bin) => {
                const entry = rangeEntry(bin);
                return {
                  key: bin.label, label: bin.label, value: bin.count,
                  title: `ISO ${bin.label} · ${n(bin.count)}`, detail: photosDetail(bin.count),
                  onPick: entry ? () => open("iso", entry) : undefined,
                };
              })}
              height={110}
            />
          </Card>
          <Card title={t("stats.habits.orientation")} testId="stats-orientation">
            <BarRows
              rows={["landscape", "portrait", "square"].filter((shape) => orientation[shape]).map((shape) => ({
                key: shape, label: t(`stats.orientation.${shape}`), value: orientation[shape], valueLabel: n(orientation[shape]),
                detail: photosDetail(orientation[shape]), onPick: () => open("orientation", { shape }),
              }))}
            />
          </Card>
          <Card title={t("stats.habits.formats")} testId="stats-formats">
            <BarRows rows={formatRows.map((row) => ({ ...row, valueLabel: n(row.value) }))} />
          </Card>
        </div>
      </Section>

      <Section id="culling" title={t("stats.culling.title")} subtitle={t("stats.culling.subtitle")}>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card title={t("stats.culling.funnel")} subtitle={t("stats.culling.funnelSubtitle")} testId="stats-funnel">
            <div className="flex flex-col gap-1.5">
              {funnel.map((step, index) => {
                // Each as a share of everything imported: 4 stars and up is
                // not a subset of picked, so chaining step to step would lie.
                const of = index ? culling.total : null;
                return (
                  <div
                    key={step.key}
                    data-funnel={step.key}
                    className={cx("group grid grid-cols-[110px_minmax(0,1fr)_110px] items-center gap-3 text-[12px]", step.pick && "cursor-pointer")}
                    {...tip(step.label, of != null ? t("stats.share", { share: pct(step.value, of) }) : null, step.pick)}
                  >
                    <span className="truncate text-muted group-hover:text-text">{step.label}</span>
                    <div className="h-5 overflow-hidden rounded bg-[var(--fill)]">
                      <div className="h-full rounded bg-text/30 transition-colors group-hover:bg-text/60" style={{ width: `${culling.total ? Math.max(0.6, (step.value / culling.total) * 100) : 0}%` }} />
                    </div>
                    <span className="tabular-nums text-text">
                      {n(step.value)}
                      {of != null ? <span className="ml-1.5 text-muted2">{pct(step.value, of)}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
            <Note>{t("stats.culling.funnelNote")}</Note>
          </Card>
          <Card title={t("stats.culling.unreviewed")} testId="stats-unreviewed">
            <button type="button" className="text-left" onClick={() => open("unreviewed", {})} data-testid="stats-unreviewed-count">
              <div className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-text hover:underline">{n(culling.unreviewed)}</div>
              <div className="text-[11px] text-muted2">{t("stats.culling.unreviewedDetail", { count: culling.unreviewed_recent, formatted: n(culling.unreviewed_recent) })}</div>
            </button>
            <div className="mt-4 text-[12px] font-semibold text-text">{t("stats.culling.ratings")}</div>
            <Columns
              testId="stats-ratings"
              data={culling.ratings.map((value, i) => ({
                key: String(i + 1), label: "★".repeat(i + 1), value,
                title: `${"★".repeat(i + 1)} · ${n(value)}`, detail: photosDetail(value),
                onPick: value ? () => open("rating", { stars: i + 1 }) : undefined,
              }))}
              height={64}
            />
          </Card>
        </div>
      </Section>

      <Section id="places" title={t("stats.places.title")} subtitle={t("stats.places.subtitle", { share: pct(places.located, photos), ai: pct(places.ai, photos) })}>
        <Card testId="stats-cities">
          {places.top_cities.length ? (
            <BarRows
              labelWidth={170}
              rows={places.top_cities.map((city) => ({
                key: city.city_key, label: `${cities(city)}${city.country ? ` · ${city.country}` : ""}`,
                value: city.count, valueLabel: n(city.count), detail: photosDetail(city.count, places.located),
                onPick: city.city_en ? () => open("city", city) : undefined,
              }))}
            />
          ) : <div className="text-[12px] text-muted2">{t("stats.places.none")}</div>}
        </Card>
      </Section>

      <Section id="rhythm" title={t("stats.rhythm.title")} subtitle={t("stats.rhythm.subtitle")}>
        {calendar ? (
          <Card testId="stats-calendar-card">
            <div className="mb-2 flex items-center gap-3">
              <h3 className="text-[13px] font-semibold text-text">{t("stats.rhythm.calendar")}</h3>
              <span className="text-[11px] text-muted2">{t("stats.rhythm.calendarSummary", { count: calendar.shotDays, days: n(calendar.shotDays), photos: t("stats.photoCount", { count: calendar.total, formatted: n(calendar.total) }) })}</span>
              <div className="ml-auto flex gap-1">
                {years.slice(0, 6).map((y) => (
                  <button
                    key={y}
                    type="button"
                    data-stats-year={y}
                    onClick={() => setCalendarYear(y)}
                    className={cx("h-6 rounded px-2 text-[11px] tabular-nums", y === shownYear ? "bg-[var(--fill-2)] text-text" : "text-muted hover:text-text")}
                  >
                    {y}
                  </button>
                ))}
              </div>
            </div>
            <CalendarGrid
              year={calendar}
              shade={shade}
              monthLabels={monthNames}
              weekdayLabels={weekdayNames}
              cellTitle={(c) => `${dayLabel(c.day)} · ${c.count ? t("stats.photoCount", { count: c.count, formatted: n(c.count) }) : t("stats.rhythm.noPhotos")}`}
              onPickDay={(c) => open("day", c)}
            />
            {calendar.best ? (
              <Note>{t("stats.rhythm.calendarNote", {
                run: t("stats.rhythm.run", { count: calendar.longest }),
                photos: t("stats.photoCount", { count: calendar.best.count, formatted: n(calendar.best.count) }),
                day: dayLabel(calendar.best.day),
              })}</Note>
            ) : null}
          </Card>
        ) : null}
        <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card title={t("stats.rhythm.months")} testId="stats-months">
            <Columns
              data={months.map((m) => ({
                key: m.month, label: m.monthNumber === 1 ? String(m.year) : String(m.monthNumber), forceLabel: m.monthNumber === 1,
                value: m.count, title: `${monthLabel(m.month)} · ${n(m.count)}`,
                onPick: m.count ? () => open("month", m) : undefined,
              }))}
              height={110}
              labelEvery={3}
            />
          </Card>
          <Card title={t("stats.rhythm.weekdays")} testId="stats-weekdays">
            <Columns data={weekdayCounts(rhythm.days).map((value, i) => ({ key: String(i), label: weekdayNames[i], value, title: `${weekdayNames[i]} · ${n(value)}`, detail: photosDetail(value, overview.total) }))} height={110} />
          </Card>
        </div>
        <Card className="mt-3" title={t("stats.rhythm.hours")} subtitle={t("stats.rhythm.hoursSubtitle")} testId="stats-hours">
          <Columns data={rhythm.hours.map((value, h) => ({ key: String(h), label: String(h), value, title: `${h}:00–${h}:59 · ${n(value)}`, detail: photosDetail(value, overview.total) }))} height={100} labelEvery={3} />
        </Card>
      </Section>

      <Section id="storage" title={t("stats.storage.title")} subtitle={t("stats.storage.subtitle")}>
        <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <Card title={t("stats.storage.byKind")} subtitle={bytes(storage.total_bytes)} testId="stats-storage">
            <BarRows
              rows={["raw", "jpeg", "heif", "other", "video"].filter((k) => storage.by_kind[k]).map((k) => ({
                key: k, label: t(`stats.storage.kinds.${k}`), value: storage.by_kind[k], valueLabel: bytes(storage.by_kind[k]),
                detail: t("stats.share", { share: pct(storage.by_kind[k], storage.total_bytes) }),
              }))}
            />
            <div className="mt-4 text-[12px] font-semibold text-text">{t("stats.storage.byYear")}</div>
            <Columns
              data={storage.by_year.map((entry) => ({
                key: entry.year, label: entry.year.slice(2), value: entry.bytes,
                title: `${entry.year} · ${bytes(entry.bytes)}`, onPick: () => open("year", entry),
              }))}
              height={80}
            />
          </Card>
          <Card title={t("stats.storage.cleanup")} subtitle={t("stats.storage.cleanupSubtitle")} testId="stats-cleanup">
            <div className="flex flex-col gap-1.5">
              {[
                { key: "rejected", count: storage.rejected.count, size: storage.rejected.bytes, onPick: () => open("flag", { flag: "reject" }) },
                { key: "lookalikes", count: storage.lookalikes.count, size: storage.lookalikes.bytes, groups: storage.lookalikes.groups, onPick: () => onOpenLookalikes(open) },
                { key: "missing", count: storage.missing, size: null },
              ].map((row) => (
                <button
                  key={row.key}
                  type="button"
                  data-cleanup={row.key}
                  disabled={!row.onPick || !row.count}
                  onClick={row.onPick}
                  className="flex items-center gap-3 rounded-md bg-[var(--fill)] px-3 py-2 text-left text-[12px] transition-colors enabled:hover:bg-[var(--fill-2)] disabled:cursor-default"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-text">{t(`stats.storage.${row.key}`)}</span>
                    <span className="block text-[11px] text-muted2">
                      {row.groups != null
                        ? t("stats.storage.lookalikesDetail", { count: row.count, formatted: n(row.count), groups: n(row.groups) })
                        : t("stats.photoCount", { count: row.count, formatted: n(row.count) })}
                    </span>
                  </span>
                  {row.size != null ? <span className="tabular-nums text-text">{bytes(row.size)}</span> : null}
                </button>
              ))}
            </div>
          </Card>
        </div>
      </Section>
    </>
  );
}

// Look-alikes are a gallery view of their own (status "lookalikes"), with the
// page's time range kept.
function onOpenLookalikes(open) {
  open("range", {}, "lookalikes");
}
