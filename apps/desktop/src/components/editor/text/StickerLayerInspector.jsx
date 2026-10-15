// The inspector for a sticker layer: size and opacity, a handwriting
// sticker's re-editable fill, depth position, outline, shadow and glow.

import { useTranslation } from "react-i18next";
import { SliderRow, Toggle } from "../../../ui";
import { localFileUrl as mediaUrlFor } from "../../../utils/format";
import { handwritingAlphaFromUrl, colorizeHandwriting } from "../render/handwritingMatte";
import { Section } from "./controls";
import { PaintRow, StrokeFieldRow, ShadowFieldRow } from "./PaintRow";
import GlowSection from "./GlowSection";
import { mergeHandwritingPatch } from "./textPanelLogic";

// Handwriting stickers keep the raw black-on-white generation around, so fill
// is re-editable after placement: merge the PaintRow patch into the stored
// fill, re-colorize the memoized alpha, and swap the sticker's data URL.
//
// Color-picker drags fire per pointer event, and each run ends in a full-res
// PNG encode (toDataURL) — so runs are serialized per layer with latest-wins
// coalescing: while one encode is in flight, further patches just replace the
// pending one. Encode rate becomes "as fast as encoding allows", not per event.
const pendingHandwritingFill = new Map(); // layerId → { layer, patch, update }

async function applyHandwritingFill(layer, patch, update) {
  const id = layer.id;
  if (pendingHandwritingFill.has(id)) {
    const prev = pendingHandwritingFill.get(id);
    prev.layer = layer;
    prev.patch = mergeHandwritingPatch(prev.patch, patch);
    prev.update = update;
    return;
  }
  pendingHandwritingFill.set(id, { layer, patch, update });
  try {
    while (pendingHandwritingFill.has(id)) {
      const job = pendingHandwritingFill.get(id);
      pendingHandwritingFill.set(id, { ...job, patch: null });
      await runHandwritingFill(job.layer, job.patch, job.update);
      // Nothing new arrived during the run → done; otherwise loop with it.
      if (pendingHandwritingFill.get(id)?.patch == null) pendingHandwritingFill.delete(id);
    }
  } finally {
    pendingHandwritingFill.delete(id);
  }
}

async function runHandwritingFill(layer, patch, update) {
  const prev = layer.handwriting?.fill || { mode: "solid", color: "#ffffff" };
  const g = patch.gradient || {};
  const next = { ...prev };
  if (patch.mode !== undefined) next.mode = patch.mode;
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.opacity !== undefined) next.opacity = Math.round(patch.opacity * 100);
  for (const k of ["from", "fromOpacity", "to", "toOpacity", "angle"]) {
    if (g[k] !== undefined) next[k] = g[k];
  }
  if (next.mode === "gradient" && next.from === undefined) {
    Object.assign(next, { from: "#ffd76a", fromOpacity: 1, to: "#ff7a59", toOpacity: 1, angle: 90 });
  }
  const alpha = await handwritingAlphaFromUrl(mediaUrlFor(layer.handwriting.rawPath));
  if (!alpha) return;
  const canvas = colorizeHandwriting(alpha, next);
  update(layer.id, {
    stickerPath: canvas.toDataURL("image/png"),
    handwriting: { ...layer.handwriting, fill: next },
  });
}

export default function StickerLayerInspector({ layer, update, hasSceneDepth }) {
  const { t } = useTranslation("editor");
  const hasOutline = (layer.outlineWidth || 0) > 0;
  const hwFill = layer.handwriting?.fill;
  return (
    <>
      <Section label={t("text.transform")}>
        <SliderRow label={t("text.size")} min={2} max={200} value={Math.round((layer.scale ?? 0.4) * 100)} onChange={(v) => update(layer.id, { scale: v / 100 })} suffix="%" />
        <SliderRow label={t("text.opacity")} min={0} max={100} value={layer.opacity ?? 100} onChange={(v) => update(layer.id, { opacity: v })} suffix="%" />
      </Section>

      {/* Fill — handwriting stickers only: re-colorized from the cached raw
          generation, same controls as the text fill. */}
      {layer.handwriting?.rawPath && (
        <Section label={t("text.fill")}>
          <PaintRow
            paint={{
              mode: hwFill?.mode === "gradient" ? "gradient" : "solid",
              color: hwFill?.color ?? "#ffffff",
              opacity: (hwFill?.opacity ?? 100) / 100,
              gradient: {
                from: hwFill?.from ?? "#ffd76a",
                fromOpacity: hwFill?.fromOpacity ?? 1,
                to: hwFill?.to ?? "#ff7a59",
                toOpacity: hwFill?.toOpacity ?? 1,
                angle: hwFill?.angle ?? 90,
              },
            }}
            availableModes={["solid", "gradient"]}
            onUpdate={(patch) => { void applyHandwritingFill(layer, patch, update); }}
            opacityValue={layer.opacity ?? 100}
            onOpacityChange={(v) => update(layer.id, { opacity: v })}
          />
        </Section>
      )}

      {hasSceneDepth && (
        <Section label={t("text.depthPosition")}>
          <SliderRow min={0} max={100} value={Math.round((layer.zPosition ?? 1) * 100)} onChange={(v) => update(layer.id, { zPosition: v / 100 })} suffix="%" compact />
        </Section>
      )}

      {/* Outline — same shape as text Stroke (StrokeFieldRow handles both) */}
      <Section label={t("text.outline")} right={
        <Toggle on={hasOutline} onChange={() => update(layer.id, { outlineWidth: hasOutline ? 0 : 8 })} />
      }>
        {hasOutline && (
          <StrokeFieldRow
            paint={{
              mode: "solid",
              color: layer.outlineColor || "#ffffff",
              opacity: (layer.outlineOpacity ?? 100) / 100,
              gradient: { from: "#fff", fromOpacity: 1, to: "#000", toOpacity: 1, angle: 90 },
            }}
            availableModes={["solid"]}
            onPaintUpdate={(patch) => {
              const next = {};
              if (patch.color !== undefined) next.outlineColor = patch.color;
              if (patch.opacity !== undefined) next.outlineOpacity = Math.round(patch.opacity * 100);
              if (Object.keys(next).length) update(layer.id, next);
            }}
            width={layer.outlineWidth}
            maxWidth={200}
            onWidthChange={(v) => update(layer.id, { outlineWidth: v })}
          />
        )}
      </Section>

      <Section label={t("text.shadow")} right={
        <Toggle on={layer.shadow} onChange={() => update(layer.id, { shadow: !layer.shadow })} />
      }>
        {layer.shadow && (
          <ShadowFieldRow layer={layer} onChange={(patch) => update(layer.id, patch)} />
        )}
      </Section>

      <GlowSection layer={layer} update={update} />
    </>
  );
}
