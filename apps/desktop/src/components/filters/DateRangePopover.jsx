// The capture-date facet: a calendar range or "the last N days".

import { useTranslation } from "react-i18next";
import Popover from "./Popover";
import { setOrDelete } from "./filterValues";
import Calendar from "react-calendar";
import "react-calendar/dist/Calendar.css";

export function toYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseYmd(s) {
  if (!s) return undefined;
  const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
  if (!y) return undefined;
  return new Date(y, (m || 1) - 1, d || 1);
}

export const RELATIVE_DAY_PRESETS = [7, 30, 90, 365];

export default function DateRangePopover({ captureRange, filters, onChange }) {
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
