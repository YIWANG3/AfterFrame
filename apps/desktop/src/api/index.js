// Flat facade over the bridge. The request/response methods are generated
// from shared/ipcChannels.mjs — declare a new one there and it exists here,
// in preload.js and in the two tests that keep the three aligned. Only the
// subscriptions, sync values and the one argument-reshaping method are
// written out below.

import { invoke, bridge } from "./client";
import { IPC_METHOD_NAMES } from "../../shared/ipcChannels.mjs";

const api = {
  get isPackaged() { return bridge().isPackaged; },
  // Capability check — facade methods always exist, so guards that previously
  // tested `window.mediaWorkspace?.method` must ask the bridge instead.
  has: (method) => typeof bridge()[method] === "function",
  // Coarse feature flags a bridge may declare (web bridge sets these); absent
  // on the desktop bridge, where every capability is implied by has().
  get capabilities() { return bridge().capabilities || {}; },
  // Capability gate for UI: hidden only when the bridge EXPLICITLY declares
  // the flag false — undeclared (desktop) means available.
  can: (flag) => !flag || bridge().capabilities?.[flag] !== false,

  // ── hand-written: not plain invokes ──
  deleteImageAssetsFromDisk: (...args) => invoke("deleteImageAssetsFromDisk", ...args),
  getPathForFile: (...args) => invoke("getPathForFile", ...args),
  getMediaServerPort: (...args) => invoke("getMediaServerPort", ...args),
  onFullscreen: (...args) => invoke("onFullscreen", ...args),
  onExternalImport: (...args) => invoke("onExternalImport", ...args),
  onAgentRevealAssets: (...args) => invoke("onAgentRevealAssets", ...args),
  sendAgentRevealResult: (...args) => invoke("sendAgentRevealResult", ...args),
  reportSelection: (...args) => invoke("reportSelection", ...args),
  onCatalogChanged: (...args) => invoke("onCatalogChanged", ...args),
  onAgentRender: (...args) => invoke("onAgentRender", ...args),
  sendAgentRenderResult: (...args) => invoke("sendAgentRenderResult", ...args),
  onMenuAction: (...args) => invoke("onMenuAction", ...args),
  onWatchedImport: (cb) => window.mediaWorkspace?.onWatchedImport?.(cb),
  getInitialLocale: (...args) => invoke("getInitialLocale", ...args),
};

for (const method of IPC_METHOD_NAMES) {
  api[method] = (...args) => invoke(method, ...args);
}

export default api;
