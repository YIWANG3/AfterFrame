// The agent ↔ window bridge against a fake ipcMain / BrowserWindow: the
// per-request reply channel, the timeouts (reveal resolves, render rejects),
// render serialization, and the selection mirror.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createAgentBridge } = require("./agentBridge");

// A renderer that answers each request on its reply channel after `delayMs`,
// or never when `answer` returns undefined.
function fakeApp({ windows = 1, answer = () => ({}), delayMs = 0 } = {}) {
  const ipcMain = new EventEmitter();
  const sent = [];
  const win = {
    destroyed: false,
    minimized: true,
    restored: 0, shown: 0, focused: 0,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    restore() { this.restored += 1; this.minimized = false; },
    show() { this.shown += 1; },
    focus() { this.focused += 1; },
    webContents: {
      send(channel, message) {
        sent.push({ channel, message });
        const prefix = channel === "workspace:agent-reveal-assets" ? "workspace:agent-reveal-result" : "workspace:agent-render-result";
        const reply = answer(channel, message);
        if (reply === undefined) return;
        setTimeout(() => ipcMain.emit(`${prefix}:${message.requestId}`, {}, reply), delayMs);
      },
    },
  };
  const BrowserWindow = { getAllWindows: () => (windows ? [win] : []) };
  return { ipcMain, BrowserWindow, win, sent };
}

test("selection mirror: the renderer's reports are what get_selection reads; a catalog switch clears it", () => {
  const { ipcMain, BrowserWindow } = fakeApp();
  const bridge = createAgentBridge({ BrowserWindow, ipcMain });
  assert.deepEqual(bridge.getCurrentSelection(), { assets: [], updatedAt: null });
  ipcMain.emit("workspace:selection-changed", {}, [{ asset_id: "a" }]);
  assert.deepEqual(bridge.getCurrentSelection().assets, [{ asset_id: "a" }]);
  assert.ok(bridge.getCurrentSelection().updatedAt);
  ipcMain.emit("workspace:selection-changed", {}, "not a list");
  assert.deepEqual(bridge.getCurrentSelection().assets, []);
  bridge.clearSelection();
  assert.deepEqual(bridge.getCurrentSelection(), { assets: [], updatedAt: null });
});

test("broadcastCatalogChanged reaches every live window with the agent reason", () => {
  const { ipcMain, BrowserWindow, sent } = fakeApp({ answer: () => undefined });
  createAgentBridge({ BrowserWindow, ipcMain }).broadcastCatalogChanged("assets", { ids: ["a"] });
  assert.deepEqual(sent, [{ channel: "workspace:catalog-changed", message: { scope: "assets", reason: "agent", ids: ["a"] } }]);
});

test("revealAssetsInApp: brings the window forward, resolves with the renderer's ack, or acknowledged:false on timeout", async () => {
  const answered = fakeApp({ answer: (_c, m) => ({ found: m.assetIds, missing: [] }) });
  const bridge = createAgentBridge(answered);
  assert.deepEqual(await bridge.revealAssetsInApp(["a", "b"]), { shown: true, acknowledged: true, found: ["a", "b"], missing: [] });
  assert.deepEqual([answered.win.restored, answered.win.shown, answered.win.focused], [1, 1, 1]);
  assert.equal(answered.sent[0].channel, "workspace:agent-reveal-assets");
  assert.deepEqual(answered.sent[0].message.assetIds, ["a", "b"]);
  assert.ok(answered.sent[0].message.requestId);

  const silent = fakeApp({ answer: () => undefined });
  const t0 = Date.now();
  // The timeout is 8 s; the reply channel is dropped when it fires, so the
  // late answer below is not left dangling. Fire the timer early.
  const setTimeoutReal = global.setTimeout;
  global.setTimeout = (fn) => setTimeoutReal(fn, 0);
  try {
    const result = await createAgentBridge(silent).revealAssetsInApp(["x"]);
    assert.deepEqual(result, { shown: true, acknowledged: false, requested: ["x"] });
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    global.setTimeout = setTimeoutReal;
  }
  assert.equal(silent.ipcMain.listenerCount(`workspace:agent-reveal-result:${silent.sent[0].message.requestId}`), 0, "the reply listener is removed on timeout");

  const noWindow = fakeApp({ windows: 0 });
  assert.deepEqual(await createAgentBridge(noWindow).revealAssetsInApp(["x"]), { shown: false, error: "App window is not available." });
});

test("askRenderer: one request at a time, the renderer's error becomes a rejection, no window rejects", async () => {
  const order = [];
  const app = fakeApp({
    delayMs: 5,
    answer: (_c, m) => {
      order.push(`start:${m.kind}`);
      return m.kind === "bad" ? { error: "cannot draw that" } : { ok: m.kind };
    },
  });
  const bridge = createAgentBridge(app);
  const first = bridge.askRenderer("collage", { files: [] });
  const second = bridge.askRenderer("bad", {});
  const third = bridge.askRenderer("frame", {});
  assert.deepEqual(await first, { ok: "collage" });
  await assert.rejects(second, /cannot draw that/);
  assert.deepEqual(await third, { ok: "frame" });
  assert.deepEqual(order, ["start:collage", "start:bad", "start:frame"], "the next request starts only after the previous answered");
  assert.equal(app.sent[0].channel, "workspace:agent-render");
  assert.deepEqual(app.sent[0].message.payload, { files: [] });

  await assert.rejects(createAgentBridge(fakeApp({ windows: 0 })).askRenderer("collage", {}), /window is not available/);
});
