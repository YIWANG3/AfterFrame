import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check, X, Star } from "lucide-react";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";

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

function ListPopover({ label, value, options, onSelect }) {
  return (
    <Popover label={label} active={!!value} summary={value} width={200}>
      <div className="popover-scroll -mr-2 max-h-[280px] overflow-y-auto pr-1">
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-muted hover:bg-hover hover:text-text"
          onClick={() => onSelect(undefined)}
        >
          <span className="flex h-3 w-3 items-center justify-center">{!value && <Check className="h-3 w-3 text-accent" />}</span>
          Any {label}
        </button>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={[
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] hover:bg-hover",
              value === opt.value ? "text-text" : "text-muted",
            ].join(" ")}
            onClick={() => onSelect(value === opt.value ? undefined : opt.value)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex h-3 w-3 shrink-0 items-center justify-center">{value === opt.value && <Check className="h-3 w-3 text-accent" />}</span>
              <span className="truncate">{opt.value}</span>
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted2">{opt.count}</span>
          </button>
        ))}
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
        <FacetSlider label="Min" lo={lo} hi={hi} step={step} value={vMin} prefix={prefix} suffix={suffix} decimals={decimals}
          onChange={(v) => emit(Math.min(v, vMax), vMax)} />
        <FacetSlider label="Max" lo={lo} hi={hi} step={step} value={vMax} prefix={prefix} suffix={suffix} decimals={decimals}
          onChange={(v) => emit(vMin, Math.max(v, vMin))} />
      </div>
      {active && (
        <button
          type="button"
          className="mt-2 w-full rounded-md py-1 text-[11px] text-muted2 hover:bg-hover hover:text-text"
          onClick={() => onChange(setOrDelete(setOrDelete(filters, minKey, undefined), maxKey, undefined))}
        >
          Reset
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

function DateRangePopover({ captureRange, filters, onChange }) {
  const from = parseYmd(filters.date_from);
  const to = parseYmd(filters.date_to);
  const active = !!(from || to);
  const fmt = (d) => (d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "…");
  const summary = active ? `${fmt(from)} – ${fmt(to)}` : "Date";
  const minD = parseYmd(captureRange?.min);
  const maxD = parseYmd(captureRange?.max);

  function setRange(nextFrom, nextTo) {
    let next = setOrDelete(filters, "date_from", nextFrom ? toYmd(nextFrom) : undefined);
    next = setOrDelete(next, "date_to", nextTo ? toYmd(nextTo) : undefined);
    onChange(next);
  }

  return (
    <Popover label="Date" active={active} summary={summary} width="auto">
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
          onClick={() => onChange(setOrDelete(setOrDelete(filters, "date_from", undefined), "date_to", undefined))}
        >
          Reset
        </button>
      )}
    </Popover>
  );
}

export default function FilterBar({ facetValues, filters, onChange }) {
  const f = filters || {};
  const cameras = facetValues?.cameras || [];
  const lenses = facetValues?.lenses || [];
  const activeCount = Object.keys(f).length;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 bg-chrome/60 px-2 py-1.5">
      {cameras.length > 0 && (
        <ListPopover label="Camera" value={f.camera} options={cameras} onSelect={(v) => onChange(setOrDelete(f, "camera", v))} />
      )}
      {lenses.length > 0 && (
        <ListPopover label="Lens" value={f.lens} options={lenses} onSelect={(v) => onChange(setOrDelete(f, "lens", v))} />
      )}

      <RangePopover label="ISO" bounds={facetValues?.iso} step={50} minKey="iso_min" maxKey="iso_max" filters={f} onChange={onChange} />
      <RangePopover label="Aperture" bounds={facetValues?.aperture} step={0.1} minKey="aperture_min" maxKey="aperture_max" filters={f} onChange={onChange} prefix="ƒ/" decimals={1} />
      <RangePopover label="Focal" bounds={facetValues?.focal} step={1} minKey="focal_min" maxKey="focal_max" filters={f} onChange={onChange} suffix="mm" />

      <DateRangePopover captureRange={facetValues?.capture_time} filters={f} onChange={onChange} />

      {/* Rating ≥ N */}
      <div className="flex h-6 items-center gap-0.5 rounded-md border border-border/70 bg-app px-1.5">
        {[1, 2, 3, 4, 5].map((n) => {
          const on = (f.rating_min || 0) >= n;
          return (
            <button
              key={n}
              type="button"
              title={`Rating ≥ ${n}`}
              onClick={() => onChange(setOrDelete(f, "rating_min", f.rating_min === n ? undefined : n))}
              className="p-0.5"
            >
              <Star className={["h-3 w-3", on ? "fill-accent text-accent" : "text-muted2"].join(" ")} />
            </button>
          );
        })}
      </div>

      {activeCount > 0 && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] text-muted2 transition-colors hover:bg-hover hover:text-text"
        >
          <X className="h-2.5 w-2.5" />
          Clear {activeCount}
        </button>
      )}
    </div>
  );
}
