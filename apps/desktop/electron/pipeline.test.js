const test = require("node:test");
const assert = require("node:assert/strict");
const { createImportPipeline } = require("./pipeline");

// A catalog's jobs as the sidecar answers for them, and what the pipeline
// asked of it and of the starters.
function setup({ settings = {}, jobs = [], pending = [], annotationCount = 3, canIndex = true, hasProvider = true, importBusy = false } = {}) {
  const state = { jobs: [...jobs], pending: pending.map((item) => ({ followups: {}, ...item })), importBusy };
  const calls = { paused: [], resumed: [], marked: [], people: [], annotation: [], imports: [], started: [], announced: [] };
  const commands = {
    listActiveJobs: async () => state.jobs.map((job) => ({ ...job })),
    pauseJob: async (jobId, options) => {
      calls.paused.push([jobId, options]);
      const job = state.jobs.find((row) => row.job_id === jobId);
      if (job) Object.assign(job, { status: "paused", paused_for_import: options?.forImport === true });
      return job;
    },
    pendingImportFollowups: async () => state.pending.map((item) => ({ ...item, followups: { ...item.followups } })),
    markImportFollowups: async (jobId, followups) => {
      calls.marked.push([jobId, followups]);
      const item = state.pending.find((row) => row.job_id === jobId);
      if (item) {
        item.followups = { ...item.followups, ...followups };
        if (item.followups.done) state.pending = state.pending.filter((row) => row !== item);
      }
      return item?.followups;
    },
    annotationCount: async ({ importJobIds }) => {
      calls.counted = importJobIds;
      return { count: annotationCount };
    },
  };
  const tasks = {
    startImportTask: async (options) => {
      calls.imports.push(options);
      if (state.importBusy) return { jobId: "running-import", running: true, busy: true };
      state.jobs.push({ job_id: `import-${calls.imports.length}`, job_type: "import", status: "running" });
      return { jobId: `import-${calls.imports.length}`, running: true };
    },
    startColorsTask: async (options) => { calls.started.push(["colors", options]); return { jobId: "colors-1", running: true }; },
    startVisualTask: async (options) => { calls.started.push(["visual", options]); return { jobId: "visual-1", running: true }; },
    startOrientationTask: async () => { calls.started.push(["orientation"]); return { running: false }; },
    startPreviewTask: async (kind) => { calls.started.push(["preview", kind]); return { jobId: "preview-1", running: true }; },
  };
  const people = {
    canIndex: () => canIndex,
    startPeopleIndex: async (options) => { calls.people.push(options); return { jobId: "people-new", running: true }; },
    resumePeopleIndexJob: async (jobId) => { calls.resumed.push(jobId); return { jobId, running: true }; },
  };
  const annotation = {
    hasProvider: async () => hasProvider,
    startAnnotationTask: async (options) => { calls.annotation.push(options); return { jobId: "annotation-new", running: true }; },
  };
  const pipeline = createImportPipeline({
    commands, tasks, people, annotation,
    readAppSettings: () => settings,
    getCatalogPath: () => "/demo.afcatalog",
    announce: (jobId, jobType) => calls.announced.push([jobId, jobType]),
    log: { warn() {} },
  });
  return { pipeline, state, calls };
}

const ON = { peopleRecognition: { autoIndexOnImport: true }, aiAnnotation: { autoOnImport: true } };

test("an import that ended with new photos gets its people scan and annotation once, cancelled or not", async () => {
  const { pipeline, calls, state } = setup({
    settings: ON,
    pending: [
      { job_id: "import-a", status: "cancelled", new_assets: 12 },
      { job_id: "import-b", status: "failed", new_assets: 3 },
    ],
  });
  await pipeline.sweep();
  assert.deepEqual(calls.people, [{ auto: true }]);
  assert.deepEqual(calls.annotation, [{ scope: "import", importJobIds: ["import-a", "import-b"], onlyMissing: true, auto: true }]);
  assert.deepEqual(calls.marked, [
    ["import-a", { people: "started", annotation: "started", done: true }],
    ["import-b", { people: "started", annotation: "started", done: true }],
  ]);
  assert.deepEqual(calls.announced, [["people-new", "people_index"], ["annotation-new", "annotation"]]);
  assert.equal(state.pending.length, 0);
  await pipeline.sweep();
  assert.equal(calls.people.length, 1);
  assert.equal(calls.annotation.length, 1);
});

test("with the settings off nothing starts, and the import is done with", async () => {
  const { pipeline, calls } = setup({ pending: [{ job_id: "import-a", status: "succeeded", new_assets: 5 }] });
  await pipeline.sweep();
  assert.deepEqual(calls.people, []);
  assert.deepEqual(calls.annotation, []);
  assert.deepEqual(calls.marked, [["import-a", { people: "off", annotation: "off", done: true }]]);
});

test("no model, no provider: as good as off", async () => {
  const { pipeline, calls } = setup({
    settings: ON, canIndex: false, hasProvider: false,
    pending: [{ job_id: "import-a", status: "succeeded", new_assets: 5 }],
  });
  await pipeline.sweep();
  assert.deepEqual(calls.marked, [["import-a", { people: "off", annotation: "off", done: true }]]);
});

test("an import that added nothing is done with, and one with nothing left to annotate starts no job", async () => {
  const { pipeline, calls } = setup({
    settings: ON, annotationCount: 0,
    pending: [
      { job_id: "import-a", status: "succeeded", new_assets: 0 },
      { job_id: "import-b", status: "succeeded", new_assets: 2 },
    ],
  });
  await pipeline.sweep();
  assert.deepEqual(calls.counted, ["import-b"]);
  assert.deepEqual(calls.annotation, []);
  assert.deepEqual(calls.marked, [
    ["import-a", { people: "none", annotation: "none", done: true }],
    ["import-b", { people: "started", annotation: "none", done: true }],
  ]);
});

test("while an import runs the people scan is paused for it and the new one waits; annotation goes ahead", async () => {
  const { pipeline, calls } = setup({
    settings: ON,
    jobs: [
      { job_id: "import-now", job_type: "import", status: "running" },
      { job_id: "people-old", job_type: "people_index", status: "running" },
    ],
    pending: [{ job_id: "import-a", status: "succeeded", new_assets: 4 }],
  });
  await pipeline.sweep();
  assert.deepEqual(calls.paused, [["people-old", { forImport: true }]]);
  assert.deepEqual(calls.people, []);
  assert.equal(calls.annotation.length, 1);
  assert.deepEqual(calls.marked, [["import-a", { annotation: "started", done: false }]]);
});

test("when imports are over the scan the app paused goes on; the one the user paused stays", async () => {
  const { pipeline, calls } = setup({
    jobs: [
      { job_id: "people-app", job_type: "people_index", status: "paused", paused_for_import: true },
      { job_id: "people-user", job_type: "people_index", status: "paused", paused_for_import: false },
      { job_id: "people-cancelled", job_type: "people_index", status: "paused", paused_for_import: true, cancel_requested: true },
    ],
  });
  await pipeline.sweep();
  assert.deepEqual(calls.resumed, ["people-app"]);
});

test("a scan under way when the import ended doesn't see its photos: a new one starts after it", async () => {
  const { pipeline, calls, state } = setup({
    settings: { peopleRecognition: { autoIndexOnImport: true } },
    jobs: [{ job_id: "people-old", job_type: "people_index", status: "running" }],
    pending: [{ job_id: "import-a", status: "succeeded", new_assets: 4 }],
  });
  await pipeline.sweep();
  assert.deepEqual(calls.people, []);
  assert.deepEqual(calls.marked, [["import-a", { annotation: "off", done: false }]]);
  state.jobs = [];
  await pipeline.sweep();
  assert.deepEqual(calls.people, [{ auto: true }]);
  assert.deepEqual(calls.marked.at(-1), ["import-a", { people: "started", done: true }]);
});

test("an agent's import behind a running one is queued and starts when that one ends", async () => {
  const { pipeline, calls, state } = setup({ importBusy: true });
  const status = await pipeline.startImport({ mode: "processed_only", imageDirs: ["/photos"] });
  assert.equal(status.queued, true);
  assert.equal(status.jobId, "running-import");
  assert.equal(pipeline.queuedImports(), 1);

  state.jobs = [{ job_id: "running-import", job_type: "import", status: "running" }];
  await pipeline.sweep();
  assert.equal(calls.imports.length, 1, "nothing new starts while one runs");

  state.jobs = [];
  state.importBusy = false;
  await pipeline.sweep();
  assert.deepEqual(calls.imports.at(-1), { mode: "processed_only", imageDirs: ["/photos"] });
  assert.equal(pipeline.queuedImports(), 0);
  assert.deepEqual(calls.announced, [["import-2", "import"]]);
});

test("a queue and the analysis put off belong to their catalog", async () => {
  const { pipeline, calls, state } = setup({ importBusy: true });
  await pipeline.startImport({ mode: "processed_only", imageDirs: ["/photos"] });
  pipeline.deferUntilImportsEnd("colors", { auto: true });
  pipeline.catalogChanged();
  pipeline.stop();
  state.importBusy = false;
  await pipeline.sweep();
  assert.equal(pipeline.queuedImports(), 0);
  assert.equal(calls.imports.length, 1);
  assert.deepEqual(calls.started, []);
});

test("analysis asked for during an import starts once imports are over", async () => {
  const { pipeline, calls, state } = setup({ jobs: [{ job_id: "import-now", job_type: "import", status: "running" }] });
  pipeline.deferUntilImportsEnd("colors", { auto: true });
  pipeline.deferUntilImportsEnd("visual", { auto: true });
  pipeline.deferUntilImportsEnd("preview", { kind: "preview-hd" });
  pipeline.deferUntilImportsEnd("nonsense", {});
  await pipeline.sweep();
  assert.deepEqual(calls.started, []);
  state.jobs = [];
  await pipeline.sweep();
  assert.deepEqual(calls.started, [["colors", { auto: true }], ["visual", { auto: true }], ["preview", "preview-hd"]]);
  await pipeline.sweep();
  assert.equal(calls.started.length, 3);
});

test("no catalog, no sweep", async () => {
  const pipeline = createImportPipeline({
    commands: { listActiveJobs: async () => { throw new Error("must not be asked"); } },
    tasks: {}, people: {}, annotation: {},
    readAppSettings: () => ({}), getCatalogPath: () => null, log: { warn() { throw new Error("no warning expected"); } },
  });
  await pipeline.sweep();
});
