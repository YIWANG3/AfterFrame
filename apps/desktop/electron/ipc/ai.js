// AI Repaint IPC — provider token storage, model listing, style library,
// repaint job kickoff + status, repaint history.
// Provider tokens use safeStorage via the deps passed in; styles live in a
// plain JSON file under userData/afterframe/.

const path = require("path");
const fs = require("fs");

function register({
  app,
  ipcMain,
  callSidecarJsonAsync,
  getCatalogState,
  readAppSettings,
  updateAppSettings,
  getStoredProviderConfigWithMigration,
  setStoredProviderConfig,
  deleteStoredProviderConfig,
  startAiRepaintTask,
  latestJobStatus,
  formatJobStatus,
}) {
  function aiStylesPath() {
    return path.join(app.getPath("userData"), "afterframe", "ai-styles.json");
  }
  function readAiStyles() {
    try {
      return JSON.parse(fs.readFileSync(aiStylesPath(), "utf-8"));
    } catch {
      return null;
    }
  }
  async function writeAiStyles(styles) {
    const p = aiStylesPath();
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, JSON.stringify(styles, null, 2) + "\n", "utf-8");
  }

  ipcMain.handle("workspace:ai-repaint-status", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
    try { return await latestJobStatus("ai_repaint"); } catch { return formatJobStatus(null); }
  });

  ipcMain.handle("workspace:ai-repaint-start", (_event, options) => startAiRepaintTask(options));

  ipcMain.handle("workspace:list-ai-models", async (_event, providerId, providerType) => {
    const instanceId = String(providerId || "");
    const typeKey = String(providerType || "nanobanana");
    const providerConfig = await getStoredProviderConfigWithMigration(instanceId);
    let apiKey = providerConfig?.token || null;
    let baseUrl = null;
    if (typeKey === "openai_compatible" && apiKey) {
      try {
        const parsed = JSON.parse(apiKey);
        apiKey = parsed.token || null;
        baseUrl = parsed.base_url || null;
      } catch (_) { /* plain string token */ }
    }
    if (!apiKey) return [];
    try {
      const cmd = ["list-ai-models", "--provider", typeKey, "--api-key", apiKey];
      if (baseUrl) cmd.push("--base-url", baseUrl);
      return await callSidecarJsonAsync(cmd) || [];
    } catch (err) {
      console.error("[list-ai-models] error:", err.message);
      return [];
    }
  });

  ipcMain.handle("workspace:get-ai-preferences", () => {
    const settings = readAppSettings();
    return settings?.aiPreferences ?? {};
  });

  ipcMain.handle("workspace:save-ai-preferences", async (_event, prefs) => {
    await updateAppSettings((settings) => ({ ...settings, aiPreferences: prefs }));
  });

  ipcMain.handle("workspace:get-ai-styles", () => {
    return readAiStyles();
  });

  ipcMain.handle("workspace:save-ai-styles", async (_event, styles) => {
    await writeAiStyles(styles);
  });

  ipcMain.handle("workspace:list-repaint-history", async (_event, assetPath) => {
    if (!assetPath) return [];
    return await callSidecarJsonAsync(["list-repaint-history", "--asset-path", String(assetPath)]) || [];
  });

  ipcMain.handle("workspace:get-ai-provider-token", async (_event, provider) => {
    return await getStoredProviderConfigWithMigration(String(provider || "")) || {};
  });

  ipcMain.handle("workspace:set-ai-provider-token", async (_event, provider, token) => {
    const next = await setStoredProviderConfig(String(provider || ""), { token: String(token || "") });
    return next || {};
  });

  ipcMain.handle("workspace:delete-ai-provider-token", async (_event, provider) => {
    await deleteStoredProviderConfig(String(provider || ""));
    return { provider: String(provider || ""), configured: false };
  });
}

module.exports = { register };
