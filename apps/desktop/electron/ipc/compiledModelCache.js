// Where a native helper keeps a model's compiled copy between runs (the
// --compiled-model argument of compute-depth and people-worker). Core ML
// caches the Neural Engine build of a compiled model by its location, so a
// stable path is what makes every photo after the first take ~0.2 s instead
// of ~16 s; and a model compiled anew each run lands in the temporary
// directory, where nothing removes it.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

function createCompiledModelCache({ dir, appVersion }) {
  return {
    // null for a model that already is compiled (.mlmodelc): it loads as is.
    // The key has the app version because the bundled model keeps its path
    // across updates and a copy can keep its mtime.
    pathFor(modelPath) {
      if (path.extname(modelPath).toLowerCase() === ".mlmodelc") return null;
      let real = path.resolve(modelPath);
      let mtime = 0;
      try {
        real = fs.realpathSync(modelPath);
        mtime = Math.floor(fs.statSync(real).mtimeMs);
      } catch { /* missing model: the helper reports it */ }
      const key = crypto.createHash("sha1").update(`${real}|${mtime}|${appVersion}`).digest("hex");
      return path.join(dir, `${key}.mlmodelc`);
    },

    // Keep only the compiled models in use (each is 50 to 125 MB): before
    // compiling a new one, drop the rest. Names containing a kept one's key
    // are spared, so a concurrent run's staging copy and lock survive.
    pruneExcept(...keepPaths) {
      const keys = keepPaths.map((keepPath) => path.basename(keepPath, ".mlmodelc"));
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (keys.some((key) => name.includes(key))) continue;
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    },
  };
}

module.exports = { createCompiledModelCache };
