// Vertical tool switcher on the right edge of the editor. Presentational —
// owns no state; the parent passes the active tool + a single onSelect(toolKey)
// handler (which also resets the depth-map overlay for non-text tools).
// Extracted from EditorOverlay (Phase 4).

import { Crop, Type, Cannabis, Sparkles, Columns3, createLucideIcon } from "lucide-react";
import api from "../../../api";
import { LOCKED_HINT_KEY } from "../../DesktopOnly";

// The Frame tool: a photo in a frame with an info bar below it. (Lucide's
// Frame is a hash mark that reads as Crop next to it.)
const PhotoFrame = createLucideIcon("photo-frame", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", key: "frame" }],
  ["rect", { x: "7", y: "7", width: "10", height: "7", rx: "1", key: "photo" }],
  ["path", { d: "M8 17.5h4", key: "bar" }],
]);

// The LUT tool: the word in a rounded frame, a badge with the weight of the
// stroked icons around it. Photographers know "LUT"; no pictogram for a
// colour lookup reads as one (two overlapping circles read as "blend").
function LutGlyph() {
  return (
    <span className="flex h-[14px] items-center rounded-[3px] border-[1.4px] border-current px-[2.5px] text-[8px] font-bold leading-none tracking-[0.03em]">
      LUT
    </span>
  );
}

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
      {/* macOS only for now, and hidden rather than locked elsewhere
          (docs/lut-plan.md): the web build has no LUT library either. */}
      {api.can("lut") && api.has("listLuts") ? (
        <ToolTab active={tool === "lut"} icon={LutGlyph} label={t("overlay.tools.lut")} onClick={() => onSelect("lut")} />
      ) : null}
      <ToolTab active={tool === "split"} icon={Columns3} label={t("overlay.tools.split")} onClick={() => onSelect("split")} />
      <ToolTab active={tool === "text"} icon={Type} label={t("overlay.tools.text")} onClick={() => onSelect("text")} />
      <ToolTab active={tool === "frame"} icon={PhotoFrame} label={t("overlay.tools.frame")} onClick={() => onSelect("frame")} />
      {api.can("stickerExtract") ? (
        <ToolTab active={tool === "sticker"} icon={Cannabis} label={t("overlay.tools.sticker")} onClick={() => onSelect("sticker")} />
      ) : (
        <button
          type="button"
          className="flex h-8 w-8 cursor-default items-center justify-center rounded-md text-muted2/50"
          title={`${t("overlay.tools.sticker")} · ${t(LOCKED_HINT_KEY, { ns: "common" })}`}
        >
          <Cannabis className="h-4 w-4" />
        </button>
      )}
      {api.can("aiRepaint") ? (
        <ToolTab active={tool === "ai"} icon={Sparkles} label={t("overlay.tools.repaint")} onClick={() => onSelect("ai")} />
      ) : (
        <button
          type="button"
          className="flex h-8 w-8 cursor-default items-center justify-center rounded-md text-muted2/50"
          title={`${t("overlay.tools.repaint")} · ${t(LOCKED_HINT_KEY, { ns: "common" })}`}
        >
          <Sparkles className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
