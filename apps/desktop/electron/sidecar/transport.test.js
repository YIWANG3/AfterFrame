const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const os = require("node:os");
const { createSidecarTransport, devPython } = require("./transport");

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
      // Exited before the action runs: on POSIX through the job's SIGTERM
      // handler (9); Windows has no signals, so kill() ends it outright.
      if (process.platform === "win32") assert.equal(children[0].signalCode, "SIGTERM", "wait for the job's actual exit before deletion");
      else assert.equal(children[0].exitCode, 9, "wait for the job's actual exit before deletion");
      assert.equal(children[1].exitCode, null, "unrelated catalog job is untouched");
    });
    assert.equal(children.length, 2, "the killed job must not send fail-job into the rebuilt DB");
  } finally {
    await transport.withCatalogPaused("/sample.afcatalog", () => {});
    await transport.withCatalogPaused("/other.afcatalog", () => {});
  }
});

function recordingTransport(options = {}) {
  const calls = [];
  const transport = createSidecarTransport({
    rootDir: "/tmp", sidecarSrc: "/tmp/src", isPackaged: false, resourcesPath: "/res",
    getCatalogPath: () => "/sample.afcatalog",
    spawnProcess: (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => {};
      child.unref = () => {};
      child.pid = 4000 + calls.length;
      calls.push({ cmd, args, opts, child });
      return child;
    },
    ...options,
  });
  return { transport, calls };
}

test("a job runs below normal priority; the resident sidecar and one-shots keep the app's", async () => {
  const lowered = [];
  const { transport, calls } = recordingTransport({ setPriority: (pid, priority) => lowered.push([pid, priority]) });
  const pending = transport.callAsync(["summary"]); // the resident serve process
  calls[0].child.emit("exit", 1);                   // ...dies, so the call falls back to a one-shot
  calls[0].child.emit("close", 1);
  await new Promise((resolve) => setImmediate(resolve));
  calls[1].child.stdout.end(JSON.stringify({ ok: 1 }));
  calls[1].child.emit("close", 0);
  await pending;
  transport.launchJob(["run-import-job", "--job-id", "j1"]);
  assert.deepEqual(lowered, [[calls[2].child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
  assert.deepEqual(calls[2].args.slice(-3), ["run-import-job", "--job-id", "j1"]);
  transport.stopResident();
});

test("a job that is gone before its priority is set still runs its course", () => {
  const { transport, calls } = recordingTransport({ setPriority: () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); } });
  assert.doesNotThrow(() => transport.launchJob(["run-import-job", "--job-id", "j1"]));
  assert.equal(calls.length, 1);
});

test("every sidecar process gets UTF-8 pipes and no console window", async () => {
  const { transport, calls } = recordingTransport({ platform: "win32" });
  const pending = transport.callAsync(["summary"]);       // the resident serve process
  calls[0].child.emit("exit", 1);                          // ...dies, so the call falls back
  calls[0].child.emit("close", 1);
  await new Promise((resolve) => setImmediate(resolve));
  transport.launchJob(["run-import-job", "--job-id", "j1"]); // a detached runner
  assert.equal(calls.length, 3, "resident, one-shot fallback, detached job");
  for (const { opts } of calls) {
    assert.equal(opts.windowsHide, true);
    assert.equal(opts.env.PYTHONUTF8, "1");
    assert.equal(opts.env.PYTHONIOENCODING, "utf-8");
  }
  assert.equal(calls[2].opts.detached, true);
  calls[1].child.stdout.end(JSON.stringify({ ok: 1 }));
  calls[1].child.emit("close", 0);
  await pending;
  transport.stopResident();
});

test("the dev sidecar runs python on Windows, python3 elsewhere, AFTERFRAME_PYTHON over both", () => {
  assert.equal(devPython("win32", {}), "python", "python3 on Windows is the Microsoft Store stub");
  assert.equal(devPython("darwin", {}), "python3");
  assert.equal(devPython("linux", {}), "python3");
  assert.equal(devPython("win32", { AFTERFRAME_PYTHON: "C:\\venv\\Scripts\\python.exe" }), "C:\\venv\\Scripts\\python.exe");

  const { transport, calls } = recordingTransport({ platform: "win32" });
  transport.launchJob(["run-import-job", "--job-id", "j1"]);
  assert.equal(calls[0].cmd, devPython("win32", process.env));
  assert.deepEqual(calls[0].args.slice(0, 2), ["-m", "media_workspace"]);
});

test("the packaged sidecar is media-workspace.exe on Windows", () => {
  const packaged = (platform) => {
    const { transport, calls } = recordingTransport({ platform, isPackaged: true });
    transport.launchJob(["run-import-job", "--job-id", "j1"]);
    return calls[0].cmd;
  };
  assert.match(packaged("win32"), /media-workspace[\\/]media-workspace\.exe$/);
  assert.match(packaged("darwin"), /media-workspace[\\/]media-workspace$/);
});
