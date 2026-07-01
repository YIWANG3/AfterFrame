// Border/frame controls, shown inside the Text tool (no separate frame tool).
//  1. Frame presets — a compact strip (scroll horizontally; the chevron expands
//     to a full grid). Click one to drop its text + logo layers + margins.
//  2. Manual border — a uniform "margin" slider (synced) with an optional
//     per-edge breakout, plus a background color. Margins are fractions of the
//     photo's short edge. Slider drags are live; onPadCommit records one history
//     entry on release.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { SliderRow } from "../../../ui";

const EDGE_KEYS = ["top", "bottom", "left", "right"];
const toPct = (v) => Math.round((v || 0) * 100);

export default function BorderControls({ templates = [], thumbs, cellAspect, onApplyPreset, pad, onPad, onPadCommit, bg, onBg }) {
  const { t } = useTranslation("editor");
  const [perEdge, setPerEdge] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const p = pad || { top: 0, right: 0, bottom: 0, left: 0 };
  const uniform = Math.max(p.top || 0, p.right || 0, p.bottom || 0, p.left || 0);
  const bgColor = bg?.color || "#ffffff";

  const Thumb = (tpl) => {
    const thumb = thumbs?.get?.(tpl.id);
    return (
      <button
        key={tpl.id} type="button" title={tpl.name}
        onClick={() => onApplyPreset?.(tpl)}
        style={{ aspectRatio: String(cellAspect || 0.8) }}
        className="grid shrink-0 place-items-center overflow-hidden rounded-md p-1 transition hover:bg-hover"
      >
        {thumb
          ? <img src={thumb} alt="" className="max-h-full max-w-full object-contain" />
          : <div className="h-3.5 w-3.5 animate-pulse rounded-full bg-hover" />}
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted2">
          <span>{t("border.presets")}</span>
          <button
            type="button"
            title={expanded ? "收起" : "展开"}
            onClick={() => setExpanded((v) => !v)}
            className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-text"
          >
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>
        {expanded ? (
          <div className="grid grid-cols-3 gap-1.5">
            {templates.map(Thumb)}
          </div>
        ) : (
          // Compact strip: scroll horizontally; scrollbar hidden (drag/wheel to scroll).
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {templates.map((tpl) => (
              <div key={tpl.id} className="w-[30%] shrink-0">{Thumb(tpl)}</div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px] text-muted2">
          <span>{t("border.margin")}</span>
          <button
            type="button"
            onClick={() => setPerEdge((v) => !v)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition ${perEdge ? "bg-[rgb(var(--accent-color)/0.16)] text-[rgb(var(--accent-color))]" : "text-muted2 hover:bg-hover hover:text-text"}`}
          >
            {t("border.edges")}
          </button>
        </div>
        {perEdge ? (
          EDGE_KEYS.map((edge) => (
            <SliderRow
              key={edge} compact label={t(`border.${edge}`)} min={0} max={40} suffix="%" resetValue={0}
              value={toPct(p[edge])}
              onChange={(v) => onPad({ [edge]: v / 100 })}
              onCommit={onPadCommit}
            />
          ))
        ) : (
          <SliderRow
            compact min={0} max={40} suffix="%" resetValue={0}
            value={toPct(uniform)}
            onChange={(v) => { const f = v / 100; onPad({ top: f, right: f, bottom: f, left: f }); }}
            onCommit={onPadCommit}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="min-w-[48px] text-[10px] text-muted2">{t("border.background")}</span>
        <div className="flex items-center gap-1.5">
          {["#ffffff", "#000000", "#f2f2f2"].map((c) => (
            <button
              key={c} type="button"
              onClick={() => onBg(c)}
              className={`h-[18px] w-[18px] rounded-full border transition ${
                bgColor.toLowerCase() === c ? "border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color))]" : "border-border/70 hover:border-muted"
              }`}
              style={{ background: c }}
            />
          ))}
          <label className="relative h-[18px] w-[18px] cursor-pointer overflow-hidden rounded-full border border-border/70" title="Custom">
            <span className="absolute inset-0" style={{ background: "conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)" }} />
            <input type="color" value={bgColor} onChange={(e) => onBg(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
        </div>
      </div>
    </div>
  );
}
