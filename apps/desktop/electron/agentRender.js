// Render bridge: lets MCP tools run rendering INSIDE the renderer process,
// reusing the exact canvas code the UI exports with (collage, editor layers,
// frames) — zero duplicated compositors, pixel-identical output.
//
// Generalizes the revealAssetsInApp pattern (webContents.send + one-shot
// ipcMain.once on a per-request channel). Requests are serialized through a
// promise chain: canvas rendering competes with the UI for the renderer's main
// thread and for memory, so one at a time.

const crypto = require("node:crypto");

function createAgentRenderBridge({ BrowserWindow, ipcMain }) {
  let chain = Promise.resolve();

  function askRenderer(kind, payload, { timeoutMs = 120_000 } = {}) {
    const run = () =>
      new Promise((resolve, reject) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          reject(new Error("App window is not available — rendering tools need the AfterFrame window open."));
          return;
        }
        const requestId = crypto.randomUUID();
        const channel = `workspace:agent-render-result:${requestId}`;
        const timer = setTimeout(() => {
          ipcMain.removeAllListeners(channel);
          reject(new Error(`Renderer did not answer '${kind}' within ${timeoutMs / 1000}s.`));
        }, timeoutMs);
        ipcMain.once(channel, (_event, result) => {
          clearTimeout(timer);
          if (result && result.error) reject(new Error(result.error));
          else resolve(result);
        });
        win.webContents.send("workspace:agent-render", { requestId, kind, payload });
      });
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  }

  return { askRenderer };
}

module.exports = { createAgentRenderBridge };
