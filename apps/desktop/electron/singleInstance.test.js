const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { claimSingleInstance, launchPaths } = require("./singleInstance");

const photos = path.resolve("/photos");
const a = path.join(photos, "a.jpg");
const b = path.join(photos, "b.jpg");
const onDisk = new Set([a, b, photos]);
const exists = (file) => onDisk.has(file);

test("a launch names the files and folders after the executable, not switches or missing paths", () => {
  const argv = ["AfterFrame.exe", "--squirrel-firstrun", a, "b.jpg", path.join(photos, "gone.jpg"), photos];
  assert.deepEqual(launchPaths(argv, { cwd: photos, exists }), [a, b, photos]);
});

test("an unpackaged launch skips the app path too", () => {
  const argv = ["electron.exe", photos, "--remote-debugging-port=9222", a];
  assert.deepEqual(launchPaths(argv, { defaultApp: true, cwd: photos, exists }), [a]);
  assert.deepEqual(launchPaths(["electron.exe", "."], { defaultApp: true, exists: () => true }), []);
});

function fakeApp({ locked }) {
  const app = new EventEmitter();
  app.requests = [];
  app.requestSingleInstanceLock = (data) => {
    app.requests.push(data);
    return !locked;
  };
  return app;
}

test("macOS takes no lock", () => {
  const app = fakeApp({ locked: true });
  assert.equal(claimSingleInstance({ app, platform: "darwin", argv: ["AfterFrame"], onSecondInstance: () => {} }), true);
  assert.deepEqual(app.requests, []);
});

test("the first instance keeps the lock and gets each later launch's paths", () => {
  const app = fakeApp({ locked: false });
  const received = [];
  const first = claimSingleInstance({
    app, platform: "win32", argv: ["AfterFrame.exe"], onSecondInstance: (paths) => received.push(paths),
  });
  assert.equal(first, true);
  assert.deepEqual(app.requests, [{ paths: [] }]);

  app.emit("second-instance", {}, ["AfterFrame.exe", a], "C:\\", { paths: [a, 7] });
  app.emit("second-instance", {}, ["AfterFrame.exe"], "C:\\", null);
  assert.deepEqual(received, [[a], []]);
});

test("a later launch hands over its paths and is told to quit", () => {
  const app = fakeApp({ locked: true });
  const argv = ["AfterFrame.exe", path.relative(process.cwd(), __filename)];
  const first = claimSingleInstance({ app, platform: "win32", argv, onSecondInstance: () => assert.fail() });
  assert.equal(first, false);
  assert.deepEqual(app.requests, [{ paths: [__filename] }]);
  assert.equal(app.listenerCount("second-instance"), 0);
});
