const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { register, cacheDirs } = require("./appSettings");

function setup(initial = {}, { platform = "darwin", userData } = {}) {
  let settings = initial;
  const handlers = new Map();
  const opened = [];
  const menu = { installed: 0, accelerators: null };
  register({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    shell: { openPath: async (p) => { opened.push(p); } },
    getUserDataPath: () => userData || "/userData",
    readAppSettings: () => settings,
    updateAppSettings: async (mutate) => { settings = mutate(settings); return settings; },
    platform,
    installMenu: () => { menu.installed += 1; },
    setMenuAccelerators: (on) => { menu.accelerators = on; },
  });
  return { handlers, opened, menu, settings: () => settings };
}

test("open-cache-dir: creates and opens a known cache folder, refuses an unknown kind", async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "af-appsettings-"));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const { handlers, opened } = setup({}, { userData });
  assert.equal(await handlers.get("app:open-cache-dir")({}, "luts"), true);
  assert.deepEqual(opened, [path.join(userData, "afterframe", "luts")]);
  assert.ok(fs.existsSync(path.join(userData, "afterframe", "luts")));
  assert.equal(await handlers.get("app:open-cache-dir")({}, "etc"), false);
  assert.deepEqual(Object.keys(cacheDirs(userData)).sort(), ["depth", "luts", "renders", "stickers", "videoProxies"]);
});

test("preview settings: read the subtree, merge on save", async () => {
  const { handlers, settings } = setup({ previews: { generateHd: true } });
  assert.deepEqual(await handlers.get("app:get-preview-settings")(), { generateHd: true });
  assert.deepEqual(await handlers.get("app:save-preview-settings")({}, { analyzeColors: false }), { generateHd: true, analyzeColors: false });
  assert.deepEqual(settings().previews, { generateHd: true, analyzeColors: false });
  assert.deepEqual(await setup({}).handlers.get("app:get-preview-settings")(), {});
});

test("shortcuts: sanitized on the way in and out, saving reinstalls the menu", async () => {
  const { handlers, menu, settings } = setup({ shortcuts: { "photo.edit": ["Mod+KeyE"], bogus: 42 } });
  assert.deepEqual(await handlers.get("app:get-shortcuts")(), { "photo.edit": ["Mod+KeyE"] });
  const saved = await handlers.get("app:save-shortcuts")({}, { "photo.edit": ["KeyW"], nope: null });
  assert.deepEqual(saved, { "photo.edit": ["KeyW"] });
  assert.deepEqual(settings().shortcuts, { "photo.edit": ["KeyW"] });
  assert.equal(menu.installed, 1);
  assert.equal(await handlers.get("app:set-menu-accelerators")({}, false), true);
  assert.equal(menu.accelerators, false);
  await handlers.get("app:set-menu-accelerators")({}, undefined);
  assert.equal(menu.accelerators, true, "anything but false means on");
});
