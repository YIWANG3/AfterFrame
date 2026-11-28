// Compiled copies of the bundled models that the native helpers left in the
// temporary folder. A Core ML package has to be compiled before it loads, and
// Core ML compiles it into the per-user temporary folder as
// <Name>_<UUID>.mlmodelc. people-worker did that each time a worker started
// and never removed the copy, three workers a scan, 125 MB each (#359 keeps
// one copy in userData instead); compute-depth did it for every photo up to
// 0.5.6. macOS empties that folder only when the Mac restarts, so a Mac that
// stays on collected gigabytes. Launching the app removes them.
//
// Only the bundled models' names, in Core ML's own form, are touched: anything
// else in that folder may be another app's. A copy changed in the last few
// minutes is left alone, since it may still be compiling or about to load. One
// that is already loaded can go: Core ML doesn't read it again (a worker whose
// copy was deleted under it went on giving the same embeddings).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

// scripts/bundled-models.mjs, minus ".mlpackage" (the test keeps them equal).
const MODEL_NAMES = Object.freeze(["FaceEmbedding", "PetEmbedding", "DepthAnythingV2SmallF16"]);
const LEFTOVER = new RegExp(
  `^(?:${MODEL_NAMES.join("|")})_[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\\.mlmodelc$`,
);
const MIN_AGE_MS = 10 * 60 * 1000;

// Where Core ML compiles: the folder macOS gives the user, whatever TMPDIR says.
function coreMLTempDir() {
  return new Promise((resolve) => {
    execFile("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { timeout: 5000 }, (error, stdout) => {
      const dir = String(stdout || "").trim();
      resolve(!error && dir ? dir : os.tmpdir());
    });
  });
}

// The names removed from `dir` (Core ML's folder when not given).
async function removeLeftoverCompiledModels({ dir, now = Date.now(), minAgeMs = MIN_AGE_MS } = {}) {
  const folder = dir || (await coreMLTempDir());
  let names;
  try {
    names = await fs.promises.readdir(folder);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!LEFTOVER.test(name)) continue;
    const target = path.join(folder, name);
    try {
      // lstat: a link with that name is left alone, not followed.
      const stat = await fs.promises.lstat(target);
      if (!stat.isDirectory() || now - stat.mtimeMs < minAgeMs) continue;
      await fs.promises.rm(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Gone meanwhile, or not ours to remove: the next launch tries again.
    }
  }
  return removed;
}

module.exports = { MODEL_NAMES, MIN_AGE_MS, coreMLTempDir, removeLeftoverCompiledModels };
