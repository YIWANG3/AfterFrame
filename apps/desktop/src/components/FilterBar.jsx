import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import api from "../api";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { ChevronDown, Check, X, Star, ScanFace, Sparkles, Map as MapIcon, ListFilter, Save, SlidersHorizontal } from "lucide-react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";
import { localFileUrl } from "../utils/format";
import { isEmptyValue } from "../hooks/workspaceLogic";
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
function Popover({ label, active, summary, children, width = 220 }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const estWidth = width === "auto" ? 480 : width;
    let left = r.left;
    if (left + estWidth > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - estWidth);
    setPos({ left, top: r.bottom + 4 });
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

// Multi-select list. Ticking several options means "any of these"; the popover
// stays open so they can be ticked in a row. `matchMode` / `onMatchMode` add the
// any / all switch that only tags need ("night AND neon").
function ListPopover({ label, value, options, onSelect, searchable, onSearch, matchMode, onMatchMode, labelOf = String }) {
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
  const summary = picked.length > 1
    ? t("filter.pickedMore", { first: labelOf(picked[0]), count: picked.length - 1 })
    : picked.length ? labelOf(picked[0]) : undefined;

  return (
    <Popover label={label} active={picked.length > 0} summary={summary} width={200}>
      {(searchable || onSearch) && (
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("filter.searchPlaceholder", { label })}
          className="mb-1.5 w-full rounded border border-border/60 bg-app px-2 py-1 text-[11px] text-text outline-none placeholder:text-muted2 focus:border-accent/50"
        />
      )}
      {onMatchMode && picked.length > 1 && (
        <div className="mb-1.5 flex gap-1 rounded-md bg-app p-0.5" data-facet-match="true">
          {["any", "all"].map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onMatchMode(mode)}
              className={[
                "h-5 flex-1 rounded text-[10px] transition-colors",
                (matchMode || "any") === mode ? "bg-selected text-text" : "text-muted2 hover:text-text",
              ].join(" ")}
            >
              {t(`filter.match.${mode}`)}
            </button>
          ))}
        </div>
      )}
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
              <span className="shrink-0 text-[10px] tabular-nums text-muted2">{opt.count}</span>
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
function PersonFilterPopover({ value, personGroup, onSelect }) {
  const { t } = useTranslation("nav");
  const [known, setKnown] = useState([]);
  const match = (personGroup?.group_id === value ? personGroup : null)
    || known.find((group) => group.group_id === value);
  return (
    <Popover
      label={t("filter.person")}
      active={!!value}
      summary={match?.name?.trim() || t("filter.person")}
      width={230}
    >
      <PersonFilterOptions value={value} onSelect={onSelect} onLoaded={setKnown} />
    </Popover>
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
  { id: "people", keys: ["people"], capability: "people" },
  { id: "annotated", keys: ["annotated"], capability: "annotation" },
  { id: "person_group", keys: ["person_group"], capability: "people" },
  { id: "iso", keys: ["iso_min", "iso_max"] },
  { id: "aperture", keys: ["aperture_min", "aperture_max"] },
  { id: "focal", keys: ["focal_min", "focal_max"] },
  { id: "date", keys: ["date_from", "date_to", "date_within_days"] },
  { id: "rating", keys: ["rating_min"] },
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

function FacetChooser({ hidden, onToggle, slotLabel }) {
  const { t } = useTranslation("nav");
  return (
    <Popover label={t("filter.addFacet")} width={200}>
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
    </Popover>
  );
}

export default function FilterBar({ facetValues, filters, onChange, personGroup, onPersonGroup, facetScope, smart }) {
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
  const activeCount = Object.keys(f).filter((key) => key !== "tag_match").length;

  const [hidden, setHidden] = useState(readHiddenFacets);
  const toggleFacet = (id) => {
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    setHidden(next);
    try { localStorage.setItem(HIDDEN_FACETS_KEY, JSON.stringify(next)); } catch { /* preference only */ }
  };
  const slotActive = (id) => FACET_SLOTS.find((slot) => slot.id === id).keys.some((key) => !isEmptyValue(f[key]));
  const shows = (id) => !hidden.includes(id) || slotActive(id);
  const slotLabel = (id) => ({
    camera: t("filter.camera"), lens: t("filter.lens"), tag: t("filter.tag"), extension: t("filter.format"),
    location_source: t("filter.locationSource.label"), country: t("filter.country"), city: t("filter.city"),
    text: t("filter.textContains"), people: t("filter.people"), annotated: t("filter.annotated"),
    person_group: t("filter.person"), iso: t("filter.iso"), aperture: t("filter.aperture"),
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
      data-filter-bar="true"
      className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-chrome/60 px-2 py-1.5"
    >
      <div
        ref={scrollRef}
        data-filter-scroll="true"
        // The right-edge fade is a "more this way" hint, so it is only on
        // while there IS more: at the end of the row it would just dim the
        // last facet.
        data-more={moreRight ? "true" : undefined}
        onScroll={measureMore}
        className="filter-bar-scroll flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
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
        <ListPopover label={t("filter.camera")} value={f.camera} options={cameras} onSelect={(v) => onChange(setOrDelete(f, "camera", v))} />
      )}
      {shows("lens") && (lenses.length > 0 || toList(f.lens).length > 0) && (
        <ListPopover label={t("filter.lens")} value={f.lens} options={lenses} onSelect={(v) => onChange(setOrDelete(f, "lens", v))} />
      )}
      {shows("tag") && (tags.length > 0 || toList(f.tag).length > 0) && (
        <ListPopover
          label={t("filter.tag")}
          value={f.tag}
          options={tags}
          onSearch={(q) => api.searchFacet({ field: "tag", q, limit: 60, ...(facetScope || {}) })}
          // "All" only means something with several tags; a single pick drops it.
          onSelect={(v) => onChange(setOrDelete(setOrDelete(f, "tag", v), "tag_match", Array.isArray(v) ? f.tag_match : undefined))}
          matchMode={f.tag_match}
          onMatchMode={(mode) => onChange(setOrDelete(f, "tag_match", mode === "all" ? "all" : undefined))}
        />
      )}
      {shows("extension") && (extensions.length > 0 || toList(f.extension).length > 0) && (
        <ListPopover
          label={t("filter.format")}
          value={f.extension}
          options={extensions.map((e) => ({ value: String(e.value).toUpperCase(), count: e.count }))}
          labelOf={(value) => String(value).toUpperCase()} // a rule saved by an agent may say "jpg"
          onSelect={(v) => onChange(setOrDelete(f, "extension", v))}
        />
      )}

      {shows("location_source") && (locationSources.length > 0 || toList(f.location_source).length > 0) && (
        <ListPopover
          label={t("filter.locationSource.label")}
          value={f.location_source}
          options={locationSources}
          labelOf={(value) => t(`filter.locationSource.${value}`, { defaultValue: String(value) })}
          onSelect={(v) => onChange(setOrDelete(f, "location_source", v))}
        />
      )}
      {shows("country") && (countries.length > 0 || toList(f.country).length > 0) && (
        <ListPopover
          label={t("filter.country")}
          value={f.country}
          options={countries}
          searchable
          labelOf={countryLabel}
          onSelect={(v) => onChange(setOrDelete(f, "country", v))}
        />
      )}
      {shows("city") && (cities.length > 0 || toList(f.city).length > 0) && (
        <ListPopover
          label={t("filter.city")}
          value={f.city}
          options={cities}
          onSearch={(q) => api.searchFacet({ field: "city", q, limit: 60, ...(facetScope || {}) })}
          labelOf={cityLabel}
          onSelect={(v) => onChange(setOrDelete(f, "city", v))}
        />
      )}
      {shows("text") && <TextContainsPopover filters={f} onChange={onChange} />}

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
          personGroup={personGroup}
          onSelect={(group) => {
            onPersonGroup?.(group || null);
            onChange(setOrDelete(f, "person_group", group?.group_id));
          }}
        />
      )}

      {shows("iso") && <RangePopover label={t("filter.iso")} bounds={facetValues?.iso} step={50} minKey="iso_min" maxKey="iso_max" filters={f} onChange={onChange} />}
      {shows("aperture") && <RangePopover label={t("filter.aperture")} bounds={facetValues?.aperture} step={0.1} minKey="aperture_min" maxKey="aperture_max" filters={f} onChange={onChange} prefix="ƒ/" decimals={1} />}
      {shows("focal") && <RangePopover label={t("filter.focal")} bounds={facetValues?.focal} step={1} minKey="focal_min" maxKey="focal_max" filters={f} onChange={onChange} suffix="mm" />}

      {shows("date") && <DateRangePopover captureRange={facetValues?.capture_time} filters={f} onChange={onChange} />}

      {/* Rating ≥ N */}
      {shows("rating") && (
      <div className="flex h-6 items-center gap-0.5 rounded-md border border-border/70 bg-app px-1.5" data-facet-rating="true">
        {[1, 2, 3, 4, 5].map((n) => {
          const on = (f.rating_min || 0) >= n;
          return (
            <button
              key={n}
              type="button"
              title={t("filter.ratingAtLeast", { n })}
              onClick={() => onChange(setOrDelete(f, "rating_min", f.rating_min === n ? undefined : n))}
              className="p-0.5"
            >
              <Star className={["h-3 w-3", on ? "fill-accent text-accent" : "text-muted2"].join(" ")} />
            </button>
          );
        })}
      </div>
      )}

      {/* Location chip — created by moving the map, removable here. Removing
          it only drops filters.geo; the map drawer stays open. */}
      {f.geo && (
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

      <FacetChooser hidden={hidden} onToggle={toggleFacet} slotLabel={slotLabel} />
      </div>

      {(activeCount > 0 || smart?.canSave || smart?.editing) && (
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
