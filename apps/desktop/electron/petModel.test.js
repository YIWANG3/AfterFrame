const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  BUNDLED_DINOV2_SMALL,
  BUNDLED_PET_MODEL_KEY,
  bundledPetModelPath,
  bundledPetRecord,
  isBundledPetModel,
} = require("./petModel");
const { modelKey } = require("./peopleModel");

test("the built-in pet model is found in Resources/native when packaged and native/ in a checkout", () => {
  assert.equal(
    bundledPetModelPath({ isPackaged: true, resourcesPath: "/App/Contents/Resources", desktopDir: "/repo/apps/desktop", env: {} }),
    path.join("/App/Contents/Resources", "native", "PetEmbedding.mlpackage"),
  );
  assert.equal(
    bundledPetModelPath({ isPackaged: false, resourcesPath: "/x", desktopDir: "/repo/apps/desktop", env: {} }),
    path.join("/repo/apps/desktop", "native", "PetEmbedding.mlpackage"),
  );
  assert.equal(
    bundledPetModelPath({ isPackaged: true, resourcesPath: "/x", desktopDir: "/y", env: { AFTERFRAME_BUNDLED_PET_MODEL: "/e2e/Pet.mlpackage" } }),
    path.resolve("/e2e/Pet.mlpackage"),
  );
});

test("the built-in pet model's record and key name a vector space of its own", () => {
  const record = bundledPetRecord("/m/PetEmbedding.mlpackage");
  assert.equal(record.kind, "pet");
  assert.equal(record.source, "bundled");
  assert.equal(record.embeddingDimensions, 384);
  assert.equal(record.clusterThreshold, BUNDLED_DINOV2_SMALL.cluster_threshold);
  assert.equal(BUNDLED_PET_MODEL_KEY, modelKey(record.id, record.version, record.manifestHash));
  assert.equal(isBundledPetModel({ modelId: record.id, modelVersion: record.version, manifestHash: record.manifestHash }), true);
  assert.equal(isBundledPetModel({ modelId: record.id, modelVersion: record.version, manifestHash: "other" }), false);
});
