// Frame tool panel — a preset picker. Clicking a preset instantiates it as
// editable LAYERS (text + logo) + canvas margins into the unified editor and
// switches to the Text tool, where it's dragged/resized/edited like anything
// else. The logo color + text/margin knobs are GENERATION options applied at
// the moment a preset is picked. Body only; the panel chrome is provided by
// EditorOverlay.

import { SliderRow } from "../../ui";

// Logo tint choices. `value: null` = 原色 (brand color where iconic, else
// frame-appropriate mono). Others force that color on the mark.
const LOGO_COLORS = [
  { label: "原色", value: null, swatch: "conic-gradient(from 210deg, #cc0011, #f47521, #b08d4c, #1a1a1a, #cc0011)" },
  { label: "黑", value: "#141414", swatch: "#141414" },
  { label: "白", value: "#ffffff", swatch: "#ffffff" },
  { label: "灰", value: "#9a9a9a", swatch: "#9a9a9a" },
  { label: "金", value: "#b08d4c", swatch: "#b08d4c" },
];

export default function FramePanel({ frameTool, onApplyPreset }) {
  const { templates, thumbs, cellAspect, logosReady,
    textScale, setTextScale, marginScale, setMarginScale, logoColor, setLogoColor } = frameTool;
  return (
    <div className="flex max-h-[calc(100vh-10rem)] flex-col">
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">预设</div>
        <div className="mb-2 px-1 text-[10.5px] leading-snug text-muted2/80">点击一个预设 → 作为图层加入,之后可自由拖动 / 缩放 / 改字</div>
        <div className="grid grid-cols-2 gap-2">
          {templates.map((tpl) => {
            const thumb = thumbs?.get?.(tpl.id);
            return (
              <button
                key={tpl.id}
                type="button"
                title={tpl.name}
                onClick={() => onApplyPreset?.(tpl)}
                style={{ aspectRatio: String(cellAspect || 0.8) }}
                className="grid place-items-center overflow-hidden rounded-lg p-1.5 transition hover:bg-hover"
              >
                {thumb
                  ? <img src={thumb} alt="" className="max-h-full max-w-full object-contain" />
                  : <div className="h-4 w-4 animate-pulse rounded-full bg-hover" />}
              </button>
            );
          })}
        </div>
        {!logosReady && <div className="mt-3 px-1 text-[11px] text-muted2">正在加载 logo…</div>}
      </div>
      <div className="border-t border-border/60 px-3 py-3">
        <div className="mb-3.5 flex items-center gap-2">
          <span className="min-w-[48px] text-[10px] text-muted2">标志</span>
          <div className="flex items-center gap-2">
            {LOGO_COLORS.map((c) => {
              const active = (c.value ?? null) === (logoColor ?? null);
              return (
                <button
                  key={c.label} type="button" title={c.label}
                  onClick={() => setLogoColor(c.value)}
                  className={`h-[18px] w-[18px] rounded-full border transition ${
                    active ? "border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color))]" : "border-border/70 hover:border-muted"
                  }`}
                  style={{ background: c.swatch }}
                />
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-3.5">
          <SliderRow compact label="文字" min={30} max={200} suffix="%" resetValue={100}
            value={Math.round(textScale * 100)} onChange={(v) => setTextScale(v / 100)} />
          <SliderRow compact label="留白" min={30} max={200} suffix="%" resetValue={100}
            value={Math.round(marginScale * 100)} onChange={(v) => setMarginScale(v / 100)} />
        </div>
      </div>
    </div>
  );
}
