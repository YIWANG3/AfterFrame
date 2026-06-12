// Helpers for launching the Electron app with isolated state.
// Each test gets a fresh userData dir under e2e/.artifacts/ so we don't
// touch the user's real catalog / settings / sticker library.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { _electron: electron } = require("@playwright/test");

const REPO_DESKTOP_DIR = path.resolve(__dirname, "..", "..");
const SEEDED_CATALOG = path.resolve(__dirname, "..", "fixtures", "test-catalog.afcatalog");

/**
 * Launch the packaged-style Electron app pointing at a temp userData dir.
 * @param {object} opts
 * @param {string} [opts.testName] - used to prefix the temp dir for debugging
 * @param {boolean} [opts.withCatalog=true] - load the seeded e2e catalog
 *   (10 gradient images). Set false for tests that want a blank-state app.
 * @returns {Promise<{ app: import('playwright').ElectronApplication, window: import('playwright').Page, userDataDir: string }>}
 */
// Each launch gets its own MCP port: the dev app holds the default 41706, and
// a port collision is silently swallowed by the server (EADDRINUSE → no MCP),
// which would make MCP-dependent specs flake in confusing ways.
let nextMcpPort = 42100 + (Number(process.env.TEST_WORKER_INDEX) || 0) * 50;

async function launchApp({ testName = "e2e", withCatalog = true } = {}) {
  // Fresh userData so each run starts from a clean slate
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${testName}-`));
  const mcpPort = nextMcpPort++;

  const env = {
    ...process.env,
    AFTERFRAME_USER_DATA: userDataDir,
    AFTERFRAME_MCP_PORT: String(mcpPort),
    NODE_ENV: "test",
  };

  // Copy the seeded catalog into a tmp dir so save/import tests can't
  // contaminate the version-controlled fixture between runs.
  let workCatalog = null;
  if (withCatalog) {
    workCatalog = path.join(userDataDir, "test-catalog.afcatalog");
    fs.cpSync(SEEDED_CATALOG, workCatalog, { recursive: true });
    env.MEDIA_WORKSPACE_CATALOG = workCatalog;
  }

  const app = await electron.launch({
    args: [REPO_DESKTOP_DIR],
    cwd: REPO_DESKTOP_DIR,
    env,
  });
  const window = await app.firstWindow();
  return { app, window, userDataDir, catalogDir: workCatalog, mcpPort };
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
  try {
    await app.close();
  } catch (_) { /* already closed */ }
  if (userDataDir && userDataDir.startsWith(os.tmpdir())) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { launchApp, closeApp, mcpCall, REPO_DESKTOP_DIR };
