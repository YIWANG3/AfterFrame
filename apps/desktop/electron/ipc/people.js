// Local people-recognition model and indexing IPC.
//
// The native worker deliberately has no Electron or database dependency. This
// module owns the user-facing model lifecycle: validate locally, copy models
// into Application Support, persist a small manifest record, and ask the
// sidecar to launch a resumable indexing job. There is intentionally no
// hard-coded download URL here: a release manifest is required before the app
// can offer an official model download.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const https = require("node:https");

const MODEL_EXTENSIONS = new Set([".mlpackage", ".mlmodelc"]);
const MAX_MANIFEST_BYTES = 128 * 1024;
const OFFICIAL_ARCFACE_R100 = {
  id: "arcface-r100-coreml",
  version: "b51b655",
  name: "ArcFace R100 · Core ML",
  kind: "arcface",
  license: "Apache-2.0",
  license_url: "https://huggingface.co/RuiSumida/ArcFace-R100-CoreML",
  archive_url: "https://huggingface.co/RuiSumida/ArcFace-R100-CoreML/resolve/b51b655da6b4acc72bfdbfdcd316b3cf4f698e4e/FaceEmbedding.mlpackage.tar.gz",
  archive_sha256: "3644ff110ba03a082515d3a9fa22dbc8c1eb66054bb6bbbc0e84eb62b4771f2b",
  archive_bytes: 110376172,
  model_path: "FaceEmbedding.mlpackage",
};

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

async function pathDigest(targetPath) {
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  async function visit(currentPath, relativePath) {
    const stat = await fs.promises.lstat(currentPath);
    if (stat.isSymbolicLink()) throw new Error("Model packages may not contain symbolic links.");
    if (stat.isDirectory()) {
      hash.update(`dir:${relativePath}\n`);
      const entries = await fs.promises.readdir(currentPath);
      for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
        await visit(path.join(currentPath, entry), path.posix.join(relativePath, entry));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("Model package contains an unsupported filesystem entry.");
    hash.update(`file:${relativePath}:${stat.size}\n`);
    totalBytes += stat.size;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(currentPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  }

  await visit(targetPath, path.basename(targetPath));
  return { sha256: hash.digest("hex"), sizeBytes: totalBytes };
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

function workerSelfTest(workerPath, modelPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(workerPath, ["--model", modelPath, "--self-test"]);
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
      if (!payload?.ok || Number(payload.embedding_dimensions) !== 512) {
        reject(new Error("This Core ML model is not a compatible 512-dimensional face embedding model."));
        return;
      }
      resolve(payload);
    });
  });
}

function downloadToFile(url, destination, expectedSha256) {
  return new Promise((resolve, reject) => {
    const request = (target, redirects = 0) => {
      const req = https.get(target, { headers: { "User-Agent": "AfterFrame/people-model-installer" } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 5) {
          response.resume();
          request(new URL(response.headers.location, target).toString(), redirects + 1);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`Official model download failed (HTTP ${response.statusCode}).`));
          return;
        }
        const hash = crypto.createHash("sha256");
        const output = fs.createWriteStream(destination, { flags: "wx" });
        response.on("data", (chunk) => hash.update(chunk));
        response.on("error", reject);
        output.on("error", reject);
        output.on("finish", () => {
          const actual = hash.digest("hex");
          if (actual !== expectedSha256) {
            void fs.promises.rm(destination, { force: true });
            reject(new Error("Official model checksum did not match; the download was discarded."));
            return;
          }
          resolve();
        });
        response.pipe(output);
      });
      req.on("error", reject);
    };
    request(url);
  });
}

function runTar(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/tar", args);
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || "Could not unpack the official model archive."));
    });
  });
}

async function extractVerifiedArchive(archivePath, outputDirectory, expectedModelPath) {
  const listing = (await runTar(["-tzf", archivePath])).split("\n").filter(Boolean);
  if (!listing.length || listing.some((entry) => path.isAbsolute(entry) || entry.split("/").includes(".."))) {
    throw new Error("Official model archive has an unsafe path and was discarded.");
  }
  if (!listing.every((entry) => entry === expectedModelPath || entry.startsWith(`${expectedModelPath}/`))) {
    throw new Error("Official model archive has an unexpected layout and was discarded.");
  }
  await runTar(["-xzf", archivePath, "-C", outputDirectory]);
  const modelPath = path.join(outputDirectory, expectedModelPath);
  if (!isModelDirectory(modelPath) || !fs.existsSync(modelPath)) {
    throw new Error("Official model archive did not contain the expected Core ML package.");
  }
  return modelPath;
}

function register({
  app,
  ipcMain,
  dialog,
  isPackaged,
  resourcesPath,
  readAppSettings,
  updateAppSettings,
  getCatalogState,
  createJob,
  launchSidecarJob,
  latestJobStatus,
  formatJobStatus,
  commands,
}) {
  const workerPath = isPackaged
    ? path.join(resourcesPath, "native", "bin", "people-worker")
    : path.join(__dirname, "..", "..", "native", "bin", "people-worker");
  const modelStore = path.join(app.getPath("userData"), "people-models");

  function getSettings() {
    const source = readAppSettings()?.peopleRecognition;
    return source && typeof source === "object" ? source : {};
  }

  function records() {
    const configured = getSettings().models;
    return configured && typeof configured === "object" && !Array.isArray(configured) ? configured : {};
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
      available: exists,
    };
  }

  function state() {
    const settings = getSettings();
    const all = records();
    const models = Object.entries(all).map(([key, record]) => publicRecord(key, record));
    const activeKey = models.find((model) => model.key === settings.activeModelKey && model.available)
      ? settings.activeModelKey
      : null;
    return {
      activeModelKey: activeKey,
      activeModel: activeKey ? models.find((model) => model.key === activeKey) : null,
      models,
      automaticDownloads: !!settings.automaticDownloads,
      download: {
        available: true,
        name: OFFICIAL_ARCFACE_R100.name,
        sizeBytes: OFFICIAL_ARCFACE_R100.archive_bytes,
        license: OFFICIAL_ARCFACE_R100.license,
        sourceUrl: OFFICIAL_ARCFACE_R100.license_url,
      },
    };
  }

  async function persistRecord(key, record) {
    await updateAppSettings((settings) => ({
      ...settings,
      peopleRecognition: {
        ...(settings.peopleRecognition || {}),
        activeModelKey: key,
        models: { ...((settings.peopleRecognition || {}).models || {}), [key]: record },
      },
    }));
    return state();
  }

  function activeInternalRecord() {
    const settings = getSettings();
    const key = settings.activeModelKey;
    const record = key ? records()[key] : null;
    if (!record?.modelPath || !fs.existsSync(record.modelPath)) return null;
    return { key, record };
  }

  async function installModel(sourceModelPath, manifest, source = "custom") {
    const sourceDigest = await pathDigest(sourceModelPath);
    const selfTest = await workerSelfTest(workerPath, sourceModelPath);
    const id = safeId(manifest?.id, `custom-${sourceDigest.sha256.slice(0, 16)}`);
    const version = safeId(manifest?.version, "1");
    const key = `${id}@${version}@${sourceDigest.sha256.slice(0, 16)}`;
    const destinationDir = path.join(modelStore, key);
    const destinationModelPath = path.join(destinationDir, path.basename(sourceModelPath));
    await fs.promises.mkdir(modelStore, { recursive: true });
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
    return persistRecord(key, {
      id,
      version,
      name: String(manifest?.name || `Custom · ${path.basename(sourceModelPath)}`).slice(0, 120),
      kind: String(manifest?.kind || "arcface").slice(0, 40),
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
    });
  }

  function commandForPeopleJob(job) {
    const payload = job?.payload || {};
    const modelPath = String(payload.model_path || "");
    const modelId = String(payload.model_id || "");
    const modelVersion = String(payload.model_version || "");
    const manifestHash = String(payload.manifest_hash || "");
    if (!modelPath || !modelId || !modelVersion || !manifestHash) {
      throw new Error("This people task is missing its model configuration and cannot be resumed.");
    }
    if (!fs.existsSync(modelPath)) throw new Error("The model used by this people task is no longer installed.");
    const args = [
      "run-people-index-job",
      "--job-id", String(job.job_id),
      "--model-id", modelId,
      "--model-version", modelVersion,
      "--model-path", modelPath,
      "--manifest-hash", manifestHash,
    ];
    if (!Array.isArray(payload.resolved_asset_ids) && Array.isArray(payload.requested_asset_ids)) {
      for (const assetId of payload.requested_asset_ids) args.push("--asset-id", String(assetId));
    }
    return args;
  }

  function launchPeopleJob(job) {
    launchSidecarJob(commandForPeopleJob(job));
  }

  ipcMain.handle("workspace:get-people-settings", () => state());

  ipcMain.handle("workspace:set-people-auto-download", async (_event, enabled) => {
    await updateAppSettings((settings) => ({
      ...settings,
      peopleRecognition: { ...(settings.peopleRecognition || {}), automaticDownloads: !!enabled },
    }));
    return state();
  });

  ipcMain.handle("workspace:pick-people-model", async () => {
    if (process.platform !== "darwin") throw new Error("People recognition currently requires macOS.");
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

  ipcMain.handle("workspace:download-official-people-model", async () => {
    if (process.platform !== "darwin") throw new Error("People recognition currently requires macOS.");
    if (!fs.existsSync(workerPath)) throw new Error("People Worker is missing. Reinstall AfterFrame and try again.");
    await fs.promises.mkdir(modelStore, { recursive: true });
    const temporaryDir = path.join(modelStore, `.official-download-${crypto.randomUUID()}`);
    const archivePath = path.join(temporaryDir, "official-model.tar.gz");
    try {
      await fs.promises.mkdir(temporaryDir, { recursive: true });
      await downloadToFile(OFFICIAL_ARCFACE_R100.archive_url, archivePath, OFFICIAL_ARCFACE_R100.archive_sha256);
      const sourceModelPath = await extractVerifiedArchive(
        archivePath,
        temporaryDir,
        OFFICIAL_ARCFACE_R100.model_path,
      );
      return await installModel(sourceModelPath, {
        id: OFFICIAL_ARCFACE_R100.id,
        version: OFFICIAL_ARCFACE_R100.version,
        name: OFFICIAL_ARCFACE_R100.name,
        kind: OFFICIAL_ARCFACE_R100.kind,
        license: OFFICIAL_ARCFACE_R100.license,
        license_url: OFFICIAL_ARCFACE_R100.license_url,
      }, "official");
    } finally {
      await fs.promises.rm(temporaryDir, { recursive: true, force: true });
    }
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

  async function startPeopleIndex(options) {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) throw new Error("Open a catalog before recognizing people.");
    const active = activeInternalRecord();
    if (!active) throw new Error("Install and select a compatible local face model first.");
    const current = await latestJobStatus("people_index");
    if (current.active) return current;
    const opts = options || {};
    const assetIds = Array.isArray(opts.assetIds)
      ? [...new Set(opts.assetIds.map(String).filter((value) => value.length > 0))].slice(0, 50000)
      : [];
    const { record } = active;
    const job = await createJob("people_index", {
      scope: assetIds.length ? "selection" : "catalog",
      asset_count: assetIds.length || null,
      requested_asset_ids: assetIds,
      model_id: record.id,
      model_version: record.version,
      model_path: record.modelPath,
      manifest_hash: record.manifestHash,
    }, { priority: Number.isFinite(opts.priority) ? opts.priority : 5 });
    launchPeopleJob(job);
    return formatJobStatus(job);
  }

  async function resumePeopleIndexJob(jobId) {
    const job = await commands.getJob(jobId);
    if (!job || job.job_type !== "people_index") return job ? formatJobStatus(job) : null;
    if (job.status !== "paused") return formatJobStatus(job);
    const resumed = await commands.resumeJob(jobId);
    if (resumed?.status === "queued" && !resumed.cancel_requested) launchPeopleJob(resumed);
    return formatJobStatus(resumed);
  }

  async function recoverQueuedPeopleJobs() {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return [];
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
  }

  ipcMain.handle("workspace:people-index-start", (_event, options) => startPeopleIndex(options));
  ipcMain.handle("workspace:people-index-status", async () => {
    const { currentCatalogPath, catalogHasDb } = getCatalogState();
    if (!currentCatalogPath || !catalogHasDb()) return formatJobStatus(null);
    try { return await latestJobStatus("people_index"); } catch { return formatJobStatus(null); }
  });

  return { startPeopleIndex, resumePeopleIndexJob, recoverQueuedPeopleJobs };
}

module.exports = { register };
