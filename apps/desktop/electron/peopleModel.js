// The ArcFace R100 face model that ships inside AfterFrame.
//
// Up to 0.5.5 it was a 110 MB download from Hugging Face on first use, which
// fails from mainland China (#127). It now ships in Resources/native/ next to
// the depth model. Its weights are over GitHub's 100 MB file limit, so it isn't
// committed: scripts/fetch-people-model.mjs downloads and verifies it at build
// time, and electron-builder copies native/*.mlpackage into the app.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BUNDLED_ARCFACE_R100 = Object.freeze({
  id: "arcface-r100-coreml",
  version: "b51b655",
  name: "ArcFace R100 · Core ML",
  kind: "arcface",
  license: "Apache-2.0",
  license_url: "https://huggingface.co/RuiSumida/ArcFace-R100-CoreML",
  archive_url: "https://huggingface.co/RuiSumida/ArcFace-R100-CoreML/resolve/b51b655da6b4acc72bfdbfdcd316b3cf4f698e4e/FaceEmbedding.mlpackage.tar.gz",
  archive_sha256: "3644ff110ba03a082515d3a9fa22dbc8c1eb66054bb6bbbc0e84eb62b4771f2b",
  archive_bytes: 110376172,
  model_path: "FaceEmbedding.mlpackage",
  // pathDigest() of the unpacked package. 0.5.5 recorded the same hash for its
  // downloaded copy, so the bundled model gets the same key and face indexes
  // built with the download stay valid.
  manifest_hash: "743cae41246e637e62e67224211bafd71f2b297dcc696523ed8b4aeaa7613d6c",
  size_bytes: 130796743,
  embedding_dimensions: 512,
  input_name: "faceImage",
  output_name: "embedding",
});

const BUNDLED_MODEL_KEY = modelKey(
  BUNDLED_ARCFACE_R100.id,
  BUNDLED_ARCFACE_R100.version,
  BUNDLED_ARCFACE_R100.manifest_hash,
);

function modelKey(id, version, manifestHash) {
  return `${id}@${version}@${String(manifestHash).slice(0, 16)}`;
}

// AFTERFRAME_BUNDLED_PEOPLE_MODEL lets E2E runs choose whether a model is
// present, independent of whether this checkout has fetched it.
function bundledModelPath({ isPackaged, resourcesPath, desktopDir, env = process.env }) {
  if (env.AFTERFRAME_BUNDLED_PEOPLE_MODEL) return path.resolve(env.AFTERFRAME_BUNDLED_PEOPLE_MODEL);
  const nativeDir = isPackaged ? path.join(resourcesPath, "native") : path.join(desktopDir, "native");
  return path.join(nativeDir, BUNDLED_ARCFACE_R100.model_path);
}

// Same shape as the records installModel persists for a chosen model.
function bundledRecord(modelPath) {
  const model = BUNDLED_ARCFACE_R100;
  return {
    id: model.id,
    version: model.version,
    name: model.name,
    kind: model.kind,
    source: "bundled",
    license: model.license,
    licenseUrl: model.license_url,
    manifestHash: model.manifest_hash,
    sizeBytes: model.size_bytes,
    installedAt: null,
    embeddingDimensions: model.embedding_dimensions,
    inputName: model.input_name,
    outputName: model.output_name,
    modelPath,
  };
}

function isBundledModel({ modelId, modelVersion, manifestHash }) {
  return modelId === BUNDLED_ARCFACE_R100.id
    && modelVersion === BUNDLED_ARCFACE_R100.version
    && manifestHash === BUNDLED_ARCFACE_R100.manifest_hash;
}

async function pathDigest(targetPath) {
  const hash = crypto.createHash("sha256");
  let totalBytes = 0;

  async function visit(currentPath, relativePath) {
    const stat = await fs.promises.lstat(currentPath);
    if (stat.isSymbolicLink()) throw new Error("Model packages may not contain symbolic links.");
    if (stat.isDirectory()) {
      hash.update(`dir:${relativePath}\n`);
      const entries = await fs.promises.readdir(currentPath);
      for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
        await visit(path.join(currentPath, entry), path.posix.join(relativePath, entry));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("Model package contains an unsupported filesystem entry.");
    hash.update(`file:${relativePath}:${stat.size}\n`);
    totalBytes += stat.size;
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(currentPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  }

  await visit(targetPath, path.basename(targetPath));
  return { sha256: hash.digest("hex"), sizeBytes: totalBytes };
}

module.exports = {
  BUNDLED_ARCFACE_R100,
  BUNDLED_MODEL_KEY,
  modelKey,
  bundledModelPath,
  bundledRecord,
  isBundledModel,
  pathDigest,
};
