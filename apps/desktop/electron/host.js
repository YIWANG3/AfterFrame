// The host: the one bag of main-process services every register(host) gets —
// the ipc modules, the watcher, the MCP server, and (from PR 1 of
// docs/feature-modules-plan.md on) the feature modules. main.js builds the
// parts and hands them to createHost once; everything after that reads them
// from here instead of each call site picking its own dozen names.
//
// Frozen on purpose: HOST_KEYS below is the whole surface a module can rely
// on, and the public plugin API will be a subset of it. The one mutable part
// is `services`, where the modules that return an api (watcher, annotation,
// people, saveFile, mcp) hang it for the modules registered after them — see
// createServices. A module needing something not listed here adds it to
// HOST_KEYS and to main.js, not to the object it was handed.

// Grouped as main.js builds them. Primitives and functions are flat (the
// modules destructure them by name, as they always did); objects that one
// factory already returns (catalog, tasks, tokens, media, …) stay whole.
const HOST_KEYS = [
  // Electron
  "app", "ipcMain", "dialog", "shell", "BrowserWindow", "nativeImage", "clipboard", "sharp",
  // Environment
  "platform", "isPackaged", "rootDir", "resourcesPath", "nativeBin", "sidecarSrc", "getUserDataPath", "t",
  // Settings files (./settingsStore.js)
  "getAppSettingsPath", "readAppSettings", "updateAppSettings", "readCatalogSettings", "updateCatalogSettings",
  // The open catalog (./catalog.js) and the sidecar: verb layer, detached jobs, root registration
  "catalog", "commands", "launchSidecarJob", "registerRoots",
  // Background tasks (./tasks.js), credentials (./tokens.js), media:// and the range server (./media)
  "tasks", "tokens", "media", "mediaHttp",
  // Window, menu, language, agent bridge (./appShell.js, ./locale.js, ./agentBridge.js)
  "getMainWindow", "appShell", "locale", "agentBridge",
  // Native dialogs (./ipc/dialogs.js createDialogs) and image write-back (./imageMetadata.js)
  "dialogs", "writeImageWithSourceMetadata",
  // What registered modules return for the ones registered after them
  "services",
];

// The apis a register() returns that others consume, in registration order.
// Each is null until its module registered; a consumer registered earlier
// (createTaskStarters needing people) reads it lazily at call time.
const SERVICE_NAMES = ["watcher", "annotation", "people", "saveFile", "mcp"];

function createServices(names = SERVICE_NAMES) {
  const services = {
    set(name, api) {
      if (!names.includes(name)) throw new Error(`host.services: unknown service "${name}" (known: ${names.join(", ")})`);
      if (services[name]) throw new Error(`host.services: "${name}" is already set`);
      services[name] = api;
      return api;
    },
  };
  for (const name of names) services[name] = null;
  // Sealed, not frozen: the known slots are writable, new ones are not.
  return Object.seal(services);
}

function createHost(parts) {
  const missing = HOST_KEYS.filter((key) => parts[key] === undefined);
  const unknown = Object.keys(parts).filter((key) => !HOST_KEYS.includes(key));
  if (missing.length) throw new Error(`createHost: missing ${missing.join(", ")}`);
  if (unknown.length) throw new Error(`createHost: unknown ${unknown.join(", ")} — add it to HOST_KEYS or leave it in main.js`);
  return Object.freeze({ ...parts });
}

module.exports = { HOST_KEYS, SERVICE_NAMES, createHost, createServices };
