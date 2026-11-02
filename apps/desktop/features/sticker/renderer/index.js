// What the sticker feature gives the renderer (features/index.js reads it by
// the manifest's id). The tool panel is a lazy chunk, loaded when the tool is
// first opened; the hooks, the canvas overlay and the library view are plain
// imports, as EditorOverlay and App call the hooks on every render.
import { lazy } from "react";
import { Cannabis } from "lucide-react";
import api from "../../../src/api";
import { localFileUrl } from "../../../src/utils/format";

// The editor tool (manifest `editorTool`).
export const Panel = lazy(() => import("./StickerPanel.jsx"));
export { useStickerTool as useTool } from "./useStickerTool";
export { default as Overlay } from "./StickerRegionOverlay.jsx";
export const icon = Cannabis;

// The Stickers library view (manifest `sidebarView`).
export { View, Inspector, useView } from "./StickerView.jsx";
export const sidebarIcon = Cannabis;

// The Text tool's "add sticker" picker (manifest `layerSource`): the
// library's entries, a thumbnail URL for one, and the picker button's icon.
export const layerSource = {
  icon: Cannabis,
  list: () => api.stickerList(),
  thumbUrl: (sticker) => localFileUrl(sticker.thumbPath || sticker.path),
};
