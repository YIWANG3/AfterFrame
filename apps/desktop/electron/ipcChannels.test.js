// Every row of shared/ipcChannels.mjs must be answered by exactly one
// ipcMain.handle(...) somewhere under electron/ or features/*/electron/, and
// every handler must be reachable from the table — otherwise a channel is dead on one side and
// nothing says so until a click does nothing. Channel strings are literals
// throughout, so this is a text scan — plus the handler tables
// ipc/browse.js registers in a loop, whose rows are read from the module.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { IPC_METHODS } = require("../shared/ipcChannels.mjs");
const browseIpc = require("./ipc/browse");

const HANDLER_TABLES = [
  ["ipc/browse.js", browseIpc.SIDECAR_QUERIES],
  ["ipc/browse.js", browseIpc.PEOPLE_WRITES],
];

// Handlers the bridge reaches by other means: sync values the preload reads
// at startup (ipcMain.on), fire-and-forget sends, and the dev-only capture.
const NOT_IN_TABLE = new Set([
  "annotate:capture",                          // vibepin, exposed only under VITE_DEV_SERVER_URL
  "workspace:delete-image-assets-from-disk",   // hand-written: preload reshapes (ids, paths) into one object
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

// Main-process code: electron/ and each feature module's electron/ (its
// renderer/ holds no handlers, and no handler may hide there).
const APP_DIR = path.join(__dirname, "..");
const MAIN_PROCESS_FILES = [
  ...walk(__dirname),
  ...walk(path.join(APP_DIR, "features")).filter((file) => file.split(path.sep).includes("electron")),
];

const registered = new Map(); // channel -> [file]
const record = (channel, file) => registered.set(channel, [...(registered.get(channel) || []), file]);
for (const file of MAIN_PROCESS_FILES) {
  const source = fs.readFileSync(file, "utf8");
  for (const m of source.matchAll(/ipcMain\.handle\("([^"]+)"/g)) record(m[1], path.relative(APP_DIR, file));
}
for (const [file, table] of HANDLER_TABLES) {
  for (const [channel] of table) record(channel, file);
}

test("every table channel has exactly one ipcMain.handle", () => {
  const missing = IPC_METHODS.filter(([, channel]) => !registered.has(channel)).map(([method, channel]) => `${method} → ${channel}`);
  assert.deepEqual(missing, [], "in the table but no ipcMain.handle answers it");
  const twice = IPC_METHODS.filter(([, channel]) => (registered.get(channel) || []).length > 1)
    .map(([, channel]) => `${channel}: ${registered.get(channel).join(", ")}`);
  assert.deepEqual(twice, [], "registered more than once");
});

test("every ipcMain.handle is reachable from the table", () => {
  const orphans = [...registered.keys()].filter((channel) => !NOT_IN_TABLE.has(channel) && !IPC_METHODS.some(([, c]) => c === channel)).sort();
  assert.deepEqual(orphans, [], "handled in the main process but no bridge method reaches it (add a row or list it in NOT_IN_TABLE)");
});
