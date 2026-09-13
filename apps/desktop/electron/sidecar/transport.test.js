const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createSidecarTransport } = require("./transport");

function harness() {
  const children = [];
  const transport = createSidecarTransport({
    rootDir: "/tmp", sidecarSrc: "/tmp", isPackaged: false,
    getCatalogPath: () => "/sample.afcatalog",
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => { child.killed = true; };
      child.unref = () => {};
      children.push(child);
      return child;
    },
  });
  return { transport, children };
}

test("reset waits for resident exit, blocks new requests, and never retries old requests", async () => {
  const { transport, children } = harness();
  const pending = assert.rejects(transport.callAsync(["summary"]), /catalog switched or reset/);
  let removed = false;
  const reset = transport.withCatalogPaused("/sample.afcatalog", () => { removed = true; });
  await pending;
  assert.equal(children[0].killed, true);
  assert.equal(removed, false, "sending SIGTERM alone does not release SQLite handles");
  await assert.rejects(transport.callAsync(["summary"]), /reset in progress/);
  assert.throws(() => transport.launchJob(["run-import-job"]), /reset in progress/);
  assert.equal(children.length, 1, "no one-shot fallback may reopen the old catalog");
  children[0].emit("close");
  await reset;
  assert.equal(removed, true);
  const fresh = transport.callAsync(["summary"]);
  children[1].stdout.write(JSON.stringify({ id: 1, code: 0, stdout: "new catalog" }) + "\n");
  assert.equal(await fresh, "new catalog");
  transport.stopResident();
  children[1].emit("close");
});

test("reset also drains an already-running one-shot fallback", async () => {
  const { transport, children } = harness();
  const pending = transport.callAsync(["summary"]);
  children[0].emit("exit", 1);
  children[0].emit("close", 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2, "normal transport failures still use fallback");
  const rejected = assert.rejects(pending, /catalog switched or reset/);
  let removed = false;
  const reset = transport.withCatalogPaused("/sample.afcatalog", () => { removed = true; });
  assert.equal(children[1].killed, true);
  assert.equal(removed, false);
  children[1].emit("close", 0);
  await Promise.all([reset, rejected]);
  assert.equal(removed, true);
});

test("failed reset releases the pause so the catalog can be recovered", async () => {
  const { transport, children } = harness();
  await assert.rejects(transport.withCatalogPaused("/sample.afcatalog", () => {
    throw new Error("delete failed");
  }), /delete failed/);
  const pending = transport.callAsync(["summary"]);
  children[0].stdout.write(JSON.stringify({ id: 1, code: 0, stdout: "recovered" }) + "\n");
  assert.equal(await pending, "recovered");
  transport.stopResident();
  children[0].emit("close");
});

test("reset waits for detached jobs, suppresses their failure callbacks, and leaves other catalogs alone", async () => {
  const children = [];
  let catalogPath = "/sample.afcatalog";
  const transport = createSidecarTransport({
    rootDir: process.cwd(), sidecarSrc: process.cwd(), isPackaged: false,
    getCatalogPath: () => catalogPath,
    spawnProcess: (_cmd, _args, options) => {
      const child = spawn(process.execPath, ["-e", `
        process.on('SIGTERM', () => process.exit(9));
        setInterval(() => {}, 1000);
        process.stdout.write('ready');
      `], { ...options, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      return child;
    },
  });
  try {
    transport.launchJob(["run-import-job", "--job-id", "old-import"]);
    await once(children[0].stdout, "data");
    catalogPath = "/other.afcatalog";
    transport.launchJob(["run-import-job", "--job-id", "other-import"]);
    await once(children[1].stdout, "data");
    catalogPath = "/sample.afcatalog";
    await transport.withCatalogPaused(catalogPath, () => {
      assert.equal(children[0].exitCode, 9, "wait for the job's actual exit before deletion");
      assert.equal(children[1].exitCode, null, "unrelated catalog job is untouched");
    });
    assert.equal(children.length, 2, "the killed job must not send fail-job into the rebuilt DB");
  } finally {
    await transport.withCatalogPaused("/sample.afcatalog", () => {});
    await transport.withCatalogPaused("/other.afcatalog", () => {});
  }
});
