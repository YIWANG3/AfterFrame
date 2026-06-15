// LLM auto-annotation IPC — settings, single-asset trigger, fetch, tag list.
// Provider keys reuse the same token store as AI Repaint (different provider
// namespace) so users only ever have one place to think about keys.

function register({
  ipcMain,
  callSidecarJsonAsync,
  commands,
  getCatalogState,
  readAppSettings,
  updateAppSettings,
  getStoredProviderConfigWithMigration,
  setStoredProviderConfig,
  deleteStoredProviderConfig,
  createJob,
  launchSidecarJob,
  latestJobStatus,
  formatJobStatus,
}) {
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
    const stored = (await getStoredProviderConfigWithMigration(ns)) || {};
    let apiKey = stored.token || null;
    let baseUrl = active.baseUrl || null;
    // openai_compatible may store the token as JSON {base_url, token}
    if (sidecarProvider === "openai_compatible" && apiKey) {
      try {
        const parsed = JSON.parse(apiKey);
        apiKey = parsed.token || apiKey;
        baseUrl = parsed.base_url || baseUrl;
      } catch (_) { /* plain token */ }
    }
    if (sidecarProvider === "anthropic" && !apiKey) {
      throw new Error("No API key configured for the active provider.");
    }
    return { settings, active, sidecarProvider, apiKey, baseUrl };
  }

  function annotationArgsFromSettings(settings) {
    const args = [];
    if (Array.isArray(settings.languages) && settings.languages.length) {
      args.push("--languages", settings.languages.join(","));
    }
    if (Number.isFinite(settings.maxTags)) args.push("--max-tags", String(settings.maxTags));
    if (Number.isFinite(settings.maxCaptionChars)) args.push("--max-caption-chars", String(settings.maxCaptionChars));
    if (settings.customInstructions) args.push("--custom-instructions", String(settings.customInstructions));
    // Video frame sampling interval (seconds). 0 / unset → default 3 frames.
    if (Number.isFinite(settings.videoFrameInterval) && settings.videoFrameInterval > 0) {
      args.push("--video-frame-interval", String(settings.videoFrameInterval));
    }
    return args;
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
  ipcMain.handle("workspace:annotate-asset", async (_event, options) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb) throw new Error("Open a catalog before annotating assets.");

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

  // ── Batch annotation job ──────────────────────────────────────────────────
  // scope: "all" | "selection" | "collection"
  //   selection → opts.assetIds (multi-select)
  //   collection → opts.collectionId (folder)
  // onlyMissing (default true) skips already-annotated assets; pass false to
  // re-annotate. Reads provider + annotation options from saved settings.
  // Shared by the IPC handler below and the MCP annotate_assets tool.
  async function startAnnotationTask(options) {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb()) throw new Error("Open a catalog before annotating assets.");

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

    const args = [
      "run-annotation-job",
      "--job-id", job.job_id,
      "--provider", String(sidecarProvider),
      "--model", String(active.model || ""),
    ];
    if (apiKey) args.push("--api-key", apiKey);
    if (baseUrl) args.push("--base-url", baseUrl);
    if (!onlyMissing) args.push("--reannotate");
    if (assetIds.length) args.push("--asset-ids", assetIds.join(","));
    if (collectionId) args.push("--collection-id", String(collectionId));
    args.push(...annotationArgsFromSettings(settings));

    launchSidecarJob(args);
    return formatJobStatus(job);
  }

  ipcMain.handle("workspace:annotation-start", (_event, options) => startAnnotationTask(options));

  ipcMain.handle("workspace:annotation-status", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
    try { return await latestJobStatus("annotation"); } catch { return formatJobStatus(null); }
  });

  ipcMain.handle("workspace:annotation-count", async (_event, options) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb()) return { count: 0 };
    const opts = options || {};
    const args = ["annotation-count"];
    if (opts.onlyMissing === false) args.push("--reannotate");
    if (Array.isArray(opts.assetIds) && opts.assetIds.length) args.push("--asset-ids", opts.assetIds.filter(Boolean).join(","));
    if (opts.collectionId) args.push("--collection-id", String(opts.collectionId));
    const res = await callSidecarJsonAsync(args);
    return res || { count: 0 };
  });

  ipcMain.handle("workspace:add-asset-tag", async (_event, assetId, tag) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb()) throw new Error("Open a catalog first.");
    if (!assetId || !tag) return null;
    return await commands.addAssetTag(assetId, tag);
  });

  ipcMain.handle("workspace:remove-asset-tag", async (_event, assetId, tag) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb()) throw new Error("Open a catalog first.");
    if (!assetId || !tag) return null;
    return await commands.removeAssetTag(assetId, tag);
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

  // Catalog-independent — works even when no catalog is open. Used by the
  // Settings panel for "Test connection" and "Fetch models" buttons.
  ipcMain.handle("workspace:test-annotation-connection", async (_event, options) => {
    const opts = options || {};
    if (!opts.provider) return { ok: false, error: "provider is required" };

    const ns = `annotation:${opts.providerId || opts.provider}`;
    const stored = await getStoredProviderConfigWithMigration(ns) || {};
    const apiKey = opts.apiKey || stored.token || "";

    const args = ["annotation-test-connection", "--provider", String(opts.provider)];
    if (apiKey) args.push("--api-key", apiKey);
    if (opts.baseUrl) args.push("--base-url", String(opts.baseUrl));
    try {
      return await callSidecarJsonAsync(args);
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

    const args = ["annotation-list-models", "--provider", String(opts.provider)];
    if (apiKey) args.push("--api-key", apiKey);
    if (opts.baseUrl) args.push("--base-url", String(opts.baseUrl));
    try {
      const result = await callSidecarJsonAsync(args);
      return result || { ok: false, error: "no result", models: [] };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), models: [] };
    }
  });

  return { startAnnotationTask };
}

module.exports = { register };
