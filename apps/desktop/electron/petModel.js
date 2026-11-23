// The pet identity model that ships inside AfterFrame: DINOv2 Small (Meta,
// Apache-2.0) as a Core ML package, built by scripts/models/convert-pet-model.py
// and published on the repository's `models` release. The People Worker runs
// it beside the face model (--pet-model) to tell one cat or dog from another.
// See docs/pet-recognition-design.md.

const path = require("node:path");
const { canLoadBundledModel, modelKey } = require("./peopleModel");

const BUNDLED_DINOV2_SMALL = Object.freeze({
  id: "dinov2-small-coreml",
  version: "ed25f3a",
  name: "DINOv2 Small · Core ML",
  kind: "pet",
  license: "Apache-2.0",
  license_url: "https://huggingface.co/facebook/dinov2-small",
  archive_name: "PetEmbedding-dinov2-small-846f00a0.mlpackage.tar.gz",
  archive_sha256: "846f00a00b5f5ca5ffe8a01886bb37a9732d23b8d836842953cb4a04b19a73cd",
  archive_bytes: 40076226,
  model_path: "PetEmbedding.mlpackage",
  // pathDigest() of the unpacked package.
  manifest_hash: "bf28131349d056ecc8db06733f82ee1a7098fc948973c5b4aaf8cf154c878e2e",
  size_bytes: 43411883,
  embedding_dimensions: 384,
  input_name: "image",
  output_name: "embedding",
  // Cosine similarity two animals need before they may group: the best
  // average-link cut on the Commons test set (distance 0.92 between unit
  // vectors). To be re-tuned on household photos.
  cluster_threshold: 0.58,
  min_macos: 14,
});

const BUNDLED_PET_MODEL_KEY = modelKey(
  BUNDLED_DINOV2_SMALL.id,
  BUNDLED_DINOV2_SMALL.version,
  BUNDLED_DINOV2_SMALL.manifest_hash,
);

// AFTERFRAME_BUNDLED_PET_MODEL lets E2E runs choose whether a model is present,
// independent of whether this checkout has fetched it.
function bundledPetModelPath({ isPackaged, resourcesPath, desktopDir, env = process.env }) {
  if (env.AFTERFRAME_BUNDLED_PET_MODEL) return path.resolve(env.AFTERFRAME_BUNDLED_PET_MODEL);
  const nativeDir = isPackaged ? path.join(resourcesPath, "native") : path.join(desktopDir, "native");
  return path.join(nativeDir, BUNDLED_DINOV2_SMALL.model_path);
}

// Same shape as the records the people IPC persists for a chosen model.
function bundledPetRecord(modelPath) {
  const model = BUNDLED_DINOV2_SMALL;
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
    clusterThreshold: model.cluster_threshold,
    modelPath,
  };
}

function isBundledPetModel({ modelId, modelVersion, manifestHash }) {
  return modelId === BUNDLED_DINOV2_SMALL.id
    && modelVersion === BUNDLED_DINOV2_SMALL.version
    && manifestHash === BUNDLED_DINOV2_SMALL.manifest_hash;
}

module.exports = {
  BUNDLED_DINOV2_SMALL,
  BUNDLED_PET_MODEL_KEY,
  bundledPetModelPath,
  bundledPetRecord,
  // The pet model is an ML Program for macOS 14, like the face model.
  canLoadBundledPetModel: canLoadBundledModel,
  isBundledPetModel,
};
