const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BUNDLED_MODEL_KEY,
  bundledModelPath,
  isBundledModel,
  modelKey,
  pathDigest,
} = require("./peopleModel");
const peopleIpc = require("./ipc/people");

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-people-model-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeModel(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Manifest.json"), "{}");
  return dir;
}

// register() with in-memory settings and a fake ipcMain, as main.js wires it.
function registerPeople(t, { settings = {}, prepare, bundled = true, jobs = {} } = {}) {
  const root = tempDir(t);
  const userData = path.join(root, "userData");
  fs.mkdirSync(userData);
  if (prepare) settings = prepare(userData);
  const modelPath = path.join(root, "app", "native", "FaceEmbedding.mlpackage");
  if (bundled) fakeModel(modelPath);
  const previous = process.env.AFTERFRAME_BUNDLED_PEOPLE_MODEL;
  process.env.AFTERFRAME_BUNDLED_PEOPLE_MODEL = modelPath;
  t.after(() => {
    if (previous === undefined) delete process.env.AFTERFRAME_BUNDLED_PEOPLE_MODEL;
    else process.env.AFTERFRAME_BUNDLED_PEOPLE_MODEL = previous;
  });

  let stored = settings;
  const handlers = {};
  const launched = [];
  const api = peopleIpc.register({
    app: { getPath: () => userData },
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    dialog: {},
    isPackaged: true,
    resourcesPath: path.join(root, "app"),
    readAppSettings: () => stored,
    updateAppSettings: async (fn) => { stored = fn(stored); },
    getCatalogState: () => ({ currentCatalogPath: null, catalogHasDb: () => false }),
    createJob: async () => null,
    launchSidecarJob: (argv) => launched.push(argv),
    latestJobStatus: async () => ({ active: false }),
    formatJobStatus: (job) => job,
    commands: {
      getJob: async (id) => jobs[id] || null,
      resumeJob: async (id) => ({ ...jobs[id], status: "queued" }),
    },
  });
  return {
    api,
    launched,
    modelPath,
    userData,
    settings: () => stored,
    state: () => handlers["workspace:get-people-settings"](),
    invoke: (channel, ...args) => handlers[channel]({}, ...args),
  };
}

// What 0.5.5 stored after "Download ArcFace R100".
function downloadedRecord(userData) {
  const modelPath = path.join(userData, "people-models", BUNDLED_MODEL_KEY, "FaceEmbedding.mlpackage");
  fakeModel(modelPath);
  return {
    id: "arcface-r100-coreml",
    version: "b51b655",
    source: "official",
    manifestHash: "743cae41246e637e62e67224211bafd71f2b297dcc696523ed8b4aeaa7613d6c",
    modelPath,
  };
}

async function waitFor(condition) {
  for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition());
}

test("the bundled model's key is the one 0.5.5 recorded for its download", () => {
  assert.equal(BUNDLED_MODEL_KEY, "arcface-r100-coreml@b51b655@743cae41246e637e");
  assert.equal(modelKey("custom", "1", "0123456789abcdef0123"), "custom@1@0123456789abcdef");
});

test("the bundled model lives in Resources/native when packaged and in native/ in dev", () => {
  const env = {};
  assert.equal(
    bundledModelPath({ isPackaged: true, resourcesPath: "/App/Contents/Resources", desktopDir: "/repo/apps/desktop", env }),
    path.join("/App/Contents/Resources", "native", "FaceEmbedding.mlpackage"),
  );
  assert.equal(
    bundledModelPath({ isPackaged: false, resourcesPath: "/unused", desktopDir: "/repo/apps/desktop", env }),
    path.join("/repo/apps/desktop", "native", "FaceEmbedding.mlpackage"),
  );
  assert.equal(
    bundledModelPath({ isPackaged: true, resourcesPath: "/x", desktopDir: "/y", env: { AFTERFRAME_BUNDLED_PEOPLE_MODEL: "/e2e/Model.mlpackage" } }),
    path.resolve("/e2e/Model.mlpackage"),
  );
});

test("only the exact id, version and hash count as the bundled model", () => {
  const bundled = { modelId: "arcface-r100-coreml", modelVersion: "b51b655", manifestHash: "743cae41246e637e62e67224211bafd71f2b297dcc696523ed8b4aeaa7613d6c" };
  assert.equal(isBundledModel(bundled), true);
  assert.equal(isBundledModel({ ...bundled, modelVersion: "1" }), false);
  assert.equal(isBundledModel({ ...bundled, manifestHash: "743cae41246e637e" }), false);
});

test("pathDigest covers names and contents, and refuses symlinks", async (t) => {
  const root = tempDir(t);
  const model = fakeModel(path.join(root, "A.mlpackage"));
  const first = await pathDigest(model);
  assert.equal(first.sizeBytes, 2);
  assert.equal((await pathDigest(model)).sha256, first.sha256);
  fs.writeFileSync(path.join(model, "Manifest.json"), "[]");
  assert.notEqual((await pathDigest(model)).sha256, first.sha256);
  fs.symlinkSync(path.join(model, "Manifest.json"), path.join(model, "link"));
  await assert.rejects(pathDigest(model), /symbolic links/);
});

test("with no model chosen, the bundled one is active", (t) => {
  const people = registerPeople(t);
  const state = people.state();
  assert.equal(state.activeModelKey, BUNDLED_MODEL_KEY);
  assert.equal(state.activeModel.source, "bundled");
  assert.equal(state.activeModel.available, true);
  assert.deepEqual(state.models.map((model) => model.key), [BUNDLED_MODEL_KEY]);
  assert.equal("download" in state, false);
});

test("a build without the bundled model has no active model", (t) => {
  const people = registerPeople(t, { bundled: false });
  assert.equal(people.state().activeModelKey, null);
  assert.deepEqual(people.state().models, []);
});

test("a chosen model stays active; the bundled one is listed first", (t) => {
  const root = tempDir(t);
  const custom = fakeModel(path.join(root, "Custom.mlpackage"));
  const people = registerPeople(t, {
    settings: { peopleRecognition: { activeModelKey: "custom@1@abc", models: { "custom@1@abc": { id: "custom", version: "1", modelPath: custom } } } },
  });
  const state = people.state();
  assert.equal(state.activeModelKey, "custom@1@abc");
  assert.deepEqual(state.models.map((model) => model.key), [BUNDLED_MODEL_KEY, "custom@1@abc"]);
});

test("a chosen model that's gone falls back to the bundled one", (t) => {
  const people = registerPeople(t, {
    settings: { peopleRecognition: { activeModelKey: "custom@1@abc", models: { "custom@1@abc": { modelPath: "/gone/Custom.mlpackage" } } } },
  });
  assert.equal(people.state().activeModelKey, BUNDLED_MODEL_KEY);
});

test("0.5.5's downloaded copy is replaced by the bundled model and deleted", async (t) => {
  let download;
  const people = registerPeople(t, {
    prepare: (userData) => {
      download = downloadedRecord(userData);
      return { peopleRecognition: { activeModelKey: BUNDLED_MODEL_KEY, autoIndexOnImport: true, models: { [BUNDLED_MODEL_KEY]: download } } };
    },
  });
  assert.equal(people.state().activeModel.source, "bundled");
  await waitFor(() => !fs.existsSync(path.dirname(download.modelPath)));
  await waitFor(() => Object.keys(people.settings().peopleRecognition.models).length === 0);
  assert.equal(people.settings().peopleRecognition.activeModelKey, BUNDLED_MODEL_KEY);
  assert.equal(people.settings().peopleRecognition.autoIndexOnImport, true);
  assert.equal(people.state().activeModelKey, BUNDLED_MODEL_KEY);
});

test("without the bundled model, 0.5.5's download is kept and used", async (t) => {
  let download;
  const people = registerPeople(t, {
    bundled: false,
    prepare: (userData) => {
      download = downloadedRecord(userData);
      return { peopleRecognition: { activeModelKey: BUNDLED_MODEL_KEY, models: { [BUNDLED_MODEL_KEY]: download } } };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(download.modelPath), true);
  assert.equal(people.state().activeModel.source, "official");
});

test("a paused task started on 0.5.5's download resumes on the bundled model", async (t) => {
  const job = {
    job_id: "j1",
    job_type: "people_index",
    status: "paused",
    payload: {
      model_id: "arcface-r100-coreml",
      model_version: "b51b655",
      manifest_hash: "743cae41246e637e62e67224211bafd71f2b297dcc696523ed8b4aeaa7613d6c",
      model_path: "/Users/someone/Library/Application Support/afterframe/people-models/x/FaceEmbedding.mlpackage",
    },
  };
  const people = registerPeople(t, { jobs: { j1: job } });
  await people.api.resumePeopleIndexJob("j1");
  const [argv] = people.launched;
  assert.equal(argv[argv.indexOf("--model-path") + 1], people.modelPath);
});

test("the built-in model can't be removed", async (t) => {
  const root = tempDir(t);
  const custom = fakeModel(path.join(root, "Custom.mlpackage"));
  const people = registerPeople(t, {
    settings: { peopleRecognition: { activeModelKey: "custom@1@abc", models: { "custom@1@abc": { modelPath: custom } } } },
  });
  await assert.rejects(people.invoke("workspace:remove-people-model", BUNDLED_MODEL_KEY), /built-in model/);
});
