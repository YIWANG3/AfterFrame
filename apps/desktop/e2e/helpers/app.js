// Helpers for launching the Electron app with isolated state.
// Each test gets a fresh userData dir under e2e/.artifacts/ so we don't
// touch the user's real catalog / settings / sticker library.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { _electron: electron } = require("@playwright/test");
const { devPython } = require("../../electron/sidecar/transport");
const { desktopCapabilities } = require("../../electron/capabilities");
const { splitsImport } = require("../../electron/importDialog");

// On Windows %TEMP% can be an 8.3 short path (C:\Users\ADMINI~1\…, as on
// GitHub's runners). The sidecar stores paths in their long form, so a path a
// spec builds from os.tmpdir() wouldn't equal the one the app reports. Use the
// long form here and in the app this launches.
if (process.platform === "win32") {
  try { process.env.TEMP = process.env.TMP = fs.realpathSync.native(os.tmpdir()); } catch { /* keep it */ }
}

// A feature this platform's build locks ("macOS for now", electron/capabilities.js):
// its specs skip there instead of failing on a control that is meant to be off.
const lacks = (feature) => desktopCapabilities(process.platform)[feature] === false;

// Selects the cards (and anything else) carrying this file's path. In a CSS
// string a backslash starts an escape, so Windows paths need theirs doubled.
const byImagePath = (file) => `[data-image-path='${file.replace(/[\\']/g, "\\$&")}']`;

// Toolbar + › Import, the native picker answering with `paths`: an import the
// way a user starts one. Windows and Linux split the entry into Import Files…
// and Import Folder…, since their pickers can't take both (#123).
async function importThroughToolbar(app, window, paths) {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: picked });
  }, paths);
  const folders = paths.every((p) => fs.statSync(p).isDirectory());
  const entry = !splitsImport(process.platform) ? "Import" : folders ? "Import Folder…" : "Import Files…";
  await window.locator(".app-toolbar button").first().click();
  await window.getByRole("button", { name: entry, exact: true }).click();
}

const REPO_DESKTOP_DIR = path.resolve(__dirname, "..", "..");
const SEEDED_CATALOG = path.resolve(__dirname, "..", "fixtures", "test-catalog.afcatalog");
// People-recognition fixture: AI-generated fictional people with real faces,
// embeddings and person groups pre-baked (seed-people-catalog.js), so the
// specs exercise people flows without any Core ML model at runtime.
const SEEDED_PEOPLE_CATALOG = path.resolve(__dirname, "..", "fixtures", "people-catalog.afcatalog");

/**
 * Launch the packaged-style Electron app pointing at a temp userData dir.
 * @param {object} opts
 * @param {string} [opts.testName] - used to prefix the temp dir for debugging
 * @param {boolean} [opts.withCatalog=true] - load the seeded e2e catalog
 *   (10 gradient images). Set false for tests that want a blank-state app.
 * @param {"default"|"people"} [opts.catalogFixture="default"] - which seeded
 *   catalog to copy in; "people" loads people-catalog.afcatalog.
 * @param {(catalogDir: string) => void} [opts.prepareCatalog] - runs against
 *   the private working copy before Electron starts — for specs that need the
 *   fixture in a specific state (e.g. HD previews stripped so lazy generation
 *   is exercised).
 * @param {string} [opts.reuseUserDataDir] - reuse an isolated E2E directory to
 *   exercise app restart and saved-catalog migrations; use withCatalog: false.
 * @param {object} [opts.env] - extra environment for the app, e.g. { TZ }.
 * @returns {Promise<{ app: import('playwright').ElectronApplication, window: import('playwright').Page, userDataDir: string }>}
 */
// Each launch gets its own MCP port: the dev app holds the default 41706, and
// a port collision is silently swallowed by the server (EADDRINUSE → no MCP),
// which would make MCP-dependent specs flake in confusing ways.
let nextMcpPort = 42100 + (Number(process.env.TEST_WORKER_INDEX) || 0) * 50;

// Coverage run (npm run coverage / e2e:coverage): the renderer is an istanbul build
// (vite.config.js), the main process writes V8 coverage on exit, and the dev
// sidecar runs under Python coverage. Everything lands in .coverage/ and
// scripts/e2e-coverage.mjs turns it into one report.
const COVERAGE = process.env.AFTERFRAME_COVERAGE === "1";
const COVERAGE_DIR = path.resolve(REPO_DESKTOP_DIR, ".coverage");
function coverageEnv() {
  if (!COVERAGE) return {};
  for (const sub of ["main", "renderer", "sidecar"]) fs.mkdirSync(path.join(COVERAGE_DIR, sub), { recursive: true });
  return {
    NODE_V8_COVERAGE: path.join(COVERAGE_DIR, "main"),
    AFTERFRAME_SIDECAR_COVERAGE: path.join(COVERAGE_DIR, "sidecar"),
    AFTERFRAME_SIDECAR_COVERAGE_PYLIB: path.resolve(REPO_DESKTOP_DIR, ".coverage-tools", "pylib"),
  };
}

// Pull window.__coverage__ out of every renderer window. Must run BEFORE the
// app closes (the counters live in the page); a no-op on normal runs and on
// pages that were never instrumented.
async function collectCoverage(app) {
  if (!COVERAGE) return;
  for (const page of app.windows()) {
    try {
      const json = await page.evaluate(() => (window.__coverage__ ? JSON.stringify(window.__coverage__) : null));
      if (!json) continue;
      const name = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`;
      fs.writeFileSync(path.join(COVERAGE_DIR, "renderer", name), json);
    } catch (_) { /* window already gone */ }
  }
}

async function launchApp({ testName = "e2e", withCatalog = true, noCatalog = false, catalogFixture = "default", prepareCatalog, reuseUserDataDir, keepCatalog = false, peopleModel = "none", env: extraEnv = {} } = {}) {
  // Fresh userData so each run starts from a clean slate
  if (reuseUserDataDir && (!path.basename(reuseUserDataDir).startsWith("afterframe-e2e-")
    || fs.realpathSync(path.dirname(reuseUserDataDir)) !== fs.realpathSync(os.tmpdir()))) {
    throw new Error("Only an isolated E2E userData directory can be reused");
  }
  const userDataDir = reuseUserDataDir || fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${testName}-`));
  const mcpPort = nextMcpPort++;

  const env = {
    ...process.env,
    AFTERFRAME_USER_DATA: userDataDir,
    AFTERFRAME_MCP_PORT: String(mcpPort),
    AFTERFRAME_SIDECAR_TRACE: "1",
    NODE_ENV: "test",
    ...coverageEnv(),
    ...extraEnv,
  };
  // Production tests must not accidentally attach to an inherited Vite URL.
  delete env.VITE_DEV_SERVER_URL;
  if (reuseUserDataDir) {
    delete env.MEDIA_WORKSPACE_CATALOG;
    delete env.AFTERFRAME_NO_DEFAULT_CATALOG;
  }

  // Simulate packaged first-run (no default catalog) — exercises the
  // no-catalog welcome state, which dev's scratch catalog would otherwise hide.
  if (noCatalog) env.AFTERFRAME_NO_DEFAULT_CATALOG = "1";

  // The bundled face model, independent of whether this checkout fetched it:
  // "none" (default) = a build without it, "stub" = an empty package that
  // satisfies the UI but can't run a scan, "real" = native/ as fetched.
  if (peopleModel !== "real") {
    const modelPath = path.join(userDataDir, "bundled-people-model", "FaceEmbedding.mlpackage");
    if (peopleModel === "stub") {
      fs.mkdirSync(modelPath, { recursive: true });
      fs.writeFileSync(path.join(modelPath, "Manifest.json"), "{}");
    }
    env.AFTERFRAME_BUNDLED_PEOPLE_MODEL = modelPath;
  }

  // Copy the seeded catalog into a tmp dir so save/import tests can't
  // contaminate the version-controlled fixture between runs.
  let workCatalog = null;
  if (withCatalog && !noCatalog) {
    const seeded = catalogFixture === "people" ? SEEDED_PEOPLE_CATALOG : SEEDED_CATALOG;
    workCatalog = path.join(userDataDir, path.basename(seeded));
    // keepCatalog: a relaunch that must see what the previous run wrote to the
    // catalog (with reuseUserDataDir). Without it every launch starts from the
    // seeded fixture again.
    if (!(keepCatalog && fs.existsSync(workCatalog))) {
      fs.cpSync(seeded, workCatalog, { recursive: true });
      relocateFixturePaths(workCatalog);
      prepareCatalog?.(workCatalog);
    }
    env.MEDIA_WORKSPACE_CATALOG = workCatalog;
  }

  const app = await electron.launch({
    // Exercise the actual .app / ASAR when requested, including packaged
    // Worker URLs and sidecar resources rather than only dist on disk.
    ...(process.env.AFTERFRAME_E2E_EXECUTABLE
      ? { executablePath: path.resolve(process.env.AFTERFRAME_E2E_EXECUTABLE), args: [] }
      : { args: [REPO_DESKTOP_DIR] }),
    cwd: REPO_DESKTOP_DIR,
    env,
  });
  const window = await app.firstWindow();
  captureAppLogs(app, window, testName);
  return { app, window, userDataDir, catalogDir: workCatalog, mcpPort };
}

// The seeded catalogs were built on one machine and store absolute source
// paths (assets, roots, registry…). On any other checkout — CI lives under
// /Users/runner/work — every asset reads "Missing" and nothing that needs
// the original (HD previews, save, lightbox zoom, RAW dims) can run; the
// previews shipped with the fixture hid this. Rewrite the fixtures-dir
// prefix to this checkout before the app opens the copy.
const PATH_COLUMNS = [
  ["catalog_roots", "path"],
  ["assets", "canonical_path"],
  ["asset_files", "path"],
  ["raw_metadata_cache", "path"],
  ["image_lookup_registry", "image_path"],
  ["deleted_files", "path"],
];
function relocateFixturePaths(catalogDir) {
  const db = path.join(catalogDir, "catalog.sqlite3");
  if (!fs.existsSync(db)) return;
  const seededRoot = execFileSync("sqlite3", [db, "SELECT path FROM catalog_roots ORDER BY path LIMIT 1"]).toString().trim();
  // The fixtures were seeded on macOS, so their paths use "/" on every
  // platform; one re-seeded on Windows would use "\".
  const seededSep = seededRoot.includes(`${path.posix.sep}e2e${path.posix.sep}fixtures${path.posix.sep}`) ? path.posix.sep : path.win32.sep;
  const marker = `${seededSep}e2e${seededSep}fixtures${seededSep}`;
  const at = seededRoot.indexOf(marker);
  if (at < 0) return;
  const oldPrefix = seededRoot.slice(0, at + marker.length);
  const newPrefix = path.resolve(__dirname, "..", "fixtures") + path.sep;
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  // The rest of each path takes this platform's separator too, or the app
  // can't find the file (every asset reads "Missing" on Windows).
  const rest = (column) => {
    const tail = `substr(${column}, ${oldPrefix.length + 1})`;
    return seededSep === path.sep ? tail : `replace(${tail}, ${quote(seededSep)}, ${quote(path.sep)})`;
  };
  if (oldPrefix !== newPrefix) {
    const sql = PATH_COLUMNS.map(([table, column]) =>
      `UPDATE ${table} SET ${column} = ${quote(newPrefix)} || ${rest(column)} WHERE ${column} LIKE ${quote(`${oldPrefix}%`)};`,
    ).join(" ");
    execFileSync("sqlite3", [db, sql]);
  }
  restoreSeededMtimes(db);
}

// A fresh checkout gives every fixture file a new mtime. Browse compares
// size + mtime against the catalog row and reports the source as changed,
// which the app answers by re-reading metadata from disk — wiping whatever a
// spec seeded into the row (32-gps-location-menu's GPS, on CI). Put the
// mtimes back to what the catalog recorded, to the microsecond. Node's utimes
// takes float seconds, too coarse at today's epoch for Windows' 100 ns file
// times: a third of the fixtures came back 1 µs off there and read as
// changed. Python sets them in nanoseconds.
const SET_MTIMES_PY = [
  "import os, sys",
  "from datetime import datetime",
  "for line in sys.stdin.buffer.read().decode('utf-8').splitlines():",
  "    path, _, iso = line.partition('\\t')",
  "    if not iso or not os.path.exists(path):",
  "        continue",
  "    stamp = datetime.fromisoformat(iso)",
  "    ns = (int(stamp.replace(microsecond=0).timestamp()) * 1_000_000 + stamp.microsecond) * 1000",
  "    try:",
  "        os.utime(path, ns=(ns, ns))",
  "    except OSError:",
  "        pass  # read-only checkout: browse will just flag it",
].join("\n");
function restoreSeededMtimes(db) {
  const rows = execFileSync("sqlite3", ["-separator", "\t", db, "SELECT canonical_path, modified_time FROM assets"]);
  execFileSync(devPython(process.platform), ["-c", SET_MTIMES_PY], { input: rows });
}

// Main-process stdout/stderr and renderer console lines go to
// e2e/.artifacts/app-logs/ so a CI failure ships the sidecar/browse timeline
// alongside Playwright's own screenshot and trace (which never see either).
const APP_LOG_DIR = path.resolve(__dirname, "..", ".artifacts", "app-logs");
function captureAppLogs(app, window, testName) {
  let stream = null;
  const startedAt = Date.now();
  const write = (source, text) => {
    if (!stream) {
      fs.mkdirSync(APP_LOG_DIR, { recursive: true });
      stream = fs.createWriteStream(path.join(APP_LOG_DIR, `${testName}-${process.pid}-${startedAt}.log`), { flags: "a" });
    }
    const stamp = String(Date.now() - startedAt).padStart(7);
    for (const line of String(text).split("\n")) {
      if (line.trim()) stream.write(`${stamp} [${source}] ${line}\n`);
    }
  };
  app.process().stdout?.on("data", (chunk) => write("main", chunk));
  app.process().stderr?.on("data", (chunk) => write("main:err", chunk));
  window.on("console", (message) => write(`renderer:${message.type()}`, message.text()));
  window.on("pageerror", (error) => write("renderer:pageerror", error.stack || error.message));
  app.once("close", () => stream?.end());
}

/**
 * JSON-RPC call against the app's embedded MCP server.
 * @param {number} port - from launchApp().mcpPort
 * @param {string} method - e.g. "initialize", "tools/list", "tools/call"
 * @param {object} [params]
 */
async function mcpCall(port, method, params) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, ...(params ? { params } : {}) }),
  });
  if (!response.ok) throw new Error(`mcp ${method} → HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`mcp ${method} → ${body.error.message}`);
  return body.result;
}

async function closeApp(app, userDataDir) {
  await collectCoverage(app);
  try {
    await app.close();
  } catch (_) { /* already closed */ }
  if (userDataDir && userDataDir.startsWith(os.tmpdir())) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// The editor's test backdoor arrives in two steps: App.jsx installs
// window.__afterframeTest.openEditor before any editor exists, and
// EditorOverlay's passive effect merges setTool/addTextLayer/undo/… in AFTER
// its first paint. "Save button visible" is the paint, not the effect — on a
// slow runner a spec that calls setTool right after it hits
// `__afterframeTest.setTool is not a function` (CI, 2026-09-16). Waits for the
// merged backdoor; pass { preview: true } to also wait until the editor is
// ready to edit (getEditReady): preview decoded (commitTransform is a no-op
// while the image is still decoding) AND the initial snapshot recorded (an
// edit made before it lands cannot be undone — history index 0). Transform /
// layer specs need it; sticker/handwriting specs don't, and 18-editor-
// transform polls getPreviewReady itself because it holds measurements back.
async function waitForEditor(window, { preview = false, timeout = 15_000, previewTimeout = 10_000 } = {}) {
  await window.waitForFunction(
    () => typeof window.__afterframeTest?.setTool === "function", null, { timeout },
  );
  if (!preview) return;
  await window.waitForFunction(
    () => window.__afterframeTest.getEditReady?.() === true, null, { timeout: previewTimeout },
  );
}

module.exports = {
  launchApp, closeApp, collectCoverage, waitForEditor, mcpCall, relocateFixturePaths, lacks, byImagePath, importThroughToolbar,
  REPO_DESKTOP_DIR,
};
