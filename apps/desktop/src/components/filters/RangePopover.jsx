// A numeric facet: min + max sliders with editable value boxes.

import { useTranslation } from "react-i18next";
import Popover from "./Popover";
import { SliderRow } from "../../ui";
import { setOrDelete, fmtNum } from "./filterValues";

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
        <SliderRow compact label={t("filter.min")} labelClassName="w-7 shrink-0 uppercase tracking-wider" inputClassName="w-14"
          min={lo} max={hi} step={step} value={vMin} prefix={prefix} suffix={suffix} decimals={decimals}
          onChange={(v) => emit(Math.min(v, vMax), vMax)} />
        <SliderRow compact label={t("filter.max")} labelClassName="w-7 shrink-0 uppercase tracking-wider" inputClassName="w-14"
          min={lo} max={hi} step={step} value={vMax} prefix={prefix} suffix={suffix} decimals={decimals}
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
