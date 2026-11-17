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
  return { zooms, isDestroyed: () => false, webContents: { setZoomFactor: (f) => zooms.push(f) } };
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
