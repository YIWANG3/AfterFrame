// The inspector for an overlay (蒙层) layer: its paint and its coverage.

import { useTranslation } from "react-i18next";
import { PanelTop, PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { SliderRow } from "../../../ui";
import { normalizeScrim, OVERLAY_EDGES } from "../render/canvasHelpers";
import { Section } from "./controls";
import { PaintRow } from "./PaintRow";

const OVERLAY_EDGE_ICON = { bottom: PanelBottom, top: PanelTop, left: PanelLeft, right: PanelRight };

// One inspector for every overlay: the wash a frame preset ships with and the
// user's own 蒙层 are the same layer type, so both get paint (solid / multi-
// stop gradient) AND coverage (which edge it grows from + how far it reaches).
export default function OverlayLayerInspector({ layer, update }) {
  const { t } = useTranslation("editor");
  const s = normalizeScrim(layer);
  const updatePaint = (patch) => {
    const next = {};
    if (patch.mode !== undefined) next.mode = patch.mode;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.opacity !== undefined) next.opacity = Math.round(patch.opacity * 100);
    if (patch.gradient) next.gradient = { ...s.gradient, ...patch.gradient };
    update(layer.id, next);
  };
  const edgeBtn = (active) => [
    "flex h-6 w-6 items-center justify-center rounded border transition-colors",
    active
      ? "border-[rgb(var(--accent-color)/0.4)] bg-[rgb(var(--accent-color)/0.08)] text-[rgb(var(--accent-color))]"
      : "border-border/60 bg-app text-muted2 hover:bg-hover hover:text-text",
  ].join(" ");
  return (
    <>
      <Section label={t("text.overlaySettings")}>
        <PaintRow
          paint={{ mode: s.mode, color: s.color, opacity: s.opacity / 100, gradient: s.gradient }}
          availableModes={["solid", "gradient"]}
          multiStop
          onUpdate={updatePaint}
          opacityValue={s.opacity}
          onOpacityChange={(opacity) => update(layer.id, { opacity })}
        />
      </Section>
      <Section
        label={t("text.coverage")}
        right={(
          <div className="flex items-center gap-1" title={t("text.coverageEdge")}>
            {OVERLAY_EDGES.map((edge) => {
              const Icon = OVERLAY_EDGE_ICON[edge];
              return (
                <button
                  key={edge}
                  type="button"
                  title={t(`text.coverageEdges.${edge}`)}
                  aria-pressed={s.edge === edge}
                  className={edgeBtn(s.edge === edge)}
                  onClick={() => update(layer.id, { edge })}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              );
            })}
          </div>
        )}
      >
        <SliderRow
          label={t("text.coverage")}
          min={5}
          max={100}
          value={Math.round(s.coverage * 100)}
          onChange={(coverage) => update(layer.id, { coverage: coverage / 100 })}
          suffix="%"
        />
      </Section>
    </>
  );
}
