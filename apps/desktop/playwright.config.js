// Playwright config for AfterFrame Electron E2E smoke tests.
// Tests live in ./e2e/, each launching its own Electron instance against the
// production build (dist/index.html). Renderer must be built before running:
//   npm run build && npm run e2e
//
// We deliberately keep this minimal — single worker, no retries — because
// each test launches its own full Electron process and parallelism would
// fight over OS resources (windows, ports, sidecar).

const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  outputDir: "./e2e/.artifacts",
});
