// Watermark profile, user frame templates and the user's own logos
// (docs/next-features-plan.md §E).
// The profile ({author, brandLogos}) lives in app settings beside the other
// preferences; brandLogos maps a camera brand (a built-in brand id, or
// "make:<exif make>" for one with no built-in logo), or one model of it
// ("<brand>#<model>"), to one of my logos, which frames then use in place of
// the brand's own mark;
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

const BRAND_LOGOS_MAX = 100;
// A brand ("canon", "make:<make>"), or one of its models ("dji#fc9184").
const BRAND_KEY = /^(?:[a-z0-9][a-z0-9-]{0,39}|make:[^\n#]{1,120})(?:#[^\n]{1,120})?$/;
const LOGO_ID = /^[\w-]{1,64}$/;

function cleanBrandLogos(map) {
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [key, id] of Object.entries(map)) {
    if (Object.keys(out).length >= BRAND_LOGOS_MAX) break;
    if (BRAND_KEY.test(key) && typeof id === "string" && LOGO_ID.test(id)) out[key] = id;
  }
  return out;
}

// The user's names for a model ("dji#fc9184": "Air 3S") or for a brand with
// no built-in logo; models of a brand named the same are one camera.
const CAMERA_NAME_MAX = 40;
function cleanCameraNames(map) {
  const out = {};
  if (!map || typeof map !== "object" || Array.isArray(map)) return out;
  for (const [key, name] of Object.entries(map)) {
    if (Object.keys(out).length >= BRAND_LOGOS_MAX * 2) break;
    const clean = typeof name === "string" ? name.replace(/\s+/g, " ").trim().slice(0, CAMERA_NAME_MAX) : "";
    if (BRAND_KEY.test(key) && clean) out[key] = clean;
  }
  return out;
}

function cleanProfile(profile) {
  const author = String(profile?.author ?? "").replace(/\s+/g, " ").trim().slice(0, AUTHOR_MAX);
  return { author, brandLogos: cleanBrandLogos(profile?.brandLogos), cameraNames: cleanCameraNames(profile?.cameraNames) };
}

// What a logo is for: "custom" (a signature, a studio mark: every photo) or
// "camera" (one brand's, `brand` its key). Logos from before the split are
// the camera's that uses them, else custom.
function logoKind(logo, brandLogos) {
  if (logo.kind === "camera" && typeof logo.brand === "string" && logo.brand) return { kind: "camera", brand: logo.brand };
  if (logo.kind === "custom") return { kind: "custom" };
  const key = Object.keys(brandLogos || {}).find((k) => brandLogos[k] === logo.id);
  return key ? { kind: "camera", brand: key.split("#")[0] } : { kind: "custom" };
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
  const withPath = (logo) => ({
    ...logo,
    ...logoKind(logo, cleanProfile(readAppSettings()?.watermarkProfile).brandLogos),
    path: path.join(logosDir(), path.basename(logo.file)),
  });
  const saveLogos = (logos) => writeJson(logosManifest(), { version: 1, logos });

  ipcMain.handle("app:watermark-profile", () => cleanProfile(readAppSettings()?.watermarkProfile));

  // Name a model or an unknown brand (null or empty: back to what EXIF says).
  ipcMain.handle("app:set-camera-name", async (_event, key, name) => {
    let next = null;
    await updateAppSettings((settings) => {
      const current = cleanProfile(settings.watermarkProfile);
      const cameraNames = { ...current.cameraNames };
      const clean = typeof name === "string" ? name.trim() : "";
      if (clean) cameraNames[String(key)] = clean;
      else delete cameraNames[String(key)];
      next = cleanProfile({ ...current, cameraNames });
      return { ...settings, watermarkProfile: next };
    });
    return next;
  });

  // Merged into what is there: saving the name keeps the brand logos.
  ipcMain.handle("app:save-watermark-profile", async (_event, profile) => {
    let next = null;
    await updateAppSettings((settings) => {
      next = cleanProfile({ ...cleanProfile(settings.watermarkProfile), ...(profile || {}) });
      return { ...settings, watermarkProfile: next };
    });
    return next;
  });

  // A brand's frame logo: one of my logos, or (logoId null) its own again.
  // The logo becomes that brand's (a camera logo), and stays so after.
  ipcMain.handle("app:set-brand-logo", async (_event, brandKey, logoId) => {
    if (logoId) {
      const brand = String(brandKey).split("#")[0];
      const logos = readLogos();
      if (logos.some((logo) => logo.id === logoId && (logo.kind !== "camera" || logo.brand !== brand))) {
        await saveLogos(logos.map((logo) => (logo.id === logoId ? { ...logo, kind: "camera", brand } : logo)));
      }
    }
    let next = null;
    await updateAppSettings((settings) => {
      const current = cleanProfile(settings.watermarkProfile);
      const brandLogos = { ...current.brandLogos };
      if (logoId) brandLogos[String(brandKey)] = String(logoId);
      else delete brandLogos[String(brandKey)];
      next = cleanProfile({ ...current, brandLogos });
      return { ...settings, watermarkProfile: next };
    });
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

  // Logos from before the camera / custom split get their kind written once,
  // so a camera logo set back to default stays that brand's.
  ipcMain.handle("app:personal-logos", async () => {
    const logos = readLogos();
    if (logos.some((logo) => !logo.kind)) {
      const brandLogos = cleanProfile(readAppSettings()?.watermarkProfile).brandLogos;
      await saveLogos(logos.map((logo) => (logo.kind ? logo : { ...logo, ...logoKind(logo, brandLogos) })));
      return { logos: readLogos().map(withPath) };
    }
    return { logos: logos.map(withPath) };
  });

  // One logo file into my logos. Throws LogoError for a file that is no logo.
  async function importOne(source, kindOf) {
    const logos = readLogos();
    if (logos.length >= LOGOS_MAX) throw new LogoError("too_many");
    const stat = await fs.promises.stat(source);
    if (stat.size > 10 * 1024 * 1024) throw new LogoError("too_large");
    const processed = await processLogo(sharp, await fs.promises.readFile(source), source);
    const id = `logo_${crypto.randomUUID().slice(0, 8)}`;
    const file = `${id}.png`;
    await fs.promises.mkdir(logosDir(), { recursive: true });
    await fs.promises.writeFile(path.join(logosDir(), file), processed.png);
    const name = path.basename(source).replace(/\.[^.]+$/, "").trim().slice(0, LOGO_NAME_MAX) || id;
    const logo = {
      id, name, file, width: processed.width, height: processed.height,
      tintable: processed.tintable, color: processed.color, createdAt: new Date().toISOString(), ...kindOf,
    };
    await saveLogos([...logos, logo]);
    return withPath(logo);
  }

  // `options`: a file path (skips the dialog: the e2e specs), or
  // { kind: "custom" | "camera", brand, multiple }. A camera logo is that
  // brand's; `multiple` lets the dialog pick several (custom logos).
  // Returns { logo, logos } (logo: the first), or { error: code } when
  // nothing could be imported: thrown IPC errors lose their code.
  ipcMain.handle("app:import-personal-logo", async (_event, options) => {
    const opts = typeof options === "string" ? { filePath: options } : (options || {});
    const brand = typeof opts.brand === "string" ? opts.brand.split("#")[0] : "";
    const kindOf = opts.kind === "camera" && BRAND_KEY.test(brand) ? { kind: "camera", brand } : { kind: "custom" };
    try {
      let sources = typeof opts.filePath === "string" && opts.filePath ? [opts.filePath] : null;
      if (!sources) {
        const picked = await dialog.showOpenDialog(getMainWindow(), {
          properties: opts.multiple ? ["openFile", "multiSelections"] : ["openFile"],
          filters: [{ name: "Logo", extensions: ["svg", "png"] }],
        });
        if (picked.canceled || !picked.filePaths?.length) return { canceled: true };
        sources = picked.filePaths;
      }
      const imported = [];
      let firstError = null;
      for (const source of sources) {
        try {
          imported.push(await importOne(source, kindOf));
        } catch (error) {
          if (!(error instanceof LogoError)) console.error("[personal-logos] import failed:", error);
          firstError ??= error instanceof LogoError ? { error: error.code } : { error: "failed", message: error?.message || String(error) };
        }
      }
      if (!imported.length) return firstError || { error: "failed" };
      return { logo: imported[0], logos: imported, ...(firstError ? { skipped: sources.length - imported.length } : {}) };
    } catch (error) {
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

  // Templates that used it keep working; the logo is just left out. A brand
  // that used it goes back to its own logo.
  ipcMain.handle("app:delete-personal-logo", async (_event, id) => {
    const logos = readLogos();
    const gone = logos.find((logo) => logo.id === id);
    const rest = logos.filter((logo) => logo.id !== id);
    await saveLogos(rest);
    if (gone) await fs.promises.rm(path.join(logosDir(), path.basename(gone.file)), { force: true });
    const profile = cleanProfile(readAppSettings()?.watermarkProfile);
    if (Object.values(profile.brandLogos).includes(id)) {
      await updateAppSettings((settings) => {
        const current = cleanProfile(settings.watermarkProfile);
        const brandLogos = Object.fromEntries(Object.entries(current.brandLogos).filter(([, logoId]) => logoId !== id));
        return { ...settings, watermarkProfile: { ...current, brandLogos } };
      });
    }
    return { logos: rest.map(withPath) };
  });
}

module.exports = { register, cleanProfile, cleanTemplates };
