// The editor's tools, in rail order. ToolRail renders this table; nothing
// else decides which buttons the rail shows or where. A row names the tool
// (the `tool` value EditorOverlay switches on), its icon, its label's i18n
// key in the editor namespace, and — when a bridge can turn the tool off
// (shared/capabilities.mjs) — the flag it needs and what the rail does
// without it:
//   "hidden"  the button disappears (LUT: macOS only for now, and hidden
//             rather than locked elsewhere, docs/lut-plan.md — Windows and
//             the web build declare lut false);
//   "locked"  the button stays, greyed, with the platform hint as its title.
// Capability names stay string literals: src/api/capabilities.test.js reads
// this file as text and holds every cap in it to the shared list.

import { createElement } from "react";
import { Crop, Type, Cannabis, Sparkles, Columns3, createLucideIcon } from "lucide-react";

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
  return createElement(
    "span",
    { className: "flex h-[14px] items-center rounded-[3px] border-[1.4px] border-current px-[2.5px] text-[8px] font-bold leading-none tracking-[0.03em]" },
    "LUT",
  );
}

export const EDITOR_TOOLS = [
  { key: "crop", icon: Crop, labelKey: "overlay.tools.crop", cap: null, unavailable: null },
  { key: "lut", icon: LutGlyph, labelKey: "overlay.tools.lut", cap: "lut", unavailable: "hidden" },
  { key: "split", icon: Columns3, labelKey: "overlay.tools.split", cap: null, unavailable: null },
  { key: "text", icon: Type, labelKey: "overlay.tools.text", cap: null, unavailable: null },
  { key: "frame", icon: PhotoFrame, labelKey: "overlay.tools.frame", cap: null, unavailable: null },
  { key: "sticker", icon: Cannabis, labelKey: "overlay.tools.sticker", cap: "stickerExtract", unavailable: "locked" },
  { key: "ai", icon: Sparkles, labelKey: "overlay.tools.repaint", cap: "aiRepaint", unavailable: "locked" },
];
