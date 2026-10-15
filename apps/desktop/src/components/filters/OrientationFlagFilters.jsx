// The orientation and flag facets: a row of icon toggles each.

import { useTranslation } from "react-i18next";
import { Flag, FlagOff, RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { setOrDelete, toList } from "./filterValues";

// Landscape / portrait / square as the photo shows (the sidecar reads it off
// the thumbnail, so a camera's upright shot counts as portrait). Several = OR.
export const ORIENTATION_OPTIONS = [
  { value: "landscape", icon: RectangleHorizontal },
  { value: "portrait", icon: RectangleVertical },
  { value: "square", icon: Square },
];

export function OrientationFilter({ filters, onChange }) {
  const { t } = useTranslation("nav");
  const picked = toList(filters.orientation);
  const toggle = (value) => {
    const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
    onChange(setOrDelete(filters, "orientation", next.length === 0 ? undefined : next.length === 1 ? next[0] : next));
  };
  return (
    <div className="flex h-6 items-center gap-0.5 rounded-md border border-border/70 bg-app px-1" data-facet-orientation="true">
      {ORIENTATION_OPTIONS.map(({ value, icon: Icon }) => {
        const on = picked.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            data-orientation-option={value}
            onClick={() => toggle(value)}
            className={["inline-flex items-center gap-1 rounded px-1 text-[10.5px] transition-colors", on ? "bg-accent/15 text-text" : "text-muted2 hover:text-text"].join(" ")}
          >
            <Icon className="h-3 w-3" />
            {t(`filter.orientation.${value}`)}
          </button>
        );
      })}
    </div>
  );
}

// Pick / rejected / no flag (Lightroom's P / X / U); several picked are OR,
// so "picked + no flag" is everything not rejected.
export const FLAG_OPTIONS = [
  { value: "pick", icon: Flag },
  { value: "reject", icon: FlagOff },
  { value: "none", icon: null },
];

export function FlagFilter({ filters, onChange }) {
  const { t } = useTranslation("nav");
  const picked = toList(filters.flag);
  const toggle = (value) => {
    const next = picked.includes(value) ? picked.filter((v) => v !== value) : [...picked, value];
    onChange(setOrDelete(filters, "flag", next.length === 0 ? undefined : next.length === 1 ? next[0] : next));
  };
  return (
    <div className="flex h-6 items-center gap-0.5 rounded-md border border-border/70 bg-app px-1" data-facet-flag="true">
      {FLAG_OPTIONS.map(({ value, icon: Icon }) => {
        const on = picked.includes(value);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={on}
            data-flag-option={value}
            onClick={() => toggle(value)}
            className={["inline-flex items-center gap-1 rounded px-1 text-[10.5px] transition-colors", on ? "bg-accent/15 text-text" : "text-muted2 hover:text-text"].join(" ")}
          >
            {Icon ? <Icon className={["h-3 w-3", on && value === "pick" ? "fill-current" : ""].join(" ")} /> : null}
            {t(value === "none" ? "flag.unflagged" : `flag.${value}`)}
          </button>
        );
      })}
    </div>
  );
}
