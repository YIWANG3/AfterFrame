// LLM auto-annotation IPC — settings, single-asset trigger, fetch, tag list.
// Provider keys reuse the same token store as AI Repaint (different provider
// namespace) so users only ever have one place to think about keys.

const jobArgv = require("../sidecar/jobArgv");
const { withCatalog, catalogRequired, jobStatusHandler } = require("./guard");

function register({
  ipcMain,
  commands,
  getCatalogState,
  readAppSettings,
  updateAppSettings,
  getStoredProviderConfigWithMigration,
  providerCredentials,
  setStoredProviderConfig,
  deleteStoredProviderConfig,
  createJob,
  launchSidecarJob,
  latestJobStatus,
  formatJobStatus,
}) {
  const guarded = (fallback, fn) => withCatalog(getCatalogState, fallback, fn);

  // Resolve the active annotation provider + its API key from saved settings.
  // Mirrors the single-asset resolution in AnnotationsSection: anthropic stays
  // anthropic; every other type routes through the openai_compatible adapter.
  async function resolveActiveProvider() {
    const settings = readAppSettings()?.aiAnnotation || {};
    const providers = Array.isArray(settings.providers) ? settings.providers : [];
    const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
    if (!active) throw new Error("No AI provider configured. Open Settings → AI to add one.");

    const sidecarProvider = active.type === "anthropic" ? "anthropic" : "openai_compatible";
    const ns = `annotation:${active.id || active.type}`;
    // The provider's own baseUrl from settings applies where the stored
    // openai_compatible token carries no base_url of its own.
    const { apiKey, baseUrl } = await providerCredentials(ns, sidecarProvider, { fallbackBaseUrl: active.baseUrl });
    if (sidecarProvider === "anthropic" && !apiKey) {
      throw new Error("No API key configured for the active provider.");
    }
    return { settings, active, sidecarProvider, apiKey, baseUrl };
  }

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
  ipcMain.handle("workspace:annotate-asset", guarded(catalogRequired("Open a catalog before annotating assets."), async (_event, options) => {
    const opts = options || {};
    if (!opts.assetId) throw new Error("assetId is required");
    if (!opts.imagePath) throw new Error("imagePath is required");
    if (!opts.provider) throw new Error("provider is required");
    if (!opts.model) throw new Error("model is required");

    // providerId is the multi-config namespace key. Falls back to provider type
    // so single-config callers (older code path) keep working.
    const ns = `annotation:${opts.providerId || opts.provider}`;
    const stored = await getStoredProviderConfigWithMigration(ns) || {};
    const apiKey = opts.apiKey || stored.token || null;

    return await commands.annotateAsset({
      assetId: opts.assetId,
      imagePath: opts.imagePath,
      provider: opts.provider,
      model: opts.model,
      apiKey,
      baseUrl: opts.baseUrl,
      languages: opts.languages,
      maxTags: opts.maxTags,
      maxCaptionChars: opts.maxCaptionChars,
      customInstructions: opts.customInstructions,
      hint: opts.hint,
    });
  }));

  // ── Batch annotation job ──────────────────────────────────────────────────
  // scope: "all" | "selection" | "collection"
  //   selection → opts.assetIds (multi-select)
  //   collection → opts.collectionId (folder)
  // onlyMissing (default true) skips already-annotated assets; pass false to
  // re-annotate. Reads provider + annotation options from saved settings.
  // Shared by the IPC handler below and the MCP annotate_assets tool.
  const startAnnotationTask = guarded(catalogRequired("Open a catalog before annotating assets."), async (options) => {
    const current = await latestJobStatus("annotation");
    if (current.running) return current;

    const opts = options || {};
    const { settings, sidecarProvider, active, apiKey, baseUrl } = await resolveActiveProvider();

    const onlyMissing = opts.onlyMissing !== false;
    const assetIds = Array.isArray(opts.assetIds) ? opts.assetIds.filter(Boolean) : [];
    const collectionId = opts.collectionId || null;

    const job = await createJob("annotation", {
      provider: sidecarProvider,
      model: active.model,
      scope: opts.scope || "all",
      only_missing: onlyMissing,
      asset_count: assetIds.length || null,
      collection_id: collectionId,
    });

    launchSidecarJob(jobArgv.annotationJob({
      jobId: job.job_id,
      provider: sidecarProvider,
      model: active.model || "",
      apiKey,
      baseUrl,
      reannotate: !onlyMissing,
      assetIds,
      collectionId,
      settings,
    }));
    return formatJobStatus(job);
  });

  ipcMain.handle("workspace:annotation-start", (_event, options) => startAnnotationTask(options));

  ipcMain.handle("workspace:annotation-status", jobStatusHandler({ getCatalogState, latestJobStatus, formatJobStatus }, "annotation"));

  ipcMain.handle("workspace:annotation-count", guarded({ count: 0 }, (_event, options) => {
    const opts = options || {};
    return commands.annotationCount({
      onlyMissing: opts.onlyMissing,
      assetIds: opts.assetIds,
      collectionId: opts.collectionId,
    });
  }));

  ipcMain.handle("workspace:add-asset-tag", guarded(catalogRequired(), (_event, assetId, tag) =>
    (assetId && tag ? commands.addAssetTag(assetId, tag) : null)));

  // A photo's tags, hand-added and AI alike: { asset_id, tags }.
  ipcMain.handle("workspace:get-asset-tags", async (_event, assetId) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb() || !assetId) return { asset_id: assetId || null, tags: [] };
    return await commands.getAssetTags(assetId);
  });

  // Several photos, several tags, one write (the gallery's "Add Tags…").
  ipcMain.handle("workspace:add-asset-tags", guarded(catalogRequired(), (_event, assetIds, tags) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    const clean = [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];
    if (!ids.length || !clean.length) return null;
    return commands.addAssetTags(ids, clean);
  }));

  ipcMain.handle("workspace:remove-asset-tag", guarded(catalogRequired(), (_event, assetId, tag) =>
    (assetId && tag ? commands.removeAssetTag(assetId, tag) : null)));

  // User veto of a wrong AI location guess — nulls the annotation's
  // location and drops the resolved map point in one step.
  ipcMain.handle("workspace:clear-ai-location", guarded(null, (_event, assetId) =>
    (assetId ? commands.clearAiLocation(assetId) : null)));

  ipcMain.handle("workspace:get-annotation", guarded(null, (_event, assetId) =>
    (assetId ? commands.getAnnotation(assetId) : null)));

  // Catalog-independent — works even when no catalog is open. Used by the
  // Settings panel for "Test connection" and "Fetch models" buttons.
  ipcMain.handle("workspace:test-annotation-connection", async (_event, options) => {
    const opts = options || {};
    if (!opts.provider) return { ok: false, error: "provider is required" };

    const ns = `annotation:${opts.providerId || opts.provider}`;
    const stored = await getStoredProviderConfigWithMigration(ns) || {};
    const apiKey = opts.apiKey || stored.token || "";

    try {
      return await commands.annotationTestConnection({ provider: opts.provider, apiKey, baseUrl: opts.baseUrl });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("workspace:list-annotation-models", async (_event, options) => {
    const opts = options || {};
    if (!opts.provider) return { ok: false, error: "provider is required", models: [] };

    const ns = `annotation:${opts.providerId || opts.provider}`;
    const stored = await getStoredProviderConfigWithMigration(ns) || {};
    const apiKey = opts.apiKey || stored.token || "";

    try {
      const result = await commands.annotationListModels({ provider: opts.provider, apiKey, baseUrl: opts.baseUrl });
      return result || { ok: false, error: "no result", models: [] };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), models: [] };
    }
  });

  return { startAnnotationTask };
}

module.exports = { register };
