import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import api from "../api";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, Check, X, Star, ScanFace, Sparkles, Map as MapIcon, ListFilter, Save, SlidersHorizontal, Split } from "lucide-react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import { localFileUrl } from "../utils/format";
import { activeFilterCount, isEmptyValue } from "../hooks/workspaceLogic";
import FaceCrop from "./FaceCrop";
import InlineEdit from "./InlineEdit";

// Collapsible facet filter bar under the Toolbar. Reads options/ranges from
// `facetValues` and emits a structured `filters` object matching the sidecar's
// browse-exports --filters.

function setOrDelete(obj, key, value) {
  const next = { ...obj };
  if (value === undefined || value === null || value === "") delete next[key];
  else next[key] = value;
  return next;
}

function fmtNum(v, decimals) {
  return decimals ? Number(v).toFixed(decimals) : String(Math.round(Number(v)));
}

// Shared popover shell. The panel is portaled to <body> and fixed-positioned
// under the trigger, so it can't be clipped or covered by sibling panels
// (e.g. the Inspector) regardless of stacking context.
function Popover({ label, active, summary, children, width = 220, excluded = false }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  // Below the chip when the list fits there; otherwise above it, or pinned to
  // the window's bottom edge. A chip low on the screen (a group in the
  // condition-groups dialog, on a small window) must not open off-screen.
  // Re-placed when the list changes size (options arriving, a search).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return undefined;
    function place() {
      const r = btnRef.current.getBoundingClientRect();
      const estWidth = width === "auto" ? 480 : width;
      let left = r.left;
      if (left + estWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - estWidth);
      const h = panelRef.current?.offsetHeight || 0;
      let top = r.bottom + 4;
      if (h && top + h > window.innerHeight - 8) {
        top = r.top - 4 - h >= 8 ? r.top - 4 - h : Math.max(8, window.innerHeight - 8 - h);
      }
      setPos((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    }
    place();
    const observer = panelRef.current ? new ResizeObserver(place) : null;
    if (observer) observer.observe(panelRef.current);
    return () => observer?.disconnect();
  }, [open, width]);

  useEffect(() => {
    if (!open) return;
    function down(e) {
      if (btnRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function key(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((c) => !c)}
        data-excluded={excluded ? "true" : undefined}
        className={[
          "flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] transition-colors",
          active ? "border-accent/50 bg-accent/10 text-text" : "border-border/70 bg-app text-muted hover:border-border hover:text-text",
        ].join(" ")}
      >
        <span className="max-w-[160px] truncate">{active ? summary : label}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0 text-muted2" />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          data-popover-panel="true"
          className="fixed z-[12000] rounded-lg border border-border/60 bg-chrome p-2 shadow-overlay"
          style={{ left: pos.left, top: pos.top, width: width === "auto" ? undefined : width }}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

// "Contains" on one text field each. The search box matches seven fields at
// once (a camera name hits as readily as a caption); these match exactly one,
// and are saved into a smart collection as such. Typing commits after a pause.
const TEXT_FACETS = ["caption_contains", "ocr_contains", "path_contains"];

function TextContainsPopover({ filters, onChange }) {
  const { t } = useTranslation("nav");
  const [draft, setDraft] = useState(() => Object.fromEntries(TEXT_FACETS.map((key) => [key, filters[key] || ""])));
  const active = TEXT_FACETS.filter((key) => filters[key]);
  // Cleared from outside (Clear, leaving the place): follow it.
  const committed = TEXT_FACETS.map((key) => filters[key] || "").join("\u0000");
  useEffect(() => {
    setDraft((current) => {
      const next = Object.fromEntries(TEXT_FACETS.map((key) => [key, filters[key] || ""]));
      return TEXT_FACETS.every((key) => (current[key] || "").trim() === next[key]) ? current : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed]);
  useEffect(() => {
    const timer = setTimeout(() => {
      let next = filters;
      for (const key of TEXT_FACETS) {
        const text = (draft[key] || "").trim();
        if (text !== (filters[key] || "")) next = setOrDelete(next, key, text || undefined);
      }
      if (next !== filters) onChange(next);
    }, 350);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const summary = active.length > 1
    ? t("filter.pickedMore", { first: filters[active[0]], count: active.length - 1 })
    : filters[active[0]];
  return (
    <Popover label={t("filter.textContains")} active={active.length > 0} summary={summary} width={230}>
      {TEXT_FACETS.map((key) => (
        <label key={key} className="mb-1.5 block last:mb-0">
          <span className="mb-0.5 block text-[10px] text-muted2">{t(`filter.contains.${key}`)}</span>
          <input
            data-text-facet={key}
            value={draft[key]}
            onChange={(e) => setDraft((current) => ({ ...current, [key]: e.target.value }))}
            placeholder={t("filter.containsPlaceholder")}
            className="w-full rounded border border-border/60 bg-app px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
          />
        </label>
      ))}
    </Popover>
  );
}

// A facet's value: nothing, one pick (a scalar, as it has always been stored),
// or several (a list). Several values within one facet are OR.
const toList = (value) => (value == null || value === "" ? [] : Array.isArray(value) ? value : [value]);
const fromList = (list) => (list.length === 0 ? undefined : list.length === 1 ? list[0] : list);
const sameOption = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const MODE_LABELS = { any: "filter.match.any", all: "filter.match.all", include: "filter.matchInclude", exclude: "filter.matchExclude" };

// The switch at the top of a facet's list: include / exclude, and for several
// tags any / all / exclude ("night AND neon", "none of these").
function MatchModes({ modes, mode, onMode }) {
  const { t } = useTranslation("nav");
  return (
    <div className="mb-1.5 flex gap-1 rounded-md bg-app p-0.5" data-facet-match="true">
      {modes.map((option) => (
        <button
          key={option}
          type="button"
          data-facet-mode={option}
          aria-pressed={mode === option}
          onClick={() => onMode(option)}
          className={[
            "h-5 flex-1 rounded text-[10px] transition-colors",
            mode === option ? "bg-selected text-text" : "text-muted2 hover:text-text",
          ].join(" ")}
        >
          {t(MODE_LABELS[option])}
        </button>
      ))}
    </div>
  );
}

// Multi-select list. Ticking several options means "any of these"; the popover
// stays open so they can be ticked in a row. `modes` / `mode` / `onMode` add
// the switch above the options (see MatchModes); in "exclude" the chip reads
// `excludeKey` ("Camera is not X").
function ListPopover({ label, value, options, onSelect, searchable, onSearch, modes, mode, onMode, excludeKey = "filter.excluded", labelOf = String }) {
  const { t } = useTranslation("nav");
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState(null);
  const picked = toList(value);

  // When onSearch is provided, typing queries the backend (debounced) so the
  // list stays bounded no matter how many distinct values exist.
  useEffect(() => {
    if (!onSearch) return undefined;
    const term = q.trim();
    if (!term) { setRemote(null); return undefined; }
    const t = setTimeout(async () => {
      try { setRemote(await onSearch(term)); } catch { setRemote([]); }
    }, 200);
    return () => clearTimeout(t);
  }, [q, onSearch]);

  let shown;
  if (onSearch) shown = q.trim() ? (remote || []) : options;
  else if (searchable && q) {
    const term = q.toLowerCase();
    shown = options.filter((o) => String(o.value).toLowerCase().includes(term) || String(labelOf(o.value, o)).toLowerCase().includes(term));
  }
  else shown = options;
  // Counts follow the other active filters, so a picked value can drop out of
  // the list (nothing matches it any more). Keep it, at 0: that is the
  // explanation for an empty grid, and the row the user unticks to get out.
  if (!q.trim()) {
    const missing = picked.filter((value_) => !shown.some((o) => sameOption(o.value, value_)));
    if (missing.length) shown = [...missing.map((value_) => ({ value: value_, count: 0 })), ...shown];
  }

  const isPicked = (option) => picked.some((value_) => sameOption(value_, option));
  const toggle = (option) => onSelect(fromList(isPicked(option)
    ? picked.filter((value_) => !sameOption(value_, option))
    : [...picked, option]));
  const picks = picked.length > 1
    ? t("filter.pickedMore", { first: labelOf(picked[0]), count: picked.length - 1 })
    : picked.length ? labelOf(picked[0]) : undefined;
  const excluded = mode === "exclude" && picked.length > 0;
  const summary = excluded ? t(excludeKey, { label, value: picks }) : picks;

  return (
    <Popover label={label} active={picked.length > 0} summary={summary} width={200} excluded={excluded}>
      {(searchable || onSearch) && (
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("filter.searchPlaceholder", { label })}
          className="mb-1.5 w-full rounded border border-border/60 bg-app px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
      )}
      {onMode && modes?.length > 1 && picked.length > 0 && <MatchModes modes={modes} mode={mode} onMode={onMode} />}
      <div className="popover-scroll -mr-2 max-h-[280px] overflow-y-auto pr-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
          onClick={() => onSelect(undefined)}
        >
          <span className="flex h-3 w-3 items-center justify-center">{picked.length === 0 && <Check className="h-3 w-3 text-accent" />}</span>
          {t("filter.any", { label })}
        </button>
        {shown.map((opt) => {
          const on = isPicked(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={[
                "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
                on ? "text-text" : "text-muted",
              ].join(" ")}
              onClick={() => toggle(opt.value)}
              data-facet-option={opt.value}
              data-facet-count={opt.count}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className={[
                  "flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border",
                  on ? "border-accent/70 bg-accent/15" : "border-border",
                ].join(" ")}
                >
                  {on && <Check className="h-2.5 w-2.5 text-accent" />}
                </span>
                <span className="truncate">{labelOf(opt.value, opt)}</span>
              </span>
              {opt.count != null && <span className="shrink-0 text-[10px] tabular-nums text-muted2">{opt.count}</span>}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

// Editable numeric value box (no native spin buttons). Keeps a local draft so
// typing partial values ("1.") doesn't fight the controlled value; commits on
// blur / Enter, clamped to [lo, hi].
function NumberBox({ value, lo, hi, step, prefix, suffix, decimals, onCommit }) {
  const [draft, setDraft] = useState(fmtNum(value, decimals));
  useEffect(() => { setDraft(fmtNum(value, decimals)); }, [value, decimals]);
  function commit(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n)) { setDraft(fmtNum(value, decimals)); return; }
    onCommit(Math.min(hi, Math.max(lo, n)));
  }
  return (
    <div className="flex h-5 w-[64px] shrink-0 items-center gap-0.5 rounded border border-border/60 bg-app px-1.5 text-[10px] tabular-nums text-text">
      {prefix && <span className="shrink-0 text-muted2">{prefix}</span>}
      <input
        type="number"
        className="no-spinner min-w-0 flex-1 bg-transparent text-right outline-none"
        value={draft}
        min={lo} max={hi} step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { commit(e.target.value); e.currentTarget.blur(); } }}
      />
      {suffix && <span className="shrink-0 text-muted2">{suffix}</span>}
    </div>
  );
}

function FacetSlider({ label, lo, hi, step, value, prefix, suffix, decimals, onChange }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 shrink-0 text-[9px] uppercase tracking-wider text-muted2">{label}</span>
      <input
        type="range" min={lo} max={hi} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1"
      />
      <NumberBox value={value} lo={lo} hi={hi} step={step} prefix={prefix} suffix={suffix} decimals={decimals} onCommit={onChange} />
    </div>
  );
}

// Min + Max sliders for a numeric facet. A value at a bound clears that side.
function RangePopover({ label, bounds, step, minKey, maxKey, filters, onChange, prefix = "", suffix = "", decimals = 0 }) {
  const { t } = useTranslation("nav");
  const lo = Number(bounds?.min);
  const hi = Number(bounds?.max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;
  const vMin = filters[minKey] ?? lo;
  const vMax = filters[maxKey] ?? hi;
  const active = filters[minKey] != null || filters[maxKey] != null;
  const disp = (v) => `${prefix}${fmtNum(v, decimals)}${suffix}`;
  const summary = `${label} ${disp(vMin)}–${disp(vMax)}`;

  function emit(nmin, nmax) {
    let next = setOrDelete(filters, minKey, nmin <= lo ? undefined : nmin);
    next = setOrDelete(next, maxKey, nmax >= hi ? undefined : nmax);
    onChange(next);
  }

  return (
    <Popover label={label} active={active} summary={summary} width={260}>
      <div className="flex flex-col gap-2.5">
        <FacetSlider label={t("filter.min")} lo={lo} hi={hi} step={step} value={vMin} prefix={prefix} suffix={suffix} decimals={decimals}
          onChange={(v) => emit(Math.min(v, vMax), vMax)} />
        <FacetSlider label={t("filter.max")} lo={lo} hi={hi} step={step} value={vMax} prefix={prefix} suffix={suffix} decimals={decimals}
          onChange={(v) => emit(vMin, Math.max(v, vMin))} />
      </div>
      {active && (
        <button
          type="button"
          className="mt-2 w-full rounded-md py-1 text-[11px] text-muted2 hover:bg-hover hover:text-text"
          onClick={() => onChange(setOrDelete(setOrDelete(filters, minKey, undefined), maxKey, undefined))}
        >
          {t("filter.reset")}
        </button>
      )}
    </Popover>
  );
}

function toYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(s) {
  if (!s) return undefined;
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  if (!y) return undefined;
  return new Date(y, (m || 1) - 1, d || 1);
}

const RELATIVE_DAY_PRESETS = [7, 30, 90, 365];

function DateRangePopover({ captureRange, filters, onChange }) {
  const { t } = useTranslation("nav");
  const from = parseYmd(filters.date_from);
  const to = parseYmd(filters.date_to);
  // "Last N days" is relative to today, so a smart collection saved with it
  // keeps moving with the calendar; a picked range is fixed. One or the other.
  const withinDays = Number(filters.date_within_days) || 0;
  const active = !!(from || to || withinDays);
  const fmt = (d) => (d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "…");
  const summary = withinDays
    ? t("filter.lastDays", { count: withinDays })
    : active ? `${fmt(from)} – ${fmt(to)}` : t("filter.date");
  const minD = parseYmd(captureRange?.min);
  const maxD = parseYmd(captureRange?.max);

  function setRange(nextFrom, nextTo) {
    let next = setOrDelete(filters, "date_from", nextFrom ? toYmd(nextFrom) : undefined);
    next = setOrDelete(next, "date_to", nextTo ? toYmd(nextTo) : undefined);
    onChange(setOrDelete(next, "date_within_days", undefined));
  }

  function setWithinDays(days) {
    const cleared = setOrDelete(setOrDelete(filters, "date_from", undefined), "date_to", undefined);
    onChange(setOrDelete(cleared, "date_within_days", days === withinDays ? undefined : days));
  }

  return (
    <Popover label={t("filter.date")} active={active} summary={summary} width="auto">
      <div className="mb-2 flex gap-1" data-filter-within-days="true">
        {RELATIVE_DAY_PRESETS.map((days) => (
          <button
            key={days}
            type="button"
            onClick={() => setWithinDays(days)}
            className={[
              "h-6 flex-1 rounded-md px-1.5 text-[11px] transition-colors",
              withinDays === days ? "bg-selected text-text" : "text-muted2 hover:bg-hover hover:text-text",
            ].join(" ")}
          >
            {t("filter.lastDaysShort", { count: days })}
          </button>
        ))}
      </div>
      <Calendar
        className="cal-dark"
        selectRange
        showNeighboringMonth={false}
        minDate={minD}
        maxDate={maxD}
        defaultActiveStartDate={to || from || maxD || undefined}
        value={from && to ? [from, to] : null}
        onChange={(val) => {
          const arr = Array.isArray(val) ? val : [val, val];
          setRange(arr[0] || undefined, arr[1] || undefined);
        }}
      />
      {active && (
        <button
          type="button"
          className="mt-2 w-full rounded-md py-1 text-[11px] text-muted2 hover:bg-hover hover:text-text"
          onClick={() => onChange(setOrDelete(setOrDelete(setOrDelete(filters, "date_from", undefined), "date_to", undefined), "date_within_days", undefined))}
        >
          {t("filter.reset")}
        </button>
      )}
    </Popover>
  );
}

// A resident "person" facet: pick any named person straight from the gallery,
// without a detour through the people wall. Options load when the panel opens
// so freshly named people always appear.
function PersonFilterPopover({ value, personGroup, onSelect, mode, onMode }) {
  const { t } = useTranslation("nav");
  const [known, setKnown] = useState([]);
  const match = (personGroup?.group_id === value ? personGroup : null)
    || known.find((group) => group.group_id === value);
  const name = match?.name?.trim() || t("filter.person");
  const excluded = !!value && mode === "exclude";
  return (
    <Popover
      label={t("filter.person")}
      active={!!value}
      summary={excluded ? t("filter.excludedPerson", { value: name }) : name}
      width={230}
      excluded={excluded}
    >
      {value && onMode && <MatchModes modes={["include", "exclude"]} mode={mode} onMode={onMode} />}
      <PersonFilterOptions value={value} onSelect={onSelect} onLoaded={setKnown} />
    </Popover>
  );
}

// Stars compared at least / exactly / at most; "Unrated" is at most 0.
const RATING_MODES = ["ge", "eq", "le"];
const RATING_SIGNS = { ge: "≥", eq: "=", le: "≤" };
const RATING_TITLES = { ge: "filter.ratingAtLeast", eq: "filter.ratingExactly", le: "filter.ratingAtMost" };
function ratingModeOf(f) {
  if (f.rating_min != null && f.rating_min === f.rating_max) return "eq";
  if (f.rating_min == null && f.rating_max > 0) return "le";
  return "ge";
}

function RatingFilter({ filters, onChange }) {
  const { t } = useTranslation("nav");
  const f = filters;
  const unrated = f.rating_max === 0 && f.rating_min == null;
  const [mode, setMode] = useState(() => ratingModeOf(f));
  // A saved rule, Clear or another bar changes the stars from outside; the
  // switch follows whatever they now say.
  useEffect(() => {
    if (f.rating_min != null || f.rating_max > 0) setMode(ratingModeOf(f));
  }, [f.rating_min, f.rating_max]); // eslint-disable-line react-hooks/exhaustive-deps
  const stars = unrated ? null : (mode === "le" ? f.rating_max : f.rating_min) ?? null;
  const apply = (n, nextMode, extra = {}) => {
    const next = setOrDelete(setOrDelete(f, "rating_min", undefined), "rating_max", undefined);
    if (n != null && nextMode !== "le") next.rating_min = n;
    if (n != null && nextMode !== "ge") next.rating_max = n;
    onChange({ ...next, ...extra });
  };
  return (
    <div className="flex h-6 items-center gap-0.5 rounded-md border border-border/70 bg-app px-1" data-facet-rating="true" data-rating-mode={mode}>
      <button
        type="button"
        data-rating-mode-toggle="true"
        title={t("filter.ratingModeHint", { mode: t(`filter.ratingMode.${mode}`) })}
        onClick={() => {
          const nextMode = RATING_MODES[(RATING_MODES.indexOf(mode) + 1) % RATING_MODES.length];
          setMode(nextMode);
          if (stars != null) apply(stars, nextMode);
        }}
        className="w-3.5 text-center text-[11px] tabular-nums text-muted transition-colors hover:text-text"
      >
        {RATING_SIGNS[mode]}
      </button>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          title={t(RATING_TITLES[mode], { n })}
          onClick={() => apply(stars === n ? null : n, mode)}
          className="p-0.5"
        >
          <Star className={["h-3 w-3", stars != null && n <= stars ? "fill-accent text-accent" : "text-muted2"].join(" ")} />
        </button>
      ))}
      <button
        type="button"
        data-rating-unrated="true"
        aria-pressed={unrated}
        onClick={() => (unrated ? apply(null, mode) : apply(null, mode, { rating_max: 0 }))}
        className={["ml-0.5 rounded px-1 text-[10px] transition-colors", unrated ? "bg-accent/15 text-text" : "text-muted2 hover:text-text"].join(" ")}
      >
        {t("filter.unrated")}
      </button>
    </div>
  );
}

function PersonFilterOptions({ value, onSelect, onLoaded }) {
  const { t } = useTranslation("nav");
  const [groups, setGroups] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api.listPeopleGroups() || [];
        const named = rows.filter((group) => group.name?.trim());
        if (!cancelled) { setGroups(named); onLoaded?.(named); }
      } catch {
        if (!cancelled) setGroups([]);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const label = t("filter.person");
  return (
    <div className="popover-scroll -mr-2 max-h-[280px] overflow-y-auto pr-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
        onClick={() => onSelect(undefined)}
      >
        <span className="flex h-3 w-3 items-center justify-center">{!value && <Check className="h-3 w-3 text-accent" />}</span>
        {t("filter.any", { label })}
      </button>
      {groups === null ? (
        <div className="px-2 py-2 text-[11px] text-muted2">{t("people.loading")}</div>
      ) : groups.length === 0 ? (
        <div className="px-2 py-2 text-[11px] text-muted2">{t("filter.noNamedPeople")}</div>
      ) : groups.map((group) => (
        <button
          key={group.group_id}
          type="button"
          className={[
            "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
            value === group.group_id ? "text-text" : "text-muted",
          ].join(" ")}
          onClick={() => onSelect(value === group.group_id ? undefined : group)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-3 w-3 shrink-0 items-center justify-center">{value === group.group_id && <Check className="h-3 w-3 text-accent" />}</span>
            <FaceCrop
              src={localFileUrl(group.cover_preview_path || group.cover_image_path)}
              bbox={group.cover_bbox}
              size={20}
              className="shrink-0 rounded-full"
            />
            <span className="truncate">{group.name}</span>
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted2">{group.face_count}</span>
        </button>
      ))}
    </div>
  );
}

// The bar floats over the photos, so anything in it needs a surface of its own:
// bare text ("Clear", "Save as smart collection") vanishes against an image.
// These are the facet chips' classes, which is also what the skin hangs the
// glass pill on (index.css: `.flex-wrap.border-b button.rounded-md.border`).
const ACTION_CHIP = "flex h-6 items-center gap-1 rounded-md border border-border/70 bg-app px-2 text-[11px] text-muted transition-colors hover:border-border hover:text-text";

// What the bar offers depends on the layer the user is working in
// (hooks/workspaceLogic.js):
//   a status view or folder, refined → "Save as smart collection"
//   inside a smart collection, refined → "Narrow «X» to this" (its rules are
//       rewritten) or "Save as new". An unrefined collection offers nothing:
//       picking a format in there narrows the view, it does not edit the rules.
//   editing a collection's conditions → Save / Cancel
function SmartCollectionControls({ smart }) {
  const { t } = useTranslation("nav");
  const [naming, setNaming] = useState(false);
  if (!smart) return null;
  if (smart.editing) {
    return (
      <>
        <span className="flex h-6 items-center gap-1 px-1 text-[11px] text-muted2" data-smart-editing="true">
          <SlidersHorizontal className="h-2.5 w-2.5" />
          <span className="max-w-[140px] truncate">{t("filter.editingSmart", { name: smart.activeName })}</span>
        </span>
        <button type="button" className={ACTION_CHIP} onClick={() => smart.onCancelEdit?.()}>{t("filter.cancelEdit")}</button>
        <button
          type="button"
          className={`${ACTION_CHIP} disabled:cursor-not-allowed disabled:opacity-50`}
          disabled={!smart.dirty || !smart.canSave}
          title={smart.canSave ? undefined : t("filter.needsCondition")}
          onClick={() => smart.onSaveEdit?.()}
        >
          <Save className="h-2.5 w-2.5" />
          {t("filter.saveEdit")}
        </button>
      </>
    );
  }
  if (!smart.canSave) return null;
  if (naming) {
    return (
      <span className="w-40 rounded-md border border-border/70 bg-app" data-smart-name-input="true">
        <InlineEdit
          initial=""
          onConfirm={async (name) => { setNaming(false); await smart.onSave?.(name); }}
          onCancel={() => setNaming(false)}
        />
      </span>
    );
  }
  return (
    <>
      {smart.activeName && (
        <button type="button" className={ACTION_CHIP} onClick={() => smart.onNarrow?.()} title={t("filter.narrowSmartHint", { name: smart.activeName })}>
          <Save className="h-2.5 w-2.5" />
          <span className="max-w-[160px] truncate">{t("filter.narrowSmart", { name: smart.activeName })}</span>
        </button>
      )}
      <button type="button" className={ACTION_CHIP} onClick={() => setNaming(true)}>
        <ListFilter className="h-2.5 w-2.5" />
        {smart.activeName ? t("filter.saveSmartAs") : t("filter.saveSmart")}
      </button>
    </>
  );
}

// How mainland Chinese apps word these three in their own country/region
// pickers; the platform's names are either formal (中国香港特别行政区) or,
// for TW, just the island's name.
const ZH_REGION_LABELS = { TW: "中国台湾", HK: "中国香港", MO: "中国澳门" };

// The colour filter takes any colour. This grid is the shortcut: the hue
// wheel in two lightnesses, plus the neutrals. Anything else goes in the box.
const COLOR_PRESETS = [
  "#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60",
  "#ef9a9a", "#ffcc80", "#fff59d", "#a5d6a7", "#80deea", "#90caf9", "#b39ddb", "#f48fb1",
  "#795548", "#ffffff", "#bdbdbd", "#616161", "#000000", "#f5e6c8", "#3e2723", "#1a237e",
];
const COLOR_TOLERANCES = ["strict", "normal", "loose"];
const isHex = (value) => /^#?[0-9a-fA-F]{6}$/.test(String(value || "").trim());
const normalizeHex = (value) => `#${String(value).trim().replace(/^#/, "").toLowerCase()}`;

function ColorPopover({ filters, onChange }) {
  const { t } = useTranslation("nav");
  const picked = toList(filters.color).map(normalizeHex);
  const tolerance = filters.color_tolerance || "normal";
  const [draft, setDraft] = useState("");
  const set = (colors, nextTolerance = tolerance) => onChange(setOrDelete(
    setOrDelete(filters, "color", fromList(colors)),
    "color_tolerance",
    colors.length && nextTolerance !== "normal" ? nextTolerance : undefined,
  ));
  const toggle = (hex) => set(picked.includes(hex) ? picked.filter((c) => c !== hex) : [...picked, hex]);
  const summary = picked.length ? (
    <span className="flex items-center gap-1">
      {picked.slice(0, 3).map((hex) => <span key={hex} className="h-3 w-3 rounded-full border border-black/20" style={{ background: hex }} />)}
      {picked.length > 3 && <span>+{picked.length - 3}</span>}
    </span>
  ) : undefined;
  return (
    <Popover label={t("filter.color")} active={picked.length > 0} summary={summary} width={236}>
      <div className="grid grid-cols-8 gap-1" data-color-presets="true">
        {COLOR_PRESETS.map((hex) => {
          const on = picked.includes(hex);
          return (
            <button
              key={hex}
              type="button"
              role="checkbox"
              aria-checked={on}
              data-color-option={hex}
              title={hex.toUpperCase()}
              onClick={() => toggle(hex)}
              style={{ background: hex }}
              className={[
                "h-5 w-5 rounded-full border transition-transform",
                on ? "scale-110 border-accent ring-2 ring-accent/40" : "border-black/15 hover:scale-110",
              ].join(" ")}
            />
          );
        })}
      </div>
      <form
        className="mt-2 flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!isHex(draft)) return;
          const hex = normalizeHex(draft);
          if (!picked.includes(hex)) set([...picked, hex]);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("filter.colorHexPlaceholder")}
          data-color-hex-input="true"
          className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-app px-2 text-[11px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
        <button type="submit" disabled={!isHex(draft)} className={`${ACTION_CHIP} disabled:opacity-40`}>{t("filter.colorAdd")}</button>
      </form>
      {picked.some((hex) => !COLOR_PRESETS.includes(hex)) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {picked.filter((hex) => !COLOR_PRESETS.includes(hex)).map((hex) => (
            <button key={hex} type="button" onClick={() => toggle(hex)} title={t("filter.colorRemove", { hex: hex.toUpperCase() })} className={ACTION_CHIP}>
              <span className="h-3 w-3 rounded-full border border-black/20" style={{ background: hex }} />
              {hex.toUpperCase()}
              <X className="h-2.5 w-2.5" />
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex gap-1 rounded-md bg-app p-0.5" data-color-tolerance="true">
        {COLOR_TOLERANCES.map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => picked.length && set(picked, level)}
            className={[
              "h-5 flex-1 rounded text-[10px] transition-colors",
              tolerance === level ? "bg-selected text-text" : "text-muted2 hover:text-text",
            ].join(" ")}
          >
            {t(`filter.colorTolerance.${level}`)}
          </button>
        ))}
      </div>
    </Popover>
  );
}

// Which facets sit on the bar is the user's choice: every one is listed
// under "Add filter", and the unticked ones are kept out of the way. The
// choice is stored as the HIDDEN set, so a facet added in a later version
// shows up for everyone. A hidden facet that is filtering (a smart
// collection's rule, a person picked from the wall) still shows: what is
// narrowing the grid must always be on the bar.
export const FACET_SLOTS = [
  { id: "camera", keys: ["camera"] },
  { id: "lens", keys: ["lens"] },
  { id: "tag", keys: ["tag", "tag_match"] },
  { id: "extension", keys: ["extension"] },
  { id: "location_source", keys: ["location_source"] },
  { id: "country", keys: ["country"] },
  { id: "city", keys: ["city"] },
  { id: "text", keys: TEXT_FACETS },
  { id: "color", keys: ["color", "color_tolerance"], capability: "colors" },
  { id: "people", keys: ["people"], capability: "people" },
  { id: "annotated", keys: ["annotated"], capability: "annotation" },
  { id: "person_group", keys: ["person_group"], capability: "people" },
  { id: "in_collection", keys: ["in_collection"] },
  { id: "iso", keys: ["iso_min", "iso_max"] },
  { id: "aperture", keys: ["aperture_min", "aperture_max"] },
  { id: "focal", keys: ["focal_min", "focal_max"] },
  { id: "date", keys: ["date_from", "date_to", "date_within_days"] },
  { id: "rating", keys: ["rating_min", "rating_max"] },
];
export const HIDDEN_FACETS_KEY = "afterframe.filterBar.hidden";
const SLOT_IDS = new Set(FACET_SLOTS.map((slot) => slot.id));

function readHiddenFacets() {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_FACETS_KEY) || "[]");
    return Array.isArray(stored) ? stored.filter((id) => SLOT_IDS.has(id)) : [];
  } catch {
    return [];
  }
}

function FacetChooser({ hidden, onToggle, slotLabel, label, onAddGroups }) {
  const { t } = useTranslation("nav");
  return (
    <Popover label={label || t("filter.addFacet")} width={200}>
      <div className="popover-scroll -mr-2 max-h-[320px] overflow-y-auto pr-1" data-facet-chooser="true">
        {FACET_SLOTS.filter((slot) => !slot.capability || api.can(slot.capability)).map((slot) => {
          const on = !hidden.includes(slot.id);
          return (
            <button
              key={slot.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              data-facet-slot={slot.id}
              onClick={() => onToggle(slot.id)}
              className={[
                "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
                on ? "text-text" : "text-muted",
              ].join(" ")}
            >
              <span className={[
                "flex h-3 w-3 shrink-0 items-center justify-center rounded-[3px] border",
                on ? "border-accent/70 bg-accent/15" : "border-border",
              ].join(" ")}
              >
                {on && <Check className="h-2.5 w-2.5 text-accent" />}
              </span>
              <span className="truncate">{slotLabel(slot.id)}</span>
            </button>
          );
        })}
      </div>
      {onAddGroups && (
        <button
          type="button"
          data-filter-groups-entry="true"
          onClick={onAddGroups}
          className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-border/60 px-2 pb-1 pt-1.5 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
        >
          <Split className="h-3 w-3" />
          {t("filter.groups.entry")}
        </button>
      )}
    </Popover>
  );
}

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
  const [hidden, setHidden] = useState(() => (embedded ? FACET_SLOTS.map((slot) => slot.id).filter((id) => !slotActive(id)) : readHiddenFacets()));
  const toggleFacet = (id) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
    if (embedded) return;
    try { localStorage.setItem(HIDDEN_FACETS_KEY, JSON.stringify(next)); } catch { /* preference only */ }
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
    focal: t("filter.focal"), date: t("filter.date"), rating: t("filter.rating"),
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
