// The font family picker (bundled fonts first, then the system's, searched
// and arrow-stepped with a live preview) and the weight select.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { FONT_OPTIONS } from "../textState";
import { loadSystemFontFamilies } from "../fontFamilies";
import { FIELD_CHROME, FIELD_SIZE, Select, cx } from "../../../ui";

const WEIGHT_OPTIONS = [
  { value: 100, label: "Thin" },
  { value: 200, label: "ExtraLight" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "SemiBold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "ExtraBold" },
  { value: 900, label: "Black" },
];

export function WeightSelect({ value, onChange }) {
  return (
    <Select className="flex-1" value={value} onChange={(v) => onChange(Number(v))} options={WEIGHT_OPTIONS} />
  );
}

export default function FontSelect({ value, onChange }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const [systemFonts, setSystemFonts] = useState([]);
  const [filter, setFilter] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const listRef = useRef(null);
  const selectedRef = useRef(null);
  const inputRef = useRef(null);
  const openValueRef = useRef(value);

  const loadFonts = async () => {
    setSystemFonts(await loadSystemFontFamilies());
  };

  // Load on mount so arrow-cycling works before the dropdown is ever opened,
  // and re-query every time the dropdown opens so fonts installed while the
  // app is running show up without a restart.
  useEffect(() => { loadFonts(); }, []);
  useEffect(() => { if (open) loadFonts(); }, [open]);

  const allFonts = [
    ...FONT_OPTIONS.map((f) => f.family),
    ...systemFonts.filter((f) => !FONT_OPTIONS.some((o) => o.family === f)),
  ];

  const filtered = filter
    ? allFonts.filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    : allFonts;

  // Scroll to selected font when dropdown opens — manipulate the list's
  // scrollTop directly so we don't bubble the scroll up to the inspector's
  // outer scroll container (which would shove the whole panel up).
  useEffect(() => {
    if (open && !filter && selectedRef.current && listRef.current) {
      const list = listRef.current;
      const item = selectedRef.current;
      list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2;
    }
    // Also focus the search input without scrolling parents.
    if (open && inputRef.current) {
      inputRef.current.focus({ preventScroll: true });
    }
  }, [open, filter]);

  // Reset highlight when filter changes
  useEffect(() => { setHighlightIdx(-1); }, [filter]);

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // Arrow keys apply the highlighted font immediately so the canvas
      // previews it live while browsing the list.
      e.preventDefault();
      if (!filtered.length) return;
      const base = highlightIdx >= 0 ? highlightIdx : Math.max(filtered.indexOf(value), 0);
      const next = e.key === "ArrowDown"
        ? Math.min(base + 1, filtered.length - 1)
        : Math.max(base - 1, 0);
      setHighlightIdx(next);
      if (filtered[next] !== value) onChange(filtered[next]);
    } else if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < filtered.length) {
      e.preventDefault();
      onChange(filtered[highlightIdx]);
      setOpen(false);
      setFilter("");
      setHighlightIdx(-1);
    } else if (e.key === "Escape") {
      // Revert any live-previewed font back to what was set when the
      // dropdown opened.
      if (openValueRef.current && openValueRef.current !== value) onChange(openValueRef.current);
      setOpen(false);
      setFilter("");
      setHighlightIdx(-1);
    }
  };

  // Arrow keys on the CLOSED button cycle fonts directly — no need to open
  // the dropdown at all.
  const handleButtonKeyDown = (e) => {
    if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    e.preventDefault();
    if (!allFonts.length) return;
    const cur = allFonts.indexOf(value);
    const next = e.key === "ArrowDown"
      ? Math.min((cur < 0 ? -1 : cur) + 1, allFonts.length - 1)
      : Math.max((cur < 0 ? 1 : cur) - 1, 0);
    if (allFonts[next] !== value) onChange(allFonts[next]);
  };

  // Scroll highlighted item into view (only within the list — never bubble
  // the scroll up to the inspector's outer scroll container).
  useEffect(() => {
    if (highlightIdx < 0 || !listRef.current) return;
    const list = listRef.current;
    const el = list.children[highlightIdx];
    if (!el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [highlightIdx]);

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="font-select"
        // The same field chrome as the weight Select beside it.
        className={cx("flex w-full items-center gap-2", FIELD_SIZE.sm, FIELD_CHROME)}
        onClick={() => {
          if (!open) openValueRef.current = value;
          setOpen(!open);
        }}
        onKeyDown={handleButtonKeyDown}
      >
        {/* Name in the UI font: rendering it in the chosen font shifts the baseline with each font's metrics; the "Aa" sample carries the preview. */}
        <span className="flex-1 truncate text-left text-[11px] leading-none text-text">{value}</span>
        <span className="text-[11px] text-muted" style={{ fontFamily: value }}>Aa</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted2 flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border bg-chrome shadow-lg">
          <div className="border-b border-border/60 px-2 py-1.5">
            <input
              ref={inputRef}
              type="text"
              className="w-full bg-transparent text-[11px] text-text outline-none placeholder:text-muted2"
              placeholder={t("text.searchFonts")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div ref={listRef} className="max-h-72 overflow-y-auto">
            {filtered.map((family, idx) => (
              <button
                key={family}
                ref={family === value && !filter ? selectedRef : undefined}
                type="button"
                className={[
                  "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] transition-colors",
                  idx === highlightIdx ? "bg-hover" : "hover:bg-hover",
                  value === family ? "text-[rgb(var(--accent-color))]" : "text-text",
                ].join(" ")}
                style={{ fontFamily: `"${family}", sans-serif` }}
                onClick={() => { onChange(family); setOpen(false); setFilter(""); setHighlightIdx(-1); }}
              >
                <span className="flex-1">{family}</span>
                <span className="text-muted">Aa</span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-2.5 py-2 text-[11px] text-muted2">{t("text.noFonts")}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
