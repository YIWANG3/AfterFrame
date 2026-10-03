const test = require("node:test");
const assert = require("node:assert/strict");

const { windowChromeOptions, WIN_TITLEBAR_HEIGHT } = require("./windowChrome");
const { createAppShell } = require("./appShell");

const BIG_SCREEN = { width: 2560, height: 1415 };

test("macOS keeps the Tahoe shell exactly", () => {
  assert.deepEqual(windowChromeOptions("darwin", { workArea: BIG_SCREEN }), {
    width: 1440, height: 920, minWidth: 1080, minHeight: 720,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 16 },
    transparent: true,
    backgroundColor: "#00000000",
  });
});

test("Windows gets an opaque window with native caption buttons over the title strip", () => {
  const dark = windowChromeOptions("win32", { workArea: BIG_SCREEN });
  assert.equal(dark.titleBarStyle, "hidden");
  assert.equal(dark.transparent, undefined, "a transparent window can't be resized or snapped on Windows");
  assert.deepEqual(dark.titleBarOverlay, { color: "#00000000", symbolColor: "#f2f2f2", height: WIN_TITLEBAR_HEIGHT });
  assert.equal(dark.backgroundColor, "#060607");

  const light = windowChromeOptions("win32", { workArea: BIG_SCREEN, theme: "light" });
  assert.equal(light.titleBarOverlay.symbolColor, "#1d1d1f");
  assert.equal(light.backgroundColor, "#f4f4f5");
});

test("Linux keeps the native frame", () => {
  const linux = windowChromeOptions("linux", { workArea: BIG_SCREEN });
  assert.equal(linux.titleBarStyle, undefined);
  assert.equal(linux.transparent, undefined);
});

test("the window never exceeds the work area, including its minimum size", () => {
  // 1920x1080 at 150% scaling, taskbar excluded.
  const laptop = windowChromeOptions("win32", { workArea: { width: 1280, height: 672 } });
  assert.deepEqual(
    { width: laptop.width, height: laptop.height, minWidth: laptop.minWidth, minHeight: laptop.minHeight },
    { width: 1280, height: 672, minWidth: 1080, minHeight: 672 },
  );
  const tiny = windowChromeOptions("darwin", { workArea: { width: 1024, height: 640 } });
  assert.deepEqual([tiny.minWidth, tiny.minHeight, tiny.width, tiny.height], [1024, 640, 1024, 640]);
  // No screen information: the preferred sizes.
  assert.deepEqual([windowChromeOptions("win32").width, windowChromeOptions("win32").minHeight], [1440, 720]);
});

function menuTemplateFor(platform) {
  const shell = createAppShell({
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (template) => template },
    makeT: () => (key) => key,
    getLocale: () => "en",
    platform,
  });
  return shell.buildAppMenu();
}

test("the menu drops macOS-only roles off macOS, and the separators they leave", () => {
  const roles = (template) => template.flatMap((menu) => menu.submenu.map((item) => item.role).filter(Boolean));
  const macOnly = ["services", "hide", "hideOthers", "unhide", "zoom", "front"];

  const mac = menuTemplateFor("darwin");
  for (const role of macOnly) assert.ok(roles(mac).includes(role), `macOS keeps ${role}`);

  const win = menuTemplateFor("win32");
  for (const role of macOnly) assert.ok(!roles(win).includes(role), `Windows drops ${role}`);
  for (const menu of win) {
    const items = menu.submenu;
    assert.notEqual(items[0]?.type, "separator", `${menu.label} starts with a separator`);
    assert.notEqual(items.at(-1)?.type, "separator", `${menu.label} ends with a separator`);
    items.forEach((item, i) => assert.ok(!(item.type === "separator" && items[i - 1]?.type === "separator"), `${menu.label} has stacked separators`));
  }
  // The actions that only live in the menu are still there on Windows.
  const labels = win.flatMap((menu) => menu.submenu.map((item) => item.label));
  for (const key of ["menu.scratchCatalog", "menu.addRawSources", "menu.runEnrichment", "menu.generatePreviews", "menu.verifyFiles", "menu.quit", "menu.minimize"]) {
    assert.ok(labels.includes(key), `Windows menu keeps ${key}`);
  }
});

test("the caption-button theme call is a no-op off Windows", () => {
  const calls = [];
  const fakeWindow = { isDestroyed: () => false, setTitleBarOverlay: (o) => calls.push(o) };
  const make = (platform) => createAppShell({
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (t) => t, getApplicationMenu: () => null },
    makeT: () => (k) => k, getLocale: () => "en", platform,
  });
  assert.equal(make("darwin").setTitleBarTheme(fakeWindow, "light"), false);
  assert.equal(make("win32").setTitleBarTheme(fakeWindow, "light"), true);
  assert.deepEqual(calls, [{ color: "#00000000", symbolColor: "#1d1d1f" }]);
});
