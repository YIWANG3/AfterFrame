// The editor's tools, in rail order. ToolRail renders this table; nothing
// else decides which buttons the rail shows or where. The rows come from two
// places — the tools still in the editor core below, and the feature modules
// (features/index.js `editorToolFeatures`, one row per manifest with an
// `editorTool`) — and RAIL_ORDER puts them in order. A row names the tool
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

import { Crop, Type, Columns3, createLucideIcon } from "lucide-react";
import { editorToolFeatures } from "../../../features/index.js";

// The Frame tool: a photo in a frame with an info bar below it. (Lucide's
// Frame is a hash mark that reads as Crop next to it.)
const PhotoFrame = createLucideIcon("photo-frame", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2", key: "frame" }],
  ["rect", { x: "7", y: "7", width: "10", height: "7", rx: "1", key: "photo" }],
  ["path", { d: "M8 17.5h4", key: "bar" }],
]);

// The tools still in the editor core; LUT, AI Repaint and the Sticker tool
// are feature modules.
const CORE_TOOLS = [
  { key: "crop", icon: Crop, labelKey: "overlay.tools.crop", cap: null, unavailable: null },
  { key: "split", icon: Columns3, labelKey: "overlay.tools.split", cap: null, unavailable: null },
  { key: "text", icon: Type, labelKey: "overlay.tools.text", cap: null, unavailable: null },
  { key: "frame", icon: PhotoFrame, labelKey: "overlay.tools.frame", cap: null, unavailable: null },
];

// Top to bottom. Every tool, core or feature, has its place here: a new
// feature adds its key, or the editor refuses to start.
const RAIL_ORDER = ["crop", "lut", "split", "text", "frame", "sticker", "ai"];

const byKey = new Map([...CORE_TOOLS, ...editorToolFeatures].map((row) => [row.key, row]));
const unplaced = [...byKey.keys()].filter((key) => !RAIL_ORDER.includes(key));
if (unplaced.length) throw new Error(`editorTools.js: no place on the rail for ${unplaced.join(", ")} — add it to RAIL_ORDER`);

export const EDITOR_TOOLS = RAIL_ORDER.map((key) => byKey.get(key)).filter(Boolean);
