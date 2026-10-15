import { useTranslation } from "react-i18next";
import { SliderRow, Toggle } from "../../../ui";
import { Section } from "./controls";
import { StrokeFieldRow } from "./PaintRow";

/* Outer glow — shared by the text and sticker inspectors: stacked zero-offset
   colored blur; blur size rides the stroke-row width input, intensity = number
   of stacked passes. */
export default function GlowSection({ layer, update }) {
  const { t } = useTranslation("editor");
  return (
    <Section label={t("text.glow")} right={
      <Toggle on={layer.glow} onChange={() => update(layer.id, { glow: !layer.glow })} />
    }>
      {layer.glow && (
        <>
          <StrokeFieldRow
            paint={{
              mode: "solid",
              color: layer.glowColor || "#ffd76a",
              opacity: (layer.glowOpacity ?? 80) / 100,
              gradient: { from: "#fff", fromOpacity: 1, to: "#000", toOpacity: 1, angle: 90 },
            }}
            availableModes={["solid"]}
            onPaintUpdate={(patch) => {
              const next = {};
              if (patch.color !== undefined) next.glowColor = patch.color;
              if (patch.opacity !== undefined) next.glowOpacity = Math.round(patch.opacity * 100);
              if (Object.keys(next).length) update(layer.id, next);
            }}
            width={layer.glowBlur ?? 24}
            maxWidth={120}
            onWidthChange={(v) => update(layer.id, { glowBlur: v })}
          />
          <SliderRow
            label={t("text.glowIntensity")}
            min={1}
            max={4}
            value={layer.glowIntensity ?? 2}
            onChange={(v) => update(layer.id, { glowIntensity: v })}
          />
        </>
      )}
    </Section>
  );
}
