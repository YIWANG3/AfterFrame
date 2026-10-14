const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { register } = require("./nativeVideo");

function setup(allow = async () => true, platform = "darwin") {
  const handlers = new Map(), calls = [];
  const sender = new EventEmitter();
  Object.assign(sender, { id: 1, mainFrame: {}, getZoomFactor: () => 1.5 });
  const window = new EventEmitter();
  let simpleFullScreen = false;
  Object.assign(window, { webContents: sender, isDestroyed: () => false, isSimpleFullScreen: () => simpleFullScreen, getContentSize: () => [900, 600], getNativeWindowHandle: () => Buffer.alloc(8) });
  const addon = {
    open: (arg) => { calls.push(["open", arg]); return calls.length; },
    close: (arg) => calls.push(["close", arg]),
    command: (arg) => calls.push(["command", arg]),
    state: () => ({ ready: true, time: 1 }),
  };
  const app = new EventEmitter();
  const toggleFullscreen = () => { simpleFullScreen = !simpleFullScreen; };
  register({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: { fromWebContents: () => window }, app, allowlist: { isAllowedMediaPathLoaded: allow }, addonPath: "test.node", loadAddon: () => addon, toggleFullscreen, platform });
  const event = { sender, senderFrame: sender.mainFrame };
  const ask = (verb, ...args) => handlers.get(`app:native-video-${verb}`)(event, ...args);
  const fullscreen = () => handlers.get("app:video-fullscreen")(event);
  const restore = () => handlers.get("app:video-fullscreen-restore")(event);
  const request = (session) => ({ session, path: __filename, bounds: { x: 10, y: 20, width: 100, height: 80 } });
  return { ask, fullscreen, restore, calls, request, sender, event, app, window, toggleFullscreen };
}

test("original path is allowlisted before native open; renderer bounds respect zoom", async () => {
  const { ask, calls, request } = setup();
  assert.deepEqual(await ask("open", request("first")), { session: "first" });
  assert.equal(calls[0][1].path, __filename);
  assert.deepEqual(calls[0][1].bounds, { x: 15, y: 30, width: 150, height: 120 });
  assert.equal(await ask("command", "first", "seek", 4), true);
  assert.equal(calls.at(-1)[1].value, 4);
  await ask("close", "first");
  assert.equal(await ask("state", "first"), null);
});

test("switching clips ignores late commands and close from the old session", async () => {
  const { ask, calls, request, sender } = setup();
  await ask("open", request("first"));
  await ask("open", request("second"));
  const count = calls.length;
  assert.equal(await ask("command", "first", "play"), false);
  await ask("close", "first");
  assert.equal(calls.length, count);
  assert.deepEqual(await ask("state", "second"), { ready: true, time: 1 });
  sender.emit("destroyed");
  assert.equal(calls.at(-1)[0], "close");
});

test("closing while path validation is pending never starts playback", async () => {
  let allow;
  const { ask, calls, request } = setup(() => new Promise((resolve) => { allow = resolve; }));
  const opening = ask("open", request("first"));
  await ask("close", "first");
  allow(true);
  assert.equal(await opening, null);
  assert.equal(calls.length, 0);
});

test("untrusted frames, denied files and other platforms cannot open a native view", async () => {
  const denied = setup(async () => false);
  assert.equal(await denied.ask("open", denied.request("first")), null);
  assert.equal(denied.calls.length, 0);
  const frame = setup(); frame.event.senderFrame = {};
  assert.equal(await frame.ask("open", frame.request("first")), null);
  const other = setup(undefined, "win32");
  assert.equal(await other.ask("open", other.request("first")), null);
});

test("subframes cannot control or close an existing player", async () => {
  const { ask, request, event } = setup();
  await ask("open", request("first"));
  const trustedFrame = event.senderFrame;
  event.senderFrame = {};
  assert.equal(await ask("command", "first", "pause"), false);
  assert.equal(await ask("state", "first"), null);
  await ask("close", "first");
  event.senderFrame = trustedFrame;
  assert.deepEqual(await ask("state", "first"), { ready: true, time: 1 });
  await ask("close", "first");
});

test("player fullscreen uses the shell; the lightbox, not a clip change, restores it", async () => {
  const { ask, fullscreen, restore, request, window, toggleFullscreen } = setup();
  await ask("open", request("first"));
  assert.equal(await fullscreen(), true);
  assert.equal(window.isSimpleFullScreen(), true);
  // Stepping to the next clip closes the first player and stays fullscreen.
  await ask("close", "first");
  await ask("open", request("second"));
  assert.equal(window.isSimpleFullScreen(), true);
  assert.equal(await restore(), true);
  assert.equal(window.isSimpleFullScreen(), false);
  assert.equal(await restore(), false); // nothing left to restore
  toggleFullscreen(); // Opening from an already fullscreen app must preserve it.
  await fullscreen();
  assert.equal(window.isSimpleFullScreen(), false);
  await restore();
  assert.equal(window.isSimpleFullScreen(), true);
});

test("fullscreen works without a native player (the HTML fallback), never off macOS or from subframes", async () => {
  const { fullscreen, restore, window, event } = setup();
  assert.equal(await fullscreen(), true);
  assert.equal(window.isSimpleFullScreen(), true);
  await restore();
  assert.equal(window.isSimpleFullScreen(), false);
  const trustedFrame = event.senderFrame;
  event.senderFrame = {};
  assert.equal(await fullscreen(), false);
  event.senderFrame = trustedFrame;
  const other = setup(undefined, "win32");
  assert.equal(await other.fullscreen(), false);
  assert.equal(other.window.isSimpleFullScreen(), false);
});

test("a zero-sized surface hides the picture instead of refusing the bounds", async () => {
  const { ask, calls, request } = setup();
  assert.deepEqual(await ask("open", { ...request("first"), bounds: { x: 0, y: 0, width: 0, height: 0 } }), { session: "first" });
  assert.equal(await ask("command", "first", "bounds", { x: 10, y: 10, width: 0, height: 40 }), true);
  assert.deepEqual(calls.at(-1)[1].bounds, { x: 15, y: 15, width: 0, height: 60 });
  await assert.rejects(async () => ask("command", "first", "bounds", { x: 0, y: 0, width: -1, height: 10 }), /Invalid video bounds/);
});

test("navigation and app quit stop playback; malformed commands are refused", async () => {
  const { ask, calls, request, sender, app } = setup();
  await ask("open", request("first"));
  assert.equal(await ask("command", "first", "seek", NaN), false);
  assert.equal(await ask("command", "first", "unknown"), false);
  sender.emit("did-start-navigation", {}, "about:blank", false, true);
  assert.equal(calls.at(-1)[0], "close");
  await ask("open", request("second")); app.emit("before-quit");
  assert.equal(await ask("state", "second"), null);
});
