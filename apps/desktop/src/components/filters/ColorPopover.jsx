import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import Popover, { ACTION_CHIP } from "./Popover";
import { setOrDelete, toList, fromList } from "./filterValues";

// The colour filter takes any colour. This grid is the shortcut: the hue
// wheel in two lightnesses, plus the neutrals. Anything else goes in the box.
export const COLOR_PRESETS = [
  "#e53935", "#fb8c00", "#fdd835", "#43a047", "#00acc1", "#1e88e5", "#5e35b1", "#d81b60",
  "#ef9a9a", "#ffcc80", "#fff59d", "#a5d6a7", "#80deea", "#90caf9", "#b39ddb", "#f48fb1",
  "#795548", "#ffffff", "#bdbdbd", "#616161", "#000000", "#f5e6c8", "#3e2723", "#1a237e",
];

export const COLOR_TOLERANCES = ["strict", "normal", "loose"];

export const isHex = (value) => /^#?[0-9a-fA-F]{6}$/.test(String(value || "").trim());

export const normalizeHex = (value) => `#${String(value).trim().replace(/^#/, "").toLowerCase()}`;

export default function ColorPopover({ filters, onChange }) {
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
