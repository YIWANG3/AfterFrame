const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCatalogState, normalizeCatalogPath, resolveInitialCatalogPath } = require("./catalog");

const ROOT = "/repo";

test("normalizeCatalogPath: extension rules and relative resolution", () => {
  assert.equal(normalizeCatalogPath(ROOT, "/x/lib.afcatalog"), "/x/lib.afcatalog");
  assert.equal(normalizeCatalogPath(ROOT, "/x/old.mwcatalog"), "/x/old.afcatalog");
  assert.equal(normalizeCatalogPath(ROOT, "/x/typed"), "/x/typed.afcatalog");
  assert.equal(normalizeCatalogPath(ROOT, "data/scratch"), path.join(ROOT, "data", "scratch.afcatalog"));
  assert.equal(normalizeCatalogPath(ROOT, ""), null);
  assert.equal(normalizeCatalogPath(ROOT, null), null);
});

test("resolveInitialCatalogPath: precedence is no-default > env override > last-opened > scratch", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-catalog-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const last = path.join(dir, "last.afcatalog");
  fs.mkdirSync(last);
  const base = { env: {}, configuredCatalogPath: null, rootDir: ROOT, readAppSettings: () => ({ lastCatalogPath: last }), scratchCatalogPath: "/scratch" };

  assert.equal(resolveInitialCatalogPath({ ...base, env: { AFTERFRAME_NO_DEFAULT_CATALOG: "1" } }), null, "welcome-screen override wins over everything");
  assert.equal(resolveInitialCatalogPath({ ...base, configuredCatalogPath: "data/x" }), path.join(ROOT, "data", "x"), "env catalog beats last-opened");
  assert.equal(resolveInitialCatalogPath(base), last, "last-opened catalog is restored when it still exists");
  assert.equal(
    resolveInitialCatalogPath({ ...base, readAppSettings: () => ({ lastCatalogPath: path.join(dir, "gone.afcatalog") }) }),
    "/scratch",
    "a vanished last-opened catalog falls back to the scratch catalog",
  );
  assert.equal(
    resolveInitialCatalogPath({ ...base, readAppSettings: () => ({}), scratchCatalogPath: null }),
    null,
    "packaged builds have no default",
  );
});

test("createCatalogState: current path, db detection, sample identity, deps shapes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterframe-catalog-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userData = path.join(dir, "userData");
  const withDb = path.join(dir, "lib.afcatalog");
  fs.mkdirSync(withDb);
  fs.writeFileSync(path.join(withDb, "catalog.sqlite3"), "");
  const empty = path.join(dir, "empty.afcatalog");
  fs.mkdirSync(empty);

  const catalog = createCatalogState({
    rootDir: ROOT, sidecarSrc: "/repo/services/sidecar/src", isPackaged: true, configuredCatalogPath: withDb,
    env: {}, getUserDataDir: () => userData, readAppSettings: () => ({}),
  });

  assert.equal(catalog.path(), withDb);
  assert.equal(catalog.scratchCatalogPath, null, "packaged: no scratch catalog");
  assert.equal(catalog.hasDb(), true);
  assert.equal(catalog.hasDbAt(empty), false);
  assert.equal(catalog.hasDbAt(path.join(dir, "missing")), false);

  const state = catalog.state();
  assert.equal(state.currentCatalogPath, withDb);
  assert.equal(state.catalogHasDb(), true);

  catalog.set(empty);
  assert.equal(catalog.hasDb(), false);
  assert.equal(state.catalogHasDb(), false, "the function in an older state object reads the CURRENT path");
  assert.equal(catalog.info().catalogPath, empty);
  assert.equal(catalog.info().isSampleCatalog, false);

  assert.equal(catalog.samplePath(), path.join(userData, "afterframe", "sample.afcatalog"));
  catalog.set(catalog.samplePath());
  assert.equal(catalog.isSample(), true);
  catalog.set(null);
  assert.equal(catalog.path(), null);
  assert.equal(catalog.hasDb(), false);

  assert.equal(catalog.createAt(path.join(dir, "new")), path.join(dir, "new.afcatalog"));
  assert.ok(fs.existsSync(path.join(dir, "new.afcatalog")));
});
