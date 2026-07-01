// Border/frame controls, shown inside the Text tool (no separate frame tool).
// Two parts:
//  1. Frame presets — click one to drop its text + logo layers and margins in,
//     ready to drag/edit (via onApplyPreset).
//  2. Manual border — a uniform "四边" slider (synced) with an optional per-edge
//     breakout, plus a background color. Margins are fractions of the photo's
//     short edge.

import { useState } from "react";

const BG_SWATCHES = [
  { label: "白", color: "#ffffff" },
  { label: "黑", color: "#000000" },
  { label: "浅灰", color: "#f2f2f2" },
];
const MAX_PAD = 0.4;
const EDGES = [["top", "上"], ["bottom", "下"], ["left", "左"], ["right", "右"]];

export default function BorderControls({ templates = [], thumbs, cellAspect, onApplyPreset, pad, onPad, bg, onBg }) {
  const [perEdge, setPerEdge] = useState(false);
  const p = pad || { top: 0, right: 0, bottom: 0, left: 0 };
  // Uniform value = the max edge (so the synced slider reflects a non-uniform pad).
  const uniform = Math.max(p.top || 0, p.right || 0, p.bottom || 0, p.left || 0);
  const bgColor = bg?.color || "#ffffff";

  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <div className="mb-1.5 text-[10px] text-muted2">预设</div>
        <div className="grid grid-cols-3 gap-1.5">
          {templates.map((tpl) => {
            const thumb = thumbs?.get?.(tpl.id);
            return (
              <button
                key={tpl.id} type="button" title={tpl.name}
                onClick={() => onApplyPreset?.(tpl)}
                style={{ aspectRatio: String(cellAspect || 0.8) }}
                className="grid place-items-center overflow-hidden rounded-md p-1 transition hover:bg-hover"
              >
                {thumb
                  ? <img src={thumb} alt="" className="max-h-full max-w-full object-contain" />
                  : <div className="h-3.5 w-3.5 animate-pulse rounded-full bg-hover" />}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between text-[10px] text-muted2">
          <span>边距</span>
          <button
            type="button"
            onClick={() => setPerEdge((v) => !v)}
            className={`rounded px-1.5 py-0.5 text-[10px] transition ${perEdge ? "bg-[rgb(var(--accent-color)/0.16)] text-[rgb(var(--accent-color))]" : "text-muted2 hover:bg-hover hover:text-text"}`}
          >
            各边
          </button>
        </div>
        {perEdge ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {EDGES.map(([edge, label]) => (
              <label key={edge} className="flex items-center gap-2 text-[11px] text-muted">
                <span className="w-3 shrink-0 text-muted2">{label}</span>
                <input
                  type="range" min="0" max={MAX_PAD} step="0.005"
                  value={p[edge] || 0}
                  onChange={(e) => onPad({ [edge]: Number(e.target.value) })}
                  className="min-w-0 flex-1"
                />
              </label>
            ))}
          </div>
        ) : (
          <input
            type="range" min="0" max={MAX_PAD} step="0.005"
            value={uniform}
            onChange={(e) => {
              const v = Number(e.target.value);
              onPad({ top: v, right: v, bottom: v, left: v });
            }}
            className="w-full"
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="min-w-[36px] text-[10px] text-muted2">底色</span>
        <div className="flex items-center gap-1.5">
          {BG_SWATCHES.map((s) => (
            <button
              key={s.color} type="button" title={s.label}
              onClick={() => onBg(s.color)}
              className={`h-[18px] w-[18px] rounded-full border transition ${
                bgColor.toLowerCase() === s.color ? "border-[rgb(var(--accent-color))] ring-1 ring-[rgb(var(--accent-color))]" : "border-border/70 hover:border-muted"
              }`}
              style={{ background: s.color }}
            />
          ))}
          <label className="relative h-[18px] w-[18px] cursor-pointer overflow-hidden rounded-full border border-border/70" title="自定义">
            <span className="absolute inset-0" style={{ background: "conic-gradient(red, orange, yellow, lime, cyan, blue, magenta, red)" }} />
            <input
              type="color" value={bgColor}
              onChange={(e) => onBg(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
