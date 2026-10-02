// Watermark profile, user frame templates and the user's own logos
// (docs/next-features-plan.md §E).
// The profile ({author}) lives in app settings beside the other preferences;
// templates are a plain JSON file under userData/afterframe/, saved and read
// whole like the AI styles (ai.js). A template is layers plus margins, never
// pixels: logos are found again for each photo (see
// src/components/editor/frameUserTemplates.js), so the file stays small.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { processLogo, LogoError } = require("../personalLogos");

const AUTHOR_MAX = 80;
const TEMPLATES_MAX = 200;
const LOGOS_MAX = 50;
const LOGO_NAME_MAX = 40;

function cleanProfile(profile) {
  const author = String(profile?.author ?? "").replace(/\s+/g, " ").trim().slice(0, AUTHOR_MAX);
  return { author };
}

// Only what the editor wrote: user ids, the layers kind, a name. Anything else
// in the file (a hand edit, a newer version's extra kinds) is dropped rather
// than handed to the renderer.
function cleanTemplates(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const tpl of list) {
    if (!tpl || typeof tpl !== "object" || tpl.kind !== "layers") continue;
    const id = String(tpl.id || "");
    if (!id.startsWith("user:") || seen.has(id) || !Array.isArray(tpl.layers)) continue;
    seen.add(id);
    out.push({ ...tpl, id, name: String(tpl.name || "").trim().slice(0, 80) || id });
    if (out.length >= TEMPLATES_MAX) break;
  }
  return out;
}

function register({ app, ipcMain, dialog, getMainWindow, sharp, readAppSettings, updateAppSettings }) {
  const templatesPath = () => path.join(app.getPath("userData"), "afterframe", "frame-templates.json");
  // My logos: PNGs made by personalLogos.processLogo, plus a manifest. Under
  // userData, which media:// already serves, so the renderer loads them by path.
  const logosDir = () => path.join(app.getPath("userData"), "afterframe", "personal-logos");
  const logosManifest = () => path.join(app.getPath("userData"), "afterframe", "personal-logos.json");

  async function writeJson(file, value) {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
    await fs.promises.rename(tmp, file);
  }
  function readLogos() {
    try {
      const list = JSON.parse(fs.readFileSync(logosManifest(), "utf-8"))?.logos;
      return Array.isArray(list) ? list.filter((l) => l && typeof l.id === "string" && typeof l.file === "string") : [];
    } catch {
      return [];
    }
  }
  const withPath = (logo) => ({ ...logo, path: path.join(logosDir(), path.basename(logo.file)) });
  const saveLogos = (logos) => writeJson(logosManifest(), { version: 1, logos });

  ipcMain.handle("app:watermark-profile", () => cleanProfile(readAppSettings()?.watermarkProfile));

  ipcMain.handle("app:save-watermark-profile", async (_event, profile) => {
    const next = cleanProfile(profile);
    await updateAppSettings((settings) => ({ ...settings, watermarkProfile: next }));
    return next;
  });

  ipcMain.handle("app:frame-templates", () => {
    try {
      return cleanTemplates(JSON.parse(fs.readFileSync(templatesPath(), "utf-8"))?.templates);
    } catch {
      return [];
    }
  });

  ipcMain.handle("app:save-frame-templates", async (_event, templates) => {
    const next = cleanTemplates(templates);
    // Write-then-rename: a crash mid-write must not leave half a file that
    // reads as "no templates" and is then saved over.
    await writeJson(templatesPath(), { version: 1, templates: next });
    return next;
  });

  ipcMain.handle("app:personal-logos", () => ({ logos: readLogos().map(withPath) }));

  // `filePath` skips the open dialog (the e2e specs; nothing else sends one).
  // Failures come back as { error: code }: thrown IPC errors lose their code.
  ipcMain.handle("app:import-personal-logo", async (_event, filePath) => {
    try {
      let source = typeof filePath === "string" && filePath ? filePath : null;
      if (!source) {
        const picked = await dialog.showOpenDialog(getMainWindow(), {
          properties: ["openFile"],
          filters: [{ name: "Logo", extensions: ["svg", "png"] }],
        });
        if (picked.canceled || !picked.filePaths?.[0]) return { canceled: true };
        source = picked.filePaths[0];
      }
      const logos = readLogos();
      if (logos.length >= LOGOS_MAX) return { error: "too_many" };
      const stat = await fs.promises.stat(source);
      if (stat.size > 10 * 1024 * 1024) return { error: "too_large" };
      const processed = await processLogo(sharp, await fs.promises.readFile(source), source);
      const id = `logo_${crypto.randomUUID().slice(0, 8)}`;
      const file = `${id}.png`;
      await fs.promises.mkdir(logosDir(), { recursive: true });
      await fs.promises.writeFile(path.join(logosDir(), file), processed.png);
      const name = path.basename(source).replace(/\.[^.]+$/, "").trim().slice(0, LOGO_NAME_MAX) || id;
      const logo = {
        id, name, file, width: processed.width, height: processed.height,
        tintable: processed.tintable, color: processed.color, createdAt: new Date().toISOString(),
      };
      await saveLogos([...logos, logo]);
      return { logo: withPath(logo) };
    } catch (error) {
      if (error instanceof LogoError) return { error: error.code };
      console.error("[personal-logos] import failed:", error);
      return { error: "failed", message: error?.message || String(error) };
    }
  });

  ipcMain.handle("app:rename-personal-logo", async (_event, id, name) => {
    const clean = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, LOGO_NAME_MAX);
    if (!clean) return { logos: readLogos().map(withPath) };
    const logos = readLogos().map((logo) => (logo.id === id ? { ...logo, name: clean } : logo));
    await saveLogos(logos);
    return { logos: logos.map(withPath) };
  });

  // Templates that used it keep working; the logo is just left out.
  ipcMain.handle("app:delete-personal-logo", async (_event, id) => {
    const logos = readLogos();
    const gone = logos.find((logo) => logo.id === id);
    const rest = logos.filter((logo) => logo.id !== id);
    await saveLogos(rest);
    if (gone) await fs.promises.rm(path.join(logosDir(), path.basename(gone.file)), { force: true });
    return { logos: rest.map(withPath) };
  });
}

module.exports = { register, cleanProfile, cleanTemplates };
