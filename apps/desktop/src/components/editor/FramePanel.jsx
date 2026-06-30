// Frame tool panel — template picker + export. Body only; the panel chrome
// (header) is provided by EditorOverlay, like the other tool panels.

import { Download, LoaderCircle } from "lucide-react";
import { SliderRow } from "../../ui";

export default function FramePanel({ frameTool }) {
  const { templates, templateId, setTemplateId, thumbs, cellAspect, logosReady, exporting, rendering, exportFramed,
    textScale, setTextScale, marginScale, setMarginScale } = frameTool;
  return (
    <div className="flex max-h-[calc(100vh-10rem)] flex-col">
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted2">预设</div>
        <div className="grid grid-cols-2 gap-2">
          {templates.map((tpl) => {
            const thumb = thumbs?.get?.(tpl.id);
            const active = tpl.id === templateId;
            return (
              <button
                key={tpl.id}
                type="button"
                title={tpl.name}
                onClick={() => setTemplateId(tpl.id)}
                // Uniform cells whose aspect adapts to the photo (so landscape
                // shots don't leave huge vertical gaps); contain-fit letterboxes
                // the rest. No border — selection is a subtle background tint.
                style={{ aspectRatio: String(cellAspect || 0.8) }}
                className={`grid place-items-center overflow-hidden rounded-lg p-1.5 transition ${
                  active ? "bg-[rgb(var(--accent-color)/0.18)]" : "hover:bg-hover"
                }`}
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
        <div className="mb-3.5 flex flex-col gap-3.5">
          <SliderRow compact label="文字" min={60} max={160} suffix="%" resetValue={100}
            value={Math.round(textScale * 100)} onChange={(v) => setTextScale(v / 100)} />
          <SliderRow compact label="留白" min={60} max={160} suffix="%" resetValue={100}
            value={Math.round(marginScale * 100)} onChange={(v) => setMarginScale(v / 100)} />
        </div>
        <button
          type="button"
          onClick={() => void exportFramed()}
          disabled={exporting || !logosReady}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[rgb(var(--accent-color))] px-4 py-2 text-[12.5px] font-semibold text-[#1a1407] disabled:opacity-50"
        >
          {exporting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          导出
        </button>
      </div>
    </div>
  );
}
