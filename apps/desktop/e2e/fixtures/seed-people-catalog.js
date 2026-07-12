// Seeds the people-recognition E2E catalog at
// apps/desktop/e2e/fixtures/people-catalog.afcatalog/.
//
// Source photos are AI-GENERATED FICTIONAL people (no portrait rights holder;
// see marketing/demo-people/, gitignored) — downscaled copies are committed
// under people-images/. Seeding runs the REAL people worker + ArcFace model
// locally once, so the committed DB contains genuine faces, embeddings and
// person groups; CI and specs never need the Core ML model.
//
// Layout produced (asserted by 18-people-flows.spec.js):
//   - "Lin Xi": NAMED person (portrait + 3 solos + 1 group-photo face)
//   - one unnamed candidate (Chen Mo: portrait + 2 solos + 1 group-photo face)
//
// Requirements to (re)seed: python3 env for the sidecar, native people-worker
// built (npm run build:native), an installed ArcFace model under
// ~/Library/Application Support/AfterFrame/people-models/.
// Run once with:  node e2e/fixtures/seed-people-catalog.js

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const sharp = require("sharp");

const FIXTURES_DIR = __dirname;
const CATALOG_DIR = path.join(FIXTURES_DIR, "people-catalog.afcatalog");
const IMAGES_DIR = path.join(FIXTURES_DIR, "people-images");
const REPO_ROOT = path.resolve(FIXTURES_DIR, "..", "..", "..", "..");
const SIDECAR_SRC = path.join(REPO_ROOT, "services", "sidecar", "src");
const WORKER_BIN = path.join(REPO_ROOT, "apps", "desktop", "native", "bin", "people-worker");
const DEMO_OUTPUT = path.join(REPO_ROOT, "marketing", "demo-people", "output");
const MODEL_STORE = path.join(os.homedir(), "Library", "Application Support", "AfterFrame", "people-models");

// identity -> source files relative to marketing/demo-people/output.
// Regenerating people-images/ needs those sources; the committed downscales
// keep working without them.
const SOURCES = {
  "linxi_portrait.jpg": "refs/linxi.png",
  "linxi_solo_00.jpg": "jimeng/linxi/solo_00.png",
  "linxi_solo_01.jpg": "jimeng/linxi/solo_01.png",
  "linxi_solo_02.jpg": "jimeng/linxi/solo_02.png",
  "chenmo_portrait.jpg": "refs/chenmo.png",
  "chenmo_solo_00.jpg": "jimeng/chenmo/solo_00.png",
  "chenmo_solo_01.jpg": "jimeng/chenmo/solo_01.png",
  "group_rooftop.jpg": "nanobanana/groups/group_00.png",
};
const NAMED_PERSON = { marker: "linxi_portrait", name: "Lin Xi" };

function runSidecar(args) {
  return execFileSync("python3", ["-m", "media_workspace", ...args], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONPATH: SIDECAR_SRC, PEOPLE_WORKER_PATH: WORKER_BIN },
  });
}

function findModel() {
  for (const key of fs.readdirSync(MODEL_STORE)) {
    const dir = path.join(MODEL_STORE, key);
    for (const entry of fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []) {
      if (entry.endsWith(".mlpackage") || entry.endsWith(".mlmodelc")) {
        const [modelId = "arcface", version = "1"] = key.split("@");
        return { modelPath: path.join(dir, entry), modelId, version, manifestHash: key.split("@")[2] || "fixture" };
      }
    }
  }
  throw new Error(`No installed people model under ${MODEL_STORE}`);
}

async function ensureImages() {
  const missing = Object.keys(SOURCES).filter((name) => !fs.existsSync(path.join(IMAGES_DIR, name)));
  if (!missing.length) return;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  for (const name of missing) {
    const source = path.join(DEMO_OUTPUT, SOURCES[name]);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing committed fixture ${name} and its source ${source}.\n` +
        "Regenerate sources via marketing/demo-people/generate.py first.");
    }
    console.log("Downscaling", name);
    await sharp(source).resize({ width: 720, withoutEnlargement: true }).jpeg({ quality: 82 }).toFile(path.join(IMAGES_DIR, name));
  }
}

async function main() {
  await ensureImages();
  fs.rmSync(CATALOG_DIR, { recursive: true, force: true });
  fs.mkdirSync(CATALOG_DIR, { recursive: true });

  console.log("Initializing catalog at", CATALOG_DIR);
  runSidecar(["--catalog", CATALOG_DIR, "init-catalog"]);
  runSidecar(["--catalog", CATALOG_DIR, "register-roots", "--root-type", "image", "--path", IMAGES_DIR]);
  for (const name of Object.keys(SOURCES)) {
    console.log("Registering", name);
    runSidecar(["--catalog", CATALOG_DIR, "quick-register", "--image-path", path.join(IMAGES_DIR, name)]);
  }
  console.log("Generating previews…");
  runSidecar(["--catalog", CATALOG_DIR, "generate-previews"]);

  const model = findModel();
  console.log("Running people index with", model.modelPath);
  const job = JSON.parse(runSidecar([
    "--catalog", CATALOG_DIR, "create-job", "--job-type", "people_index",
    "--payload-json", JSON.stringify({
      model_id: model.modelId, model_version: model.version,
      model_path: model.modelPath, manifest_hash: model.manifestHash,
    }),
  ]));
  runSidecar([
    "--catalog", CATALOG_DIR, "run-people-index-job", "--job-id", job.job_id,
    "--model-id", model.modelId, "--model-version", model.version,
    "--model-path", model.modelPath, "--manifest-hash", model.manifestHash,
  ]);

  // Name the Lin Xi group (found via her portrait's face); leave the other
  // candidate unnamed so specs can exercise the naming flow.
  const groups = JSON.parse(runSidecar(["--catalog", CATALOG_DIR, "list-people-groups"]));
  if (groups.length !== 2) throw new Error(`expected exactly 2 person groups, got ${groups.length}`);
  let named = 0;
  for (const group of groups) {
    const detail = JSON.parse(runSidecar([
      "--catalog", CATALOG_DIR, "people-group-detail", "--group-id", group.group_id,
    ]));
    if (detail.faces.some((face) => face.image_path.includes(NAMED_PERSON.marker))) {
      console.log("Naming group", group.group_id, "→", NAMED_PERSON.name);
      runSidecar([
        "--catalog", CATALOG_DIR, "rename-people-group",
        "--group-id", group.group_id, "--name", NAMED_PERSON.name,
      ]);
      named += 1;
    }
  }
  if (named !== 1) throw new Error(`expected to name exactly 1 group, named ${named}`);

  // WAL checkpoint so the committed DB is a single self-contained file.
  runSidecar(["--catalog", CATALOG_DIR, "summary"]);
  const final = JSON.parse(runSidecar(["--catalog", CATALOG_DIR, "list-people-groups"]));
  console.log("Seeded people catalog:", final.map((g) => `${g.name || "(unnamed)"}×${g.face_count}`).join(", "));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
