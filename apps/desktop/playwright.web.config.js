// Web-build smoke suite: drives web.html in a real Chromium against the vite
// dev server (dev mode on purpose — StrictMode double-invocation is part of
// what we want covered). Separate from playwright.config.js, which launches
// the Electron app.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./e2e-web",
  timeout: 60_000,
  workers: 1,
  outputDir: "e2e-web/.artifacts",
  use: {
    baseURL: "http://127.0.0.1:5190",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --port 5190 --strictPort",
    url: "http://127.0.0.1:5190/web.html",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
