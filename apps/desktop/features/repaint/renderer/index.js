// What the repaint feature gives the renderer (features/index.js reads it by
// the manifest's id). The panel is a plain import, not a lazy chunk: the
// editor keeps it mounted from the moment it opens (manifest `mount: "always"`),
// so a chunk would load on every editor open anyway.
import { Sparkles, Wand2 } from "lucide-react";

export { default as Panel } from "./AiRepaintPanel.jsx";
export { default as SettingsTab } from "./RepaintSettings.jsx";
export const icon = Sparkles;
export const settingsTabIcon = Wand2;
