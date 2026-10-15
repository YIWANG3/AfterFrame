const test = require("node:test");
const assert = require("node:assert/strict");
const { listSystemFonts, register } = require("./systemFonts");

test("macOS: the AppKit families, one per line, blank lines dropped", async () => {
  const ran = [];
  const run = async (command, options) => { ran.push({ command, options }); return { stdout: "Avenir\nHelvetica\n\nPingFang SC\n" }; };
  assert.deepEqual(await listSystemFonts({ platform: "darwin", run }), ["Avenir", "Helvetica", "PingFang SC"]);
  assert.match(ran[0].command, /^osascript -l JavaScript/);
  assert.equal(ran[0].options.timeout, 10000);
});

test("Windows: PowerShell's CRLF lines, with the console window hidden", async () => {
  const ran = [];
  const run = async (command, options) => { ran.push({ command, options }); return { stdout: "Arial\r\nSegoe UI\r\n" }; };
  assert.deepEqual(await listSystemFonts({ platform: "win32", run }), ["Arial", "Segoe UI"]);
  assert.match(ran[0].command, /^powershell -Command/);
  assert.equal(ran[0].options.windowsHide, true);
});

test("other platforms and a failed command answer an empty list", async () => {
  let asked = 0;
  const run = async () => { asked += 1; throw new Error("spawn ENOENT"); };
  assert.deepEqual(await listSystemFonts({ platform: "linux", run }), []);
  assert.equal(asked, 0, "nothing is run where no command is known");
  assert.deepEqual(await listSystemFonts({ platform: "darwin", run }), []);
  assert.equal(asked, 1);
});

test("registers the one channel", async () => {
  const handlers = new Map();
  register({ ipcMain: { handle: (c, fn) => handlers.set(c, fn) }, platform: "darwin", run: async () => ({ stdout: "A\n" }) });
  assert.deepEqual(await handlers.get("workspace:list-system-fonts")(), ["A"]);
});
