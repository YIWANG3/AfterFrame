const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { commandLineBatches, detectEditors, openOnWindows } = require("./editors");

// A Start menu as Windows lays it out, under a temp ProgramData and APPDATA:
// shortcuts at the top and in vendor folders, pointing at .exe files.
function startMenu() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-editors-"));
  const programs = (base) => path.join(root, base, "Microsoft", "Windows", "Start Menu", "Programs");
  const links = new Map();
  const exe = (name) => {
    const file = path.join(root, "Program Files", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    return file;
  };
  const shortcut = (base, rel, target) => {
    const file = path.join(programs(base), rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    links.set(file, target);
  };
  return {
    root, exe, shortcut,
    env: { ProgramData: path.join(root, "ProgramData"), APPDATA: path.join(root, "AppData") },
    readShortcutLink: (file) => {
      if (!links.has(file)) throw new Error("not a shortcut");
      return { target: links.get(file) };
    },
  };
}

test("Windows: editors are found by their Start menu shortcuts, the latest version first", () => {
  const menu = startMenu();
  try {
    const ps25 = menu.exe("Adobe/Adobe Photoshop 2025/Photoshop.exe");
    const ps26 = menu.exe("Adobe/Adobe Photoshop 2026/Photoshop.exe");
    const lrc = menu.exe("Adobe/Adobe Lightroom Classic/Lightroom.exe");
    const gimp = menu.exe("GIMP 2/bin/gimp-2.10.exe");
    const pixcake = menu.exe("PixCake/PixCake.exe");
    menu.shortcut("ProgramData", "Adobe Photoshop 2025.lnk", ps25);
    menu.shortcut("ProgramData", "Adobe Photoshop 2026.lnk", ps26);
    menu.shortcut("ProgramData", "Adobe/Adobe Lightroom Classic.lnk", lrc); // in a vendor folder
    menu.shortcut("ProgramData", "GIMP 2.10.38.lnk", gimp);
    menu.shortcut("ProgramData", "GIMP/Uninstall GIMP.lnk", menu.exe("GIMP 2/uninst/unins000.exe"));
    menu.shortcut("AppData", "像素蛋糕.lnk", pixcake); // a per-user install
    menu.shortcut("ProgramData", "Affinity Photo 2.lnk", path.join(menu.root, "gone", "Photo.exe")); // uninstalled
    menu.shortcut("ProgramData", "Adobe Lightroom Help.lnk", path.join(menu.root, "help.chm"));
    fs.writeFileSync(path.join(menu.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs", "desktop.ini"), "");

    const found = detectEditors({ platform: "win32", env: menu.env, readShortcutLink: menu.readShortcutLink });
    assert.deepEqual(Object.fromEntries(found.map((e) => [e.label, e.appPath])), {
      Photoshop: ps26,
      "Lightroom Classic": lrc,
      "像素蛋糕": pixcake,
      GIMP: gimp,
    });
  } finally {
    fs.rmSync(menu.root, { recursive: true, force: true });
  }
});

test("Windows: no Start menu, or no editors in it, finds nothing", () => {
  assert.deepEqual(detectEditors({ platform: "win32", env: {}, readShortcutLink: () => ({}) }), []);
});

test("a large selection goes to the editor in launches its command line can take", () => {
  const files = Array.from({ length: 5 }, (_, i) => `C:\\photos\\${String(i).padStart(3, "0")}.jpg`);
  assert.deepEqual(commandLineBatches("C:\\x.exe", files), [files]);
  const batches = commandLineBatches("C:\\x.exe", files, 60);
  assert.deepEqual(batches.flat(), files, "every file, once, in order");
  for (const batch of batches) {
    assert.ok(batch.length >= 1);
    assert.ok("C:\\x.exe".length + 3 + batch.reduce((n, f) => n + f.length + 3, 0) <= 60 || batch.length === 1);
  }
});

function fakeSpawn(outcome) {
  const calls = [];
  const spawnProcess = (cmd, args, options) => {
    const child = new EventEmitter();
    child.unref = () => {};
    calls.push({ cmd, args, options });
    setImmediate(() => (outcome === "error" ? child.emit("error", new Error("ENOENT")) : child.emit("spawn")));
    return child;
  };
  return { spawnProcess, calls };
}

test("Windows: the editor is started with the files, detached from the app", async () => {
  const { spawnProcess, calls } = fakeSpawn("spawn");
  const result = await openOnWindows("C:\\PS\\Photoshop.exe", ["C:\\a.jpg", "C:\\b.jpg"], spawnProcess);
  assert.deepEqual(result, { ok: true, count: 2 });
  assert.deepEqual(calls, [{ cmd: "C:\\PS\\Photoshop.exe", args: ["C:\\a.jpg", "C:\\b.jpg"], options: { detached: true, stdio: "ignore" } }]);
});

test("Windows: an editor that won't start is reported, not thrown", async () => {
  const { spawnProcess } = fakeSpawn("error");
  assert.deepEqual(await openOnWindows("C:\\gone.exe", ["C:\\a.jpg"], spawnProcess), { ok: false, error: "ENOENT" });
  const throwing = () => { throw new Error("EINVAL"); };
  assert.deepEqual(await openOnWindows("C:\\bad.exe", ["C:\\a.jpg"], throwing), { ok: false, error: "EINVAL" });
});
