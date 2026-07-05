// Border/frame controls, shown inside the Text tool (no separate frame tool).
//  1. Frame presets — a compact strip (scroll horizontally; the chevron expands
//     to a full grid). Click one to drop its text + logo layers + margins.
//  2. Manual border — four compact scrub-inputs (top/bottom/left/right; drag on
//     the box or click to type) with a Sketch-style link toggle: linked (default)
//     moves all four together; unlinked lets each edge move on its own. Plus a
//     background color. Margins are fractions of the photo's short edge. Scrub
//     drags are live; onPadCommit records one history entry on release/blur.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Link2, Link2Off, PanelTop, PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { NumberDragInput } from "../../../ui";
import ColorPickerPopover from "../../collage/ColorPickerPopover";
import { COLOR_SWATCHES } from "../textState";
import { bgToCss } from "../render/canvasHelpers";

const EDGE_KEYS = ["top", "bottom", "left", "right"];
const EDGE_ICON = { top: PanelTop, bottom: PanelBottom, left: PanelLeft, right: PanelRight };
const toPct = (v) => Math.round((v || 0) * 100);
const DEFAULT_GRAD = { from: "#ffffff", to: "#000000", fromOpacity: 1, toOpacity: 1, angle: 180 };

export default function BorderControls({ templates = [], thumbs, cellAspect, onApplyPreset, onClearPreset, pad, onPad, onPadCommit, bg, onBg }) {
  const { t } = useTranslation("editor");
  const [linked, setLinked] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const swatchRef = useRef(null);
  const p = pad || { top: 0, right: 0, bottom: 0, left: 0 };
  // An asymmetric pad (e.g. a bottom-bar preset) auto-unlinks the edges —
  // otherwise the first linked edit would flatten the preset's layout to a
  // uniform border.
  const edgesEqual = (p.top || 0) === (p.right || 0) && (p.top || 0) === (p.bottom || 0) && (p.top || 0) === (p.left || 0);
  useEffect(() => { if (!edgesEqual) setLinked(false); }, [edgesEqual]);
  const bgMode = bg?.mode === "gradient" ? "gradient" : "solid";
  const bgColor = bg?.color || "#ffffff";
  const grad = bg?.gradient || DEFAULT_GRAD;
  // Same renderer as the live canvas background, so the swatch preview (incl.
  // gradient opacity) can't diverge from what the border actually shows.
  const swatchBg = bgToCss(bg || { color: bgColor });

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
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onClearPreset?.()}
              className="rounded px-1.5 py-0.5 text-[10px] text-muted2 hover:bg-hover hover:text-text"
            >
              {t("border.clear")}
            </button>
            <button
              type="button"
              title={expanded ? t("border.collapse") : t("border.expand")}
              onClick={() => setExpanded((v) => !v)}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-text"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
          </div>
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
            title={linked ? t("border.linked") : t("border.unlinked")}
            aria-pressed={linked}
            onClick={() => setLinked((v) => !v)}
            className={`flex h-5 w-5 items-center justify-center rounded transition ${linked ? "bg-[rgb(var(--accent-color)/0.16)] text-[rgb(var(--accent-color))]" : "text-muted2 hover:bg-hover hover:text-text"}`}
          >
            {linked ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="flex items-center justify-between gap-1">
          {EDGE_KEYS.map((edge) => {
            const Icon = EDGE_ICON[edge];
            return (
              <div key={edge} className="flex items-center gap-1" title={t(`border.${edge}`)}>
                <Icon className="h-3 w-3 shrink-0 text-muted2" />
                <NumberDragInput
                  className="w-9"
                  min={0} max={100}
                  value={toPct(p[edge])}
                  onChange={(v) => {
                    const f = v / 100;
                    onPad(linked ? { top: f, right: f, bottom: f, left: f } : { [edge]: f });
                  }}
                  onCommit={onPadCommit}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="min-w-[48px] text-[10px] text-muted2">{t("border.background")}</span>
        <div className="flex items-center gap-1.5">
          {["#ffffff", "#000000", "#f2f2f2"].map((c) => (
            <button
              key={c} type="button"
              onClick={() => onBg({ mode: "solid", color: c })}
              className={`h-[18px] w-[18px] rounded-full border transition ${
                bgMode === "solid" && bgColor.toLowerCase() === c ? "border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color))]" : "border-border/70 hover:border-muted"
              }`}
              style={{ background: c }}
            />
          ))}
          <button
            ref={swatchRef} type="button" title={t("text.editColor")}
            onClick={() => setPickerOpen((v) => !v)}
            className="h-[18px] w-[18px] cursor-pointer rounded-full border border-border/70"
            style={{ background: swatchBg }}
          />
        </div>
        {pickerOpen && (
          <ColorPickerPopover
            anchorEl={swatchRef.current}
            onClose={() => setPickerOpen(false)}
            color={bgColor}
            onChange={(hex) => onBg({ ...bg, mode: "solid", color: hex })}
            presets={COLOR_SWATCHES}
            availableModes={["solid", "gradient"]}
            mode={bgMode}
            onModeChange={(m) => onBg({ ...bg, mode: m, gradient: bg?.gradient || DEFAULT_GRAD })}
            gradient={grad}
            onGradientChange={(patch) => onBg({ ...bg, mode: "gradient", gradient: { ...grad, ...patch } })}
          />
        )}
      </div>
    </div>
  );
}
