// The job projection, the resume routing and the default repaint provider
// are read by both the IPC handlers and the MCP tools; they live once in
// tasks.js so the two surfaces cannot drift (review 2026-10-14 §D).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createTaskStarters } = require("./tasks");

function starters({ settings = {}, commands = {}, resumePeopleIndexJob } = {}) {
  return createTaskStarters({
    app: { getPath: () => "/tmp" },
    readAppSettings: () => settings,
    commands,
    launchSidecarJob: () => {},
    addAllowedMediaDir: () => {},
    providerCredentials: async () => ({ apiKey: null, baseUrl: null }),
    resumePeopleIndexJob,
  });
}

test("listActiveJobsFormatted: every active job in the renderer's shape, with its type and cancel flag", async () => {
  const tasks = starters({
    commands: {
      listActiveJobs: async () => [
        { job_id: "j1", job_type: "import", status: "running", progress: 0.5, payload: { phase: "scan" }, cancel_requested: 1 },
        { job_id: "j2", job_type: "people_index", status: "paused", progress: 0.2, payload: {} },
      ],
    },
  });
  const jobs = await tasks.listActiveJobsFormatted();
  assert.deepEqual(jobs.map((j) => [j.jobId, j.jobType, j.running, j.paused, j.cancel_requested]), [
    ["j1", "import", true, false, true],
    ["j2", "people_index", false, true, false],
  ]);
  assert.equal(jobs[0].phase, "scan");
});

test("resumeJob: people_index goes through the people worker relaunch, everything else resumes in the sidecar", async () => {
  const sidecar = [];
  const people = [];
  const commands = {
    getJob: async (id) => ({ job_id: id, job_type: id === "p1" ? "people_index" : "import" }),
    resumeJob: async (id) => { sidecar.push(id); return { job_id: id, status: "queued" }; },
  };
  const tasks = starters({ commands, resumePeopleIndexJob: async (id) => { people.push(id); return { jobId: id, status: "queued" }; } });
  assert.deepEqual(await tasks.resumeJob("p1"), { jobId: "p1", status: "queued" });
  assert.deepEqual(await tasks.resumeJob("i1"), { job_id: "i1", status: "queued" });
  assert.deepEqual([people, sidecar], [["p1"], ["i1"]]);

  // The people bridge is wired after the starters (main.js); a null answer
  // from it falls through to the sidecar rather than resuming nothing.
  const unwired = starters({ commands, resumePeopleIndexJob: async () => null });
  await unwired.resumeJob("p1");
  assert.deepEqual(sidecar, ["i1", "p1"]);
});

test("activeRepaintProvider: the active provider (else the first) with the model picked for it, or null", () => {
  const providers = [{ id: "a", type: "openai", name: "A" }, { id: "b", type: "nanobanana", name: "B" }];
  assert.deepEqual(
    starters({ settings: { aiPreferences: { providers, activeProvider: "b", selectedModels: { b: "flash" } } } }).activeRepaintProvider(),
    { provider: providers[1], model: "flash" },
  );
  assert.deepEqual(
    starters({ settings: { aiPreferences: { providers, activeProvider: "gone" } } }).activeRepaintProvider(),
    { provider: providers[0], model: "" },
  );
  assert.equal(starters({ settings: {} }).activeRepaintProvider(), null);
});
