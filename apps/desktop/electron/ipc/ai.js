// AI providers IPC — the credentials (safeStorage, through host.tokens),
// preferences and model listing of the image-generation providers, shared by
// the editor's text tool (handwriting, text-image jobs below) and the AI
// Repaint feature module (features/repaint/electron/repaint.js, which owns
// the repaint job, its history and the style library). The provider registry
// itself (the five provider types) is the repaint feature's for now.

const path = require("path");
const fs = require("fs");
const { jobStatusHandler } = require("./guard");

function register({
  app,
  ipcMain,
  commands,
  catalog: { state: getCatalogState },
  readAppSettings,
  updateAppSettings,
  tokens: { getStoredProviderConfigWithMigration, providerCredentials, setStoredProviderConfig, deleteStoredProviderConfig },
  tasks: { startTextImageTask, latestJobStatus, formatJobStatus },
}) {
  const status = (jobType) => jobStatusHandler({ getCatalogState, latestJobStatus, formatJobStatus }, jobType);

  ipcMain.handle("workspace:text-image-status", status("text_image"));

  ipcMain.handle("workspace:text-image-start", (_event, options) => startTextImageTask(options));

  // Bundled handwriting preset reference images (handwriting-presets/,
  // extraResources — resolved dev-vs-packaged like frame-logos). Returns the
  // absolute path for --ref-image, or null when missing.
  ipcMain.handle("workspace:handwriting-preset-ref", (_event, presetId) => {
    const id = String(presetId || "");
    if (!/^[a-zA-Z]+$/.test(id)) return null;
    const dir = app.isPackaged
      ? path.join(process.resourcesPath, "handwriting-presets")
      : path.join(__dirname, "..", "..", "handwriting-presets");
    const filePath = path.join(dir, `${id}.png`);
    return fs.existsSync(filePath) ? filePath : null;
  });

  ipcMain.handle("workspace:list-ai-models", async (_event, providerId, providerType) => {
    const instanceId = String(providerId || "");
    const typeKey = String(providerType || "nanobanana");
    const { apiKey, baseUrl } = await providerCredentials(instanceId, typeKey);
    if (!apiKey) return [];
    try {
      return await commands.listAiModels({ providerType: typeKey, apiKey, baseUrl });
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
