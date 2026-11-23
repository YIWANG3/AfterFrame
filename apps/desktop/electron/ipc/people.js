// Local people-recognition model and indexing IPC.
//
// The native worker deliberately has no Electron or database dependency. This
// module owns the user-facing model lifecycle: the ArcFace model built into the
// app (peopleModel.js) is used by default; a model the user chooses is
// validated locally, copied into Application Support and recorded in
// settings. It also asks the sidecar to launch resumable indexing jobs.
//
// Pets ride along (docs/pet-recognition-design.md): the DINOv2 pet model built
// into the app (petModel.js), or one the user chooses the same way, runs in
// the same job and worker as the faces while "recognize pets" is on (the
// default). Its settings live beside the people ones, under petRecognition.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { spawnSafely } = require("../spawnSafely");
const jobArgv = require("../sidecar/jobArgv");
const { withCatalog, catalogRequired, jobStatusHandler } = require("./guard");
const {
  BUNDLED_ARCFACE_R100,
  BUNDLED_MODEL_KEY,
  bundledModelPath,
  bundledRecord,
  canLoadBundledModel,
  isBundledModel,
  modelKey,
  pathDigest,
} = require("../peopleModel");
const {
  BUNDLED_DINOV2_SMALL,
  BUNDLED_PET_MODEL_KEY,
  bundledPetModelPath,
  bundledPetRecord,
  isBundledPetModel,
} = require("../petModel");

const MODEL_EXTENSIONS = new Set([".mlpackage", ".mlmodelc"]);
const MAX_MANIFEST_BYTES = 128 * 1024;

function isModelDirectory(modelPath) {
  return MODEL_EXTENSIONS.has(path.extname(modelPath).toLowerCase());
}

function safeId(value, fallback) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.slice(0, 80) || fallback;
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function readBundleManifest(bundlePath) {
  const manifestPath = path.join(bundlePath, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const stat = fs.statSync(manifestPath);
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error("Model manifest is too large.");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error("Model manifest is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model manifest must be a JSON object.");
  }
  return parsed;
}

function resolveModelInBundle(bundlePath, manifest) {
  if (isModelDirectory(bundlePath)) return bundlePath;
  const declared = manifest?.model_path;
  if (declared != null) {
    if (typeof declared !== "string" || !declared.trim()) throw new Error("model_path must be a non-empty string.");
    const candidate = path.resolve(bundlePath, declared);
    if (!inside(bundlePath, candidate) || !isModelDirectory(candidate) || !fs.existsSync(candidate)) {
      throw new Error("manifest.json model_path must point to an included .mlpackage or .mlmodelc directory.");
    }
    return candidate;
  }
  const candidates = fs.readdirSync(bundlePath)
    .map((entry) => path.join(bundlePath, entry))
    .filter((entry) => isModelDirectory(entry) && fs.existsSync(entry));
  if (candidates.length !== 1) {
    throw new Error("Select a .mlpackage directly, or provide manifest.json with one model_path.");
  }
  return candidates[0];
}

// kind "face" (ArcFace-style, 512 values) or "pet" (an image in, a vector out).
function workerSelfTest(workerPath, modelPath, kind = "face") {
  return new Promise((resolve, reject) => {
    const child = spawnSafely(spawn, workerPath, [kind === "pet" ? "--pet-model" : "--model", modelPath, "--self-test"]);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("People model validation timed out."));
    }, 120000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `People model validation failed (exit ${code}).`));
        return;
      }
      let payload;
      try { payload = JSON.parse(stdout.trim()); } catch {
        reject(new Error("People model validation returned invalid JSON."));
        return;
      }
      const dimensions = Number(payload?.embedding_dimensions);
      if (kind === "pet") {
        if (!payload?.ok || payload.kind !== "pet" || !(dimensions >= 16 && dimensions <= 4096)) {
          reject(new Error("This Core ML model is not a compatible pet model: it needs one image input and one vector output."));
          return;
        }
      } else if (!payload?.ok || dimensions !== 512) {
        reject(new Error("This Core ML model is not a compatible 512-dimensional face embedding model."));
        return;
      }
      resolve(payload);
    });
  });
}

function register({
  app,
  ipcMain,
  dialog,
  isPackaged,
  resourcesPath,
  readAppSettings,
  updateAppSettings,
  catalog: { state: getCatalogState },
  launchSidecarJob,
  tasks: { createJob, latestJobStatus, formatJobStatus },
  commands,
  platform = process.platform,
  osRelease,
}) {
  const workerPath = isPackaged
    ? path.join(resourcesPath, "native", "bin", "people-worker")
    : path.join(__dirname, "..", "..", "native", "bin", "people-worker");
  const modelStore = path.join(app.getPath("userData"), "people-models");
  const petModelStore = path.join(app.getPath("userData"), "pet-models");
  const desktopDir = path.join(__dirname, "..", "..");
  const bundledPath = bundledModelPath({ isPackaged, resourcesPath, desktopDir });
  const bundledPetPath = bundledPetModelPath({ isPackaged, resourcesPath, desktopDir });
  const bundledLoadable = canLoadBundledModel({ platform, ...(osRelease ? { osRelease } : {}) });

  function getSettings() {
    const source = readAppSettings()?.peopleRecognition;
    return source && typeof source === "object" ? source : {};
  }

  function getPetSettings() {
    const source = readAppSettings()?.petRecognition;
    return source && typeof source === "object" ? source : {};
  }

  // Pets are recognized unless the user turned it off.
  function petsEnabled() {
    return getPetSettings().enabled !== false;
  }

  function hasBundledPetModel() {
    return bundledLoadable && fs.existsSync(bundledPetPath);
  }

  function petRecords() {
    const configured = getPetSettings().models;
    const stored = configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {};
    if (!hasBundledPetModel()) return stored;
    const { [BUNDLED_PET_MODEL_KEY]: _same, ...chosen } = stored;
    return { [BUNDLED_PET_MODEL_KEY]: bundledPetRecord(bundledPetPath), ...chosen };
  }

  function petActiveKey() {
    const all = petRecords();
    const chosen = getPetSettings().activeModelKey;
    if (chosen && all[chosen]?.modelPath && fs.existsSync(all[chosen].modelPath)) return chosen;
    return hasBundledPetModel() ? BUNDLED_PET_MODEL_KEY : null;
  }

  // The pet model a new job should run, or null (pets off, or no model).
  function activePetRecord() {
    if (!petsEnabled()) return null;
    const key = petActiveKey();
    return key ? { key, record: petRecords()[key] } : null;
  }

  // On macOS 12–13 the bundled model is shipped but can't load, so it is
  // treated as absent and state() says which macOS it needs.
  function hasBundledModel() {
    return bundledLoadable && fs.existsSync(bundledPath);
  }

  // The bundled model is listed first and never persisted; chosen models come
  // from settings. A stored record with the bundled key (0.5.5's download of
  // the same model) is replaced by the bundled one.
  function records() {
    const configured = getSettings().models;
    const stored = configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {};
    if (!hasBundledModel()) return stored;
    const { [BUNDLED_MODEL_KEY]: _download, ...chosen } = stored;
    return { [BUNDLED_MODEL_KEY]: bundledRecord(bundledPath), ...chosen };
  }

  // The chosen model while it's still on disk, otherwise the bundled one.
  function activeKey() {
    const all = records();
    const chosen = getSettings().activeModelKey;
    if (chosen && all[chosen]?.modelPath && fs.existsSync(all[chosen].modelPath)) return chosen;
    return hasBundledModel() ? BUNDLED_MODEL_KEY : null;
  }

  function publicRecord(key, record) {
    const exists = !!record?.modelPath && fs.existsSync(record.modelPath);
    return {
      key,
      id: record?.id || null,
      version: record?.version || null,
      name: record?.name || "Local Core ML model",
      kind: record?.kind || "arcface",
      source: record?.source || "custom",
      license: record?.license || null,
      licenseUrl: record?.licenseUrl || null,
      manifestHash: record?.manifestHash || null,
      sizeBytes: Number(record?.sizeBytes || 0),
      installedAt: record?.installedAt || null,
      embeddingDimensions: Number(record?.embeddingDimensions || 0),
      ...(record?.kind === "pet" ? { clusterThreshold: Number.isFinite(record?.clusterThreshold) ? record.clusterThreshold : null } : {}),
      available: exists,
    };
  }

  function petState() {
    const models = Object.entries(petRecords()).map(([key, record]) => publicRecord(key, record));
    const key = petActiveKey();
    return {
      enabled: petsEnabled(),
      activeModelKey: key,
      activeModel: key ? models.find((model) => model.key === key) : null,
      models,
      builtInNeedsMacOS: !bundledLoadable && platform === "darwin" && fs.existsSync(bundledPetPath)
        ? BUNDLED_DINOV2_SMALL.min_macos
        : null,
    };
  }

  function state() {
    const models = Object.entries(records()).map(([key, record]) => publicRecord(key, record));
    const key = activeKey();
    return {
      activeModelKey: key,
      activeModel: key ? models.find((model) => model.key === key) : null,
      models,
      autoIndexOnImport: !!getSettings().autoIndexOnImport,
      builtInNeedsMacOS: !bundledLoadable && platform === "darwin" && fs.existsSync(bundledPath)
        ? BUNDLED_ARCFACE_R100.min_macos
        : null,
      pets: petState(),
    };
  }

  // section: "peopleRecognition" for face models, "petRecognition" for pets.
  async function persistRecord(key, record, section = "peopleRecognition") {
    await updateAppSettings((settings) => ({
      ...settings,
      [section]: {
        ...(settings[section] || {}),
        activeModelKey: key,
        models: { ...((settings[section] || {}).models || {}), [key]: record },
      },
    }));
    return state();
  }

  function activeInternalRecord() {
    const key = activeKey();
    return key ? { key, record: records()[key] } : null;
  }

  // 0.5.5 downloaded this same model into people-models/. With the bundled
  // copy present that download is never loaded again, so free its 125 MB.
  async function removeDownloadedCopy() {
    if (!hasBundledModel()) return;
    const download = getSettings().models?.[BUNDLED_MODEL_KEY];
    if (!download) return;
    if (download.modelPath && inside(modelStore, download.modelPath)) {
      await fs.promises.rm(path.dirname(download.modelPath), { recursive: true, force: true });
    }
    await updateAppSettings((settings) => {
      const peopleRecognition = { ...(settings.peopleRecognition || {}) };
      const { [BUNDLED_MODEL_KEY]: _download, ...models } = peopleRecognition.models || {};
      return { ...settings, peopleRecognition: { ...peopleRecognition, models } };
    });
  }

  async function installModel(sourceModelPath, manifest, source = "custom", kind = "face") {
    const pet = kind === "pet";
    const sourceDigest = await pathDigest(sourceModelPath);
    const selfTest = await workerSelfTest(workerPath, sourceModelPath, kind);
    const id = safeId(manifest?.id, `custom-${sourceDigest.sha256.slice(0, 16)}`);
    const version = safeId(manifest?.version, "1");
    const key = modelKey(id, version, sourceDigest.sha256);
    const destinationDir = path.join(pet ? petModelStore : modelStore, key);
    const destinationModelPath = path.join(destinationDir, path.basename(sourceModelPath));
    await fs.promises.mkdir(pet ? petModelStore : modelStore, { recursive: true });
    if (!fs.existsSync(destinationModelPath)) {
      const temporaryDir = `${destinationDir}.installing-${crypto.randomUUID()}`;
      try {
        await fs.promises.rm(destinationDir, { recursive: true, force: true });
        await fs.promises.mkdir(temporaryDir, { recursive: true });
        await fs.promises.cp(sourceModelPath, path.join(temporaryDir, path.basename(sourceModelPath)), {
          recursive: true,
          errorOnExist: true,
          dereference: false,
        });
        await fs.promises.rename(temporaryDir, destinationDir);
      } catch (error) {
        await fs.promises.rm(temporaryDir, { recursive: true, force: true });
        throw error;
      }
    }
    // A pet model's similarity scale is its own: the manifest may say where
    // two animals count as one (cosine); without it the built-in model's is used.
    const threshold = Number(manifest?.cluster_threshold);
    return persistRecord(key, {
      id,
      version,
      name: String(manifest?.name || `Custom · ${path.basename(sourceModelPath)}`).slice(0, 120),
      kind: pet ? "pet" : String(manifest?.kind || "arcface").slice(0, 40),
      ...(pet ? { clusterThreshold: threshold > 0 && threshold < 1 ? threshold : null } : {}),
      source,
      license: typeof manifest?.license === "string" ? manifest.license.slice(0, 160) : "Unverified custom model",
      licenseUrl: typeof manifest?.license_url === "string" ? manifest.license_url.slice(0, 1000) : null,
      manifestHash: sourceDigest.sha256,
      sizeBytes: sourceDigest.sizeBytes,
      installedAt: new Date().toISOString(),
      embeddingDimensions: Number(selfTest.embedding_dimensions),
      inputName: selfTest.input_name,
      outputName: selfTest.output_name,
      modelPath: destinationModelPath,
    }, pet ? "petRecognition" : "peopleRecognition");
  }

  function commandForPeopleJob(job) {
    const payload = job?.payload || {};
    const modelId = String(payload.model_id || "");
    const modelVersion = String(payload.model_version || "");
    const manifestHash = String(payload.manifest_hash || "");
    // A task on the bundled model (or on 0.5.5's download of it) uses wherever
    // the bundled copy is now: the app may have moved since the task started.
    const modelPath = isBundledModel({ modelId, modelVersion, manifestHash }) && hasBundledModel()
      ? bundledPath
      : String(payload.model_path || "");
    if (!modelPath || !modelId || !modelVersion || !manifestHash) {
      throw new Error("This people task is missing its model configuration and cannot be resumed.");
    }
    if (!fs.existsSync(modelPath)) throw new Error("The model used by this people task is no longer installed.");
    // Once the runner has resolved the request into concrete asset ids (stored
    // on the payload) a resume must not re-send the original request.
    const resolved = Array.isArray(payload.resolved_asset_ids);
    return jobArgv.peopleIndexJob({
      jobId: job.job_id,
      modelId,
      modelVersion,
      modelPath,
      manifestHash,
      assetIds: !resolved && Array.isArray(payload.requested_asset_ids) ? payload.requested_asset_ids : [],
      pets: petsForJob(payload),
    });
  }

  // The pet half of a task, or null. Like the face model, the built-in pet
  // model is found wherever it is now; a task whose pet model has gone since
  // carries on with the faces alone.
  function petsForJob(payload) {
    const modelId = String(payload.pet_model_id || "");
    const modelVersion = String(payload.pet_model_version || "");
    const manifestHash = String(payload.pet_manifest_hash || "");
    if (!modelId || !modelVersion || !manifestHash) return null;
    const modelPath = isBundledPetModel({ modelId, modelVersion, manifestHash }) && hasBundledPetModel()
      ? bundledPetPath
      : String(payload.pet_model_path || "");
    if (!modelPath || !fs.existsSync(modelPath)) {
      console.warn("[people] the pet model of this task is gone; continuing with faces only");
      return null;
    }
    const threshold = Number(payload.pet_threshold);
    return { modelId, modelVersion, modelPath, manifestHash, ...(threshold > 0 && threshold < 1 ? { threshold } : {}) };
  }

  function launchPeopleJob(job) {
    launchSidecarJob(commandForPeopleJob(job));
  }

  void removeDownloadedCopy().catch((error) => {
    console.warn("[people] could not remove the downloaded model copy", error?.message || error);
  });

  ipcMain.handle("workspace:get-people-settings", () => state());

  // The renderer reads this when an import job finishes (App.jsx), the same
  // place annotation's autoOnImport is honoured.
  ipcMain.handle("workspace:set-people-auto-index", async (_event, enabled) => {
    await updateAppSettings((settings) => ({
      ...settings,
      peopleRecognition: { ...(settings.peopleRecognition || {}), autoIndexOnImport: !!enabled },
    }));
    return state();
  });

  ipcMain.handle("workspace:pick-people-model", async () => {
    if (platform !== "darwin") throw new Error("People recognition currently requires macOS.");
    if (!fs.existsSync(workerPath)) throw new Error("People Worker is missing. Reinstall AfterFrame and try again.");
    const result = await dialog.showOpenDialog({
      title: "Select face model bundle or Core ML model",
      // .mlpackage is a Finder package: treating it as a directory makes it
      // appear disabled in NSOpenPanel. Allow both the package *file* and a
      // .afpersonmodel directory that contains manifest.json + the package.
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "People model", extensions: ["afpersonmodel", "mlpackage", "mlmodelc"] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;

    const selectedPath = path.resolve(result.filePaths[0]);
    const manifest = readBundleManifest(selectedPath);
    const sourceModelPath = resolveModelInBundle(selectedPath, manifest);
    return installModel(sourceModelPath, manifest, manifest ? "bundle" : "custom");
  });

  ipcMain.handle("workspace:set-pets-enabled", async (_event, enabled) => {
    await updateAppSettings((settings) => ({
      ...settings,
      petRecognition: { ...(settings.petRecognition || {}), enabled: !!enabled },
    }));
    return state();
  });

  ipcMain.handle("workspace:pick-pet-model", async () => {
    if (platform !== "darwin") throw new Error("Pet recognition currently requires macOS.");
    if (!fs.existsSync(workerPath)) throw new Error("People Worker is missing. Reinstall AfterFrame and try again.");
    const result = await dialog.showOpenDialog({
      title: "Select pet model bundle or Core ML model",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "Pet model", extensions: ["afpetmodel", "mlpackage", "mlmodelc"] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const selectedPath = path.resolve(result.filePaths[0]);
    const manifest = readBundleManifest(selectedPath);
    const sourceModelPath = resolveModelInBundle(selectedPath, manifest);
    return installModel(sourceModelPath, manifest, manifest ? "bundle" : "custom", "pet");
  });

  ipcMain.handle("workspace:set-active-pet-model", async (_event, key) => {
    const record = petRecords()[String(key || "")];
    if (!record?.modelPath || !fs.existsSync(record.modelPath)) throw new Error("Selected pet model is no longer available.");
    await updateAppSettings((settings) => ({
      ...settings,
      petRecognition: { ...(settings.petRecognition || {}), activeModelKey: String(key) },
    }));
    return state();
  });

  ipcMain.handle("workspace:remove-pet-model", async (_event, key) => {
    if (petActiveKey() === key) throw new Error("Select another model before removing the active model.");
    if (key === BUNDLED_PET_MODEL_KEY && hasBundledPetModel()) throw new Error("The built-in model can't be removed.");
    const record = petRecords()[String(key || "")];
    if (!record) return state();
    if (record.modelPath && inside(petModelStore, record.modelPath)) {
      await fs.promises.rm(path.dirname(record.modelPath), { recursive: true, force: true });
    }
    await updateAppSettings((settings) => {
      const petRecognition = { ...(settings.petRecognition || {}) };
      const models = { ...(petRecognition.models || {}) };
      delete models[String(key)];
      return { ...settings, petRecognition: { ...petRecognition, models } };
    });
    return state();
  });

  ipcMain.handle("workspace:set-active-people-model", async (_event, key) => {
    const record = records()[String(key || "")];
    if (!record?.modelPath || !fs.existsSync(record.modelPath)) throw new Error("Selected people model is no longer available.");
    await updateAppSettings((settings) => ({
      ...settings,
      peopleRecognition: { ...(settings.peopleRecognition || {}), activeModelKey: String(key) },
    }));
    return state();
  });

  ipcMain.handle("workspace:remove-people-model", async (_event, key) => {
    const current = activeInternalRecord();
    if (current?.key === key) throw new Error("Select another model before removing the active model.");
    if (key === BUNDLED_MODEL_KEY && hasBundledModel()) throw new Error("The built-in model can't be removed.");
    const record = records()[String(key || "")];
    if (!record) return state();
    if (record.modelPath && inside(modelStore, record.modelPath)) {
      await fs.promises.rm(path.dirname(record.modelPath), { recursive: true, force: true });
    }
    await updateAppSettings((settings) => {
      const peopleRecognition = { ...(settings.peopleRecognition || {}) };
      const models = { ...(peopleRecognition.models || {}) };
      delete models[String(key)];
      return { ...settings, peopleRecognition: { ...peopleRecognition, models } };
    });
    return state();
  });

  const startPeopleIndex = withCatalog(getCatalogState, catalogRequired("Open a catalog before recognizing people."), async (options) => {
    const active = activeInternalRecord();
    if (!active) throw new Error("Install and select a compatible local face model first.");
    const current = await latestJobStatus("people_index");
    if (current.active) return current;
    const opts = options || {};
    const assetIds = Array.isArray(opts.assetIds)
      ? [...new Set(opts.assetIds.map(String).filter((value) => value.length > 0))].slice(0, 50000)
      : [];
    const { record } = active;
    // opts.pets false leaves the pets out of this run (MCP's index_people can).
    const pet = opts.pets === false ? null : activePetRecord();
    const job = await createJob("people_index", {
      scope: assetIds.length ? "selection" : "catalog",
      asset_count: assetIds.length || null,
      requested_asset_ids: assetIds,
      model_id: record.id,
      model_version: record.version,
      model_path: record.modelPath,
      manifest_hash: record.manifestHash,
      ...(pet ? {
        pet_model_id: pet.record.id,
        pet_model_version: pet.record.version,
        pet_model_path: pet.record.modelPath,
        pet_manifest_hash: pet.record.manifestHash,
        pet_threshold: Number.isFinite(pet.record.clusterThreshold) ? pet.record.clusterThreshold : BUNDLED_DINOV2_SMALL.cluster_threshold,
      } : {}),
    }, { priority: Number.isFinite(opts.priority) ? opts.priority : 5 });
    launchPeopleJob(job);
    return formatJobStatus(job);
  });

  async function resumePeopleIndexJob(jobId) {
    const job = await commands.getJob(jobId);
    if (!job || job.job_type !== "people_index") return job ? formatJobStatus(job) : null;
    if (job.status !== "paused") return formatJobStatus(job);
    const resumed = await commands.resumeJob(jobId);
    if (resumed?.status === "queued" && !resumed.cancel_requested) launchPeopleJob(resumed);
    return formatJobStatus(resumed);
  }

  const recoverQueuedPeopleJobs = withCatalog(getCatalogState, [], async () => {
    const jobs = await commands.listActiveJobs();
    const recovered = [];
    for (const job of jobs) {
      if (job.job_type !== "people_index" || job.status !== "queued" || job.cancel_requested) continue;
      try {
        launchPeopleJob(job);
        recovered.push(job.job_id);
      } catch (error) {
        console.warn("[people] could not recover queued task", job.job_id, error?.message || error);
      }
    }
    return recovered;
  });

  ipcMain.handle("workspace:people-index-start", (_event, options) => startPeopleIndex(options));
  ipcMain.handle("workspace:people-index-status", jobStatusHandler({ getCatalogState, latestJobStatus, formatJobStatus }, "people_index"));

  return { startPeopleIndex, resumePeopleIndexJob, recoverQueuedPeopleJobs };
}

module.exports = { register };
