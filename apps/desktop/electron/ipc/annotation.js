// LLM auto-annotation IPC — settings, single-asset trigger, fetch, tag list.
// Provider keys reuse the same token store as AI Repaint (different provider
// namespace) so users only ever have one place to think about keys.

function register({
  ipcMain,
  callSidecarJsonAsync,
  getCatalogState,
  readAppSettings,
  updateAppSettings,
  getStoredProviderConfigWithMigration,
  setStoredProviderConfig,
  deleteStoredProviderConfig,
}) {
  // ── Settings (annotation-specific subtree under aiAnnotation) ────────────
  ipcMain.handle("workspace:get-annotation-settings", async () => {
    const settings = readAppSettings();
    return settings?.aiAnnotation ?? {};
  });

  ipcMain.handle("workspace:save-annotation-settings", async (_event, next) => {
    await updateAppSettings((s) => ({ ...s, aiAnnotation: { ...(s?.aiAnnotation || {}), ...(next || {}) } }));
    const settings = readAppSettings();
    return settings?.aiAnnotation ?? {};
  });

  // ── Provider key (namespaced; reuses repaint token store) ────────────────
  ipcMain.handle("workspace:get-annotation-key", async (_event, providerKey) => {
    const ns = `annotation:${providerKey || ""}`;
    return await getStoredProviderConfigWithMigration(ns) || {};
  });

  ipcMain.handle("workspace:set-annotation-key", async (_event, providerKey, token) => {
    const ns = `annotation:${providerKey || ""}`;
    return await setStoredProviderConfig(ns, { token: String(token || "") }) || {};
  });

  ipcMain.handle("workspace:delete-annotation-key", async (_event, providerKey) => {
    const ns = `annotation:${providerKey || ""}`;
    await deleteStoredProviderConfig(ns);
    return { configured: false };
  });

  // ── Annotation actions ───────────────────────────────────────────────────
  ipcMain.handle("workspace:annotate-asset", async (_event, options) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb) throw new Error("Open a catalog before annotating assets.");

    const opts = options || {};
    if (!opts.assetId) throw new Error("assetId is required");
    if (!opts.imagePath) throw new Error("imagePath is required");
    if (!opts.provider) throw new Error("provider is required");
    if (!opts.model) throw new Error("model is required");

    const ns = `annotation:${opts.provider}`;
    const stored = await getStoredProviderConfigWithMigration(ns) || {};
    const apiKey = opts.apiKey || stored.token || null;

    const args = [
      "annotate-asset",
      "--asset-id", String(opts.assetId),
      "--image", String(opts.imagePath),
      "--provider", String(opts.provider),
      "--model", String(opts.model),
    ];
    if (apiKey) args.push("--api-key", apiKey);
    if (opts.baseUrl) args.push("--base-url", String(opts.baseUrl));
    if (Array.isArray(opts.languages) && opts.languages.length) args.push("--languages", opts.languages.join(","));
    if (Number.isFinite(opts.maxTags)) args.push("--max-tags", String(opts.maxTags));
    if (Number.isFinite(opts.maxCaptionChars)) args.push("--max-caption-chars", String(opts.maxCaptionChars));
    if (opts.customInstructions) args.push("--custom-instructions", String(opts.customInstructions));

    return await callSidecarJsonAsync(args);
  });

  ipcMain.handle("workspace:get-annotation", async (_event, assetId) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb) return null;
    if (!assetId) return null;
    return await callSidecarJsonAsync(["get-annotation", "--asset-id", String(assetId)]);
  });

  ipcMain.handle("workspace:list-tags", async (_event, limit) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb) return [];
    const n = Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : 200;
    return await callSidecarJsonAsync(["list-tags", "--limit", String(n)]) || [];
  });
}

module.exports = { register };
