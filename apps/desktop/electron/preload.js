const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Request/response methods come from one table (shared/ipcChannels.mjs).
// The preload is sandboxed and cannot require it, so main serves the rows
// synchronously — the same way it serves isPackaged and the locale below.
// Everything hand-written after the spread is a subscription, a sync value,
// or the one method that reshapes its arguments.
const invokers = {};
for (const [method, channel, arity] of ipcRenderer.sendSync("app:ipc-methods")) {
  invokers[method] = (...args) => ipcRenderer.invoke(channel, ...args.slice(0, arity));
}

// Files to import can arrive before the page listens: a launch with files
// (a dock drop that starts the app, or on Windows the files it was opened
// with) is sent as soon as the page has loaded, and the page subscribes only
// once its catalog has. Hold those for the first subscriber.
const externalImportListeners = new Set();
const earlyExternalImports = [];
ipcRenderer.on("workspace:external-import", (_event, paths) => {
  if (!externalImportListeners.size) earlyExternalImports.push(...paths);
  for (const listener of externalImportListeners) listener(paths);
});

contextBridge.exposeInMainWorld("mediaWorkspace", {
  ...invokers,
  // Resolve the absolute filesystem path of a dropped File (Electron 30+).
  // Gallery drag-and-drop uses this to translate `dataTransfer.files` entries
  // into paths the importer can ingest.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  // Listen for files dropped on the dock icon / Finder "Open With" / open-files,
  // or named by a second launch on Windows; ones that came early arrive first.
  onExternalImport: (callback) => {
    externalImportListeners.add(callback);
    if (earlyExternalImports.length) callback(earlyExternalImports.splice(0));
    return () => externalImportListeners.delete(callback);
  },
  // Agent (MCP) asked the app to reveal assets in the gallery. The renderer
  // answers on a per-request channel so the agent learns what was found.
  onAgentRevealAssets: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:agent-reveal-assets", listener);
    return () => ipcRenderer.removeListener("workspace:agent-reveal-assets", listener);
  },
  sendAgentRevealResult: (requestId, result) =>
    ipcRenderer.send(`workspace:agent-reveal-result:${requestId}`, result),
  // Render bridge: agent (MCP) asks the renderer to run a canvas render
  // (collage / edit recipe / frame) or open a view. Same per-request-channel
  // answer pattern as the reveal flow.
  onAgentRender: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:agent-render", listener);
    return () => ipcRenderer.removeListener("workspace:agent-render", listener);
  },
  sendAgentRenderResult: (requestId, result) =>
    ipcRenderer.send(`workspace:agent-render-result:${requestId}`, result),
  // Push selection changes to main so the MCP get_selection tool can answer
  // "these photos" instantly.
  reportSelection: (assets) => ipcRenderer.send("workspace:selection-changed", assets),
  // Agent write tools mutated the catalog — refresh the affected views.
  onCatalogChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("workspace:catalog-changed", listener);
    return () => ipcRenderer.removeListener("workspace:catalog-changed", listener);
  },
  isPackaged: ipcRenderer.sendSync("workspace:is-packaged"),
  // "darwin" | "win32" | "linux": picks the window shell (main.jsx adds
  // html.platform-<name>); feature availability goes through capabilities.
  platform: process.platform,
  // Features this platform lacks, declared false (see electron/capabilities.js).
  capabilities: (() => { try { return ipcRenderer.sendSync("app:capabilities"); } catch { return {}; } })(),
  onWatchedImport: (callback) => {
    const listener = (_event, paths) => callback(paths);
    ipcRenderer.on("workspace:watched-import", listener);
    return () => ipcRenderer.removeListener("workspace:watched-import", listener);
  },
  // Photos a watched folder reported that the catalog holds as they are on
  // disk (asset ids): nothing to import, but one shown missing came back.
  onWatchedPresent: (callback) => {
    const listener = (_event, assetIds) => callback(assetIds);
    ipcRenderer.on("workspace:watched-present", listener);
    return () => ipcRenderer.removeListener("workspace:watched-present", listener);
  },
  getMediaServerPort: () => { try { return ipcRenderer.sendSync("app:get-media-port"); } catch { return 0; } },
  // i18n: synchronous so the first render is already in the right language.
  getInitialLocale: () => { try { return ipcRenderer.sendSync("app:get-locale"); } catch { return "en"; } },
  onFullscreen: (cb) => { const h = (_e, flag) => cb(!!flag); ipcRenderer.on("window:fullscreen", h); return () => ipcRenderer.removeListener("window:fullscreen", h); },
  deleteImageAssetsFromDisk: (assetIds, paths) => ipcRenderer.invoke("workspace:delete-image-assets-from-disk", { assetIds, paths }),
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on("workspace:menu-action", listener);
    return () => ipcRenderer.removeListener("workspace:menu-action", listener);
  },
});

// vibepin (dev only): lets the annotate overlay grab pixel-perfect screenshots
// via the main process. Absent in packaged builds, where the overlay isn't injected.
if (process.env.VITE_DEV_SERVER_URL) {
  contextBridge.exposeInMainWorld("__vibepinCapture", (rect) =>
    ipcRenderer.invoke("annotate:capture", rect)
  );
}
