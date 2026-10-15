import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import Popover, { MatchModes } from "./Popover";
import { toList, fromList, sameOption } from "./filterValues";

// Multi-select list. Ticking several options means "any of these"; the popover
// stays open so they can be ticked in a row. `modes` / `mode` / `onMode` add
// the switch above the options (see MatchModes); in "exclude" the chip reads
// `excludeKey` ("Camera is not X").
export default function ListPopover({ label, value, options, onSelect, searchable, onSearch, modes, mode, onMode, excludeKey = "filter.excluded", labelOf = String }) {
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
