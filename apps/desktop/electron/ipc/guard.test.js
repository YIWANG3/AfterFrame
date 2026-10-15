const test = require("node:test");
const assert = require("node:assert/strict");
const { withCatalog, catalogRequired, requireCatalogPath, jobStatusHandler, sidecarQueries } = require("./guard");

const open = () => ({ currentCatalogPath: "/lib.afcatalog", catalogHasDb: () => true });
const empty = () => ({ currentCatalogPath: "/lib.afcatalog", catalogHasDb: () => false });
const none = () => ({ currentCatalogPath: null, catalogHasDb: () => false });

test("withCatalog: runs the handler with every argument when a catalog with a db is open", async () => {
  const seen = [];
  const handler = withCatalog(open, [], async (...args) => { seen.push(args); return "ran"; });
  assert.equal(await handler("event", { a: 1 }, 2), "ran");
  assert.deepEqual(seen, [["event", { a: 1 }, 2]]);
});

test("withCatalog: without a catalog the fallback answers — a value, a factory, or a rejection", async () => {
  assert.deepEqual(await withCatalog(none, [], () => "ran")(), []);
  assert.deepEqual(await withCatalog(empty, () => ({ fresh: true }), () => "ran")(), { fresh: true });
  await assert.rejects(withCatalog(none, catalogRequired("Open one."), () => "ran")(), /Open one\./);
  await assert.rejects(withCatalog(none, catalogRequired(), () => "ran")(), /Open a catalog first\./);
});

test("requireCatalogPath: the path, or an error naming which half is missing", () => {
  assert.equal(requireCatalogPath(open), "/lib.afcatalog");
  assert.throws(() => requireCatalogPath(none), /No catalog is open/);
  assert.throws(() => requireCatalogPath(empty), /empty \(no database yet\)/);
});

test("jobStatusHandler: the latest job, an empty status without a catalog or when the sidecar fails", async () => {
  const formatJobStatus = (job) => (job ? { jobId: job.id, running: true } : { jobId: null, running: false });
  const asked = [];
  const latestJobStatus = async (type) => {
    asked.push(type);
    if (type === "broken") throw new Error("sidecar down");
    return formatJobStatus({ id: `${type}-1` });
  };
  const deps = { getCatalogState: open, latestJobStatus, formatJobStatus };
  assert.deepEqual(await jobStatusHandler(deps, "import")(), { jobId: "import-1", running: true });
  assert.deepEqual(await jobStatusHandler(deps, "broken")(), { jobId: null, running: false });
  assert.deepEqual(await jobStatusHandler({ ...deps, getCatalogState: none }, "import")(), { jobId: null, running: false });
  assert.deepEqual(asked, ["import", "broken"], "no catalog: the sidecar is not asked");
});

test("sidecarQueries: guard, map the arguments, answer the fallback on a sidecar error or nothing to ask", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };
  const calls = [];
  const commands = {
    summary: async () => { calls.push(["summary"]); return null; },
    getAssetLocation: async (id) => { calls.push(["getAssetLocation", id]); return { lat: 1 }; },
    facetValues: async (view) => { calls.push(["facetValues", view]); throw new Error("boom"); },
  };
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    sidecarQueries(ipcMain, { commands, getCatalogState: open }, [
      ["workspace:summary", "summary", { total: 0 }, () => []],
      ["workspace:get-asset-location", "getAssetLocation", null, (id) => (id ? [id] : null)],
      ["workspace:facet-values", "facetValues", null],
    ]);
    assert.deepEqual([...handlers.keys()], ["workspace:summary", "workspace:get-asset-location", "workspace:facet-values"]);
    assert.deepEqual(await handlers.get("workspace:summary")("event"), { total: 0 }, "a null sidecar answer becomes the fallback");
    assert.deepEqual(await handlers.get("workspace:get-asset-location")("event", "a1"), { lat: 1 });
    assert.equal(await handlers.get("workspace:get-asset-location")("event", ""), null, "nothing to ask: no sidecar call");
    assert.equal(await handlers.get("workspace:facet-values")("event", { status: "all" }), null);
    assert.deepEqual(calls, [["summary"], ["getAssetLocation", "a1"], ["facetValues", { status: "all" }]]);
    assert.match(warned[0], /\[workspace:facet-values\] sidecar error: boom/);
  } finally {
    console.warn = warn;
  }
  const closed = new Map();
  sidecarQueries({ handle: (c, fn) => closed.set(c, fn) }, { commands, getCatalogState: none }, [["workspace:summary", "summary", { total: 0 }, () => []]]);
  assert.deepEqual(await closed.get("workspace:summary")("event"), { total: 0 });
  assert.equal(calls.length, 3, "no catalog: the sidecar is not asked");
});
