// Background-task starters: turn a UI/MCP request into a job row plus a
// detached sidecar runner (import / enrichment / previews / AI repaint /
// text-to-image), and the one job-status shape every surface reads.
// Extracted from main.js (review 2026-09-16 §2). Injected rather than
// imported so tests can drive it with fakes:
//   app                              userData path for the handwriting cache
//   readAppSettings                  HD-preview opt-in
//   commands                         sidecar verb layer (job rows)
//   launchSidecarJob                 transport.launchJob (detached runners;
//                                    argv comes from sidecar/jobArgv.js only)
//   addAllowedMediaDir               media:// allowlist for repaint outputs
//   getStoredProviderConfigWithMigration  provider tokens (keychain-backed)

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const jobArgv = require("./sidecar/jobArgv");

function createTaskStarters({
  app,
  readAppSettings,
  commands,
  launchSidecarJob,
  addAllowedMediaDir,
  getStoredProviderConfigWithMigration,
}) {
  function formatJobStatus(job) {
    if (!job) {
      return {
        running: false,
        active: false,
        paused: false,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        phase: null,
        phaseLabel: null,
        phaseIndex: 0,
        phaseCount: 0,
        rawDirs: [],
        imageDirs: [],
        mode: null,
        kind: null,
        phaseResults: [],
        progress: 0,
        result: null,
        error: null,
        status: null,
        jobId: null,
        createdAt: null,
        updatedAt: null,
      };
    }
    const payload = job.payload || {};
    const result = job.result || {};
    const status = String(job.status || "");
    return {
      running: status === "queued" || status === "running",
      active: status === "queued" || status === "running" || status === "paused",
      paused: status === "paused",
      startedAt: job.created_at || null,
      finishedAt: status === "succeeded" || status === "failed" ? job.updated_at || null : null,
      exitCode: status === "failed" ? 1 : status === "succeeded" ? 0 : null,
      phase: payload.phase || null,
      phaseLabel: payload.phase_label || null,
      phaseIndex: Number(payload.phase_index || 0),
      phaseCount: Number(payload.phase_count || 0),
      rawDirs: Array.isArray(payload.raw_dirs) ? payload.raw_dirs : [],
      imageDirs: Array.isArray(payload.image_dirs) ? payload.image_dirs : [],
      mode: payload.mode || null,
      kind: payload.kind || null,
      phaseResults: Array.isArray(result.phase_results) ? result.phase_results : [],
      progress: Number(job.progress || 0),
      result,
      error: job.error || null,
      status,
      jobId: job.job_id,
      createdAt: job.created_at || null,
      updatedAt: job.updated_at || null,
    };
  }

  async function latestJobStatus(jobType) {
    return formatJobStatus(await commands.latestJob(jobType));
  }

  async function createJob(jobType, payload, options) {
    return await commands.createJob(jobType, payload, options);
  }

  async function startEnrichmentTask() {
    const current = await latestJobStatus("enrichment");
    if (current.running) {
      return current;
    }
    const job = await createJob("enrichment", {});
    launchSidecarJob(jobArgv.enrichmentJob({ jobId: job.job_id }));
    return formatJobStatus(job);
  }

  async function startImportTask(options) {
    const mode = String(options?.mode || "combined");
    const rawDirs = [...new Set((options?.rawDirs || []).filter(Boolean))];
    const imageDirs = [...new Set((options?.imageDirs || []).filter(Boolean))];
    const needsSources = mode === "source_only" || mode === "source_with_media" || mode === "combined";
    const needsProcessed = mode === "processed_only" || mode === "processed_with_sources" || mode === "combined";
    if (needsSources && !rawDirs.length) {
      throw new Error("choose at least one Source file or folder");
    }
    if (needsProcessed && !imageDirs.length) {
      throw new Error("choose at least one image folder");
    }
    const current = await latestJobStatus("import");
    if (current.running) {
      // The requested dirs are NOT imported here — the caller gets someone else's
      // job back. The UI copes by queueing them (useWorkspace `pendingImport`,
      // replayed from the import-finished handler); callers without a queue must
      // opt into an error so they don't report a phantom success.
      if (options?.rejectIfBusy) {
        throw new Error(
          `An import is already running (job ${current.jobId}); these folders were not imported. `
          + "Wait for it to finish (poll get_job_status) and call import_directory again.",
        );
      }
      return current;
    }
    const job = await createJob("import", { raw_dirs: rawDirs, image_dirs: imageDirs, mode });
    launchSidecarJob(jobArgv.importJob({
      jobId: job.job_id,
      mode,
      rawDirs,
      imageDirs,
      generateHd: readAppSettings()?.previews?.generateHd === true,
      // Auto imports (watched dirs live + catch-up) respect tombstones; a
      // manual re-import is the user's way to clear one.
      respectTombstones: options?.auto === true,
    }));
    return formatJobStatus(job);
  }

  async function startPreviewTask(kind = "preview") {
    const current = await latestJobStatus("preview");
    if (current.running) {
      return current;
    }
    const job = await createJob("preview", { kind, asset_type: "image" });
    launchSidecarJob(jobArgv.previewJob({ jobId: job.job_id, kind, assetType: "image" }));
    return formatJobStatus(job);
  }

  // Dominant colours for photos whose preview predates the colour filter
  // (new previews get theirs as they are rendered). Nothing to do is the
  // common case after the first pass, so it is answered without a job.
  // `force` redoes every photo (Settings ▸ Library, after the extraction
  // changed); otherwise only the ones still without colours.
  async function startColorsTask({ force = false, priority = 80 } = {}) {
    const current = await latestJobStatus("colors");
    if (current.running) {
      return current;
    }
    const status = await commands.colorStatus();
    const count = force ? (status?.analyzed || 0) + (status?.missing || 0) : (status?.missing || 0);
    if (!(count > 0)) {
      return { ...current, running: false, missing: 0 };
    }
    // The automatic catch-up runs below the user's own work (imports,
    // annotation); a run they asked for in Settings goes ahead of it.
    const job = await createJob("colors", { count, force }, { priority });
    launchSidecarJob(jobArgv.colorsJob({ jobId: job.job_id, force }));
    return { ...formatJobStatus(job), missing: status?.missing || 0 };
  }

  function deriveAiRepaintOutputPath(sourcePath) {
    const source = path.resolve(sourcePath);
    const ext = ".png";
    const parsed = path.parse(source);
    const shortId = crypto.randomBytes(4).toString("hex");
    return path.join(parsed.dir, `${parsed.name}_ai-repaint_${shortId}${ext}`);
  }

  async function startAiRepaintTask(options) {
    const sourcePath = String(options?.sourcePath || "");
    const prompt = String(options?.prompt || "");
    const providerId = String(options?.provider || "");
    const providerType = String(options?.providerType || "nanobanana");
    if (!sourcePath) {
      throw new Error("Missing source image");
    }
    const model = String(options?.model || "");
    const isUpscale = model === "jimeng_i2i_seed3_tilesr_cvtob";
    if (!prompt.trim() && !isUpscale) {
      throw new Error("Missing prompt");
    }
    const current = await latestJobStatus("ai_repaint");
    if (current.running) {
      return current;
    }
    const { apiKey, baseUrl } = await resolveProviderCredentials(providerId, providerType);
    if (!apiKey) {
      throw new Error(`No API token configured for provider.`);
    }
    // Output lands next to the original file. For RAW the editor's sourcePath is
    // the (catalog) preview, so callers pass outputBasePath = the original path.
    const outputPath = options?.outputPath || deriveAiRepaintOutputPath(options?.outputBasePath || sourcePath);
    // The sidecar writes the result next to the source; allow the renderer to
    // load it back via media:// (same as editor saves / crops / video proxies).
    // Repaint outputs aren't registered as catalog roots, so without this the
    // before/after compare 403s on the freshly-written file.
    addAllowedMediaDir(path.dirname(outputPath));
    const payload = {
      provider: providerType,
      source_path: sourcePath,
      output_path: outputPath,
      prompt,
      aspect_ratio: options?.aspectRatio || null,
      image_size: options?.resolution ? String(options.resolution).toUpperCase() : null,
      temperature: typeof options?.temperature === "number" ? options.temperature : null,
      model,
    };
    const job = await createJob("ai_repaint", payload);
    launchSidecarJob(jobArgv.aiRepaintJob({
      jobId: job.job_id,
      provider: providerType,
      inputPath: sourcePath,
      outputPath,
      originPath: sourcePath,
      prompt,
      aspectRatio: payload.aspect_ratio,
      imageSize: payload.image_size,
      temperature: payload.temperature,
      model,
      baseUrl,
      apiKey,
    }));
    return formatJobStatus(job);
  }

  // Stored provider token → { apiKey, baseUrl }. openai_compatible packs both
  // fields into one JSON token; every other type stores the key as-is.
  async function resolveProviderCredentials(providerId, providerType) {
    const providerConfig = await getStoredProviderConfigWithMigration(providerId);
    let apiKey = providerConfig?.token || null;
    let baseUrl = null;
    if (providerType === "openai_compatible" && apiKey) {
      try {
        const parsed = JSON.parse(apiKey);
        apiKey = parsed.token || null;
        baseUrl = parsed.base_url || null;
      } catch (_) { /* plain string token */ }
    }
    return { apiKey, baseUrl };
  }

  // Text-to-image (handwriting stickers). Output is a sticker source asset, not
  // a photo derivative: it lands in userData/handwriting-cache (already inside
  // the baseline media:// allowlist) keyed by a hash of the generation params,
  // so an identical request returns the cached file without another paid call.
  function handwritingCachePath(params) {
    const key = crypto
      .createHash("sha1")
      .update(JSON.stringify(params))
      .digest("hex");
    return path.join(app.getPath("userData"), "handwriting-cache", `${key}.png`);
  }

  // The cache only ever grows (every Regenerate mints a new seed → new key, and
  // placed stickers are baked to data: URLs, so old entries are never read
  // again). Trim to a byte budget by oldest mtime; cache hits bump mtime so
  // recently reused entries survive. Runs fire-and-forget per generation.
  const HANDWRITING_CACHE_MAX_BYTES = 200 * 1024 * 1024;
  let handwritingTrimRunning = false;
  async function trimHandwritingCache() {
    if (handwritingTrimRunning) return;
    handwritingTrimRunning = true;
    try {
      const dir = path.join(app.getPath("userData"), "handwriting-cache");
      const names = await fs.promises.readdir(dir).catch(() => []);
      const entries = [];
      for (const name of names) {
        if (!name.endsWith(".png")) continue;
        const filePath = path.join(dir, name);
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (stat) entries.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      }
      let total = entries.reduce((sum, e) => sum + e.size, 0);
      if (total <= HANDWRITING_CACHE_MAX_BYTES) return;
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of entries) {
        if (total <= HANDWRITING_CACHE_MAX_BYTES) break;
        await fs.promises.unlink(entry.filePath).catch(() => {});
        total -= entry.size;
      }
    } finally {
      handwritingTrimRunning = false;
    }
  }

  async function startTextImageTask(options) {
    const prompt = String(options?.prompt || "");
    if (!prompt.trim()) {
      throw new Error("Missing prompt");
    }
    const providerId = String(options?.provider || "");
    const providerType = String(options?.providerType || "nanobanana");
    const model = String(options?.model || "");
    const aspectRatio = options?.aspectRatio || null;
    const imageSize = options?.imageSize ? String(options.imageSize).toUpperCase() : null;
    const quality = options?.quality || null;
    const refImagePath = options?.refImagePath ? String(options.refImagePath) : null;
    // seed lets the UI request several candidates for otherwise identical params
    // without colliding in the cache.
    const seed = Number(options?.seed || 0);

    const outputPath = handwritingCachePath({
      providerType, model, prompt, aspectRatio, imageSize, quality, refImagePath, seed,
    });
    if (fs.existsSync(outputPath)) {
      // Bump recency so the LRU trim keeps entries that still get hits.
      const now = new Date();
      fs.promises.utimes(outputPath, now, now).catch(() => {});
      return {
        ...formatJobStatus(null),
        running: false,
        status: "succeeded",
        progress: 1,
        result: { output_path: outputPath, cached: true },
      };
    }

    const current = await latestJobStatus("text_image");
    if (current.running) {
      return current;
    }
    const { apiKey, baseUrl } = await resolveProviderCredentials(providerId, providerType);
    // Env fallback (dev): the sidecar reads these when no --api-key is passed.
    const envFallback =
      providerType === "openai" ? Boolean(process.env.OPENAI_API_KEY)
      : providerType === "jimeng" ? Boolean(process.env.VOLC_ACCESSKEY && process.env.VOLC_SECRETKEY)
      : providerType === "nanobanana" ? Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
      : providerType === "ark" ? Boolean(process.env.ARK_API_KEY)
      : false;
    if (!apiKey && providerType !== "mock" && !envFallback) {
      throw new Error("No API token configured for provider.");
    }

    const payload = {
      provider: providerType,
      output_path: outputPath,
      prompt,
      aspect_ratio: aspectRatio,
      image_size: imageSize,
      quality,
      model,
      seed,
    };
    const job = await createJob("text_image", payload);
    launchSidecarJob(jobArgv.textImageJob({
      jobId: job.job_id,
      provider: providerType,
      outputPath,
      prompt,
      aspectRatio,
      imageSize,
      quality,
      model,
      baseUrl,
      refImagePath,
      apiKey,
    }));
    void trimHandwritingCache();
    return formatJobStatus(job);
  }

  return {
    formatJobStatus,
    latestJobStatus,
    createJob,
    startEnrichmentTask,
    startImportTask,
    startPreviewTask,
    startAiRepaintTask,
    startColorsTask,
    startTextImageTask,
    resolveProviderCredentials,
  };
}

module.exports = { createTaskStarters };
