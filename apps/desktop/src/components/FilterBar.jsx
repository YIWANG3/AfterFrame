import { useLayoutEffect, useMemo, useRef, useState } from "react";
import api from "../api";
import { useTranslation } from "react-i18next";
import { X, ScanFace, Sparkles, Map as MapIcon, Split } from "lucide-react";
import { activeFilterCount, isEmptyValue } from "../hooks/workspaceLogic";
import { usePref } from "../hooks/usePref";
import { ACTION_CHIP } from "./filters/Popover";
import { setOrDelete, toList, fromList } from "./filters/filterValues";
import TextContainsPopover from "./filters/TextContainsPopover";
import ListPopover from "./filters/ListPopover";
import RangePopover from "./filters/RangePopover";
import DateRangePopover from "./filters/DateRangePopover";
import PersonFilterPopover from "./filters/PersonFilterPopover";
import RatingFilter from "./filters/RatingFilter";
import { OrientationFilter, FlagFilter } from "./filters/OrientationFlagFilters";
import SmartCollectionControls from "./filters/SmartCollectionControls";
import ColorPopover from "./filters/ColorPopover";
import FacetChooser, { FACET_SLOTS } from "./filters/FacetChooser";
import { adoptLegacyPref } from "../utils/prefs";

// Collapsible facet filter bar under the Toolbar. Reads options/ranges from
// `facetValues` and emits a structured `filters` object matching the sidecar's
// browse-exports --filters. The popovers live in ./filters.

// How mainland Chinese apps word these three in their own country/region
// pickers; the platform's names are either formal (中国香港特别行政区) or,
// for TW, just the island's name.
const ZH_REGION_LABELS = { TW: "中国台湾", HK: "中国香港", MO: "中国澳门" };

const HIDDEN_FACETS_PREF = "filterBar.hidden";
// The choice lived under a bare localStorage key until 2026-10; carried over once.
adoptLegacyPref("afterframe.filterBar.hidden", HIDDEN_FACETS_PREF, JSON.parse);

const SLOT_IDS = new Set(FACET_SLOTS.map((slot) => slot.id));

// A facet that no longer exists is dropped (utils/prefs.js).
const checkHiddenFacets = (value) => (Array.isArray(value) ? value.filter((id) => SLOT_IDS.has(id)) : undefined);

// `embedded`: one group inside the condition-groups dialog. It starts with
// only its active facets showing ("Add condition" reveals the rest), keeps no
// preferences, and has no actions, map chip or groups of its own.
export default function FilterBar({ facetValues, facetsReady = true, filters, onChange, personGroup, onPersonGroup, facetScope, smart, folders = [], onEditGroups, embedded = false }) {
  const { t, i18n } = useTranslation("nav");
  const f = filters || {};
  const cameras = facetValues?.cameras || [];
  const lenses = facetValues?.lenses || [];
  const tags = facetValues?.tags || [];
  const extensions = facetValues?.extensions || [];
  const locationSources = facetValues?.location_sources || [];
  const countries = facetValues?.countries || [];
  const cities = facetValues?.cities || [];
  // Places are stored by their canonical value (ISO code, English city name)
  // and shown in the interface language.
  const chinese = String(i18n.language || "").toLowerCase().startsWith("zh");
  const regionNames = useMemo(() => {
    try { return new Intl.DisplayNames([chinese ? "zh-CN" : "en"], { type: "region" }); } catch { return null; }
  }, [chinese]);
  // The everyday name (中国, 韩国) comes from the platform's region names,
  // which also settle how territories are worded (中国香港特别行政区); the
  // gazetteer's formal label (中华人民共和国) is the fallback. The chip is
  // "Country/Region" for the same reason: ISO 3166 lists both.
  const countryLabel = (value, option) => {
    if (chinese && ZH_REGION_LABELS[value]) return ZH_REGION_LABELS[value];
    let standard;
    try { standard = regionNames?.of(String(value)); } catch { standard = undefined; }
    if (standard && standard !== value) return standard;
    const known = option || countries.find((c) => c.value === value);
    const fromCatalog = known && (chinese ? known.label_zh : known.label_en);
    return fromCatalog || String(value);
  };
  const cityLabel = (value, option) => {
    const known = option || cities.find((c) => c.value === value);
    return (chinese && known?.label_zh) || String(value);
  };
  const folderLabel = (value) => folders.find((c) => c.collection_id === value)?.name || String(value);
  const activeCount = activeFilterCount(f);

  const slotActive = (id) => FACET_SLOTS.find((slot) => slot.id === id).keys.some((key) => !isEmptyValue(f[key]));
  // The main bar's hidden facets are remembered; a group's dialog (embedded)
  // starts with every idle facet hidden and keeps its own choice for the dialog.
  const [rememberedHidden, setRememberedHidden] = usePref(HIDDEN_FACETS_PREF, [], checkHiddenFacets);
  const [dialogHidden, setDialogHidden] = useState(() => (embedded ? FACET_SLOTS.map((slot) => slot.id).filter((id) => !slotActive(id)) : []));
  const hidden = embedded ? dialogHidden : rememberedHidden;
  const toggleFacet = (id) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    (embedded ? setDialogHidden : setRememberedHidden)(next);
  };
  // A group in the dialog must not change which person the main bar shows.
  const [ownPerson, setOwnPerson] = useState(null);
  const shownPerson = embedded ? ownPerson : personGroup;
  const pickPerson = embedded ? setOwnPerson : onPersonGroup;

  // `exclude` flips the facets it names (db/facets.py); the values stay put.
  const excludedFacets = toList(f.exclude);
  const withExcluded = (next, facet, on) => {
    const rest = toList(next.exclude).filter((name) => name !== facet);
    return setOrDelete(next, "exclude", fromList(on ? [...rest, facet] : rest));
  };
  // Emptying a facet also takes it out of `exclude`: with nothing to flip it
  // would only linger in a saved rule.
  const setFacet = (key, facet, value) => {
    const next = setOrDelete(f, key, value);
    return isEmptyValue(value) ? withExcluded(next, facet, false) : next;
  };
  const exclusion = (facet) => ({
    modes: ["include", "exclude"],
    mode: excludedFacets.includes(facet) ? "exclude" : "include",
    onMode: (mode) => onChange(withExcluded(f, facet, mode === "exclude")),
  });
  const tagModes = toList(f.tag).length > 1 ? ["any", "all", "exclude"] : ["include", "exclude"];
  const tagMode = excludedFacets.includes("tag") ? "exclude" : f.tag_match === "all" ? "all" : tagModes[0];
  const shows = (id) => !hidden.includes(id) || slotActive(id);
  const slotLabel = (id) => ({
    camera: t("filter.camera"), lens: t("filter.lens"), tag: t("filter.tag"), extension: t("filter.format"),
    location_source: t("filter.locationSource.label"), country: t("filter.country"), city: t("filter.city"),
    text: t("filter.textContains"), color: t("filter.color"), people: t("filter.people"), annotated: t("filter.annotated"),
    person_group: t("filter.person"), in_collection: t("filter.folder"), iso: t("filter.iso"), aperture: t("filter.aperture"),
    focal: t("filter.focal"), date: t("filter.date"), rating: t("filter.rating"), flag: t("filter.flag"), orientation: t("filter.orientation.label"),
  })[id];

  const scrollRef = useRef(null);
  const [moreRight, setMoreRight] = useState(false);
  const measureMore = () => {
    const el = scrollRef.current;
    if (el) setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };
  // Re-measure when the row's width changes (window resize, the actions
  // appearing beside it) or its contents do (a chip added or removed).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    measureMore();
    const observer = new ResizeObserver(measureMore);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [activeCount, f.geo?.label, hidden]);

  return (
    // Two parts: the facets scroll sideways when they do not fit; the actions
    // on what is filtered (Clear, save / update a smart collection) stay put
    // at the right edge, so they are never scrolled out of reach.
    <div
      data-filter-bar={embedded ? undefined : "true"}
      data-filter-group={embedded ? "true" : undefined}
      data-facets-ready={facetsReady ? "true" : "false"}
      className={embedded ? "flex flex-wrap items-center gap-1.5" : "flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-chrome/60 px-2 py-1.5"}
    >
      <div
        ref={scrollRef}
        data-filter-scroll="true"
        // The right-edge fade is a "more this way" hint, so it is only on
        // while there IS more: at the end of the row it would just dim the
        // last facet.
        data-more={moreRight ? "true" : undefined}
        onScroll={measureMore}
        className={`${embedded ? "" : "filter-bar-scroll "}flex min-w-0 flex-1 flex-wrap items-center gap-1.5`}
        // The skin lays the facets out as one sideways-scrolling row. Trackpads
        // scroll it natively; a mouse wheel only has a vertical axis, so map
        // that onto the row when it overflows.
        onWheel={(event) => {
          const el = event.currentTarget;
          // An open dropdown is portaled to <body>, but React still bubbles
          // its wheel events here: scrolling a list must not move the row.
          if (!el.contains(event.target)) return;
          if (el.scrollWidth <= el.clientWidth || event.deltaX !== 0 || event.deltaY === 0) return;
          el.scrollLeft += event.deltaY;
        }}
      >
      {/* A facet with nothing to offer is hidden — unless it is filtering: counts
          follow the other filters, so its options can run out while its own
          pick is still in force, and that pick must stay reachable. */}
      {shows("camera") && (cameras.length > 0 || toList(f.camera).length > 0) && (
        <ListPopover label={t("filter.camera")} value={f.camera} options={cameras} {...exclusion("camera")} onSelect={(v) => onChange(setFacet("camera", "camera", v))} />
      )}
      {shows("lens") && (lenses.length > 0 || toList(f.lens).length > 0) && (
        <ListPopover label={t("filter.lens")} value={f.lens} options={lenses} {...exclusion("lens")} onSelect={(v) => onChange(setFacet("lens", "lens", v))} />
      )}
      {shows("tag") && (tags.length > 0 || toList(f.tag).length > 0) && (
        <ListPopover
          label={t("filter.tag")}
          value={f.tag}
          options={tags}
          onSearch={(q) => api.searchFacet({ field: "tag", q, limit: 60, ...(facetScope || {}) })}
          // "All" only means something with several tags; a single pick drops it.
          onSelect={(v) => onChange(setOrDelete(setFacet("tag", "tag", v), "tag_match", Array.isArray(v) ? f.tag_match : undefined))}
          modes={tagModes}
          mode={tagMode}
          onMode={(mode) => onChange(setOrDelete(withExcluded(f, "tag", mode === "exclude"), "tag_match", mode === "all" ? "all" : undefined))}
          excludeKey="filter.excludedTag"
        />
      )}
      {shows("extension") && (extensions.length > 0 || toList(f.extension).length > 0) && (
        <ListPopover
          label={t("filter.format")}
          value={f.extension}
          options={extensions.map((e) => ({ value: String(e.value).toUpperCase(), count: e.count }))}
          labelOf={(value) => String(value).toUpperCase()} // a rule saved by an agent may say "jpg"
          {...exclusion("extension")}
          onSelect={(v) => onChange(setFacet("extension", "extension", v))}
        />
      )}
      {shows("orientation") && <OrientationFilter filters={f} onChange={onChange} />}

      {shows("location_source") && (locationSources.length > 0 || toList(f.location_source).length > 0) && (
        <ListPopover
          label={t("filter.locationSource.label")}
          value={f.location_source}
          options={locationSources}
          labelOf={(value) => t(`filter.locationSource.${value}`, { defaultValue: String(value) })}
          {...exclusion("location_source")}
          onSelect={(v) => onChange(setFacet("location_source", "location_source", v))}
        />
      )}
      {shows("country") && (countries.length > 0 || toList(f.country).length > 0) && (
        <ListPopover
          label={t("filter.country")}
          value={f.country}
          options={countries}
          searchable
          labelOf={countryLabel}
          {...exclusion("country")}
          onSelect={(v) => onChange(setFacet("country", "country", v))}
        />
      )}
      {shows("city") && (cities.length > 0 || toList(f.city).length > 0) && (
        <ListPopover
          label={t("filter.city")}
          value={f.city}
          options={cities}
          onSearch={(q) => api.searchFacet({ field: "city", q, limit: 60, ...(facetScope || {}) })}
          labelOf={cityLabel}
          {...exclusion("city")}
          onSelect={(v) => onChange(setFacet("city", "city", v))}
        />
      )}
      {shows("text") && <TextContainsPopover filters={f} onChange={onChange} />}
      {/* Shown once any photo has colours (the catch-up job runs on open); a
          saved colour rule keeps it on the bar regardless. */}
      {shows("color") && api.can("colors") && ((facetValues?.colors_analyzed || 0) > 0 || toList(f.color).length > 0) && (
        <ColorPopover filters={f} onChange={onChange} />
      )}

      {/* Face/annotation-backed filters need their data pipelines (People
          indexing, AI annotation) — hidden where the bridge declares those
          capabilities off (web build). */}
      {shows("people") && api.can("people") && (
        <button
          type="button"
          onClick={() => onChange(setOrDelete(f, "people", f.people === "with_faces" ? undefined : "with_faces"))}
          className={[
            "flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
            f.people === "with_faces" ? "border-accent/50 bg-accent/10 text-text" : "border-border/70 bg-app text-muted hover:border-border hover:text-text",
          ].join(" ")}
        >
          <ScanFace className="h-3 w-3" />
          {t("filter.people")}
        </button>
      )}

      {/* AI annotation presence — cycles off → with → without → off. */}
      {shows("annotated") && api.can("annotation") && (
        <button
          type="button"
          onClick={() => onChange(setOrDelete(f, "annotated",
            f.annotated === "with" ? "without" : f.annotated === "without" ? undefined : "with"))}
          title={t("filter.annotatedHint")}
          className={[
            "flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
            f.annotated ? "border-accent/50 bg-accent/10 text-text" : "border-border/70 bg-app text-muted hover:border-border hover:text-text",
          ].join(" ")}
        >
          <Sparkles className="h-3 w-3" />
          {f.annotated === "without" ? t("filter.notAnnotated") : t("filter.annotated")}
        </button>
      )}

      {shows("person_group") && api.can("people") && (
        <PersonFilterPopover
          value={f.person_group}
          personGroup={shownPerson}
          {...exclusion("person_group")}
          onSelect={(group) => {
            pickPerson?.(group || null);
            onChange(setFacet("person_group", "person_group", group?.group_id));
          }}
        />
      )}

      {shows("in_collection") && (folders.length > 0 || toList(f.in_collection).length > 0) && (
        <ListPopover
          label={t("filter.folder")}
          value={f.in_collection}
          options={folders.map((c) => ({ value: c.collection_id }))}
          searchable
          labelOf={folderLabel}
          {...exclusion("in_collection")}
          excludeKey="filter.excludedFolder"
          onSelect={(v) => onChange(setFacet("in_collection", "in_collection", v))}
        />
      )}

      {shows("iso") && <RangePopover label={t("filter.iso")} bounds={facetValues?.iso} step={50} minKey="iso_min" maxKey="iso_max" filters={f} onChange={onChange} />}
      {shows("aperture") && <RangePopover label={t("filter.aperture")} bounds={facetValues?.aperture} step={0.1} minKey="aperture_min" maxKey="aperture_max" filters={f} onChange={onChange} prefix="ƒ/" decimals={1} />}
      {shows("focal") && <RangePopover label={t("filter.focal")} bounds={facetValues?.focal} step={1} minKey="focal_min" maxKey="focal_max" filters={f} onChange={onChange} suffix="mm" />}

      {shows("date") && <DateRangePopover captureRange={facetValues?.capture_time} filters={f} onChange={onChange} />}

      {shows("rating") && <RatingFilter filters={f} onChange={onChange} />}
      {shows("flag") && <FlagFilter filters={f} onChange={onChange} />}

      {/* Location chip — created by moving the map, removable here. Removing
          it only drops filters.geo; the map drawer stays open. */}
      {f.geo && !embedded && (
        <button
          type="button"
          data-testid="geo-filter-chip"
          onClick={() => onChange(setOrDelete(f, "geo", undefined))}
          className="flex h-6 items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-2 text-[11px] text-text transition-colors hover:border-accent"
          title={t("filter.mapAreaRemove")}
        >
          <MapIcon className="h-3 w-3" />
          {f.geo.label || (f.geo.mode === "place" && f.geo.place_id ? f.geo.place_id : t("filter.mapArea"))}
          <X className="h-2.5 w-2.5 text-muted" />
        </button>
      )}

      {/* "Any of these groups": its conditions are edited in the dialog. */}
      {toList(f.any_of).length > 0 && !embedded && (
        <button
          type="button"
          data-filter-groups="true"
          onClick={() => onEditGroups?.()}
          className="flex h-6 items-center gap-1 rounded-md border border-accent/50 bg-accent/10 px-2 text-[11px] text-text transition-colors hover:border-accent"
        >
          <Split className="h-3 w-3" />
          {t("filter.groups.chip", { count: toList(f.any_of).length })}
        </button>
      )}

      <FacetChooser
        hidden={hidden}
        onToggle={toggleFacet}
        slotLabel={slotLabel}
        label={embedded ? t("filter.groups.addCondition") : undefined}
        onAddGroups={embedded ? undefined : onEditGroups}
      />
      </div>

      {!embedded && (activeCount > 0 || smart?.canSave || smart?.editing) && (
        <div data-filter-actions="true" className="filter-bar-actions flex shrink-0 items-center gap-1.5">
          {activeCount > 0 && (
            <button
              type="button"
              onClick={() => onChange({})}
              className={ACTION_CHIP}
            >
              <X className="h-2.5 w-2.5" />
              {t("filter.clear", { count: activeCount })}
            </button>
          )}
          <SmartCollectionControls smart={smart} />
        </div>
      )}
    </div>
  );
}
