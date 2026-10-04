// Starting a child process must never become "A JavaScript error occurred in
// the main process". A spawn that fails (ENOENT, or EMFILE once the process is
// out of file descriptors) returns a child with no stdio pipes and emits
// 'error' a tick later. Callers that touch child.stdout before adding their
// 'error' listener throw a TypeError there, the listener is never added, and
// the 'error' then goes uncaught: Electron shows its dialog every time the app
// tries to start a sidecar, which on a watched 2 TB drive was all the time
// (#130). Here the listener comes first and a missing pipe is an Error the
// caller's own handling sees.

const path = require("node:path");

function wantsPipe(stdio, index) {
  if (stdio === undefined || stdio === "pipe" || stdio === "overlapped") return true;
  if (Array.isArray(stdio)) return [undefined, null, "pipe", "overlapped"].includes(stdio[index]);
  return false;
}

function spawnSafely(spawn, command, args = [], options = {}) {
  const child = spawn(command, args, options);
  // Callers add their own 'error' handling; this one only keeps the event
  // from going uncaught when they couldn't.
  child.on("error", () => {});
  const missing = ["stdin", "stdout", "stderr"].filter((name, index) => wantsPipe(options.stdio, index) && !child[name]);
  if (missing.length) {
    try { child.kill(); } catch { /* it never started */ }
    throw new Error(`could not start ${path.basename(String(command))}: no ${missing.join("/")} (out of file descriptors?)`);
  }
  return child;
}

module.exports = { spawnSafely };
