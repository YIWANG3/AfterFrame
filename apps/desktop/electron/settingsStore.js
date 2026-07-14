const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function readJsonObject(filePath) {
  if (!filePath) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* best-effort cleanup */ }
    }
    try { await fs.promises.rm(temporaryPath, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

function assertSettingsObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Settings mutator must return an object.");
  }
  return value;
}

function createSettingsStore({ getAppSettingsPath, logger = console }) {
  if (typeof getAppSettingsPath !== "function") {
    throw new TypeError("getAppSettingsPath must be a function.");
  }

  let appWriteQueue = Promise.resolve();
  const catalogWriteQueues = new Map();

  function readAppSettings() {
    return readJsonObject(getAppSettingsPath());
  }

  function updateAppSettings(mutateFn) {
    const run = appWriteQueue.then(async () => {
      const current = readAppSettings();
      const next = assertSettingsObject(await mutateFn(current));
      await writeJsonAtomic(getAppSettingsPath(), next);
      return next;
    });
    appWriteQueue = run.catch((error) => {
      logger.error?.("[settings] write failed:", error?.message || error);
    });
    return run;
  }

  function catalogSettingsPath(catalogPath) {
    return catalogPath ? path.join(path.resolve(catalogPath), "settings.json") : null;
  }

  function readCatalogSettings(catalogPath) {
    return readJsonObject(catalogSettingsPath(catalogPath));
  }

  function updateCatalogSettings(catalogPath, mutateFn) {
    const targetCatalog = catalogPath ? path.resolve(catalogPath) : null;
    if (!targetCatalog) {
      return Promise.reject(new Error("Open a catalog before changing catalog settings."));
    }
    const previous = catalogWriteQueues.get(targetCatalog) || Promise.resolve();
    const run = previous.then(async () => {
      const current = readCatalogSettings(targetCatalog);
      const mutation = assertSettingsObject(await mutateFn(current));
      const next = { version: 1, ...current, ...mutation };
      await writeJsonAtomic(catalogSettingsPath(targetCatalog), next);
      return next;
    });
    const settled = run.catch((error) => {
      logger.error?.("[catalog-settings] write failed:", error?.message || error);
    }).finally(() => {
      if (catalogWriteQueues.get(targetCatalog) === settled) {
        catalogWriteQueues.delete(targetCatalog);
      }
    });
    catalogWriteQueues.set(targetCatalog, settled);
    return run;
  }

  return {
    readAppSettings,
    updateAppSettings,
    readCatalogSettings,
    updateCatalogSettings,
  };
}

module.exports = {
  createSettingsStore,
  readJsonObject,
  writeJsonAtomic,
};
