// Copying photos as files: the allowlist gate, missing files, and the shape
// of the command each platform runs (the child itself is faked — the real
// pasteboard write is e2e/42's business).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { register, JXA_COPY_FILES } = require("./clipboard");

function fakeChild({ stdout = "", code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", stdout);
    child.emit("close", code);
  });
  return child;
}

function setup({ platform = "darwin", onDisk = [], allowed = () => true, child = () => fakeChild({ stdout: "ok\n" }) } = {}) {
  const handlers = new Map();
  const spawned = [];
  const written = [];
  register({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    clipboard: {
      writeText: (text) => written.push({ text }),
      writeBuffer: (format, buffer) => written.push({ format, buffer: buffer.toString("utf8") }),
    },
    allowlist: { isAllowedMediaPathLoaded: async (p) => allowed(p) },
    platform,
    spawn: (command, args, options) => { spawned.push({ command, args, options }); return child(); },
    fileExists: (p) => onDisk.includes(p),
  });
  const ask = (channel, ...args) => handlers.get(channel)(null, ...args);
  return { ask, spawned, written };
}

test("copy-text writes the text as given", async () => {
  const { ask, written } = setup();
  assert.equal(await ask("app:copy-text", "/a/b.jpg\n/a/c.jpg"), true);
  assert.deepEqual(written, [{ text: "/a/b.jpg\n/a/c.jpg" }]);
  await ask("app:copy-text", undefined);
  assert.equal(written[1].text, "");
});

test("macOS: osascript runs the JXA with the existing, allowed files as argv", async () => {
  const { ask, spawned } = setup({
    onDisk: ["/photos/a.jpg", "/photos/b.jpg", "/elsewhere/x.jpg"],
    allowed: (p) => !p.startsWith("/elsewhere/"),
  });
  const result = await ask("app:copy-files", ["/photos/a.jpg", "/photos/gone.jpg", "/elsewhere/x.jpg", "/photos/b.jpg", "/photos/a.jpg", 42, ""]);
  assert.deepEqual(result, { copied: ["/photos/a.jpg", "/photos/b.jpg"], missing: ["/photos/gone.jpg"] });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "osascript");
  assert.deepEqual(spawned[0].args, ["-l", "JavaScript", "-e", JXA_COPY_FILES, "/photos/a.jpg", "/photos/b.jpg"]);
  assert.match(JXA_COPY_FILES, /NSPasteboard\.generalPasteboard/);
  assert.match(JXA_COPY_FILES, /NSURL\.fileURLWithPath/);
  assert.match(JXA_COPY_FILES, /pasteboardItems/, "reads the items back so the promised data is on the board before exit");
  assert.equal(spawned[0].options.windowsHide, true);
});

test("nothing on disk: no child runs, the missing files are reported", async () => {
  const { ask, spawned } = setup({ onDisk: [] });
  assert.deepEqual(await ask("app:copy-files", ["/photos/a.jpg"]), { copied: [], missing: ["/photos/a.jpg"] });
  assert.deepEqual(await ask("app:copy-files", "not a list"), { copied: [], missing: [] });
  assert.equal(spawned.length, 0);
});

test("macOS: the script saying anything but ok, or failing, is an error", async () => {
  const refused = setup({ onDisk: ["/photos/a.jpg"], child: () => fakeChild({ stdout: "fail\n" }) });
  await assert.rejects(refused.ask("app:copy-files", ["/photos/a.jpg"]), /refused/);
  const crashed = setup({ onDisk: ["/photos/a.jpg"], child: () => fakeChild({ code: 1 }) });
  await assert.rejects(crashed.ask("app:copy-files", ["/photos/a.jpg"]), /exited 1/);
});

test("Windows: powershell.exe gets Set-Clipboard -LiteralPath as an encoded command with quoted literals", async () => {
  const files = ["C:\\Photos\\a.jpg", "D:\\照片\\it's.jpg"];
  const { ask, spawned } = setup({ platform: "win32", onDisk: files, child: () => fakeChild() });
  assert.deepEqual(await ask("app:copy-files", files), { copied: files, missing: [] });
  assert.equal(spawned[0].command, "powershell.exe");
  const args = spawned[0].args;
  assert.ok(args.includes("-NoProfile") && args.includes("-NonInteractive"));
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  assert.equal(script, "Set-Clipboard -LiteralPath @('C:\\Photos\\a.jpg','D:\\照片\\it''s.jpg')");
});

test("Linux: a text/uri-list goes through Electron's clipboard", async () => {
  const { ask, spawned, written } = setup({ platform: "linux", onDisk: ["/photos/a b.jpg", "/photos/c.jpg"] });
  await ask("app:copy-files", ["/photos/a b.jpg", "/photos/c.jpg"]);
  assert.equal(spawned.length, 0);
  assert.deepEqual(written, [{ format: "text/uri-list", buffer: "file:///photos/a%20b.jpg\r\nfile:///photos/c.jpg\r\n" }]);
});
