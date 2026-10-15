// A numeric facet: min + max sliders with editable value boxes.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Popover from "./Popover";
import { setOrDelete, fmtNum } from "./filterValues";

// Editable numeric value box (no native spin buttons). Keeps a local draft so
// typing partial values ("1.") doesn't fight the controlled value; commits on
// blur / Enter, clamped to [lo, hi].
export function NumberBox({ value, lo, hi, step, prefix, suffix, decimals, onCommit }) {
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

export function FacetSlider({ label, lo, hi, step, value, prefix, suffix, decimals, onChange }) {
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
export default function RangePopover({ label, bounds, step, minKey, maxKey, filters, onChange, prefix = "", suffix = "", decimals = 0 }) {
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
