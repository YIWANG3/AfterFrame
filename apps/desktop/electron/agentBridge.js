// The bridges between external agents (the MCP server) and the app window.
// Design doc: docs/agent-native-mcp.md.
//
// UI → agent: the renderer reports every selection change, so get_selection
//   answers "these photos" without a round trip.
// Agent → UI: broadcastCatalogChanged tells every window a write tool
//   mutated the catalog (the UI refreshes at once); revealAssetsInApp and
//   askRenderer send the window a request and wait for its answer on a
//   per-request channel, with a timeout so a tool call never hangs on the
//   UI. askRenderer runs rendering INSIDE the renderer — the exact canvas
//   code the UI exports with (collage, editor layers, frames), so there is
//   no second compositor to keep pixel-identical — and serializes requests:
//   canvas rendering competes with the UI for the renderer's main thread
//   and for memory, so one at a time.

const crypto = require("node:crypto");

const REVEAL_TIMEOUT_MS = 8_000;

function createAgentBridge({ BrowserWindow, ipcMain }) {
  let currentSelection = { assets: [], updatedAt: null };
  ipcMain.on("workspace:selection-changed", (_event, assets) => {
    currentSelection = { assets: Array.isArray(assets) ? assets : [], updatedAt: new Date().toISOString() };
  });

  const mainWindow = () => {
    const win = BrowserWindow.getAllWindows()[0];
    return win && !win.isDestroyed() ? win : null;
  };

  // Send `channel` with a fresh requestId; resolve with what the renderer
  // sends back on `${resultPrefix}:${requestId}`, or reject after timeoutMs.
  function ask(win, channel, resultPrefix, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const reply = `${resultPrefix}:${requestId}`;
      const timer = setTimeout(() => {
        ipcMain.removeAllListeners(reply);
        reject(new Error(`Renderer did not answer '${channel}' within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      ipcMain.once(reply, (_event, result) => {
        clearTimeout(timer);
        resolve(result);
      });
      win.webContents.send(channel, { requestId, ...payload });
    });
  }

  function broadcastCatalogChanged(scope, detail = {}) {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("workspace:catalog-changed", { scope, reason: "agent", ...detail });
    }
  }

  // Bring the window forward and have the renderer select and scroll to the
  // assets. Resolves with the renderer's ack ({found, missing}) or, after the
  // timeout, with acknowledged: false — never rejects.
  async function revealAssetsInApp(assetIds) {
    const win = mainWindow();
    if (!win) return { shown: false, error: "App window is not available." };
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    try {
      const result = await ask(win, "workspace:agent-reveal-assets", "workspace:agent-reveal-result", { assetIds }, REVEAL_TIMEOUT_MS);
      return { shown: true, acknowledged: true, ...result };
    } catch {
      return { shown: true, acknowledged: false, requested: assetIds };
    }
  }

  let chain = Promise.resolve();
  function askRenderer(kind, payload, { timeoutMs = 120_000 } = {}) {
    const run = async () => {
      const win = mainWindow();
      if (!win) throw new Error("App window is not available — rendering tools need the AfterFrame window open.");
      let result;
      try {
        result = await ask(win, "workspace:agent-render", "workspace:agent-render-result", { kind, payload }, timeoutMs);
      } catch {
        throw new Error(`Renderer did not answer '${kind}' within ${timeoutMs / 1000}s.`);
      }
      if (result && result.error) throw new Error(result.error);
      return result;
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return {
    askRenderer,
    revealAssetsInApp,
    broadcastCatalogChanged,
    getCurrentSelection: () => currentSelection,
    // Per-catalog: a selection must not survive a catalog switch.
    clearSelection: () => { currentSelection = { assets: [], updatedAt: null }; },
  };
}

module.exports = { createAgentBridge };
