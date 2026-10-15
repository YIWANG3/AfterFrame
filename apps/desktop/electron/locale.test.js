const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocale } = require("./locale");

function setup(initial) {
  let settings = initial;
  const handlers = new Map();
  const sync = new Map();
  const changes = [];
  const locale = createLocale({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn), on: (c, fn) => sync.set(c, fn) },
    readAppSettings: () => settings,
    updateAppSettings: async (mutate) => { settings = mutate(settings); return settings; },
    onChange: (lng) => changes.push(lng),
  });
  return { locale, handlers, sync, changes, settings: () => settings };
}

test("starts from the saved locale, falling back to en for anything unsupported", () => {
  assert.equal(setup({ locale: "zh-CN" }).locale.current(), "zh-CN");
  assert.equal(setup({ locale: "fr" }).locale.current(), "en");
  assert.equal(setup({}).locale.current(), "en");
});

test("app:set-locale persists, notifies (menu rebuild) and answers the new value; unsupported values change nothing", async () => {
  const { locale, handlers, sync, changes, settings } = setup({ locale: "en" });
  assert.equal(await handlers.get("app:set-locale")({}, "zh-CN"), "zh-CN");
  assert.equal(locale.current(), "zh-CN");
  assert.equal(settings().locale, "zh-CN");
  assert.deepEqual(changes, ["zh-CN"]);
  assert.equal(await locale.applyLocale("de"), "zh-CN");
  assert.deepEqual(changes, ["zh-CN"]);
  const event = {};
  sync.get("app:get-locale")(event);
  assert.equal(event.returnValue, "zh-CN", "the synchronous read the preload makes at startup");
});
