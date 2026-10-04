// One AfterFrame per userData on Windows and Linux. Those platforms start a
// new process for every launch, so a second double-click — or photos dropped
// on AfterFrame.exe, or "Open with" — opened a second window on the same
// catalog, with its own sidecar, folder watcher and MCP server (whose port the
// first one already holds). The first process keeps the lock; a later launch
// hands it the files it was given and quits. macOS needs none of this:
// LaunchServices brings the running app forward and delivers files through
// open-file.

const fs = require("node:fs");
const path = require("node:path");

// The files and folders a launch names: the arguments after the executable
// (and, unpackaged, after the app path) that aren't switches and exist.
function launchPaths(argv, { defaultApp = false, cwd = process.cwd(), exists = fs.existsSync } = {}) {
  return argv
    .slice(defaultApp ? 2 : 1)
    .filter((arg) => typeof arg === "string" && arg && !arg.startsWith("-"))
    .map((arg) => path.resolve(cwd, arg))
    .filter((file) => exists(file));
}

// Takes the lock, or hands this launch's files to the instance holding it and
// returns false: the caller quits. In the first instance, onSecondInstance
// gets the paths each later launch named. The paths travel as the lock's
// additionalData because the argv Electron forwards may be reordered and
// carry extra Chromium switches.
function claimSingleInstance({
  app,
  platform = process.platform,
  argv = process.argv,
  defaultApp = Boolean(process.defaultApp),
  onSecondInstance,
}) {
  if (platform === "darwin") return true;
  if (!app.requestSingleInstanceLock({ paths: launchPaths(argv, { defaultApp }) })) return false;
  app.on("second-instance", (_event, _argv, _cwd, data) => {
    onSecondInstance(Array.isArray(data?.paths) ? data.paths.filter((p) => typeof p === "string") : []);
  });
  return true;
}

module.exports = { claimSingleInstance, launchPaths };
