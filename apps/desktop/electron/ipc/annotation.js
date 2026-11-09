// LLM auto-annotation IPC — settings, single-asset trigger, fetch, tag list.
// Provider keys reuse the same token store as AI Repaint (different provider
// namespace) so users only ever have one place to think about keys.

const jobArgv = require("../sidecar/jobArgv");
const { withCatalog, catalogRequired, jobStatusHandler } = require("./guard");

function register({
  ipcMain,
  commands,
  catalog: { state: getCatalogState },
  readAppSettings,
  updateAppSettings,
  tokens: { getStoredProviderConfigWithMigration, providerCredentials, setStoredProviderConfig, deleteStoredProviderConfig },
  launchSidecarJob,
  tasks: { createJob, latestJobStatus, formatJobStatus },
}) {
  const guarded = (fallback, fn) => withCatalog(getCatalogState, fallback, fn);
  // Where a provider's key is stored: the repaint token store, under the
  // annotation namespace keyed by the provider instance (its id), falling
  // back to the provider type for single-config callers.
  const tokenNamespace = (providerKey) => `annotation:${providerKey || ""}`;
  // The stored key for a request's provider instance (providerId), or type.
  async function storedToken(opts) {
    const stored = await getStoredProviderConfigWithMigration(tokenNamespace(opts.providerId || opts.provider)) || {};
    return stored.token;
  }

  // Resolve the active annotation provider + its API key from saved settings.
  // Mirrors the single-asset resolution in AnnotationsSection: anthropic stays
  // anthropic; every other type routes through the openai_compatible adapter.
  async function resolveActiveProvider() {
    const settings = readAppSettings()?.aiAnnotation || {};
    const providers = Array.isArray(settings.providers) ? settings.providers : [];
    const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
    if (!active) throw new Error("No AI provider configured. Open Settings → AI to add one.");

    const sidecarProvider = active.type === "anthropic" ? "anthropic" : "openai_compatible";
    const ns = tokenNamespace(active.id || active.type);
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
    return await getStoredProviderConfigWithMigration(tokenNamespace(providerKey)) || {};
  });

  ipcMain.handle("workspace:set-annotation-key", async (_event, providerKey, token) => {
    return await setStoredProviderConfig(tokenNamespace(providerKey), { token: String(token || "") }) || {};
  });

  ipcMain.handle("workspace:delete-annotation-key", async (_event, providerKey) => {
    await deleteStoredProviderConfig(tokenNamespace(providerKey));
    return { configured: false };
  });

  // ── Annotation actions ───────────────────────────────────────────────────
  ipcMain.handle("workspace:annotate-asset", guarded(catalogRequired("Open a catalog before annotating assets."), async (_event, options) => {
    const opts = options || {};
    if (!opts.assetId) throw new Error("assetId is required");
    if (!opts.imagePath) throw new Error("imagePath is required");
    if (!opts.provider) throw new Error("provider is required");
    if (!opts.model) throw new Error("model is required");

    const apiKey = opts.apiKey || await storedToken(opts) || null;

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
  //   collection → opts.collectionId (folder); opts.includeDescendants takes
  //                the folders under it too
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
    const includeDescendants = !!collectionId && opts.includeDescendants === true;

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
      includeDescendants,
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
      includeDescendants: opts.includeDescendants === true,
    });
  }));

  // `group`: where a tag new to the library goes (the Inspector's picker).
  ipcMain.handle("workspace:add-asset-tag", guarded(catalogRequired(), (_event, assetId, tag, group) =>
    (assetId && tag ? commands.addAssetTag(assetId, tag, group || undefined) : null)));

  // A photo's tags, hand-added and AI alike: { asset_id, tags }.
  ipcMain.handle("workspace:get-asset-tags", async (_event, assetId) => {
    const { catalogHasDb } = getCatalogState();
    if (!catalogHasDb() || !assetId) return { asset_id: assetId || null, tags: [] };
    return await commands.getAssetTags(assetId);
  });

  // Several photos, several tags, one write (the gallery's "Add Tags…").
  ipcMain.handle("workspace:add-asset-tags", guarded(catalogRequired(), (_event, assetIds, tags, group) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    const clean = [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];
    if (!ids.length || !clean.length) return null;
    return commands.addAssetTags(ids, clean, group || undefined);
  }));

  ipcMain.handle("workspace:remove-asset-tag", guarded(catalogRequired(), (_event, assetId, tag) =>
    (assetId && tag ? commands.removeAssetTag(assetId, tag) : null)));

  // Several photos, several tags off, one write (the batch "Remove Tags…"),
  // and its candidates: the tags the selection carries.
  ipcMain.handle("workspace:remove-asset-tags", guarded(catalogRequired(), (_event, assetIds, tags) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    const clean = [...new Set((tags || []).map((tag) => String(tag || "").trim()).filter(Boolean))];
    if (!ids.length || !clean.length) return null;
    return commands.removeAssetTags(ids, clean);
  }));
  ipcMain.handle("workspace:list-selection-tags", guarded([], (_event, assetIds) => {
    const ids = [...new Set((assetIds || []).filter(Boolean))];
    return ids.length ? commands.listSelectionTags(ids) : [];
  }));

  // ── Tags as entities: groups, aliases, pins (db/tags.py) ─────────────────
  // Library-level edits; the renderer refetches its tag caches after each.
  ipcMain.handle("workspace:list-tags", guarded({ count: 0, groups: [], ungrouped: [] }, (_event, options) =>
    commands.listTags(options || {})));
  ipcMain.handle("workspace:list-tag-groups", guarded([], () => commands.listTagGroups()));
  ipcMain.handle("workspace:manage-tag-groups", guarded(catalogRequired(), (_event, options) =>
    commands.manageTagGroups(options || {})));
  ipcMain.handle("workspace:set-tag-group", guarded(catalogRequired(), (_event, tags, group) =>
    commands.setTagGroup([...new Set((tags || []).filter(Boolean))], group || undefined)));
  ipcMain.handle("workspace:rename-tag", guarded(catalogRequired(), (_event, tag, to) =>
    (tag && to ? commands.renameTag(tag, to) : null)));
  ipcMain.handle("workspace:merge-tags", guarded(catalogRequired(), (_event, tags, into) =>
    (into ? commands.mergeTags([...new Set((tags || []).filter(Boolean))], into) : null)));
  ipcMain.handle("workspace:delete-tag", guarded(catalogRequired(), (_event, tag) =>
    (tag ? commands.deleteTag(tag) : null)));
  ipcMain.handle("workspace:pin-tag", guarded(catalogRequired(), (_event, tag, pinned) =>
    (tag ? commands.pinTag(tag, !!pinned) : null)));
  ipcMain.handle("workspace:regroup-tags", guarded(catalogRequired(), () => commands.regroupTags()));

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

    const apiKey = opts.apiKey || await storedToken(opts) || "";

    try {
      return await commands.annotationTestConnection({ provider: opts.provider, apiKey, baseUrl: opts.baseUrl });
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("workspace:list-annotation-models", async (_event, options) => {
    const opts = options || {};
    if (!opts.provider) return { ok: false, error: "provider is required", models: [] };

    const apiKey = opts.apiKey || await storedToken(opts) || "";

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
