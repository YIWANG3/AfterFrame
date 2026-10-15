import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Star } from "lucide-react";
import { setOrDelete } from "./filterValues";

// Stars compared at least / exactly / at most; "Unrated" is at most 0.
export const RATING_MODES = ["ge", "eq", "le"];

export const RATING_SIGNS = { ge: "≥", eq: "=", le: "≤" };

export const RATING_TITLES = { ge: "filter.ratingAtLeast", eq: "filter.ratingExactly", le: "filter.ratingAtMost" };

export function ratingModeOf(f) {
  if (f.rating_min != null && f.rating_min === f.rating_max) return "eq";
  if (f.rating_min == null && f.rating_max > 0) return "le";
  return "ge";
}

export default function RatingFilter({ filters, onChange }) {
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
