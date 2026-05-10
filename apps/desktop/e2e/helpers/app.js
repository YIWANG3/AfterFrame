// Helpers for launching the Electron app with isolated state.
// Each test gets a fresh userData dir under e2e/.artifacts/ so we don't
// touch the user's real catalog / settings / sticker library.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { _electron: electron } = require("@playwright/test");

const REPO_DESKTOP_DIR = path.resolve(__dirname, "..", "..");

/**
 * Launch the packaged-style Electron app pointing at a temp userData dir.
 * @param {object} opts
 * @param {string} [opts.testName] - used to prefix the temp dir for debugging
 * @returns {Promise<{ app: import('playwright').ElectronApplication, window: import('playwright').Page, userDataDir: string }>}
 */
async function launchApp({ testName = "e2e" } = {}) {
  // Fresh userData so each run starts from a clean slate
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `afterframe-e2e-${testName}-`));

  const app = await electron.launch({
    args: [REPO_DESKTOP_DIR],
    cwd: REPO_DESKTOP_DIR,
    env: {
      ...process.env,
      // Electron app reads ELECTRON_USER_DATA_OVERRIDE when set (we'll
      // teach main.js to honor it in a follow-up if needed)
      AFTERFRAME_USER_DATA: userDataDir,
      NODE_ENV: "test",
    },
  });
  const window = await app.firstWindow();
  return { app, window, userDataDir };
}

async function closeApp(app, userDataDir) {
  try {
    await app.close();
  } catch (_) { /* already closed */ }
  if (userDataDir && userDataDir.startsWith(os.tmpdir())) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { launchApp, closeApp, REPO_DESKTOP_DIR };
