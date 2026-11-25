const test = require("node:test");
const assert = require("node:assert/strict");
const { createUiScale, UI_SCALES } = require("./uiScale");

function setup(initial, windows = []) {
  let settings = initial;
  const handlers = new Map();
  const uiScale = createUiScale({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    readAppSettings: () => settings,
    updateAppSettings: async (mutate) => { settings = mutate(settings); return settings; },
    getWindows: () => windows,
  });
  return { uiScale, handlers, settings: () => settings };
}

function fakeWindow() {
  const zooms = [];
  const sent = [];
  return {
    zooms,
    sent,
    isDestroyed: () => false,
    webContents: { setZoomFactor: (f) => zooms.push(f), send: (channel, value) => sent.push([channel, value]) },
  };
}

test("starts from the saved scale, 100% for anything missing or not on the list", () => {
  assert.equal(setup({ uiScale: 0.9 }).uiScale.current(), 0.9);
  assert.equal(setup({ uiScale: 0.37 }).uiScale.current(), 1);
  assert.equal(setup({ uiScale: "big" }).uiScale.current(), 1);
  assert.equal(setup({}).uiScale.current(), 1);
});

test("the choices run from 80% to 125% and include 100%", () => {
  assert.deepEqual(UI_SCALES, [0.8, 0.9, 1, 1.1, 1.25]);
});

test("app:set-ui-scale persists, zooms every open window and answers the new value", async () => {
  const window = fakeWindow();
  const { handlers, settings } = setup({ locale: "zh-CN" }, [window]);
  assert.equal(await handlers.get("app:set-ui-scale")({}, 0.9), 0.9);
  assert.equal(settings().uiScale, 0.9);
  assert.equal(settings().locale, "zh-CN", "the other settings stay");
  assert.deepEqual(window.zooms, [0.9]);
  // and tells the page, which sizes the traffic-light gutters from it
  assert.deepEqual(window.sent, [["app:ui-scale", 0.9]]);
  assert.equal(await handlers.get("app:get-ui-scale")({}), 0.9);
});

test("a value not on the list changes nothing", async () => {
  const window = fakeWindow();
  const { handlers, settings } = setup({ uiScale: 1.1 }, [window]);
  assert.equal(await handlers.get("app:set-ui-scale")({}, 3), 1.1);
  assert.equal(settings().uiScale, 1.1);
  assert.deepEqual(window.zooms, []);
});

test("applyTo zooms a new window to the current scale and skips a closed one", () => {
  const { uiScale } = setup({ uiScale: 1.25 });
  const open = fakeWindow();
  uiScale.applyTo(open);
  assert.deepEqual(open.zooms, [1.25]);
  const closed = { ...fakeWindow(), isDestroyed: () => true };
  uiScale.applyTo(closed);
  assert.deepEqual(closed.zooms, []);
});

test("step moves one notch along the list, stays put at either end, and 0 goes back to 100%", async () => {
  const window = fakeWindow();
  const { uiScale, settings } = setup({ uiScale: 1 }, [window]);
  assert.equal(await uiScale.step(-1), 0.9);
  assert.equal(await uiScale.step(-1), 0.8);
  assert.equal(await uiScale.step(-1), 0.8, "already the smallest");
  assert.equal(await uiScale.step(0), 1);
  assert.equal(await uiScale.step(1), 1.1);
  assert.equal(await uiScale.step(1), 1.25);
  assert.equal(await uiScale.step(1), 1.25, "already the largest");
  assert.equal(settings().uiScale, 1.25);
  assert.deepEqual(window.zooms, [0.9, 0.8, 1, 1.1, 1.25], "no zoom call when nothing changes");
});

test("the number pad's + / - / 0 with the platform's modifier step the scale; other keys pass through", async () => {
  const { uiScale } = setup({ uiScale: 1 });
  const press = (input, platform) => {
    let prevented = false;
    uiScale.handleNumpad({ preventDefault: () => { prevented = true; } }, { type: "keyDown", ...input }, platform);
    return prevented;
  };
  assert.equal(press({ code: "NumpadSubtract", meta: true }, "darwin"), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(uiScale.current(), 0.9);
  assert.equal(press({ code: "NumpadAdd", control: true }, "win32"), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(uiScale.current(), 1);
  assert.equal(press({ code: "NumpadAdd", control: true }, "darwin"), false, "Ctrl is not the modifier on macOS");
  assert.equal(press({ code: "NumpadAdd" }, "win32"), false, "no modifier: the key types");
  assert.equal(press({ code: "KeyA", control: true }, "win32"), false);
  assert.equal(uiScale.current(), 1);
});
