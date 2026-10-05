// The dialogs behind Open Catalog… and New Catalog…. Windows opens a dialog
// whose default folder is missing in the app's working folder, which for an
// installed AfterFrame is C:\Windows\System32 — and on first run there is no
// Documents\AfterFrame yet. So the dialog starts in the nearest folder that
// exists instead.
//   action      "open" | "create"
//   defaultDir  where catalogs go by default
//   t           main-process translator (./i18n)

const fs = require("node:fs");
const path = require("node:path");

function nearestExistingDir(dir, exists = fs.existsSync) {
  let current = path.resolve(dir);
  while (!exists(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function catalogDialogOptions({ action, defaultDir, t, exists }) {
  const startDir = nearestExistingDir(defaultDir, exists);
  if (action === "create") {
    return {
      title: t("dialog.newCatalogTitle"),
      defaultPath: path.join(startDir || defaultDir, "untitled.afcatalog"),
      buttonLabel: t("dialog.newCatalogButton"),
    };
  }
  return {
    title: t("dialog.openCatalogTitle"),
    properties: ["openDirectory"],
    defaultPath: startDir,
  };
}

module.exports = { catalogDialogOptions, nearestExistingDir };
