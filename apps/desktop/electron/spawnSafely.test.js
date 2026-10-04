const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { spawnSafely } = require("./spawnSafely");

// What child_process.spawn returns when it fails with EMFILE: no pipes, and
// an 'error' event on the next tick.
function failedSpawn(code) {
  return () => {
    const child = new EventEmitter();
    child.stdin = child.stdout = child.stderr = null;
    child.kill = () => true;
    process.nextTick(() => child.emit("error", Object.assign(new Error(`spawn x ${code}`), { code })));
    return child;
  };
}

test("a spawn without pipes throws an error the caller can handle, and its 'error' isn't uncaught", async () => {
  let uncaught = null;
  const onUncaught = (err) => { uncaught = err; };
  process.on("uncaughtException", onUncaught);
  try {
    assert.throws(() => spawnSafely(failedSpawn("EMFILE"), "/app/media-workspace", ["serve"]), /could not start media-workspace: no stdin\/stdout\/stderr/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(uncaught, null);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});

test("detached children with stdio ignored need no pipes", async () => {
  const child = spawnSafely(failedSpawn("EMFILE"), "/app/media-workspace", ["run-import-job"], { stdio: "ignore", detached: true });
  const seen = new Promise((resolve) => child.on("error", resolve));
  assert.equal((await seen).code, "EMFILE");
});

test("a real binary that doesn't exist fails without an uncaught exception", async () => {
  let child;
  try {
    child = spawnSafely(spawn, "/nonexistent/afterframe-tool", []);
  } catch (err) {
    assert.match(err.message, /could not start afterframe-tool/);
    return;
  }
  const err = await new Promise((resolve) => child.on("error", resolve));
  assert.equal(err.code, "ENOENT");
});
