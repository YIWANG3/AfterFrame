// Settings export / import IPC (Settings ▸ General ▸ Backup & transfer).
// Plaintext API keys stay in the main process: export decrypts and reseals
// here, import unseals and re-encrypts through setStoredProviderConfig. The
// renderer only sends a passphrase and receives summaries.
// Failures come back as { error: code } — thrown IPC errors lose their code.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("../settingsStore");
const transfer = require("../settingsTransfer");

const BACKUPS_KEPT = 3;

function register({
  app,
  ipcMain,
  dialog,
  getMainWindow,
  getAppSettingsPath,
  readAppSettings,
  updateAppSettings,
  decryptToken,
  setStoredProviderConfig,
  isEncryptionAvailable,
  applyLocale,
}) {
  // One pending import at a time: inspect parses the file, apply consumes it,
  // so the renderer never round-trips the (secret-bearing) bundle.
  let pendingImport = null;

  const stylesPath = () => path.join(path.dirname(getAppSettingsPath()), "ai-styles.json");

  function readStyles() {
    try {
      return JSON.parse(fs.readFileSync(stylesPath(), "utf-8"));
    } catch {
      return null;
    }
  }

  function toResult(error) {
    if (error instanceof transfer.TransferError) return { error: error.code };
    console.error("[settings-transfer]", error);
    return { error: "failed", message: error?.message || String(error) };
  }

  async function backup(filePath, stamp) {
    if (!fs.existsSync(filePath)) return;
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, ".json");
    await fs.promises.copyFile(filePath, path.join(dir, `${base}.backup-${stamp}.json`));
    const old = (await fs.promises.readdir(dir))
      .filter((name) => name.startsWith(`${base}.backup-`) && name.endsWith(".json"))
      .sort()
      .slice(0, -BACKUPS_KEPT);
    await Promise.all(old.map((name) => fs.promises.rm(path.join(dir, name), { force: true })));
  }

  function defaultExportName() {
    const date = new Date().toISOString().slice(0, 10);
    return path.join(app.getPath("documents"), `AfterFrame Settings ${date}.afsettings`);
  }

  ipcMain.handle("settings:export", async (_event, options = {}) => {
    try {
      const sections = Array.isArray(options.sections) ? options.sections : [];
      if (!sections.length) return { error: "no_sections" };
      const includeSecrets = !!options.includeSecrets;
      if (includeSecrets && String(options.passphrase || "").length < transfer.MIN_PASSPHRASE_LENGTH) {
        return { error: "weak_passphrase" };
      }
      const { bundle, secretCount, unreadable } = await transfer.buildBundle({
        settings: readAppSettings(),
        styles: readStyles(),
        theme: typeof options.theme === "string" ? options.theme : undefined,
        sections,
        includeSecrets,
        passphrase: options.passphrase,
        decryptToken,
        appVersion: app.getVersion(),
      });
      const result = await dialog.showSaveDialog(getMainWindow(), {
        defaultPath: defaultExportName(),
        filters: [{ name: "AfterFrame Settings", extensions: ["afsettings"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      await writeJsonAtomic(result.filePath, bundle);
      return {
        filePath: result.filePath,
        sections: Object.keys(bundle.sections),
        secretCount,
        unreadableCount: unreadable.length,
      };
    } catch (error) {
      return toResult(error);
    }
  });

  ipcMain.handle("settings:import-inspect", async () => {
    try {
      const result = await dialog.showOpenDialog(getMainWindow(), {
        properties: ["openFile"],
        filters: [{ name: "AfterFrame Settings", extensions: ["afsettings"] }],
      });
      const filePath = result.filePaths?.[0];
      if (result.canceled || !filePath) return { canceled: true };
      const stat = await fs.promises.stat(filePath);
      if (stat.size > 5 * 1024 * 1024) return { error: "invalid_file" };
      const bundle = transfer.parseBundle(await fs.promises.readFile(filePath, "utf-8"));
      pendingImport = { id: crypto.randomUUID(), bundle };
      return {
        importId: pendingImport.id,
        fileName: path.basename(filePath),
        summary: transfer.summarizeBundle(bundle, readAppSettings()),
      };
    } catch (error) {
      return toResult(error);
    }
  });

  ipcMain.handle("settings:import-apply", async (_event, options = {}) => {
    try {
      if (!pendingImport || pendingImport.id !== options.importId) return { error: "expired" };
      const { bundle } = pendingImport;
      const sections = (Array.isArray(options.sections) ? options.sections : [])
        .filter((s) => bundle.sections[s]);
      const withSecrets = !!options.includeSecrets && !!bundle.secrets;
      if (!sections.length && !withSecrets) return { error: "no_sections" };

      // Unseal before touching disk: a wrong passphrase must write nothing.
      const tokens = withSecrets ? await transfer.openSecrets(bundle, options.passphrase) : {};

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await backup(getAppSettingsPath(), stamp);
      await backup(stylesPath(), stamp);

      let plan = null;
      await updateAppSettings((current) => {
        plan = transfer.mergeBundle({ settings: current, styles: readStyles(), bundle, sections });
        return plan.settings;
      });
      if (plan.styles) await writeJsonAtomic(stylesPath(), plan.styles);

      // Keys follow their providers: only namespaces referenced by an imported
      // section are written, so unticking a section also skips its keys.
      let tokenCount = 0;
      for (const ns of plan.tokenNamespaces) {
        if (!tokens[ns]) continue;
        await setStoredProviderConfig(ns, { token: tokens[ns] });
        tokenCount += 1;
      }
      if (plan.locale) await applyLocale(plan.locale);

      pendingImport = null;
      const warnings = [];
      if (tokenCount && !isEncryptionAvailable()) warnings.push("plaintext_storage");
      return { sections, tokenCount, theme: plan.theme, locale: plan.locale, warnings };
    } catch (error) {
      return toResult(error);
    }
  });

  ipcMain.handle("settings:import-cancel", () => {
    pendingImport = null;
  });
}

module.exports = { register };
