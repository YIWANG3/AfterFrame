// Watermark profile + user frame templates (docs/next-features-plan.md §E).
// The profile ({author}) lives in app settings beside the other preferences;
// templates are a plain JSON file under userData/afterframe/, saved and read
// whole like the AI styles (ai.js). A template is layers plus margins, never
// pixels: logos are found again for each photo (see
// src/components/editor/frameUserTemplates.js), so the file stays small.

const fs = require("node:fs");
const path = require("node:path");

const AUTHOR_MAX = 80;
const TEMPLATES_MAX = 200;

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

function register({ app, ipcMain, readAppSettings, updateAppSettings }) {
  const templatesPath = () => path.join(app.getPath("userData"), "afterframe", "frame-templates.json");

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
    const file = templatesPath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename: a crash mid-write must not leave half a file that
    // reads as "no templates" and is then saved over.
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify({ version: 1, templates: next }, null, 2) + "\n", "utf-8");
    await fs.promises.rename(tmp, file);
    return next;
  });
}

module.exports = { register, cleanProfile, cleanTemplates };
