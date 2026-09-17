// Helpers for launching the Electron app with isolated state.
// Each test gets a fresh userData dir under e2e/.artifacts/ so we don't
// touch the user's real catalog / settings / sticker library.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { _electron: electron } = require("@playwright/test");

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
 * @returns {Promise<{ app: import('playwright').ElectronApplication, window: import('playwright').Page, userDataDir: string }>}
 */
// Each launch gets its own MCP port: the dev app holds the default 41706, and
// a port collision is silently swallowed by the server (EADDRINUSE → no MCP),
// which would make MCP-dependent specs flake in confusing ways.
let nextMcpPort = 42100 + (Number(process.env.TEST_WORKER_INDEX) || 0) * 50;

// Coverage run (npm run e2e:coverage): the renderer is an istanbul build
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

async function launchApp({ testName = "e2e", withCatalog = true, noCatalog = false, catalogFixture = "default", prepareCatalog, reuseUserDataDir } = {}) {
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

  // Copy the seeded catalog into a tmp dir so save/import tests can't
  // contaminate the version-controlled fixture between runs.
  let workCatalog = null;
  if (withCatalog && !noCatalog) {
    const seeded = catalogFixture === "people" ? SEEDED_PEOPLE_CATALOG : SEEDED_CATALOG;
    workCatalog = path.join(userDataDir, path.basename(seeded));
    fs.cpSync(seeded, workCatalog, { recursive: true });
    prepareCatalog?.(workCatalog);
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

module.exports = { launchApp, closeApp, collectCoverage, waitForEditor, mcpCall, REPO_DESKTOP_DIR };
