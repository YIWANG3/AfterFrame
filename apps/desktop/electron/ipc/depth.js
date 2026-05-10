// Scene depth (Depth Anything V2) — IPC handlers for on-device depth inference.
// Output PNGs are cached per (source file fingerprint + active model) so the
// renderer rarely re-runs swift on the same image.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

function register({ app, ipcMain, dialog, isPackaged, readAppSettings, updateAppSettings, findSwiftRuntime }) {
  const depthScriptPath = isPackaged
    ? path.join(process.resourcesPath, "native", "compute-depth.swift")
    : path.join(__dirname, "..", "..", "native", "compute-depth.swift");

  const bundledDepthModelPath = isPackaged
    ? path.join(process.resourcesPath, "native", "DepthAnythingV2SmallF16.mlpackage")
    : path.join(__dirname, "..", "..", "native", "DepthAnythingV2SmallF16.mlpackage");

  function resolveDepthModelPath() {
    const settings = readAppSettings();
    const userPath = settings?.depthModelPath;
    if (userPath && fs.existsSync(userPath)) return userPath;
    return bundledDepthModelPath;
  }

  // Per-image cache so the same source isn't re-inferred. Key includes size +
  // mtime + active model so editing the file or swapping models invalidates
  // automatically.
  const depthCacheDir = path.join(app.getPath("userData"), "depth-cache");
  try { fs.mkdirSync(depthCacheDir, { recursive: true }); } catch (_) {}

  function depthCachePath(sourcePath, modelPath) {
    try {
      const real = fs.realpathSync(sourcePath);
      const stat = fs.statSync(real);
      const modelKey = modelPath ? path.basename(modelPath) : "default";
      const key = crypto
        .createHash("sha1")
        .update(`${real}|${stat.size}|${Math.floor(stat.mtimeMs)}|${modelKey}`)
        .digest("hex");
      return path.join(depthCacheDir, `${key}.png`);
    } catch {
      return null;
    }
  }

  ipcMain.handle("workspace:compute-depth", async (_event, options) => {
    if (process.platform !== "darwin") {
      throw new Error("Depth field generation requires macOS.");
    }
    const sourcePath = String(options?.sourcePath || "");
    if (!sourcePath) throw new Error("Missing source path");
    if (!fs.existsSync(sourcePath)) throw new Error(`Source not found: ${sourcePath}`);

    const modelPath = resolveDepthModelPath();
    const outputPath = depthCachePath(sourcePath, modelPath);
    if (!outputPath) throw new Error("Could not derive cache path for source");

    const force = !!options?.force;
    const checkOnly = !!options?.checkOnly;

    if (!force && fs.existsSync(outputPath)) {
      return { outputPath, cached: true, width: 518, height: 392 };
    }
    if (checkOnly) return null;

    if (!fs.existsSync(depthScriptPath)) {
      throw new Error(`Depth script missing at ${depthScriptPath}`);
    }
    const runtime = findSwiftRuntime();
    const env = { ...process.env };
    if (runtime.developerDir) env.DEVELOPER_DIR = runtime.developerDir;

    return await new Promise((resolve, reject) => {
      const child = spawn(runtime.binary, [depthScriptPath, sourcePath, outputPath, modelPath], { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Depth inference failed (exit ${code}).`));
          return;
        }
        const lines = stdout.trim().split("\n");
        const sizeMatch = (lines[1] || "").match(/(\d+)x(\d+)/);
        resolve({
          outputPath,
          cached: false,
          width: sizeMatch ? Number(sizeMatch[1]) : null,
          height: sizeMatch ? Number(sizeMatch[2]) : null,
        });
      });
    });
  });

  ipcMain.handle("workspace:get-depth-model", () => {
    const settings = readAppSettings();
    const userPath = settings?.depthModelPath;
    const isCustom = !!(userPath && fs.existsSync(userPath));
    const activePath = isCustom ? userPath : bundledDepthModelPath;
    return {
      path: activePath,
      name: path.basename(activePath),
      isCustom,
      bundledPath: bundledDepthModelPath,
    };
  });

  ipcMain.handle("workspace:pick-depth-model", async () => {
    const result = await dialog.showOpenDialog({
      title: "Select depth model (.mlpackage or .mlmodelc)",
      properties: ["openFile", "openDirectory"],
      filters: [{ name: "CoreML model", extensions: ["mlpackage", "mlmodelc", "mlmodel"] }],
    });
    if (result.canceled || !result.filePaths?.[0]) return null;
    const picked = result.filePaths[0];
    if (!fs.existsSync(picked)) {
      throw new Error(`Path not found: ${picked}`);
    }
    await updateAppSettings((s) => ({ ...s, depthModelPath: picked }));
    return {
      path: picked,
      name: path.basename(picked),
      isCustom: true,
      bundledPath: bundledDepthModelPath,
    };
  });

  ipcMain.handle("workspace:reset-depth-model", async () => {
    await updateAppSettings((s) => {
      const { depthModelPath: _drop, ...rest } = s || {};
      return rest;
    });
    return {
      path: bundledDepthModelPath,
      name: path.basename(bundledDepthModelPath),
      isCustom: false,
      bundledPath: bundledDepthModelPath,
    };
  });
}

module.exports = { register };
