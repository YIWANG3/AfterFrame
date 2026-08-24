// Vertical tool switcher on the right edge of the editor. Presentational —
// owns no state; the parent passes the active tool + a single onSelect(toolKey)
// handler (which also resets the depth-map overlay for non-text tools).
// Extracted from EditorOverlay (Phase 4).

import { Crop, Type, Cannabis, Sparkles } from "lucide-react";
import api from "../../../api";

function ToolTab({ active, icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      data-testid={`tool-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={[
        "flex h-8 w-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-[rgb(var(--accent-color)/0.16)] text-[rgb(var(--accent-color))]"
          : "text-muted2 hover:bg-hover hover:text-text",
      ].join(" ")}
      onClick={onClick}
      title={label}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export default function ToolRail({ tool, onSelect, t }) {
  return (
    <div
      className="pointer-events-auto flex w-12 flex-col items-center gap-2 rounded-xl border border-border/60 bg-chrome/95 p-1.5 shadow-overlay backdrop-blur-xl"
      data-editor-wheel-scope="toolbar"
    >
      <ToolTab active={tool === "crop"} icon={Crop} label={t("overlay.tools.crop")} onClick={() => onSelect("crop")} />
      <ToolTab active={tool === "text"} icon={Type} label={t("overlay.tools.text")} onClick={() => onSelect("text")} />
      <ToolTab active={tool === "sticker"} icon={Cannabis} label={t("overlay.tools.sticker")} onClick={() => onSelect("sticker")} />
      {api.can("aiRepaint") ? (
        <ToolTab active={tool === "ai"} icon={Sparkles} label={t("overlay.tools.repaint")} onClick={() => onSelect("ai")} />
      ) : (
        <button
          type="button"
          className="flex h-8 w-8 cursor-default items-center justify-center rounded-md text-muted2/50"
          title={`${t("overlay.tools.repaint")} · ${t("desktop.hint", { ns: "common" })}`}
        >
          <Sparkles className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
